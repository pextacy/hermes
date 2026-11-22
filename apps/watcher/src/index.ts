/**
 * Hermes Drops watcher: independently recomputes each epoch's Merkle root from the public
 * FoldingCash distribution (derived from the Folding@home stats) and audits every pending
 * root on chain during its timelock window. A mismatch is reported loudly so the authority
 * (or the community) can veto it before it becomes claimable.
 *
 *   pnpm --filter watcher dev -- --network chipnet [--interval 600]
 *   pnpm --filter watcher once -- --network chipnet
 *   pnpm --filter watcher dev -- --source fah            recompute from archived Folding@home snapshots
 *   pnpm --filter watcher snapshot                       archive today's F@H summary (BCH-address rows only)
 *   … --alerts nostr                                     also publish alerts as Nostr notes (#hermesdrops)
 *   … --alerts nostr --alert-identity                    sign them with a stable nsec typed at runtime (else a per-process key)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSecretKey } from 'nostr-tools/pure';
import { publishAlert } from './alerts.js';
import * as nip19 from 'nostr-tools/nip19';
import type { NetworkProvider, Utxo } from 'cashscript';
import { getProvider, type BchNetwork } from '@hermes/chain';
import {
  AccountRegistry,
  MerkleTree,
  accumulate,
  decodePending,
  decodeShardState,
  dropsContracts,
  fetchFoldingCashDistro,
  padWithSample,
  includeAddresses,
  distroFromFahSnapshots,
  fetchFahSummary,
  addressFromFahName,
  type Deployment,
  type DistroUser,
  type FahRow,
} from '@hermes/drops';
import { NETWORKS } from '@hermes/chain';
import type { Entitlement } from '@hermes/drops';

type S = Utxo & { lockingBytecode: string };

export const DEFAULT_DEPLOYMENTS_DIR = new URL('../../../packages/drops/deployments/', import.meta.url);
export const DEFAULT_DATA_DIR = new URL('../data/', import.meta.url);

export interface TreeFile {
  epoch: number;
  window: [string, string];
  leaves: number;
  root: string;
  entries: Entitlement[];
  /** Written by `tree` since the --include fix; `include` = demo addresses the publisher added (documented, re-applied here). */
  params?: { decimals?: number; monthly?: number; leaves?: number; include?: string[]; includeAmount?: string };
}

export type DistroFor = (start: Date, end: Date, monthly: number) => Promise<DistroUser[]>;

/** `--name value` lookup (same rules as before: the token after the flag, or the default). */
export const optFrom = (args: string[]) => (n: string, d?: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);

