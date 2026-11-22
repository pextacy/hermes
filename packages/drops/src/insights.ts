import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { DEFAULT_SIZES } from './cost.js';
import { MerkleTree, leafHash } from './merkle.js';
import { proofFor, treeEntries, type TreeFileLike } from './status.js';

/**
 * Read-only views over the published trees (Claims tab, Round 3 G22–G27). Pure functions: no
 * network, no keys. Amounts stay bigint so nothing is rounded.
 */

const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

/** G22: downloadable proof file for `lockingBytecode` in its newest tree (or `epoch`). */
export function proofDownload(trees: TreeFileLike[], lockingBytecode: string, epoch?: number) {
  const sorted = [...trees].sort((a, b) => b.epoch - a.epoch);
  const tree = epoch !== undefined ? sorted.find((t) => t.epoch === epoch) : sorted.find((t) => t.entries.some((e) => e.lockingBytecode === lockingBytecode));
  if (!tree) return undefined;
  const p = proofFor(tree, lockingBytecode);
  if (!p) return undefined;
  const body = { format: 'hermes-drops-proof/1', leafFormat: 'SHA256(lockingBytecode || cumulative u64 LE || accountId u32 LE)', ...p, publishedRoot: tree.root };
  return { filename: `hermes-drops-proof-epoch${tree.epoch}-account${p.leaf.accountId}.json`, json: toJson(body), proof: p };
}

export interface HistoryPoint {
  epoch: number;
  window?: [string, string];
  cumulative: bigint; // 0 when not a member
  earned: bigint; // this epoch only (cumulative − previous cumulative)
  member: boolean;
}

/** G23: per-epoch entitlement of one address across all published trees (ascending epoch). */
export function entitlementHistory(trees: TreeFileLike[], lockingBytecode: string): HistoryPoint[] {
  let prev = 0n;
  return [...trees]
    .sort((a, b) => a.epoch - b.epoch)
    .map((t) => {
      const e = t.entries.find((x) => x.lockingBytecode === lockingBytecode);
      const cumulative = e ? BigInt(e.cumulative) : prev; // cumulative never decreases; absent ⇒ unchanged
      const earned = cumulative - prev;
      prev = cumulative;
      return { epoch: t.epoch, window: t.window, cumulative, earned, member: !!e };
    });
}

export interface LeaderRow {
  rank: number;
  accountId: number;
  lockingBytecode: string;
  cumulative: bigint;
  /** Share of the tree's total, in basis points (1/100 %). */
  shareBps: number;
}

/** G24: top `n` cumulative earners of `tree` (ties broken by accountId). */
export function leaderboard(tree: TreeFileLike, n = 10): { rows: LeaderRow[]; total: bigint; members: number } {
  const entries = treeEntries(tree);
  const total = entries.reduce((s, e) => s + e.cumulative, 0n);
  const rows = [...entries]
    .sort((a, b) => (b.cumulative > a.cumulative ? 1 : b.cumulative < a.cumulative ? -1 : a.accountId - b.accountId))
    .slice(0, n)
    .map((e, i) => ({ rank: i + 1, accountId: e.accountId, lockingBytecode: e.lockingBytecode, cumulative: e.cumulative, shareBps: total ? Number((e.cumulative * 10000n) / total) : 0 }));
  return { rows, total, members: entries.length };
}

export interface AuditRow {
  epoch: number;
  storedRoot: string;
  recomputedRoot: string;
  leaves: number;
  depth: number;
  /** Recomputed root equals the root written in tree-N.json. */
  fileOk: boolean;
  /** Stored leaf count / depth match the entries. */
  shapeOk: boolean;
  /** On-chain root for this epoch (active or pending), when known. */
  chainRoots: string[];
  /** undefined: nothing on chain for this epoch; true: every on-chain root matches. */
  chainOk?: boolean;
}

/**
 * G25: recompute every tree's root from its entries; compare with the stored root and with the
 * roots found on chain (`chain`: epoch → roots from shards' active state and pending NFTs).
 */
export function auditTrees(trees: TreeFileLike[], chain?: Map<number, string[]>): AuditRow[] {
  return [...trees]
    .sort((a, b) => a.epoch - b.epoch)
    .map((t) => {
      const mt = new MerkleTree(treeEntries(t));
      const chainRoots = chain?.get(t.epoch) ?? [];
      return {
        epoch: t.epoch,
        storedRoot: t.root,
        recomputedRoot: mt.root,
        leaves: mt.entries.length,
        depth: mt.depth,
        fileOk: mt.root === t.root,
        shapeOk: (t.leaves === undefined || t.leaves === mt.entries.length) && (t.depth === undefined || t.depth === mt.depth),
        chainRoots,
        chainOk: chainRoots.length ? chainRoots.every((r) => r === mt.root) : undefined,
      };
    });
}

