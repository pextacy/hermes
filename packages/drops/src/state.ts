import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { encodeLE } from './merkle.js';

/** Must match DropsShard.cash. */
export const BITMAP_BYTES = 88;
export const ACCOUNTS_PER_SHARD = BITMAP_BYTES * 8; // 704
export const SHARD_STATE_BYTES = 1 + 4 + 32 + BITMAP_BYTES; // 125
export const MAX_DEPTH = 20;

export interface ShardState {
  shardIndex: number;
  epoch: number;
  root: string; // hex 32
  bitmap: Uint8Array; // 88 bytes
}

const readLE = (b: Uint8Array) => b.reduceRight((acc, x) => acc * 256 + x, 0);

export function encodeShardState(s: ShardState): string {
  if (s.shardIndex < 0 || s.shardIndex > 127) throw new Error('shardIndex must be 0..127');
  if (s.bitmap.length !== BITMAP_BYTES) throw new Error('bad bitmap');
  return bytesToHex(Uint8Array.from([s.shardIndex, ...encodeLE(BigInt(s.epoch), 4), ...hexToBytes(s.root), ...s.bitmap]));
}

export function decodeShardState(hex: string): ShardState {
  const b = hexToBytes(hex);
  if (b.length !== SHARD_STATE_BYTES) throw new Error('bad shard state length');
  return { shardIndex: b[0], epoch: readLE(b.slice(1, 5)), root: bytesToHex(b.slice(5, 37)), bitmap: b.slice(37) };
}

export const emptyShard = (shardIndex: number): ShardState => ({
  shardIndex,
  epoch: 0,
  root: '00'.repeat(32),
  bitmap: new Uint8Array(BITMAP_BYTES),
});

export const shardOf = (accountId: number) => Math.floor(accountId / ACCOUNTS_PER_SHARD);
export const bitOf = (accountId: number) => accountId % ACCOUNTS_PER_SHARD;

export function hasClaimed(s: ShardState, accountId: number) {
  const local = bitOf(accountId);
  return (s.bitmap[local >> 3] & (1 << (local & 7))) !== 0;
}

export function withClaimBit(s: ShardState, accountId: number): ShardState {
  const bitmap = s.bitmap.slice();
  const local = bitOf(accountId);
  bitmap[local >> 3] |= 1 << (local & 7);
  return { ...s, bitmap };
}

/** Pending root commitment: shardIndex (1) | epoch (4 LE) | root (32). */
export function encodePending(shardIndex: number, epoch: number, root: string): string {
  return bytesToHex(Uint8Array.from([shardIndex, ...encodeLE(BigInt(epoch), 4), ...hexToBytes(root)]));
}

export function decodePending(hex: string) {
  const b = hexToBytes(hex);
  if (b.length !== 37) throw new Error('bad pending length');
  return { shardIndex: b[0], epoch: readLE(b.slice(1, 5)), root: bytesToHex(b.slice(5)) };
}

/** Receipt commitment: accountId (4 LE) | claimedTotal (8 LE). */
export function encodeReceipt(accountId: number, claimedTotal: bigint): string {
  return bytesToHex(Uint8Array.from([...encodeLE(BigInt(accountId), 4), ...encodeLE(claimedTotal, 8)]));
}

export function decodeReceipt(hex: string) {
  const b = hexToBytes(hex);
  if (b.length !== 12) throw new Error('bad receipt length');
  let claimed = 0n;
  for (let i = 11; i >= 4; i--) claimed = claimed * 256n + BigInt(b[i]);
  return { accountId: readLE(b.slice(0, 4)), claimedTotal: claimed };
}
