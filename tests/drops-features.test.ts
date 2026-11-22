/**
 * Drops features F25–F30 (Claims tab / CLI / watcher), all on CashScript's MockNetworkProvider
 * (full BCH 2026 VM) or a local WebSocket relay. Nothing is broadcast to a real network.
 *   F25 pool/account status, "already claimed", receipt totals, timelock countdown, DropsSandbox
 *   F26 authority cancel (veto) of a bad pending root, end to end with the watcher audit
 *   F27 Folding@home summary → snapshots → watcher `--source fah` reproduces the publisher's root
 *   F28 watcher alerts to Nostr with a stable runtime identity (opt-in)
 *   F29 `proof --address` output = proofFor() and verifies against the published tree
 *   F30 developer guide present in PLAN §5.1 and reachable in the web app
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { MockNetworkProvider, randomUtxo, type NetworkProvider, type Utxo } from 'cashscript';
import { binToHex, encodeCashAddress, generatePrivateKey, hexToBin } from '@bitauth/libauth';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { walletFromPrivateKey } from '@hermes/chain';
import {
  DropsSandbox,
  MerkleTree,
  blocksRemaining,
  buildPromote,
  buildPublish,
  claimForWallet,
  decodeShardState,
  deployDrops,
  distroFromFahSnapshots,
  dropsContracts,
  electrumHeights,
  parseFahSummary,
  proofFor,
  readAccountStatus,
  readPoolStatus,
  treeEntries,
  type Deployment,
  type DistroUser,
  type Entitlement,
  type TreeFileLike,
} from '@hermes/drops';
import { runCli } from '../packages/drops/src/cli';
import { audit, main, makeAlerter, makeDistroFor, parseNostrSecret, recomputeRoots, loadTrees, type TreeFile } from '../apps/watcher/src/index';
import { publishAlert } from '../apps/watcher/src/alerts';

type S = Utxo & { lockingBytecode: string };
const tmpDir = () => pathToFileURL(mkdtempSync(join(tmpdir(), 'hermes-drops-features-')) + '/');
const REPO_DEPLOYMENTS = new URL('../packages/drops/deployments/', import.meta.url);
const repoTrees = (): TreeFileLike[] => [1, 2].map((e) => JSON.parse(readFileSync(new URL(`tree-${e}.json`, REPO_DEPLOYMENTS), 'utf8')));
function logger() {
  const lines: string[] = [];
  return { log: (s: string) => void lines.push(s), lines, out: () => lines.join('\n') };
}
afterEach(() => vi.restoreAllMocks());

/** A deployed mock pool with one shard, epoch trees containing `user`, and helpers to publish/promote. */
async function pool(timelock = 2) {
  const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
  const authority = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
  const user = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
  provider.addUtxo(authority.address, randomUtxo({ satoshis: 5_000_000n }));
  provider.addUtxo(user.address, randomUtxo({ satoshis: 60_000n }));
  const d = await deployDrops({ provider, network: 'chipnet', authority, shards: 1, rootTimelock: timelock, log: () => undefined });
  const c = dropsContracts(d.config, provider);
  const mk = (epoch: number, cum: bigint): TreeFileLike => {
    const entries: Entitlement[] = [
      { lockingBytecode: '76a914' + '11'.repeat(20) + '88ac', cumulative: 500n * BigInt(epoch), accountId: 0 },
      { lockingBytecode: user.lockingBytecode, cumulative: cum, accountId: 1 },
    ];
    return { epoch, root: new MerkleTree(entries).root, entries };
  };
  const trees = [mk(1, 1_000n), mk(2, 2_500n)];
  const authUtxos = async () => [...(await provider.getUtxos(authority.address)), ...(await provider.getUtxos(authority.tokenAddress))] as S[];
  const publish = async (epoch: number, root = trees[epoch - 1].root) =>
    (await buildPublish({ provider, contracts: c, authority: authority.signer, authorityAddress: authority.address, authorityTokenAddress: authority.tokenAddress, authorityUtxos: await authUtxos(), pendingCategory: d.config.pendingCategory, epoch, root, shards: 1 }).send()).txid;
  const promote = async () => {
    const p = ((await provider.getUtxos(c.pending.tokenAddress)) as S[])[0];
    const s = ((await provider.getUtxos(c.shard.tokenAddress)) as S[])[0];
    return buildPromote({ provider, contracts: c, receiptCategory: d.config.receiptCategory, shardUtxo: s, pendingUtxo: p, rootTimelock: timelock, funder: { address: authority.address, utxos: ((await provider.getUtxos(authority.address)) as S[]).filter((u) => !u.token), signer: authority.signer } }).send();
  };
  const status = async (opts: { tip?: number; heights?: Parameters<typeof readPoolStatus>[0]['heights'] } = {}) => {
    const p = await readPoolStatus({ provider, config: d.config, trees, ...opts });
    return { pool: p, account: await readAccountStatus({ provider, config: d.config, trees, pool: p, wallet: user }) };
  };
  return { provider, authority, user, d, c, trees, publish, promote, status };
}

