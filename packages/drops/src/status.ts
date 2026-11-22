import type { NetworkProvider, Utxo } from 'cashscript';
import { dropsContracts, type DropsConfig } from './contracts.js';
import { MerkleTree, verifyProof, type Entitlement } from './merkle.js';
import { decodePending, decodeShardState, hasClaimed, shardOf } from './state.js';
import { findReceipt } from './tx.js';

type S = Utxo & { lockingBytecode: string };

/**
 * Read-only pool and account status (web Claims tab, CLI `status`, integrating wallets): which
 * epoch each shard has active, which pending roots are waiting for their timelock and how many
 * blocks remain, what an address is entitled to and what its receipt NFT says it already claimed.
 */

/** A published tree file (deployments/tree-N.json) as JSON or already parsed. */
export interface TreeFileLike {
  epoch: number;
  root: string;
  window?: [string, string];
  leaves?: number;
  depth?: number;
  realMembers?: number;
  entries: { lockingBytecode: string; cumulative: string | bigint; accountId: number }[];
}

export const treeEntries = (t: TreeFileLike): Entitlement[] => t.entries.map((e) => ({ ...e, cumulative: BigInt(e.cumulative) }));

/** Height of each UTXO (by `txid:vout`) at an address; undefined when the provider cannot tell. */
export type UtxoHeights = (address: string) => Promise<Map<string, number> | undefined>;

/** Electrum (Fulcrum) heights via `blockchain.address.listunspent`; 0 / negative = unconfirmed. */
export function electrumHeights(provider: NetworkProvider): UtxoHeights {
  const p = provider as NetworkProvider & { performRequest?: (name: string, ...params: unknown[]) => Promise<unknown> };
  return async (address) => {
    if (typeof p.performRequest !== 'function') return undefined;
    try {
      const rows = (await p.performRequest('blockchain.address.listunspent', address, 'include_tokens')) as { tx_hash: string; tx_pos: number; height: number }[];
      return new Map(rows.map((r) => [`${r.tx_hash}:${r.tx_pos}`, r.height]));
    } catch {
      return undefined;
    }
  };
}

/** Blocks until a pending root of `confirmations` age can be promoted (CSV: spend height − utxo height ≥ timelock). */
export const blocksRemaining = (confirmations: number, timelock: number) => Math.max(0, timelock - confirmations);

export interface ShardStatus {
  shardIndex: number;
  epoch: number;
  root: string;
  /** Epoch of the published tree whose root this is (undefined: unknown root, or epoch 0). */
  treeEpoch?: number;
  claimedAccounts: number;
}

export interface PendingStatus {
  shardIndex: number;
  epoch: number;
  root: string;
  /** true/false when a tree-N.json for this epoch exists; undefined otherwise. */
  matchesTree?: boolean;
  confirmations?: number;
  remaining?: number;
}

export interface PoolStatus {
  tip?: number;
  rootTimelock: number;
  shards: ShardStatus[];
  pending: PendingStatus[];
  vault: { units: bigint; utxos: number };
}

const popcount = (b: Uint8Array) => [...b].reduce((n, x) => n + x.toString(2).split('1').length - 1, 0);

export async function readPoolStatus(args: {
  provider: NetworkProvider;
  config: DropsConfig;
  trees: TreeFileLike[];
  /** Chain tip; read from the provider when omitted (undefined if that fails). */
  tip?: number;
  heights?: UtxoHeights;
}): Promise<PoolStatus> {
  const { provider, config: cfg, trees } = args;
  const c = dropsContracts(cfg, provider);
  const tip = args.tip ?? (await provider.getBlockHeight().catch(() => undefined));
  const byRoot = new Map(trees.map((t) => [t.root, t.epoch]));
  const shards: ShardStatus[] = [];
  for (const s of (await provider.getUtxos(c.shard.tokenAddress)) as S[]) {
    if (s.token?.category !== cfg.receiptCategory || !s.token.nft) continue;
    try {
      const st = decodeShardState(s.token.nft.commitment);
      shards.push({ shardIndex: st.shardIndex, epoch: st.epoch, root: st.root, treeEpoch: st.epoch ? byRoot.get(st.root) : undefined, claimedAccounts: popcount(st.bitmap) });
    } catch {
      /* not a shard state */
    }
  }
  shards.sort((a, b) => a.shardIndex - b.shardIndex);
  const heights = args.heights ? await args.heights(c.pending.tokenAddress) : undefined;
  const pending: PendingStatus[] = [];
  for (const p of (await provider.getUtxos(c.pending.tokenAddress)) as S[]) {
    if (p.token?.category !== cfg.pendingCategory || !p.token.nft) continue;
    let pend;
    try {
      pend = decodePending(p.token.nft.commitment);
    } catch {
      continue;
    }
    const tree = trees.find((t) => t.epoch === pend.epoch);
    const h = heights?.get(`${p.txid}:${p.vout}`);
    const confirmations = h === undefined || tip === undefined ? undefined : h > 0 ? tip - h + 1 : 0;
    pending.push({ ...pend, matchesTree: tree ? tree.root === pend.root : undefined, confirmations, remaining: confirmations === undefined ? undefined : blocksRemaining(confirmations, cfg.rootTimelock) });
  }
  pending.sort((a, b) => a.epoch - b.epoch || a.shardIndex - b.shardIndex);
  const vaultUtxos = ((await provider.getUtxos(c.vault.tokenAddress)) as S[]).filter((u) => u.token?.category === cfg.rewardCategory);
  return { tip, rootTimelock: cfg.rootTimelock, shards, pending, vault: { units: vaultUtxos.reduce((n, u) => n + (u.token?.amount ?? 0n), 0n), utxos: vaultUtxos.length } };
}