export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Archive today's F@H summary, keeping only rows whose user name carries a BCH address. */
export async function snapshot(opts: { dataDir?: URL; fetchSummary?: () => Promise<FahRow[]>; now?: Date; log?: (s: string) => void } = {}) {
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const rows = (await (opts.fetchSummary ?? fetchFahSummary)()).filter((r) => addressFromFahName(r.name));
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const f = new URL(`fah-${day(opts.now ?? new Date())}.json`, dataDir);
  writeFileSync(f, JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  (opts.log ?? console.log)(`archived ${rows.length} BCH-address rows → ${f.pathname}`);
  return { file: f, rows: rows.length };
}

export function loadSnapshot(d: Date, dataDir: URL = DEFAULT_DATA_DIR): FahRow[] | undefined {
  const f = new URL(`fah-${day(d)}.json`, dataDir);
  if (!existsSync(f)) return undefined;
  return (JSON.parse(readFileSync(f, 'utf8')) as (Omit<FahRow, 'credit' | 'workUnits'> & { credit: string; workUnits: string })[]).map((r) => ({ ...r, credit: BigInt(r.credit), workUnits: BigInt(r.workUnits) }));
}

/** Distribution source: archived F@H snapshots (`--source fah`, falls back to the API) or the FoldingCash API. */
export function makeDistroFor(opts: { source?: string; team?: number; dataDir?: URL; fetchDistro?: DistroFor; warn?: (s: string) => void } = {}): DistroFor {
  const fetchDistro = opts.fetchDistro ?? fetchFoldingCashDistro;
  return async (start, end, monthly) => {
    if (opts.source === 'fah') {
      const a = loadSnapshot(start, opts.dataDir);
      const b = loadSnapshot(end, opts.dataDir);
      if (a && b) return distroFromFahSnapshots(a, b, monthly, opts.team);
      (opts.warn ?? console.warn)(`no F@H snapshots for ${day(start)} and ${day(end)}; falling back to the FoldingCash API`);
    }
    return fetchDistro(start, end, monthly);
  };
}

/** Alert sink: always stderr; with `mode: 'nostr'` also a public note signed by a per-process key. */
export function makeAlerter(opts: {
  network: string;
  mode?: string;
  relays?: string[];
  publish?: typeof publishAlert;
  error?: (s: string) => void;
  /** Stable alert identity (nsec typed at runtime); a fresh per-process key otherwise. */
  secretKey?: Uint8Array;
}) {
  const error = opts.error ?? console.error;
  const publish = opts.publish ?? publishAlert;
  let alertKey: Uint8Array | undefined = opts.secretKey;
  return async (message: string) => {
    error(`ALERT ${message}`);
    if (opts.mode !== 'nostr') return;
    alertKey ??= generateSecretKey();
    const relays = opts.relays ?? NETWORKS.nostr.relays;
    const r = await publish(message, { relays, secretKey: alertKey, network: opts.network });
    error(`alert published by ${nip19.npubEncode(r.pubkey)} to ${r.accepted}/${relays.length} relays`);
  };
}

/** Recompute every epoch from scratch with the same rules the publisher used. */
export async function recomputeRoots(trees: TreeFile[], decimals: number, monthly: number, leaves: number, distroFor: DistroFor) {
  const registry = new AccountRegistry();
  let cumulative = new Map<string, bigint>();
  const roots = new Map<number, string>();
  for (const t of [...trees].sort((a, b) => a.epoch - b.epoch)) {
    const distro = await distroFor(new Date(t.window[0]), new Date(t.window[1]), monthly);
    const r = accumulate(cumulative, distro, decimals, registry);
    cumulative = r.cumulative;
    // Same order as the publisher: real members, then --include demo addresses, then the sample padding.
    const include = t.params?.include ?? [];
    const withDemo = include.length ? includeAddresses(r.entries, include, BigInt(t.params?.includeAmount ?? '100000') * BigInt(t.epoch), registry) : r.entries;
    roots.set(t.epoch, new MerkleTree(padWithSample(withDemo, leaves, registry)).root);
  }
  return roots;
}

/** tree-1.json, tree-2.json, … until the first gap. */
export function loadTrees(dir: URL): TreeFile[] {
  const trees: TreeFile[] = [];
  for (let e = 1; existsSync(new URL(`tree-${e}.json`, dir)); e++) trees.push(JSON.parse(readFileSync(new URL(`tree-${e}.json`, dir), 'utf8')));
  return trees;
}

export function loadDeployment(network: string, dir: URL): Deployment {
  const depFile = new URL(`${network}.json`, dir);
  if (!existsSync(depFile)) throw new Error(`No deployment for ${network} (run the drops deploy first)`);
  return JSON.parse(readFileSync(depFile, 'utf8'));
}

/** Compare on-chain pending and active shard roots against the recomputed roots. Returns the number of problems. */
export async function auditChain(args: {
  deployment: Deployment;
  expected: Map<number, string>;
  provider: NetworkProvider;
  alert: (m: string) => Promise<void>;
  log?: (s: string) => void;
}) {
  const { deployment: d, expected, provider, alert } = args;
  const log = args.log ?? console.log;
  const c = dropsContracts(d.config, provider);
  let problems = 0;
  for (const p of (await provider.getUtxos(c.pending.tokenAddress)) as S[]) {
    if (p.token?.category !== d.config.pendingCategory || !p.token.nft) continue;
    const pend = decodePending(p.token.nft.commitment);
    const want = expected.get(pend.epoch);
    if (!want) {
      problems++;
      await alert(`pending root for unknown epoch ${pend.epoch} on shard ${pend.shardIndex}: ${pend.root}`);
    } else if (want !== pend.root) {
      problems++;
      await alert(`shard ${pend.shardIndex} epoch ${pend.epoch}: pending root ${pend.root} ≠ recomputed ${want} — veto before it matures (${d.config.rootTimelock} blocks)`);
    } else {
      log(`ok   shard ${pend.shardIndex} epoch ${pend.epoch} pending root matches`);
    }
  }
  for (const s of (await provider.getUtxos(c.shard.tokenAddress)) as S[]) {
    if (s.token?.category !== d.config.receiptCategory || !s.token.nft) continue;
    const st = decodeShardState(s.token.nft.commitment);
    if (st.epoch === 0) continue;
    const want = expected.get(st.epoch);
    if (!want) {
      problems++;
      await alert(`shard ${st.shardIndex} ACTIVE root for unknown epoch ${st.epoch} cannot be verified: ${st.root}`);
    } else if (want !== st.root) {
      problems++;
      await alert(`shard ${st.shardIndex} ACTIVE root for epoch ${st.epoch} does not match recomputation`);
    } else log(`ok   shard ${st.shardIndex} active epoch ${st.epoch}`);
  }
  return problems;
}

export interface AuditOptions {
  network: BchNetwork;
  deploymentsDir?: URL;
  decimals?: number;
  monthly?: number;
  leaves?: number;
  distroFor?: DistroFor;
  provider?: NetworkProvider;
  alert?: (m: string) => Promise<void>;
  log?: (s: string) => void;
}

/** One full audit pass: load the deployment and trees, recompute, compare with the chain. */
export async function audit(o: AuditOptions) {
  const dir = o.deploymentsDir ?? DEFAULT_DEPLOYMENTS_DIR;
  const deployment = loadDeployment(o.network, dir);
  const expected = await recomputeRoots(loadTrees(dir), o.decimals ?? 8, o.monthly ?? 1_000_000, o.leaves ?? 400, o.distroFor ?? makeDistroFor());
  return auditChain({ deployment, expected, provider: o.provider ?? getProvider(o.network), alert: o.alert ?? makeAlerter({ network: o.network }), log: o.log });
}

export interface MainDeps {
  audit?: typeof audit;
  snapshot?: typeof snapshot;
  log?: (s: string) => void;
  error?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  promptSecret?: (q: string) => Promise<string>;
}

/** nsec1… or 64-hex Nostr secret key → bytes. */
export function parseNostrSecret(s: string): Uint8Array {
  const t = s.trim();
  if (/^[0-9a-f]{64}$/i.test(t)) return Uint8Array.from(t.match(/../g)!.map((h) => parseInt(h, 16)));
  const d = nip19.decode(t);
  if (d.type !== 'nsec') throw new Error('expected an nsec1… or 64-hex Nostr secret key');
  return d.data;
}

/**
 * CLI entry. `snapshot` and `--once` return an exit code (0 ok, 2 problems found, 1 audit failed);
 * otherwise loops forever, auditing every `--interval` seconds.
 */
export async function main(args: string[], deps: MainDeps = {}): Promise<number> {
  const opt = optFrom(args);
  const network = opt('network', 'chipnet') as BchNetwork;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const now = deps.now ?? (() => new Date());
  if (args[0] === 'snapshot') {
    await (deps.snapshot ?? snapshot)({ log });
    return 0;
  }
  const once = args.includes('--once');
  const interval = Number(opt('interval', '600')) * 1000;
  const runAudit = deps.audit ?? audit;
  const options: AuditOptions = {
    network,
    decimals: Number(opt('decimals', '8')),
    monthly: Number(opt('amount', '1000000')),
    leaves: Number(opt('leaves', '400')),
    distroFor: makeDistroFor({ source: opt('source'), team: opt('team') ? Number(opt('team')) : undefined }),
    alert: makeAlerter({
      network,
      mode: opt('alerts'),
      relays: opt('relays')?.split(','),
      error,
      secretKey: opt('alerts') === 'nostr' && args.includes('--alert-identity') ? parseNostrSecret(await (deps.promptSecret ?? (await import('@hermes/chain/prompt')).promptSecret)('Watcher alert nsec (not stored): ')) : undefined,
    }),
  };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  do {
    try {
      const n = await runAudit(options);
      log(`${now().toISOString()} audit done, ${n} problem(s)`);
      if (once) return n ? 2 : 0;
    } catch (e) {
      error(`${now().toISOString()} audit failed: ${(e as Error).message}`);
      if (once) return 1;
    }
    await sleep(interval);
  } while (true);
}

/** True when this module is the process entry point (tsx src/index.ts …), not an import. */
export function isEntry(moduleUrl: string, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url)) process.exit(await main(process.argv.slice(2)));