describe('F25 pool / account status for the Claims tab', () => {
  it('walks not-active (pending countdown) → claimable → already claimed → next epoch difference → already claimed', async () => {
    const P = await pool(2);
    let s = await P.status();
    expect(s.pool.shards).toEqual([{ shardIndex: 0, epoch: 0, root: '00'.repeat(32), treeEpoch: undefined, claimedAccounts: 0 }]);
    expect(s.pool.vault).toEqual({ units: 1_000_000_000n, utxos: 1 });
    expect(s.account).toMatchObject({ state: 'not-active', accountId: 1, shardIndex: 0, activeEpoch: 0, latestEpoch: 2, latestCumulative: 2_500n, claimable: 0n });

    // Pending epoch 1 with simulated heights: published at 100, tip 100 → 1 confirmation, 1 block left.
    const txid = await P.publish(1);
    const heights = async () => new Map((await P.provider.getUtxos(P.c.pending.tokenAddress)).map((u) => [`${u.txid}:${u.vout}`, u.txid === txid ? 100 : 1]));
    s = await P.status({ tip: 100, heights });
    expect(s.pool.pending).toEqual([{ shardIndex: 0, epoch: 1, root: P.trees[0].root, matchesTree: true, confirmations: 1, remaining: 1 }]);
    expect(s.account.message).toMatch(/Epoch 1 is pending: promotable in 1 block\(s\)/);
    s = await P.status({ tip: 101, heights });
    expect(s.pool.pending[0]).toMatchObject({ confirmations: 2, remaining: 0 });
    s = await P.status({ tip: 0, heights: async () => new Map([[`${txid}:1`, 0]]) }); // unconfirmed
    expect(s.pool.pending[0]).toMatchObject({ confirmations: 0, remaining: 2 });
    s = await P.status(); // no heights → age unknown, tip from the provider
    expect(s.pool.pending[0].remaining).toBeUndefined();
    expect(s.pool.tip).toBe(133700);

    await P.promote();
    s = await P.status();
    expect(s.pool.shards[0]).toMatchObject({ epoch: 1, treeEpoch: 1 });
    expect(s.account).toMatchObject({ state: 'claimable', cumulative: 1_000n, claimable: 1_000n, firstClaimDone: false, receipt: undefined });
    expect(s.account.activeTree?.epoch).toBe(1);

    const r1 = await claimForWallet({ provider: P.provider, config: P.d.config, entries: treeEntries(s.account.activeTree!), wallet: P.user });
    expect(r1).toMatchObject({ payout: 1_000n, firstClaim: true });
    s = await P.status();
    expect(s.pool.shards[0].claimedAccounts).toBe(1);
    expect(s.pool.vault.units).toBe(1_000_000_000n - 1_000n);
    expect(s.account).toMatchObject({ state: 'already-claimed', firstClaimDone: true, receipt: { claimedTotal: 1_000n, txid: r1.txid, vout: 2 }, claimable: 0n });
    expect(s.account.message).toBe('Already claimed: the receipt NFT shows 1000 of 1000 units for epoch 1. Nothing more until epoch 2 is promoted.');
    // The second claim is refused before anything is signed, with the same wording.
    await expect(claimForWallet({ provider: P.provider, config: P.d.config, entries: treeEntries(P.trees[0]), wallet: P.user })).rejects.toThrow(/already claimed: nothing to claim .*receipt shows 1000 of 1000/);
    // Claiming with a tree that is not active (epoch 2 still unpublished) explains why.
    await expect(claimForWallet({ provider: P.provider, config: P.d.config, entries: treeEntries(P.trees[1]), wallet: P.user })).rejects.toThrow(/not the active root .*epoch 1.*pending its timelock/);

    await P.publish(2);
    await P.promote();
    s = await P.status();
    expect(s.account).toMatchObject({ state: 'claimable', activeEpoch: 2, cumulative: 2_500n, claimable: 1_500n });
    const r2 = await claimForWallet({ provider: P.provider, config: P.d.config, entries: treeEntries(s.account.activeTree!), wallet: P.user });
    expect(r2).toMatchObject({ payout: 1_500n, firstClaim: false });
    s = await P.status();
    expect(s.account).toMatchObject({ state: 'already-claimed', receipt: { claimedTotal: 2_500n } });
    expect(s.account.message).toMatch(/Nothing more until the next epoch\.$/);
  });

  it('not-in-tree, receipt-missing, unknown active root and junk tokens', async () => {
    const P = await pool(2);
    await P.publish(1);
    await P.promote();
    const p = await readPoolStatus({ provider: P.provider, config: P.d.config, trees: P.trees, tip: 5 });
    const stranger = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    expect(await readAccountStatus({ provider: P.provider, config: P.d.config, trees: P.trees, pool: p, wallet: stranger })).toMatchObject({ state: 'not-in-tree', claimable: 0n });

    await claimForWallet({ provider: P.provider, config: P.d.config, entries: treeEntries(P.trees[0]), wallet: P.user });
    // The receipt moved away (e.g. user sent it elsewhere): the bitmap says "claimed once", no receipt here.
    const elsewhere = { lockingBytecode: P.user.lockingBytecode, tokenAddress: stranger.tokenAddress };
    const p2 = await readPoolStatus({ provider: P.provider, config: P.d.config, trees: P.trees });
    expect(await readAccountStatus({ provider: P.provider, config: P.d.config, trees: P.trees, pool: p2, wallet: elsewhere })).toMatchObject({ state: 'receipt-missing', firstClaimDone: true });

    // Without the tree file of the active root, the shard is flagged as unknown and the account cannot claim.
    const p3 = await readPoolStatus({ provider: P.provider, config: P.d.config, trees: [P.trees[1]] });
    expect(p3.shards[0].treeEpoch).toBeUndefined();
    expect((await readAccountStatus({ provider: P.provider, config: P.d.config, trees: [P.trees[1]], pool: p3, wallet: P.user })).state).toBe('not-active');

    // Junk tokens sent to the covenants are ignored.
    P.provider.addUtxo(P.c.shard.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: P.d.config.receiptCategory, amount: 0n, nft: { capability: 'minting', commitment: 'beef' } } }));
    P.provider.addUtxo(P.c.pending.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: P.d.config.pendingCategory, amount: 0n, nft: { capability: 'none', commitment: 'ab' } } }));
    const p4 = await readPoolStatus({ provider: P.provider, config: P.d.config, trees: P.trees });
    expect(p4.shards).toHaveLength(1);
    expect(p4.pending).toHaveLength(0);
  });

  it('electrumHeights maps listunspent heights, and degrades to undefined', async () => {
    const calls: unknown[][] = [];
    const fake = { performRequest: async (...a: unknown[]) => (calls.push(a), [{ tx_hash: 'aa', tx_pos: 1, height: 42 }]) } as unknown as NetworkProvider;
    expect(await electrumHeights(fake)('bchtest:x')).toEqual(new Map([['aa:1', 42]]));
    expect(calls).toEqual([['blockchain.address.listunspent', 'bchtest:x', 'include_tokens']]);
    const broken = { performRequest: async () => Promise.reject(new Error('down')) } as unknown as NetworkProvider;
    expect(await electrumHeights(broken)('x')).toBeUndefined();
    expect(await electrumHeights(new MockNetworkProvider())('x')).toBeUndefined();
    expect([blocksRemaining(0, 144), blocksRemaining(100, 144), blocksRemaining(144, 144), blocksRemaining(500, 144)]).toEqual([144, 44, 0, 0]);
  });
});

