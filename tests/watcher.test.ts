/**
 * Drops watcher: root recomputation, F@H snapshot source, pending/active root audit against a
 * MockNetworkProvider (real covenants, BCH 2026 VM), alert sinks and the CLI loop. No network.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MockNetworkProvider, randomUtxo, type Utxo } from 'cashscript';
import { generatePrivateKey } from '@bitauth/libauth';
import * as nip19 from 'nostr-tools/nip19';
import { walletFromPrivateKey, type KeyWallet } from '@hermes/chain';
import {
  AccountRegistry,
  MerkleTree,
  accumulate,
  buildPromote,
  buildPublish,
  decodeShardState,
  deployDrops,
  dropsContracts,
  padWithSample,
  type Deployment,
  type DistroUser,
  type FahRow,
} from '@hermes/drops';
import {
  audit,
  auditChain,
  day,
  isEntry,
  loadDeployment,
  loadSnapshot,
  loadTrees,
  main,
  makeAlerter,
  makeDistroFor,
  optFrom,
  recomputeRoots,
  snapshot,
  type AuditOptions,
  type TreeFile,
} from '../apps/watcher/src/index';

type S = Utxo & { lockingBytecode: string };
const tmpDir = () => pathToFileURL(mkdtempSync(join(tmpdir(), 'hermes-watcher-')) + '/');
const ADDR_A = 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';
const LEGACY = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

const tree = (epoch: number, from: string, to: string): TreeFile => ({ epoch, window: [from, to], leaves: 0, root: '', entries: [] });
const T1 = tree(1, '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
const T2 = tree(2, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');

/** Epoch 1 pays A 10 tokens; epoch 2 pays A 5 and LEGACY 2 (by window start month). */
const distro = async (start: Date): Promise<DistroUser[]> =>
  start.getUTCMonth() === 8 ? [{ amount: 10, bitcoinCashAddress: ADDR_A }] : [{ amount: 5, bitcoinCashAddress: ADDR_A }, { amount: 2, bitcoinAddress: LEGACY }];

/** Independent reference computation of the publisher's roots. */
function referenceRoots(leaves: number) {
  const reg = new AccountRegistry();
  const r1 = accumulate(new Map(), [{ amount: 10, bitcoinCashAddress: ADDR_A }], 8, reg);
  const root1 = new MerkleTree(padWithSample(r1.entries, leaves, reg)).root;
  const r2 = accumulate(r1.cumulative, [{ amount: 5, bitcoinCashAddress: ADDR_A }, { amount: 2, bitcoinAddress: LEGACY }], 8, reg);
  const root2 = new MerkleTree(padWithSample(r2.entries, leaves, reg)).root;
  return { root1, root2 };
}

afterEach(() => vi.restoreAllMocks());

describe('watcher helpers', () => {
  it('optFrom / day', () => {
    const opt = optFrom(['--once', '--network', 'mock']);
    expect(opt('network', 'chipnet')).toBe('mock');
    expect(opt('interval', '600')).toBe('600');
    expect(day(new Date('2026-11-21T23:59:59Z'))).toBe('2026-11-21');
  });

  it('isEntry matches only the executed script', () => {
    const here = fileURLToPath(import.meta.url);
    expect(isEntry(import.meta.url, here)).toBe(true);
    expect(isEntry(import.meta.url, '/nope/index.ts')).toBe(false);
    expect(isEntry(import.meta.url, '')).toBe(false);
  });
});

describe('recomputeRoots', () => {
  it('reproduces the publisher roots cumulatively, in epoch order regardless of file order, without mutating input', async () => {
    const calls: string[] = [];
    const distroFor = vi.fn(async (start: Date, end: Date, monthly: number) => {
      calls.push(`${day(start)}..${day(end)}@${monthly}`);
      return distro(start);
    });
    const trees = [T2, T1];
    const roots = await recomputeRoots(trees, 8, 500, 16, distroFor);
    expect(trees.map((t) => t.epoch)).toEqual([2, 1]);
    expect(calls).toEqual(['2026-09-01..2026-10-01@500', '2026-10-01..2026-11-01@500']);
    const ref = referenceRoots(16);
    expect(roots.get(1)).toBe(ref.root1);
    expect(roots.get(2)).toBe(ref.root2);
    expect(ref.root1).not.toBe(ref.root2);
    // Different leaf count → different (padded) root.
    expect((await recomputeRoots([T1], 8, 500, 17, distroFor)).get(1)).not.toBe(ref.root1);
  });

  it('propagates distribution source failures', async () => {
    await expect(recomputeRoots([T1], 8, 1, 4, async () => Promise.reject(new Error('FoldingCash API 503')))).rejects.toThrow('FoldingCash API 503');
  });
});

