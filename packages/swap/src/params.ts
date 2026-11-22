import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import hermes from '../../../config/hermes.json' with { type: 'json' };

export const T_FIRST_SECONDS = hermes.swap.tFirstSeconds; // 3 h
export const T_SECOND_SECONDS = hermes.swap.tSecondSeconds; // 1 h
export const SAFETY_MARGIN_SECONDS = hermes.swap.safetyMarginSeconds; // 1 h
export const QUOTE_EXPIRY_SECONDS = hermes.swap.quoteExpirySeconds; // 60 s
/** Minimum time left on a leg for a party to still act on it (claim / counter-lock). */
export const ACTION_MARGIN_SECONDS = 15 * 60;

export type Direction = 'usdc-to-pusd' | 'pusd-to-usdc';
export type Chain = 'evm' | 'bch';

/** Which chain locks first: the taker always locks first (with the longer timeout). */
export const firstChain = (d: Direction): Chain => (d === 'usdc-to-pusd' ? 'evm' : 'bch');
export const secondChain = (d: Direction): Chain => (d === 'usdc-to-pusd' ? 'bch' : 'evm');

export function generateSecret(): { secret: string; hashlock: string } {
  const s = new Uint8Array(32);
  globalThis.crypto.getRandomValues(s);
  return { secret: bytesToHex(s), hashlock: bytesToHex(sha256(s)) };
}

export function hashlockOf(secretHex: string): string {
  const s = hexToBytes(secretHex);
  if (s.length !== 32) throw new Error('secret must be 32 bytes');
  return bytesToHex(sha256(s));
}

export function checkPreimage(preimageHex: string, hashlockHex: string): boolean {
  try {
    const s = hexToBytes(preimageHex.replace(/^0x/, ''));
    return s.length === 32 && bytesToHex(sha256(s)) === hashlockHex.replace(/^0x/, '').toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Invariant 4 (CLAUDE.md): the side that locks first gets the longer timeout,
 * T_first ≥ T_second + SAFETY_MARGIN, and both are in the future with room to act.
 * Returns a list of violations (empty = acceptable). Client and solver both call this.
 */
export function validateTimeouts(
  tFirst: number,
  tSecond: number,
  now = Math.floor(Date.now() / 1000),
  margin = SAFETY_MARGIN_SECONDS,
): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(tFirst) || !Number.isInteger(tSecond)) errors.push('timeouts must be integer unix seconds');
  if (tFirst < 500_000_000 || tSecond < 500_000_000) errors.push('timeouts must be unix timestamps, not block heights');
  if (tFirst < tSecond + margin) errors.push(`T_first (${tFirst}) must be ≥ T_second (${tSecond}) + ${margin}s`);
  if (tSecond <= now + ACTION_MARGIN_SECONDS) errors.push('T_second leaves no time to claim');
  if (tFirst > now + 7 * 24 * 3600) errors.push('T_first more than 7 days ahead');
  return errors;
}

export function defaultTimeouts(now = Math.floor(Date.now() / 1000)) {
  return { tFirst: now + T_FIRST_SECONDS, tSecond: now + T_SECOND_SECONDS };
}

/**
 * Convert between tokens of different decimals at a rate given in parts-per-million
 * (1_000_000 = 1:1). Rounds down: the receiver never gets more than quoted.
 */
export function convert(amountIn: bigint, decimalsIn: number, decimalsOut: number, ratePpm: bigint): bigint {
  const scaledIn = amountIn * ratePpm;
  const num = scaledIn * 10n ** BigInt(decimalsOut);
  const den = 1_000_000n * 10n ** BigInt(decimalsIn);
  return num / den;
}