describe('F25 DropsSandbox (the Claims tab before a chipnet deployment)', () => {
  it('runs the published trees + a sandbox leaf through deploy → publish → early promote rejected → claim → already claimed → epoch 2', async () => {
    const published = repoTrees();
    const lines: string[] = [];
    const sb = await DropsSandbox.create({ trees: published, rootTimelock: 144, log: (s) => lines.push(s) });
    // Sandbox trees = published entries + exactly one new leaf for the sandbox wallet.
    expect(sb.trees.map((t) => t.entries.length)).toEqual(published.map((t) => t.entries.length + 1));
    const leaf = sb.trees[1].entries.find((e) => e.lockingBytecode === sb.wallet.lockingBytecode)!;
    expect(leaf.cumulative).toBe(200_000n);
    expect(leaf.accountId).toBe(Math.max(...published.flatMap((t) => t.entries.map((e) => e.accountId))) + 1);

    expect((await sb.status()).account.state).toBe('not-active');
    await expect(sb.claim()).rejects.toThrow(/No promoted root/);
    await sb.publish(1);
    sb.mine(10);
    let st = await sb.status();
    expect(st.pool.pending[0]).toMatchObject({ epoch: 1, matchesTree: true, confirmations: 10, remaining: 134 });
    const early = await sb.promote();
    expect(early.promoted).toEqual([]);
    expect(early.rejected[0]).toMatchObject({ epoch: 1, age: 10, reason: expect.stringContaining('DropsPending') });
    sb.mine(134);
    expect((await sb.promote()).promoted).toHaveLength(1);
    st = await sb.status();
    expect(st.account).toMatchObject({ state: 'claimable', claimable: 100_000n });
    expect((await sb.claim()).firstClaim).toBe(true);
    await expect(sb.claim()).rejects.toThrow('Already claimed: the receipt NFT shows 100000 of 100000 units for epoch 1. Nothing more until epoch 2 is promoted.');
    await sb.publish(2);
    sb.mine(144);
    await sb.promote();
    const r = await sb.claim();
    expect(r).toMatchObject({ payout: 100_000n, firstClaim: false });
    st = await sb.status();
    expect(st.account).toMatchObject({ state: 'already-claimed', receipt: { claimedTotal: 200_000n } });
    expect(st.pool.vault.units).toBe(1_000_000_000n - 200_000n);
    expect(lines.some((l) => /rejected at age 10\/144 blocks/.test(l))).toBe(true);
    await expect(sb.publish(9)).rejects.toThrow('no tree for epoch 9');
    await expect(DropsSandbox.create({ trees: [] })).rejects.toThrow('no published tree');
  });

  it('sandboxTrees keeps a wallet that is already a member unchanged (same roots)', () => {
    const t = repoTrees();
    const member = t[1].entries[0].lockingBytecode;
    const out = DropsSandbox.sandboxTrees(t, member);
    expect(out.map((x) => x.root)).toEqual(t.map((x) => x.root));
  });
});