describe('F@H snapshots as an independent source', () => {
  const rows = (credit: bigint, creditB: bigint): FahRow[] => [
    { name: `alice_${ADDR_A}`, credit, workUnits: 10n, team: 1 },
    { name: `bob_${LEGACY}`, credit: creditB, workUnits: 4n, team: 2 },
    { name: 'no-address-here', credit: 999n, workUnits: 1n, team: 1 },
  ];

  it('snapshot archives only BCH-address rows; loadSnapshot restores bigints', async () => {
    const dataDir = new URL('nested/data/', tmpDir()); // created on demand
    const log = vi.fn();
    const r = await snapshot({ dataDir, fetchSummary: async () => rows(100n, 50n), now: new Date('2026-09-01T12:00:00Z'), log });
    expect(r.rows).toBe(2);
    expect(r.file.href).toBe(new URL('fah-2026-09-01.json', dataDir).href);
    expect(JSON.parse(readFileSync(r.file, 'utf8'))[0].credit).toBe('100');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('archived 2 BCH-address rows'));
    expect(loadSnapshot(new Date('2026-09-01T00:00:00Z'), dataDir)).toEqual(rows(100n, 50n).slice(0, 2));
    expect(loadSnapshot(new Date('2026-09-02T00:00:00Z'), dataDir)).toBeUndefined();
  });

  it('makeDistroFor(fah) uses the credit gained between snapshots (team filter), else warns and falls back', async () => {
    const dataDir = tmpDir();
    writeFileSync(new URL('fah-2026-09-01.json', dataDir), JSON.stringify(rows(100n, 50n), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    writeFileSync(new URL('fah-2026-10-01.json', dataDir), JSON.stringify(rows(400n, 150n), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    const fetchDistro = vi.fn(async () => [{ amount: 1, bitcoinAddress: LEGACY }] as DistroUser[]);
    const warn = vi.fn();
    const start = new Date('2026-09-01T00:00:00Z');
    const end = new Date('2026-10-01T00:00:00Z');

    const all = await makeDistroFor({ source: 'fah', dataDir, fetchDistro, warn })(start, end, 400);
    expect(all).toEqual([
      expect.objectContaining({ bitcoinCashAddress: ADDR_A, amount: 300, pointsGained: 300 }),
      expect.objectContaining({ bitcoinAddress: LEGACY, amount: 100, pointsGained: 100 }),
    ]);
    const team2 = await makeDistroFor({ source: 'fah', team: 2, dataDir, fetchDistro, warn })(start, end, 400);
    expect(team2).toEqual([expect.objectContaining({ bitcoinAddress: LEGACY, amount: 400 })]);
    expect(fetchDistro).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    const missing = await makeDistroFor({ source: 'fah', dataDir, fetchDistro, warn })(start, new Date('2026-11-01T00:00:00Z'), 7);
    expect(missing).toEqual([{ amount: 1, bitcoinAddress: LEGACY }]);
    expect(warn).toHaveBeenCalledWith('no F@H snapshots for 2026-09-01 and 2026-11-01; falling back to the FoldingCash API');
    expect(fetchDistro).toHaveBeenCalledWith(start, new Date('2026-11-01T00:00:00Z'), 7);

    // Default source: straight to the API, no snapshot lookup.
    fetchDistro.mockClear();
    await makeDistroFor({ dataDir, fetchDistro, warn })(start, end, 3);
    expect(fetchDistro).toHaveBeenCalledTimes(1);
  });
});

describe('deployment files', () => {
  it('loadTrees stops at the first gap; loadDeployment errors when missing', () => {
    const dir = tmpDir();
    expect(loadTrees(dir)).toEqual([]);
    for (const t of [T1, T2, tree(4, '', '')]) writeFileSync(new URL(`tree-${t.epoch}.json`, dir), JSON.stringify(t));
    expect(loadTrees(dir).map((t) => t.epoch)).toEqual([1, 2]);
    expect(() => loadDeployment('chipnet', dir)).toThrow('No deployment for chipnet (run the drops deploy first)');
    writeFileSync(new URL('chipnet.json', dir), JSON.stringify({ network: 'chipnet' }));
    expect(loadDeployment('chipnet', dir)).toEqual({ network: 'chipnet' });
  });
});

describe('makeAlerter', () => {
  it('stderr only by default', async () => {
    const error = vi.fn();
    const publish = vi.fn();
    await makeAlerter({ network: 'chipnet', error, publish })('boom');
    expect(error).toHaveBeenCalledWith('ALERT boom');
    expect(publish).not.toHaveBeenCalled();
  });

  it('nostr mode publishes with one stable per-process key and reports acceptance', async () => {
    const error = vi.fn();
    const publish = vi.fn(async (_m: string, o: { secretKey?: Uint8Array; relays: string[] }) => ({ event: {} as never, pubkey: 'ab'.repeat(32), accepted: o.relays.length - 1 }));
    const alert = makeAlerter({ network: 'chipnet', mode: 'nostr', relays: ['ws://a', 'ws://b'], error, publish });
    await alert('one');
    await alert('two');
    expect(publish).toHaveBeenCalledTimes(2);
    const [c1, c2] = publish.mock.calls;
    expect(c1[0]).toBe('one');
    expect(c1[1]).toMatchObject({ relays: ['ws://a', 'ws://b'], network: 'chipnet' });
    expect(c1[1].secretKey).toBeInstanceOf(Uint8Array);
    expect(c2[1].secretKey).toBe(c1[1].secretKey);
    expect(error).toHaveBeenCalledWith(`alert published by ${nip19.npubEncode('ab'.repeat(32))} to 1/2 relays`);
  });

  it('nostr mode without relays uses the configured public relays', async () => {
    const publish = vi.fn(async (_m: string, o: { relays: string[] }) => ({ event: {} as never, pubkey: 'cd'.repeat(32), accepted: o.relays.length }));
    await makeAlerter({ network: 'chipnet', mode: 'nostr', error: () => undefined, publish })('x');
    expect(publish.mock.calls[0][1].relays.length).toBeGreaterThan(0);
    expect(publish.mock.calls[0][1].relays.every((r: string) => r.startsWith('ws'))).toBe(true);
  });
});

describe('auditChain / audit on a mock chain', () => {
  let provider: MockNetworkProvider;
  let w: KeyWallet;
  let d: Deployment;
  const LEAVES = 16;
  const ref = referenceRoots(LEAVES);
  const BAD = 'ee'.repeat(32);

  const c = () => dropsContracts(d.config, provider);
  const authUtxos = async () => [...(await provider.getUtxos(w.address)), ...(await provider.getUtxos(w.tokenAddress))] as S[];
  const publish = async (epoch: number, root: string) =>
    buildPublish({ provider, contracts: c(), authority: w.signer, authorityAddress: w.address, authorityTokenAddress: w.tokenAddress, authorityUtxos: await authUtxos(), pendingCategory: d.config.pendingCategory, epoch, root, shards: d.shards }).send();
  const promoteAll = async () => {
    for (const p of (await provider.getUtxos(c().pending.tokenAddress)) as S[]) {
      if (p.token?.category !== d.config.pendingCategory) continue;
      const shards = ((await provider.getUtxos(c().shard.tokenAddress)) as S[]).filter((s) => s.token?.category === d.config.receiptCategory);
      const idx = Number.parseInt(p.token.nft!.commitment.slice(0, 2), 16);
      const shard = shards.find((s) => decodeShardState(s.token!.nft!.commitment).shardIndex === idx)!;
      await buildPromote({ provider, contracts: c(), receiptCategory: d.config.receiptCategory, shardUtxo: shard, pendingUtxo: p, rootTimelock: d.config.rootTimelock, funder: { address: w.address, utxos: ((await provider.getUtxos(w.address)) as S[]).filter((u) => !u.token), signer: w.signer } }).send();
    }
  };
  const run = async (expected: Map<number, string>) => {
    const alerts: string[] = [];
    const logs: string[] = [];
    const problems = await auditChain({ deployment: d, expected, provider, alert: async (m) => void alerts.push(m), log: (s) => void logs.push(s) });
    return { problems, alerts, logs };
  };

  beforeAll(async () => {
    provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    w = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    provider.addUtxo(w.address, randomUtxo({ satoshis: 3_000_000n }));
    d = await deployDrops({ provider, network: 'chipnet', authority: w, shards: 2, rootTimelock: 2, log: () => undefined });
  });

  it('fresh deployment: nothing pending, epoch-0 shards skipped → 0 problems, no output', async () => {
    expect(await run(new Map())).toEqual({ problems: 0, alerts: [], logs: [] });
  });

  it('correct pending roots pass; unknown epoch alerts', async () => {
    await publish(1, ref.root1);
    const ok = await run(new Map([[1, ref.root1]]));
    expect(ok.problems).toBe(0);
    expect(ok.logs.sort()).toEqual(['ok   shard 0 epoch 1 pending root matches', 'ok   shard 1 epoch 1 pending root matches']);
    const unknown = await run(new Map());
    expect(unknown.problems).toBe(2);
    expect(unknown.alerts).toContain(`pending root for unknown epoch 1 on shard 0: ${ref.root1}`);
  });

  it('a tampered pending root is a mismatch with the veto deadline; active roots are checked too', async () => {
    await promoteAll();
    await publish(2, BAD);
    // Junk tokens anyone can send to the covenant addresses must neither crash the audit nor count.
    provider.addUtxo(c().shard.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: 'cd'.repeat(32), amount: 0n, nft: { capability: 'none', commitment: 'deadbeef' } } }));
    provider.addUtxo(c().pending.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: 'cd'.repeat(32), amount: 0n, nft: { capability: 'none', commitment: 'ab' } } }));
    provider.addUtxo(c().pending.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: d.config.pendingCategory, amount: 5n } })); // FT, no NFT

    const r = await run(new Map([[1, ref.root1], [2, ref.root2]]));
    expect(r.problems).toBe(2);
    expect(r.alerts.sort()).toEqual([
      `shard 0 epoch 2: pending root ${BAD} ≠ recomputed ${ref.root2} — veto before it matures (2 blocks)`,
      `shard 1 epoch 2: pending root ${BAD} ≠ recomputed ${ref.root2} — veto before it matures (2 blocks)`,
    ]);
    expect(r.logs.sort()).toEqual(['ok   shard 0 active epoch 1', 'ok   shard 1 active epoch 1']);

    const activeBad = await run(new Map([[1, BAD], [2, BAD]]));
    expect(activeBad.alerts.filter((a) => a.includes('ACTIVE root for epoch 1 does not match recomputation'))).toHaveLength(2);
    expect(activeBad.problems).toBe(2);

    // An active epoch the watcher cannot recompute is a problem, not "ok".
    const activeUnknown = await run(new Map([[2, BAD]]));
    expect(activeUnknown.alerts.filter((a) => a.includes('ACTIVE root for unknown epoch 1 cannot be verified'))).toHaveLength(2);
    expect(activeUnknown.problems).toBe(2);
  });

  it('audit(): loads deployment + trees from disk, recomputes and audits', async () => {
    const dir = tmpDir();
    writeFileSync(new URL('chipnet.json', dir), JSON.stringify(d));
    for (const t of [T1, T2]) writeFileSync(new URL(`tree-${t.epoch}.json`, dir), JSON.stringify(t));
    const alerts: string[] = [];
    const distroFor = vi.fn(async (start: Date, _end: Date, _monthly: number) => distro(start));
    const n = await audit({ network: 'chipnet', deploymentsDir: dir, leaves: LEAVES, monthly: 42, distroFor, provider, alert: async (m) => void alerts.push(m), log: () => undefined });
    expect(distroFor).toHaveBeenCalledTimes(2);
    expect(distroFor.mock.calls[0][2]).toBe(42);
    expect(n).toBe(2); // the two tampered epoch-2 pending roots
    expect(alerts.every((a) => a.includes(`≠ recomputed ${ref.root2}`))).toBe(true);
    await expect(audit({ network: 'chipnet', deploymentsDir: tmpDir(), provider })).rejects.toThrow('No deployment for chipnet');
  });
});

