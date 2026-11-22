import { decrypt as nip04Decrypt } from 'nostr-tools/nip04';
import type { Event } from 'nostr-tools/pure';
import { parseUnits } from '@hermes/chain';

/**
 * Pay-tab helpers that hold no keys and touch no network by themselves (F8–F11):
 * NIP-05 check with a clear "couldn't check" state, payment-note parsing for the
 * recipient's inbox, local payment history, amount validation.
 */

// ── F10: NIP-05 ───────────────────────────────────────────────────────────────

export type Nip05Status = 'match' | 'mismatch' | 'not-found' | 'unreachable' | 'invalid';

/** `name@domain` (or a bare domain, meaning `_@domain`) → { local, domain }, or undefined. */
export function splitNip05(name: string | undefined): { local: string; domain: string } | undefined {
  if (!name || typeof name !== 'string') return undefined;
  const s = name.trim().toLowerCase();
  const [local, domain] = s.includes('@') ? s.split('@') : ['_', s];
  if (!local || !domain || s.split('@').length > 2) return undefined;
  if (!/^[a-z0-9._-]+$/.test(local)) return undefined;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/.test(domain)) return undefined;
  return { local, domain };
}

/**
 * Does `name@domain` point at `pubkey` right now? Unlike a plain boolean, this separates
 * "the domain says another key" (mismatch / not-found) from "we couldn't ask" (unreachable,
 * e.g. offline or no CORS), so the card never claims a mismatch it didn't see.
 * The JSON is untrusted data: only `names[local]` is read and compared.
 */
export async function checkNip05(
  name: string | undefined,
  pubkey: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i),
): Promise<Nip05Status> {
  const n = splitNip05(name);
  if (!n) return 'invalid';
  let json: unknown;
  try {
    const res = await fetchImpl(`https://${n.domain}/.well-known/nostr.json?name=${encodeURIComponent(n.local)}`, { redirect: 'error' });
    if (res.status === 404) return 'not-found';
    if (!res.ok) return 'unreachable';
    json = await res.json();
  } catch {
    return 'unreachable';
  }
  const names = (json as { names?: unknown })?.names;
  if (!names || typeof names !== 'object') return 'not-found';
  const v = (names as Record<string, unknown>)[n.local];
  if (typeof v !== 'string') return 'not-found';
  return v.toLowerCase() === pubkey.toLowerCase() ? 'match' : 'mismatch';
}

// ── F11: payment notes (recipient side) ───────────────────────────────────────

export const PAYMENT_NOTE_TAG = 'hermes-pay';

export interface PaymentNote {
  id: string;
  from: string;
  at: number;
  amount: string;
  asset: string;
  memo?: string;
  txid: string;
}

const NOTE_RE = /^Hermes Pay: sent you (\d+(?:\.\d+)?) ([^\s()]{1,64})(?: \(ref: ([\x20-\x7e]{0,64})\))?\. Transaction ([0-9a-f]{64})$/;

/** Parse the plaintext of a Hermes payment note; anything else (ordinary DMs) → undefined. */
export function parsePaymentNote(text: string): Omit<PaymentNote, 'id' | 'from' | 'at'> | undefined {
  const m = NOTE_RE.exec(text.trim());
  if (!m) return undefined;
  return { amount: m[1], asset: m[2], memo: m[3] || undefined, txid: m[4] };
}

/**
 * Decrypt kind-4 events addressed to `me` and keep the Hermes payment notes, newest first.
 * `decrypt(senderPubkey, ciphertext)` is the recipient's NIP-04 decrypt (local key or NIP-07).
 * Events that fail to decrypt or aren't payment notes are skipped, never thrown.
 */
export async function readPaymentNotes(
  events: Event[],
  me: string,
  decrypt: (sender: string, content: string) => Promise<string>,
): Promise<PaymentNote[]> {
  const seen = new Set<string>();
  const out: PaymentNote[] = [];
  for (const e of events) {
    if (seen.has(e.id) || e.kind !== 4) continue;
    seen.add(e.id);
    if (!e.tags.some((t) => t[0] === 'p' && t[1] === me)) continue;
    let text: string;
    try {
      text = await decrypt(e.pubkey, e.content);
    } catch {
      continue;
    }
    const n = parsePaymentNote(text);
    if (n) out.push({ ...n, id: e.id, from: e.pubkey, at: e.created_at });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Local-key decrypt for `readPaymentNotes`. */
export const localNoteDecrypt = (secret: Uint8Array) => async (sender: string, content: string) => nip04Decrypt(secret, sender, content);

// ── F9: local payment history ─────────────────────────────────────────────────

export interface PaidEntry {
  at: number;
  to: string;
  name?: string;
  amount: string;
  asset: string;
  txid: string;
  network: string;
  memo?: string;
  note?: boolean;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);

/** Stored history is untrusted (old versions, manual edits): keep only well-formed entries. */
export function normalizeHistory(raw: unknown): PaidEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PaidEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const txid = str(o.txid, 64);
    const to = str(o.to, 200);
    const amount = str(o.amount, 40);
    const asset = str(o.asset, 64);
    const network = o.network === 'mainnet' || o.network === 'chipnet' ? o.network : undefined;
    if (!txid || !/^[0-9a-f]{64}$/.test(txid) || !to || !amount || !asset || !network || typeof o.at !== 'number') continue;
    out.push({ at: o.at, to, name: str(o.name, 64), amount, asset, txid, network, memo: str(o.memo, 64), note: o.note === true || undefined });
  }
  return out;
}

/** Newest first, one entry per txid, capped. */
export function addToHistory(list: PaidEntry[], e: PaidEntry, max = 50): PaidEntry[] {
  return [e, ...list.filter((x) => x.txid !== e.txid)].slice(0, max);
}

// ── amounts ───────────────────────────────────────────────────────────────────

/** Why `amount` can't be sent (or undefined when it can). BCH needs at least `minBase` (dust). */
export function amountProblem(amount: string, decimals: number, minBase = 0n): string | undefined {
  let v: bigint;
  try {
    v = parseUnits(amount, decimals);
  } catch (e) {
    return (e as Error).message;
  }
  if (v <= 0n) return 'amount must be more than zero';
  if (v < minBase) return `amount below dust (${minBase} base units minimum)`;
  return undefined;
}