describe('F26 authority cancel (veto) after a watcher alert', () => {
  it('watcher flags a tampered pending root, status shows it, cancel removes it, promote has nothing left', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    const key = generatePrivateKey();
    const authority = walletFromPrivateKey(key, 'chipnet');
    provider.addUtxo(authority.address, randomUtxo({ satoshis: 3_000_000n }));
    const d: Deployment = await deployDrops({ provider, network: 'chipnet', authority, shards: 2, rootTimelock: 2, log: () => undefined });
    const dir = tmpDir();
    // Publisher's honest tree for epoch 1 (watcher recomputes the same), but a tampered root is published.
    const distro = async (): Promise<DistroUser[]> => [{ amount: 3, bitcoinCashAddress: 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy' }];
    await runCli(['tree', '--from', '2026-09-01', '--to', '2026-10-01', '--leaves', '8'], { dir, fetchDistro: distro, log: () => undefined });
    writeFileSync(new URL('chipnet.json', dir), JSON.stringify(d));
    const deps = { dir, getProvider: () => provider, promptSecret: async () => binToHex(key) };
    const honest = JSON.parse(readFileSync(new URL('tree-1.json', dir), 'utf8')).root as string;
    const evil = 'ee'.repeat(32);
    const c = dropsContracts(d.config, provider);
    const utxos = [...(await provider.getUtxos(authority.address)), ...(await provider.getUtxos(authority.tokenAddress))] as S[];
    await buildPublish({ provider, contracts: c, authority: authority.signer, authorityAddress: authority.address, authorityTokenAddress: authority.tokenAddress, authorityUtxos: utxos, pendingCategory: d.config.pendingCategory, epoch: 1, root: evil, shards: 2 }).send();

    const alerts: string[] = [];
    const n = await audit({ network: 'chipnet', deploymentsDir: dir, leaves: 8, distroFor: distro, provider, alert: async (m) => void alerts.push(m), log: () => undefined });
    expect(n).toBe(2);
    expect(alerts[0]).toContain(`pending root ${evil} ≠ recomputed ${honest} — veto before it matures (2 blocks)`);

    const st = logger();
    await runCli(['status', '--network', 'chipnet'], { ...deps, log: st.log });
    expect(st.lines.filter((l) => l.includes('DOES NOT MATCH tree-1.json (cancel --epoch 1)'))).toHaveLength(2);
    expect(st.out()).toContain('age unknown'); // the mock provider has no Electrum heights

    const cl = logger();
    await runCli(['cancel', '--network', 'chipnet', '--epoch', '1'], { ...deps, log: cl.log });
    expect(cl.lines).toEqual([expect.stringMatching(/^cancelled pending root epoch 1 shard [01]: [0-9a-f]{64}$/), expect.stringMatching(/^cancelled pending root epoch 1 shard [01]: [0-9a-f]{64}$/)]);
    expect((await provider.getUtxos(c.pending.tokenAddress)).filter((u) => u.token?.category === d.config.pendingCategory)).toHaveLength(0);
    // The pending NFTs are burned: nothing to promote, shards stay at epoch 0, watcher is clean again.
    const pl = logger();
    await runCli(['promote', '--network', 'chipnet'], { ...deps, log: pl.log });
    expect(pl.lines).toEqual([]);
    expect(((await provider.getUtxos(c.shard.tokenAddress)) as S[]).map((s) => decodeShardState(s.token!.nft!.commitment).epoch)).toEqual([0, 0]);
    expect(await audit({ network: 'chipnet', deploymentsDir: dir, leaves: 8, distroFor: distro, provider, alert: async () => undefined, log: () => undefined })).toBe(0);
    const again = logger();
    await runCli(['cancel', '--network', 'chipnet', '--epoch', '1', '--shard', '0'], { ...deps, log: again.log });
    expect(again.lines).toEqual(['no pending root for epoch 1 shard 0 (already promoted, cancelled, or never published)']);

    // Only the authority key can veto: another key's signature fails the covenant.
    await buildPublish({ provider, contracts: c, authority: authority.signer, authorityAddress: authority.address, authorityTokenAddress: authority.tokenAddress, authorityUtxos: [...(await provider.getUtxos(authority.address)), ...(await provider.getUtxos(authority.tokenAddress))] as S[], pendingCategory: d.config.pendingCategory, epoch: 1, root: honest, shards: 2 }).send();
    const thiefKey = generatePrivateKey();
    provider.addUtxo(walletFromPrivateKey(thiefKey, 'chipnet').address, randomUtxo({ satoshis: 100_000n }));
    await expect(runCli(['cancel', '--network', 'chipnet', '--epoch', '1'], { ...deps, promptSecret: async () => binToHex(thiefKey) })).rejects.toThrow(/DropsPending/);
    expect((await provider.getUtxos(c.pending.tokenAddress)).filter((u) => u.token?.category === d.config.pendingCategory)).toHaveLength(2);
  });
});

describe('F27 Folding@home daily summary as an independent watcher source', () => {
  const A = 'qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';
  const summary = (aCredit: number, bCredit: number) =>
    ['Sat Nov  1 00:00:00 GMT 2026', 'name\tnewcredit\tsum(total)\tteam', `alice_bitcoincash:${A}\t${aCredit}\t${aCredit / 100}\t1066`, `bob_1BoatSLRHtKNngkdXEeobR76b53LETtpyT\t${bCredit}\t${bCredit / 100}\t1066`, `carol_no_address\t999999\t9\t1066`, `dave_${A}\t${aCredit * 2}\t50\t42`, 'garbage line'].join('\n');

  it('parse → snapshots → `--source fah` recomputes the same root the publisher built from the same data', async () => {
    const start = parseFahSummary(summary(1000, 1000));
    const end = parseFahSummary(summary(4000, 2000));
    expect(start.map((r) => r.name)).toEqual([`alice_bitcoincash:${A}`, 'bob_1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'carol_no_address', `dave_${A}`]);
    const team = distroFromFahSnapshots(start, end, 900, 1066);
    expect(team.map((u) => [u.bitcoinCashAddress ?? u.bitcoinAddress, u.amount])).toEqual([[`bitcoincash:${A}`, 675], ['1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 225]]);

    // Publisher builds epoch 1 from this distribution; the watcher reads archived snapshots for the window bounds.
    const dir = tmpDir();
    await runCli(['tree', '--from', '2026-10-01', '--to', '2026-11-01', '--leaves', '16', '--amount', '900'], { dir, fetchDistro: async () => team, log: () => undefined });
    const dataDir = new URL('data/', dir);
    mkdirSync(dataDir);
    const ser = (rows: typeof start) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    writeFileSync(new URL('fah-2026-10-01.json', dataDir), ser(start));
    writeFileSync(new URL('fah-2026-11-01.json', dataDir), ser(end));
    const api = vi.fn(async () => [] as DistroUser[]);
    const roots = await recomputeRoots(loadTrees(dir), 8, 900, 16, makeDistroFor({ source: 'fah', team: 1066, dataDir, fetchDistro: api }));
    expect(roots.get(1)).toBe(JSON.parse(readFileSync(new URL('tree-1.json', dir), 'utf8')).root);
    expect(api).not.toHaveBeenCalled();
    // Without the team filter, dave's credit changes the distribution → a different root (the watcher would alert).
    const all = await recomputeRoots(loadTrees(dir), 8, 900, 16, makeDistroFor({ source: 'fah', dataDir, fetchDistro: api }));
    expect(all.get(1)).not.toBe(roots.get(1));
  });

  it('watcher re-applies `tree --include` demo addresses recorded in params (else every demo root would alert)', async () => {
    const dir = tmpDir();
    const demo = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    const distro = async (s: Date): Promise<DistroUser[]> => [{ amount: s.getUTCMonth() + 1, bitcoinCashAddress: `bitcoincash:${A}` }];
    await runCli(['tree', '--from', '2026-09-01', '--to', '2026-11-01', '--leaves', '12', '--include', demo.address, '--include-amount', '777'], { dir, fetchDistro: distro, log: () => undefined });
    const trees = loadTrees(dir);
    expect(trees[1].params).toMatchObject({ include: [demo.address], includeAmount: '777', leaves: 12, decimals: 8 });
    expect(trees[1].entries.find((e) => e.lockingBytecode === demo.lockingBytecode)?.cumulative).toBe('1554');
    const roots = await recomputeRoots(trees, 8, 1_000_000, 12, distro);
    expect([roots.get(1), roots.get(2)]).toEqual(trees.map((t) => t.root));
    const withoutParams = await recomputeRoots(trees.map(({ params: _p, ...t }) => t as TreeFile), 8, 1_000_000, 12, distro);
    expect(withoutParams.get(1)).not.toBe(trees[0].root);
  });
});

describe('F28 watcher alerts to Nostr (opt-in, stable identity typed at runtime)', () => {
  let wss: WebSocketServer;
  let url: string;
  const received: { pubkey: string; content: string; tags: string[][]; id: string; sig: string; kind: number; created_at: number }[] = [];
  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (sock) =>
      sock.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg[0] === 'EVENT') {
          received.push(msg[1]);
          sock.send(JSON.stringify(['OK', msg[1].id, true, '']));
        }
      }),
    );
    await new Promise((r) => wss.on('listening', r));
    url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  });
  afterAll(() => wss.close());

  it('parseNostrSecret accepts nsec and hex, rejects others', () => {
    const sk = generateSecretKey();
    expect(parseNostrSecret(nip19.nsecEncode(sk))).toEqual(sk);
    expect(parseNostrSecret(binToHex(sk))).toEqual(sk);
    expect(() => parseNostrSecret(nip19.npubEncode(getPublicKey(sk)))).toThrow(/nsec/);
  });

  it('off by default; with --alerts nostr --alert-identity every alert is signed by the typed key and reaches the relay', async () => {
    const sk = generateSecretKey();
    const err: string[] = [];
    const quiet = makeAlerter({ network: 'chipnet', error: (s) => err.push(s), publish: vi.fn() as unknown as typeof publishAlert });
    await quiet('x');
    expect(err).toEqual(['ALERT x']);

    const alerter = makeAlerter({ network: 'chipnet', mode: 'nostr', relays: [url], secretKey: sk, error: (s) => err.push(s) });
    await alerter('shard 0 epoch 2: pending root mismatch');
    await alerter('second alert');
    const mine = received.filter((e) => e.pubkey === getPublicKey(sk));
    expect(mine.map((e) => e.content)).toEqual(['Hermes Drops watcher (chipnet): shard 0 epoch 2: pending root mismatch', 'Hermes Drops watcher (chipnet): second alert']);
    expect(mine.every((e) => verifyEvent(e as Parameters<typeof verifyEvent>[0]) && e.kind === 1 && e.tags.some((t) => t[0] === 't' && t[1] === 'hermesdrops'))).toBe(true);
    expect(err.filter((l) => l.startsWith('alert published by'))).toEqual([`alert published by ${nip19.npubEncode(getPublicKey(sk))} to 1/1 relays`, `alert published by ${nip19.npubEncode(getPublicKey(sk))} to 1/1 relays`]);
  });

  it('main prompts for the alert nsec only with --alerts nostr --alert-identity, and wires it into the audit', async () => {
    const sk = generateSecretKey();
    const prompt = vi.fn(async () => nip19.nsecEncode(sk));
    let seen: ((m: string) => Promise<void>) | undefined;
    const run = vi.fn(async (o: { alert?: (m: string) => Promise<void> }) => ((seen = o.alert), 0));
    const before = received.length;
    expect(await main(['--once', '--alerts', 'nostr', '--alert-identity', '--relays', url], { audit: run as never, promptSecret: prompt, log: () => undefined, error: () => undefined })).toBe(0);
    expect(prompt).toHaveBeenCalledOnce();
    await seen!('from main');
    expect(received.slice(before).map((e) => [e.pubkey, e.content])).toEqual([[getPublicKey(sk), 'Hermes Drops watcher (chipnet): from main']]);
    prompt.mockClear();
    await main(['--once', '--alert-identity'], { audit: run as never, promptSecret: prompt, log: () => undefined, error: () => undefined });
    expect(prompt).not.toHaveBeenCalled(); // no Nostr alerts requested → no key asked
  });
});