describe('main (CLI loop)', () => {
  it('snapshot command archives and returns 0', async () => {
    const snap = vi.fn(async () => ({ file: new URL('file:///x'), rows: 0 }));
    expect(await main(['snapshot'], { snapshot: snap, log: () => undefined })).toBe(0);
    expect(snap).toHaveBeenCalledTimes(1);
  });

  it('--once exit codes: 0 clean, 2 problems, 1 failure; flags reach the audit', async () => {
    const now = () => new Date('2026-11-21T00:00:00Z');
    const log = vi.fn();
    const error = vi.fn();
    const a = vi.fn(async (_o: AuditOptions) => 0);
    expect(await main(['--once', '--network', 'mainnet', '--decimals', '2', '--amount', '9', '--leaves', '5'], { audit: a, log, error, now })).toBe(0);
    expect(a.mock.calls[0][0]).toMatchObject({ network: 'mainnet', decimals: 2, monthly: 9, leaves: 5 });
    expect(log).toHaveBeenCalledWith('2026-11-21T00:00:00.000Z audit done, 0 problem(s)');
    expect(await main(['--once'], { audit: async () => 3, log, error, now })).toBe(2);
    expect(log).toHaveBeenCalledWith('2026-11-21T00:00:00.000Z audit done, 3 problem(s)');
    expect(await main(['--once'], { audit: async () => Promise.reject(new Error('electrum down')), log, error, now })).toBe(1);
    expect(error).toHaveBeenCalledWith('2026-11-21T00:00:00.000Z audit failed: electrum down');
  });

  it('defaults: chipnet, 8 decimals, 1,000,000 monthly, 400 leaves', async () => {
    const a = vi.fn(async (_o: AuditOptions) => 0);
    await main(['--once'], { audit: a, log: () => undefined });
    expect(a.mock.calls[0][0]).toMatchObject({ network: 'chipnet', decimals: 8, monthly: 1_000_000, leaves: 400 });
  });

  it('--source fah / --team / --alerts / --relays are wired into the audit options', async () => {
    const a = vi.fn(async (_o: AuditOptions) => 0);
    await main(['--once', '--source', 'fah', '--team', '7', '--alerts', 'nostr', '--relays', 'ws://a,ws://b'], { audit: a, log: () => undefined });
    expect(typeof a.mock.calls[0][0].distroFor).toBe('function');
    expect(typeof a.mock.calls[0][0].alert).toBe('function');
  });

  it('without --once keeps auditing every --interval seconds, surviving failures', async () => {
    const results: (number | Error)[] = [1, new Error('flaky'), 0];
    const a = vi.fn(async () => {
      const r = results.shift()!;
      if (r instanceof Error) throw r;
      return r;
    });
    const sleeps: number[] = [];
    const stop = new Error('stop');
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length === 3) throw stop;
    });
    await expect(main(['--interval', '5'], { audit: a, sleep, log: () => undefined, error: () => undefined })).rejects.toBe(stop);
    expect(a).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5000, 5000, 5000]);
  });

  it('entry guard: executed directly it exits with the --once code', async () => {
    const argv = process.argv;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.argv = [argv[0], fileURLToPath(new URL('../apps/watcher/src/index.ts', import.meta.url)), '--once', '--network', 'no-such-network'];
      vi.resetModules();
      await import('../apps/watcher/src/index');
      expect(exit).toHaveBeenCalledWith(1);
      expect(err.mock.calls.some((c) => String(c[0]).includes('No deployment for no-such-network'))).toBe(true);
    } finally {
      process.argv = argv;
    }
  });
});