/** epoch → roots seen on chain, from a PoolStatus-like object (shards' active roots + pending roots). */
export function chainRootsByEpoch(pool: { shards: { epoch: number; root: string }[]; pending: { epoch: number; root: string }[] }) {
  const m = new Map<number, string[]>();
  for (const r of [...pool.shards, ...pool.pending]) {
    if (!r.epoch) continue;
    const list = m.get(r.epoch) ?? [];
    if (!list.includes(r.root)) list.push(r.root);
    m.set(r.epoch, list);
  }
  return m;
}

export interface PathStep {
  level: number;
  /** Hash entering this level (the leaf at level 0). */
  node: string;
  sibling: string;
  /** Is `node` the right child (path bit = 1)? */
  isRight: boolean;
  /** Sibling is zero padding (tree padded to a power of two). */
  siblingIsPadding: boolean;
  /** SHA256(left || right) → the node at level + 1. */
  parent: string;
}

/** G26: every hash on the way from the leaf to the root, as the covenant recomputes it. */
export function proofPath(tree: TreeFileLike, lockingBytecode: string): { leafIndex: number; leaf: string; steps: PathStep[]; root: string; ok: boolean } | undefined {
  const entries = treeEntries(tree);
  const idx = entries.findIndex((e) => e.lockingBytecode === lockingBytecode);
  if (idx < 0) return undefined;
  const p = new MerkleTree(entries).proof(idx);
  const sib = hexToBytes(p.siblings);
  let h = leafHash(entries[idx]);
  const leaf = bytesToHex(h);
  const steps: PathStep[] = [];
  for (let i = 0; i < p.depth; i++) {
    const s = sib.slice(i * 32, i * 32 + 32);
    const isRight = ((p.path >> i) & 1) === 1;
    const parent = sha256(Uint8Array.from(isRight ? [...s, ...h] : [...h, ...s]));
    steps.push({ level: i, node: bytesToHex(h), sibling: bytesToHex(s), isRight, siblingIsPadding: s.every((b) => b === 0), parent: bytesToHex(parent) });
    h = parent;
  }
  return { leafIndex: idx, leaf, steps, root: bytesToHex(h), ok: bytesToHex(h) === tree.root };
}

/** Claim transaction size at proof depth `d`: measured 1,782 B at d = 9; each level adds one 32-byte sibling. */
export const CLAIM_BYTES_PER_LEVEL = 32;
export const claimBytesAtDepth = (depth: number) => DEFAULT_SIZES.claimBytes + (depth - 9) * CLAIM_BYTES_PER_LEVEL;

export interface ClaimCostInputs {
  claims: number; // how many claim transactions
  feeRate: number; // sats/byte
  depth: number; // proof depth of the tree
  tokenDust?: number; // sats per token output (default 1000)
  firstClaims?: number; // how many of them are first claims (no old receipt to recover); default 1
}

/**
 * G27: what the claimer pays. Uses the drops cost model's measured claim size, scaled by depth.
 * A first claim locks dust in the new receipt and the payout output; later claims recover the old
 * receipt's dust, so they cost one dust less (same as `costModel().pull.userSatsPerClaim`).
 */
export function claimCost(i: ClaimCostInputs) {
  if (!(i.claims >= 0) || !(i.feeRate >= 0) || !(i.depth >= 0)) throw new Error('claims, fee rate and depth must be ≥ 0');
  const dust = i.tokenDust ?? 1000;
  const claims = Math.floor(i.claims);
  const first = Math.min(claims, Math.max(0, Math.floor(i.firstClaims ?? 1)));
  const bytesPerClaim = claimBytesAtDepth(i.depth);
  const feePerClaim = Math.ceil(bytesPerClaim * i.feeRate);
  const firstClaimSats = feePerClaim + 2 * dust;
  const laterClaimSats = feePerClaim + dust;
  const totalBytes = claims * bytesPerClaim;
  const feeSats = claims * feePerClaim;
  const dustSats = first * 2 * dust + (claims - first) * dust;
  return { bytesPerClaim, feePerClaim, firstClaimSats, laterClaimSats, totalBytes, feeSats, dustSats, totalSats: feeSats + dustSats };
}

/** G28 helper: a root that cannot match any tree (one bit flipped), for the sandbox veto drill. */
export const tamperRoot = (root: string) => (parseInt(root[0], 16) ^ 1).toString(16) + root.slice(1);