export type AccountState = 'not-in-tree' | 'not-active' | 'claimable' | 'already-claimed' | 'receipt-missing';

export interface AccountStatus {
  state: AccountState;
  message: string;
  accountId?: number;
  shardIndex?: number;
  /** Epoch active on chain for this account's shard (0 = nothing promoted yet). */
  activeEpoch: number;
  /** Cumulative entitlement in the active tree (what the covenant will accept now). */
  cumulative?: bigint;
  /** Cumulative entitlement in the newest published tree (may be pending). */
  latestCumulative?: bigint;
  latestEpoch?: number;
  firstClaimDone: boolean;
  receipt?: { claimedTotal: bigint; txid: string; vout: number };
  claimable: bigint;
  /** The tree to claim with (its root is the active root of the account's shard). */
  activeTree?: TreeFileLike;
}

/** What `lockingBytecode` can claim right now, and why (or why not). */
export async function readAccountStatus(args: {
  provider: NetworkProvider;
  config: DropsConfig;
  trees: TreeFileLike[];
  pool: PoolStatus;
  wallet: { lockingBytecode: string; tokenAddress: string };
}): Promise<AccountStatus> {
  const { trees, pool, wallet } = args;
  const sorted = [...trees].sort((a, b) => a.epoch - b.epoch);
  const latest = [...sorted].reverse().find((t) => t.entries.some((e) => e.lockingBytecode === wallet.lockingBytecode));
  const latestEntry = latest?.entries.find((e) => e.lockingBytecode === wallet.lockingBytecode);
  if (!latest || !latestEntry) return { state: 'not-in-tree', message: 'This address is not in any published tree.', activeEpoch: 0, firstClaimDone: false, claimable: 0n };
  const accountId = latestEntry.accountId;
  const shardIndex = shardOf(accountId);
  const shard = pool.shards.find((s) => s.shardIndex === shardIndex);
  const activeEpoch = shard?.epoch ?? 0;
  const activeTree = shard && shard.epoch ? sorted.find((t) => t.root === shard.root) : undefined;
  const activeEntry = activeTree?.entries.find((e) => e.accountId === accountId);
  const cumulative = activeEntry ? BigInt(activeEntry.cumulative) : undefined;
  const c = dropsContracts(args.config, args.provider);
  const shardUtxo = ((await args.provider.getUtxos(c.shard.tokenAddress)) as S[]).find((u) => {
    try {
      return u.token?.category === args.config.receiptCategory && u.token.nft && decodeShardState(u.token.nft.commitment).shardIndex === shardIndex;
    } catch {
      return false;
    }
  });
  const firstClaimDone = shardUtxo ? hasClaimed(decodeShardState(shardUtxo.token!.nft!.commitment), accountId) : false;
  const r = findReceipt((await args.provider.getUtxos(wallet.tokenAddress)) as S[], args.config.receiptCategory, accountId);
  const receipt = r ? { claimedTotal: r.claimedTotal, txid: r.utxo.txid, vout: r.utxo.vout } : undefined;
  const base = { accountId, shardIndex, activeEpoch, cumulative, latestCumulative: BigInt(latestEntry.cumulative), latestEpoch: latest.epoch, firstClaimDone, receipt, activeTree };
  if (!shard) return { ...base, state: 'not-active', message: `Shard ${shardIndex} for account #${accountId} is not deployed.`, claimable: 0n };
  if (!activeTree || cumulative === undefined) {
    const waiting = pool.pending.find((p) => p.shardIndex === shardIndex && p.epoch > activeEpoch);
    const wait = waiting ? ` Epoch ${waiting.epoch} is pending${waiting.remaining !== undefined ? `: promotable in ${waiting.remaining} block(s)` : ''}.` : '';
    return { ...base, state: 'not-active', message: `No promoted root for this account yet (shard ${shardIndex} is at epoch ${activeEpoch}).${wait}`, claimable: 0n };
  }
  const claimed = receipt?.claimedTotal ?? 0n;
  if (firstClaimDone && !receipt) {
    return { ...base, state: 'receipt-missing', message: `Account #${accountId} already claimed once, but its receipt NFT is not at ${wallet.tokenAddress}.`, claimable: 0n };
  }
  const claimable = cumulative - claimed > 0n ? cumulative - claimed : 0n;
  if (claimable === 0n) {
    const next = sorted.find((t) => t.epoch > activeEpoch);
    return {
      ...base,
      state: 'already-claimed',
      message: `Already claimed: the receipt NFT shows ${claimed} of ${cumulative} units for epoch ${activeEpoch}. Nothing more until ${next ? `epoch ${next.epoch} is promoted` : 'the next epoch'}.`,
      claimable: 0n,
    };
  }
  return { ...base, state: 'claimable', message: `Claimable now: ${claimable} units (cumulative ${cumulative} − already claimed ${claimed}).`, claimable };
}

/** Proof JSON in the same shape as `tsx src/cli.ts proof --address …` (for other clients). */
export function proofFor(tree: TreeFileLike, lockingBytecode: string) {
  const entries = treeEntries(tree);
  const i = entries.findIndex((e) => e.lockingBytecode === lockingBytecode);
  if (i < 0) return undefined;
  const t = new MerkleTree(entries);
  const p = t.proof(i);
  return { epoch: tree.epoch, root: t.root, leaf: entries[i], proof: p.siblings, path: p.path, depth: p.depth, verifies: verifyProof(entries[i], p.siblings, p.path, tree.root) && t.root === tree.root };
}