describe('F29 proof --address for other developers', () => {
  it('prints proofFor() JSON for a real FoldingCash member of the published tree; it verifies; tampering is detected', async () => {
    const t2 = repoTrees()[1] as TreeFile & TreeFileLike;
    const member = t2.entries.find((e) => e.lockingBytecode.startsWith('76a914'))!;
    const addr = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: hexToBin(member.lockingBytecode.slice(6, 46)) }).address;
    const l = logger();
    await runCli(['proof', '--address', addr], { dir: REPO_DEPLOYMENTS, log: l.log });
    const out = JSON.parse(l.out());
    expect(out).toMatchObject({ epoch: 2, root: t2.root, depth: 9, verifies: true, leaf: { accountId: member.accountId, cumulative: String(member.cumulative), lockingBytecode: member.lockingBytecode } });
    expect(out.proof).toHaveLength(9 * 64);
    expect(JSON.parse(JSON.stringify(proofFor(t2, member.lockingBytecode), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))).toEqual(out);
    // A tree file whose stated root was altered no longer verifies; a non-member gets undefined.
    expect(proofFor({ ...t2, root: '00'.repeat(32) }, member.lockingBytecode)?.verifies).toBe(false);
    expect(proofFor(t2, '76a914' + '00'.repeat(20) + '88ac')).toBeUndefined();
    const l1 = logger();
    await runCli(['proof', '--address', addr, '--epoch', '1'], { dir: REPO_DEPLOYMENTS, log: l1.log });
    expect(JSON.parse(l1.out()).epoch).toBe(1);
  });
});

