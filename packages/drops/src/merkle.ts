import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/**
 * Hermes Drops Merkle tree (must match DropsShard.cash byte for byte):
 *   leaf = SHA256(lockingBytecode || cumulative (8 bytes LE) || accountId (4 bytes LE))
 *   node = SHA256(left || right), positional; bit i of `path` = 1 when the node at level i
 *   is a right child. Trees are padded to a power of two with 32 zero bytes (unprovable).
 * Note: docs/PLAN.md §5 first sketched "sorted pairs"; positional pairs are used because
 * the BCH VM compares numbers, not 32-byte strings, and a path integer is cheaper on-chain.
 */
export interface Entitlement {
  lockingBytecode: string; // hex
  cumulative: bigint; // cumulative earned, base units
  accountId: number; // stable id, append-only registry
}

const le = (value: bigint, bytes: number) => {
  const out = new Uint8Array(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error('value does not fit');
  return out;
};

export const encodeLE = le;

export function leafHash(e: Entitlement): Uint8Array {
  if (e.cumulative <= 0n || e.cumulative >= 2n ** 63n) throw new Error('cumulative out of range');
  if (!Number.isInteger(e.accountId) || e.accountId < 0 || e.accountId >= 2 ** 31) throw new Error('accountId out of range');
  const lb = hexToBytes(e.lockingBytecode);
  return sha256(Uint8Array.from([...lb, ...le(e.cumulative, 8), ...le(BigInt(e.accountId), 4)]));
}

const ZERO = new Uint8Array(32);
const pair = (a: Uint8Array, b: Uint8Array) => sha256(Uint8Array.from([...a, ...b]));

export class MerkleTree {
  readonly levels: Uint8Array[][];
  readonly entries: Entitlement[];
  constructor(entries: Entitlement[]) {
    if (!entries.length) throw new Error('empty tree');
    this.entries = entries;
    let level = entries.map(leafHash);
    let size = 1;
    while (size < level.length) size *= 2;
    while (level.length < size) level.push(ZERO);
    this.levels = [level];
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1]));
      this.levels.push(next);
      level = next;
    }
  }
  get root(): string {
    return bytesToHex(this.levels[this.levels.length - 1][0]);
  }
  get depth(): number {
    return this.levels.length - 1;
  }
  /** Proof for the entry at `index`: concatenated siblings (hex) and path bits. */
  proof(index: number): { siblings: string; path: number; depth: number } {
    let i = index;
    const sib: Uint8Array[] = [];
    let path = 0;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const isRight = i % 2 === 1;
      if (isRight) path |= 1 << lvl;
      sib.push(this.levels[lvl][isRight ? i - 1 : i + 1]);
      i = Math.floor(i / 2);
    }
    return { siblings: bytesToHex(Uint8Array.from(sib.flatMap((s) => [...s]))), path, depth: this.depth };
  }
  indexOfAccount(accountId: number) {
    return this.entries.findIndex((e) => e.accountId === accountId);
  }
}

export function verifyProof(e: Entitlement, siblingsHex: string, path: number, rootHex: string): boolean {
  let h = leafHash(e);
  const sib = hexToBytes(siblingsHex);
  if (sib.length % 32) return false;
  for (let i = 0; i < sib.length / 32; i++) {
    const s = sib.slice(i * 32, i * 32 + 32);
    h = (path >> i) & 1 ? pair(s, h) : pair(h, s);
  }
  return bytesToHex(h) === rootHex;
}