describe('F30 developer guide', () => {
  const plan = readFileSync(new URL('../docs/PLAN.md', import.meta.url), 'utf8');
  const guide = plan.slice(plan.indexOf('### 5.1'), plan.indexOf('\n## 6'));
  it('lives in PLAN §5.1 with byte formats, lifecycle, claim layout and extension points that exist in code', () => {
    expect(guide).toMatch(/### 5\.1 Developer guide/);
    for (const s of ['Leaf', 'Shard commitment', 'Pending-root commitment', 'Receipt commitment', 'Lifecycle', 'Claim transaction', '--reward-category', '--shards', '--source fah', 'proof --address', 'readPoolStatus', 'claimForWallet', '--alerts nostr']) expect(guide).toContain(s);
    const cli = readFileSync(new URL('../packages/drops/src/cli.ts', import.meta.url), 'utf8');
    for (const cmd of ['tree', 'deploy', 'publish', 'promote', 'cancel', 'status', 'proof']) expect(cli).toContain(`case '${cmd}'`);
    expect(cli).toContain("opt('reward-category')");
  });
  it('is rendered in the Claims tab and linked from the Developers tab', () => {
    const claims = readFileSync(new URL('../apps/web/src/tabs/Claims.tsx', import.meta.url), 'utf8');
    expect(claims).toContain("docs/PLAN.md?raw");
    expect(claims).toContain("indexOf('### 5.1')");
    expect(readFileSync(new URL('../apps/web/src/tabs/Developers.tsx', import.meta.url), 'utf8')).toContain('#claims?guide');
  });
});
