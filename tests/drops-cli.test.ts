/**
 * Drops CLI command dispatch (tree, proof, deploy, publish, promote, cancel, status, cost, demo, help)
 * against an injected MockNetworkProvider, a mocked FoldingCash distribution and a temp deployments
 * directory; plus the remaining branches of sources/fah/state/deploy/tx/demo. No network.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MockNetworkProvider, randomUtxo, type Utxo } from 'cashscript';
import { binToHex, generatePrivateKey } from '@bitauth/libauth';
import { walletFromPrivateKey, type KeyWallet } from '@hermes/chain';
import {
  AccountRegistry,
  BITMAP_BYTES,
  accumulate,
  decodePending,
  decodeReceipt,
  decodeShardState,
  deployDrops,
  dropsContracts,
  encodePending,
  encodeReceipt,
  encodeShardState,
  emptyShard,
  fetchFahSummary,
  fetchFoldingCashDistro,
  findReceipt,
  findShard,
  type ClaimContext,
  lockingBytecodeForUser,
  type Deployment,
  type DistroUser,
} from '@hermes/drops';
import { claimedCount, latestEpoch, optFrom, parseNetwork, runCli, isEntry, type CliDeps } from '../packages/drops/src/cli';

type S = Utxo & { lockingBytecode: string };

const tmpDir = () => pathToFileURL(mkdtempSync(join(tmpdir(), 'hermes-drops-cli-')) + '/');
const CASHADDR = 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';
const LEGACY_P2PKH = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const LEGACY_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';

/** Records log lines; `out()` joins them. */
function logger() {
  const lines: string[] = [];
  return { log: (s: string) => void lines.push(s), lines, out: () => lines.join('\n') };
}

afterEach(() => vi.restoreAllMocks());

describe('cli helpers', () => {
  it('optFrom reads the token after a flag, or the default', () => {
    const opt = optFrom(['tree', '--leaves', '12', '--include']);
    expect(opt('leaves')).toBe('12');
    expect(opt('from', 'x')).toBe('x');
    expect(opt('include', 'd')).toBeUndefined(); // flag present, no value
  });
  it('parseNetwork refuses mainnet and passes others through', () => {
    expect(() => parseNetwork('mainnet')).toThrow(/explicit approval/);
    expect(parseNetwork('mock')).toBe('mock');
    expect(parseNetwork()).toBe('chipnet');
  });
  it('claimedCount counts set bits', () => {
    const b = new Uint8Array(BITMAP_BYTES);
    expect(claimedCount(b)).toBe(0);
    b[0] = 0b1011;
    b[87] = 0xff;
    expect(claimedCount(b)).toBe(11);
  });
  it('latestEpoch finds the highest contiguous tree-N.json', () => {
    const dir = tmpDir();
    expect(latestEpoch(dir)).toBe(1);
    for (const n of [1, 2, 3, 5]) writeFileSync(new URL(`tree-${n}.json`, dir), '{}');
    expect(latestEpoch(dir)).toBe(3);
  });
  it('isEntry is false for imports and missing argv', () => {
    expect(isEntry(import.meta.url, undefined)).toBe(false);
    expect(isEntry(import.meta.url, '/definitely/not/here.ts')).toBe(false);
    expect(isEntry(import.meta.url, fileURLToPath(import.meta.url))).toBe(true);
  });
});

describe('cli offline commands', () => {
  it('cost prints the cost model for --users', async () => {
    const l = logger();
    await runCli(['cost', '--users', '100', '--claim-rate', '0.5'], { log: l.log });
    const j = JSON.parse(l.out());
    expect(j.users).toBe(100);
    expect(j.push.operatorSats).toBeGreaterThan(0);
  });

  it('demo forwards --leaves to runDemo', async () => {
    const runDemo = vi.fn(async () => ({}) as never);
    await runCli(['demo', '--leaves', '33'], { runDemo, log: () => undefined });
    expect(runDemo).toHaveBeenCalledWith(expect.objectContaining({ leaves: 33 }));
  });

  it('unknown command prints the usage header', async () => {
    const l = logger();
    await runCli(['nope'], { log: l.log });
    expect(l.out()).toContain('Hermes Drops CLI.');
    expect(l.out()).toContain('tsx src/cli.ts proof');
  });

  it('tree builds cumulative epochs from the distribution, includes demo addresses, writes the registry; proof proves a leaf', async () => {
    const dir = tmpDir();
    const demo = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    const calls: [string, string, number][] = [];
    const fetchDistro = vi.fn(async (start: Date, end: Date, amount: number): Promise<DistroUser[]> => {
      calls.push([start.toISOString(), end.toISOString(), amount]);
      return [
        { amount: 10, bitcoinCashAddress: CASHADDR },
        { amount: 5, bitcoinAddress: LEGACY_P2PKH },
        { amount: 0, bitcoinAddress: LEGACY_P2SH }, // zero → skipped
        { amount: 3 }, // no address → skipped
      ];
    });
    const l = logger();
    await runCli(['tree', '--from', '2026-09-01', '--to', '2026-11-01', '--leaves', '12', '--amount', '777', '--include', demo.address], { dir, fetchDistro, log: l.log });
    expect(calls).toEqual([
      ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 777],
      ['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 777],
    ]);
    const t1 = JSON.parse(readFileSync(new URL('tree-1.json', dir), 'utf8'));
    const t2 = JSON.parse(readFileSync(new URL('tree-2.json', dir), 'utf8'));
    expect(t1.epoch).toBe(1);
    expect(t1.realMembers).toBe(2);
    expect(t1.skipped).toBe(2);
    expect(t1.leaves).toBe(12);
    expect(t2.entries[0].cumulative).toBe(String(2n * 10n * 10n ** 8n)); // cumulative doubles
    // --include amount scales per epoch (100000 × epoch)
    const demoLeaf = t2.entries.find((e: { accountId: number }) => e.accountId === 2);
    expect(demoLeaf.lockingBytecode).toBe(demo.lockingBytecode);
    expect(demoLeaf.cumulative).toBe('200000');
    expect(t1.root).not.toBe(t2.root);
    const reg = JSON.parse(readFileSync(new URL('registry.json', dir), 'utf8'));
    expect(Object.keys(reg)).toHaveLength(2 + 1 + 9);
    expect(l.lines[0]).toMatch(/^epoch 1: 2 FoldingCash members \+ 10 sample = 12 leaves, root [0-9a-f]{64}$/);

    // Re-running reuses the registry: existing ids never move, new leaves append.
    await runCli(['tree', '--from', '2026-09-01', '--to', '2026-10-01', '--leaves', '12'], { dir, fetchDistro, log: () => undefined });
    const reg2 = JSON.parse(readFileSync(new URL('registry.json', dir), 'utf8'));
    expect(reg2).toMatchObject(reg);
    expect(Object.keys(reg2)).toHaveLength(13);

    // proof without --epoch uses the latest tree (2), and the proof verifies.
    await runCli(['tree', '--from', '2026-09-01', '--to', '2026-11-01', '--leaves', '12', '--include', demo.address], { dir, fetchDistro, log: () => undefined });
    const p = logger();
    await runCli(['proof', '--address', demo.address], { dir, log: p.log });
    const proof = JSON.parse(p.out());
    expect(proof.epoch).toBe(2);
    expect(proof.root).toBe(JSON.parse(readFileSync(new URL('tree-2.json', dir), 'utf8')).root);
    expect(proof.verifies).toBe(true);
    expect(proof.leaf.cumulative).toBe('200000');
    const p1 = logger();
    await runCli(['proof', '--address', demo.address, '--epoch', '1'], { dir, log: p1.log });
    expect(JSON.parse(p1.out())).toMatchObject({ epoch: 1, verifies: true, leaf: { cumulative: '100000' } });

    await expect(runCli(['proof'], { dir })).rejects.toThrow('--address required');
    await expect(runCli(['proof', '--address', 'bchtest:notanaddress'], { dir })).rejects.toThrow();
    const stranger = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    await expect(runCli(['proof', '--address', stranger.address], { dir })).rejects.toThrow('address not in epoch 2');
  });

  it('tree rejects a bad --include address', async () => {
    const fetchDistro = vi.fn(async () => [] as DistroUser[]);
    await expect(runCli(['tree', '--from', '2026-09-01', '--to', '2026-10-01', '--include', 'garbage'], { dir: tmpDir(), fetchDistro, log: () => undefined })).rejects.toThrow(/bad address garbage/);
  });

  it('deploy --network mock writes mock.json with all three genesis txids', async () => {
    const dir = tmpDir();
    const l = logger();
    vi.spyOn(console, 'log').mockImplementation(() => undefined); // deployDrops' own progress lines
    await runCli(['deploy', '--network', 'mock', '--shards', '2', '--timelock', '5'], { dir, log: l.log });
    const d: Deployment = JSON.parse(readFileSync(new URL('mock.json', dir), 'utf8'));
    expect(d.network).toBe('mock');
    expect(d.shards).toBe(2);
    expect(d.config.rootTimelock).toBe(5);
    expect(Object.keys(d.txids)).toEqual(['authorityGenesis', 'shardGenesis', 'rewardGenesis']);
    expect(l.out()).toContain('deployment written to deployments/mock.json');
  });

  it('deploy --network chipnet prompts for the authority key and uses the injected provider', async () => {
    const dir = tmpDir();
    const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    const key = generatePrivateKey();
    const w = walletFromPrivateKey(key, 'chipnet');
    provider.addUtxo(w.address, randomUtxo({ satoshis: 1_000_000n }));
    const promptSecret = vi.fn(async () => binToHex(key));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runCli(['deploy', '--network', 'chipnet', '--shards', '1', '--reward-category', 'ab'.repeat(32)], { dir, getProvider: () => provider, promptSecret, log: () => undefined });
    expect(promptSecret).toHaveBeenCalledWith('Drops authority key for chipnet (WIF / hex / mnemonic): ');
    const d: Deployment = JSON.parse(readFileSync(new URL('chipnet.json', dir), 'utf8'));
    expect(d.config.authorityPkh).toBe(w.pkh);
    expect(d.config.rewardCategory).toBe('ab'.repeat(32));
    expect(Object.keys(d.txids)).toEqual(['authorityGenesis', 'shardGenesis']);
  });

  it('every networked command refuses mainnet before touching keys or providers', async () => {
    const getProvider = vi.fn();
    const promptSecret = vi.fn();
    for (const cmd of ['deploy', 'publish', 'promote', 'cancel', 'status']) {
      await expect(runCli([cmd, '--network', 'mainnet'], { dir: tmpDir(), getProvider, promptSecret })).rejects.toThrow(/explicit approval/);
    }
    expect(getProvider).not.toHaveBeenCalled();
    expect(promptSecret).not.toHaveBeenCalled();
  });
});

describe('cli chain commands on a mock provider', () => {
  let provider: MockNetworkProvider;
  let authority: KeyWallet;
  let d: Deployment;
  let dir: URL;
  let deps: Partial<CliDeps>;
  const root1 = 'aa'.repeat(32);
  const root2 = 'bb'.repeat(32);

  beforeAll(async () => {
    provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    const key = generatePrivateKey();
    authority = walletFromPrivateKey(key, 'chipnet');
    provider.addUtxo(authority.address, randomUtxo({ satoshis: 3_000_000n }));
    d = await deployDrops({ provider, network: 'chipnet', authority, shards: 2, rootTimelock: 2, log: () => undefined });
    dir = tmpDir();
    writeFileSync(new URL('chipnet.json', dir), JSON.stringify(d));
    writeFileSync(new URL('tree-1.json', dir), JSON.stringify({ epoch: 1, root: root1 }));
    writeFileSync(new URL('tree-2.json', dir), JSON.stringify({ epoch: 2, root: root2 }));
    deps = { dir, getProvider: () => provider, promptSecret: async () => binToHex(key) };
  });

  const c = () => dropsContracts(d.config, provider);
  const pendings = async () => ((await provider.getUtxos(c().pending.tokenAddress)) as S[]).filter((u) => u.token?.category === d.config.pendingCategory).map((u) => decodePending(u.token!.nft!.commitment));
  const shards = async () => ((await provider.getUtxos(c().shard.tokenAddress)) as S[]).filter((u) => u.token?.category === d.config.receiptCategory).map((u) => decodeShardState(u.token!.nft!.commitment));

  it('status on a fresh deployment, ignoring junk tokens sent to the covenants', async () => {
    // Anyone can send tokens to a covenant's token address; status must not crash or count them.
    provider.addUtxo(c().shard.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: 'cd'.repeat(32), amount: 0n, nft: { capability: 'none', commitment: 'deadbeef' } } }));
    provider.addUtxo(c().vault.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: 'cd'.repeat(32), amount: 999n } }));
    provider.addUtxo(c().pending.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: 'cd'.repeat(32), amount: 0n, nft: { capability: 'none', commitment: 'ab' } } }));
    const l = logger();
    await runCli(['status', '--network', 'chipnet'], { ...deps, log: l.log });
    expect(l.lines.filter((x) => x.startsWith('shard '))).toEqual([
      expect.stringMatching(/^shard 0: epoch 0 root 0{16}… claimed accounts 0$/),
      expect.stringMatching(/^shard 1: epoch 0 root 0{16}… claimed accounts 0$/),
    ]);
    expect(l.out()).toContain('vault: 1000000000 reward units in 2 UTXOs');
    expect(l.out()).toContain('pending roots: 0');
  });

  it('publish → pending roots for every shard; promote moves them into the shards', async () => {
    const l = logger();
    await runCli(['publish', '--network', 'chipnet', '--epoch', '1'], { ...deps, log: l.log });
    expect(l.out()).toMatch(new RegExp(`published epoch 1 root ${root1}: [0-9a-f]{64} — promotable after 2 blocks`));
    expect((await pendings()).filter((p) => p.root === root1).map((p) => p.shardIndex).sort()).toEqual([0, 1]);

    const pl = logger();
    await runCli(['promote', '--network', 'chipnet'], { ...deps, log: pl.log });
    expect(pl.lines.filter((x) => /→ epoch 1: [0-9a-f]{64}$/.test(x))).toHaveLength(2);
    expect((await shards()).map((s) => [s.shardIndex, s.epoch, s.root]).sort()).toEqual([
      [0, 1, root1],
      [1, 1, root1],
    ]);
    const st = logger();
    await runCli(['status', '--network', 'chipnet'], { ...deps, log: st.log });
    expect(st.out()).toContain(`shard 0: epoch 1 root ${root1.slice(0, 16)}…`);
  });

  it('promote reports a stale pending root as not promotable instead of failing', async () => {
    await runCli(['publish', '--network', 'chipnet', '--epoch', '1'], { ...deps, log: () => undefined }); // epoch 1 again: not newer
    const l = logger();
    await runCli(['promote', '--network', 'chipnet'], { ...deps, log: l.log });
    expect(l.lines.filter((x) => x.includes('not promotable yet (pending epoch is not newer)'))).toHaveLength(2);
    expect((await shards()).every((s) => s.epoch === 1)).toBe(true);
  });

  it('cancel vetoes only the selected epoch / shard', async () => {
    await runCli(['publish', '--network', 'chipnet', '--epoch', '2'], { ...deps, log: () => undefined });
    const before = await pendings();
    expect(before.filter((p) => p.epoch === 2)).toHaveLength(2);

    const l = logger();
    await runCli(['cancel', '--network', 'chipnet', '--epoch', '2', '--shard', '1'], { ...deps, log: l.log });
    expect(l.lines).toEqual([expect.stringMatching(/^cancelled pending root epoch 2 shard 1: [0-9a-f]{64}$/)]);
    let after = await pendings();
    expect(after.filter((p) => p.epoch === 2).map((p) => p.shardIndex)).toEqual([0]);
    expect(after.filter((p) => p.epoch === 1)).toHaveLength(2); // other epoch untouched

    const l2 = logger();
    await runCli(['cancel', '--network', 'chipnet', '--epoch', '1'], { ...deps, log: l2.log });
    expect(l2.lines).toHaveLength(2);
    after = await pendings();
    expect(after.map((p) => p.epoch)).toEqual([2]);

    // nothing matches → no tx, one explanatory line
    const l3 = logger();
    await runCli(['cancel', '--network', 'chipnet', '--epoch', '9'], { ...deps, log: l3.log });
    expect(l3.lines).toEqual([expect.stringMatching(/^no pending root for epoch 9 /)]);
  });

  it('cancel without --epoch is an error (it used to silently do nothing)', async () => {
    await expect(runCli(['cancel', '--network', 'chipnet'], { ...deps, log: () => undefined })).rejects.toThrow('--epoch required');
  });

  it('publish fails clearly without the authority minting NFT, and without a deployment file', async () => {
    const other = generatePrivateKey();
    const w = walletFromPrivateKey(other, 'chipnet');
    provider.addUtxo(w.address, randomUtxo({ satoshis: 100_000n }));
    await expect(runCli(['publish', '--network', 'chipnet', '--epoch', '2'], { ...deps, promptSecret: async () => binToHex(other) })).rejects.toThrow('authority minting NFT not found');
    await expect(runCli(['status', '--network', 'chipnet'], { ...deps, dir: tmpDir() })).rejects.toThrow(/ENOENT/);
  });
});

describe('sources: address resolution, registry and the FoldingCash API', () => {
  it('lockingBytecodeForUser: cashTokens > bitcoinCash > legacy P2PKH / P2SH; bad input → undefined', () => {
    const p2pkh = lockingBytecodeForUser({ amount: 1, bitcoinCashAddress: CASHADDR })!;
    expect(p2pkh).toMatch(/^76a914[0-9a-f]{40}88ac$/);
    // prefix-less cashaddr gets bitcoincash: added
    expect(lockingBytecodeForUser({ amount: 1, bitcoinCashAddress: CASHADDR.split(':')[1] })).toBe(p2pkh);
    // invalid cashaddr falls through to the legacy address
    const legacy = lockingBytecodeForUser({ amount: 1, cashTokensAddress: 'bitcoincash:qqqqbad', bitcoinAddress: LEGACY_P2PKH })!;
    expect(legacy).toMatch(/^76a914/);
    expect(legacy).not.toBe(p2pkh);
    expect(lockingBytecodeForUser({ amount: 1, bitcoinAddress: LEGACY_P2SH })).toMatch(/^a914[0-9a-f]{40}87$/);
    expect(lockingBytecodeForUser({ amount: 1, bitcoinAddress: 'not-base58!' })).toBeUndefined();
    expect(lockingBytecodeForUser({ amount: 1 })).toBeUndefined();
  });

  it('AccountRegistry keeps initial ids and appends new ones; toJSON / size round-trip', () => {
    const r = new AccountRegistry({ aa: 0, bb: 1 });
    expect(r.size).toBe(2);
    expect(r.idFor('bb')).toBe(1);
    expect(r.idFor('cc')).toBe(2);
    expect(r.toJSON()).toEqual({ aa: 0, bb: 1, cc: 2 });
    expect(new AccountRegistry(r.toJSON()).idFor('cc')).toBe(2);
  });

  it('accumulate skips users without an address or a positive amount', () => {
    const r = accumulate(new Map(), [{ amount: -1, bitcoinAddress: LEGACY_P2PKH }, { amount: 1 }, { amount: 2, bitcoinAddress: LEGACY_P2PKH }], 2, new AccountRegistry());
    expect(r.skipped).toBe(2);
    expect(r.entries).toEqual([expect.objectContaining({ cumulative: 200n, accountId: 0 })]);
  });

  it('fetchFoldingCashDistro: URL, field sanitising, HTTP and payload errors', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, distro: [{ amount: 1.5, bitcoinCashAddress: CASHADDR, pointsGained: 10, workUnitsGained: 2, evil: 'x' }, { amount: 'NaN', bitcoinAddress: 42 }] })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await fetchFoldingCashDistro(new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'), 1000);
      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://api.folding.cash/v1/GetDistro?startDate=09-01-2026&endDate=10-01-2026&amount=1000&includeFoldingUserTypes=15');
      expect(r).toEqual([
        { amount: 1.5, bitcoinAddress: null, bitcoinCashAddress: CASHADDR, cashTokensAddress: null, pointsGained: 10, workUnitsGained: 2 },
        { amount: 0, bitcoinAddress: null, bitcoinCashAddress: null, cashTokensAddress: null, pointsGained: undefined, workUnitsGained: undefined },
      ]);
      fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
      await expect(fetchFoldingCashDistro(new Date(), new Date(), 1)).rejects.toThrow('FoldingCash API 503');
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false })));
      await expect(fetchFoldingCashDistro(new Date(), new Date(), 1)).rejects.toThrow('no distribution');
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, distro: {} })));
      await expect(fetchFoldingCashDistro(new Date(), new Date(), 1)).rejects.toThrow('no distribution');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('fah: fetchFahSummary', () => {
  // bzip2 -9 of a 2-row daily_user_summary.txt (date line, header, one cashaddr user, one without).
  const BZ2 =
    'QlpoOTFBWSZTWbxPmDQAABZbgAAwQGJ/sAAAv3//4CAAdCpiDGpoaaA0aGm1DQinkJpp6gNNABo0AWuDC+v6NLxaJPsNITCaCtcNSlAoKFoEJGkgq48nQYOKtFrUTyqBydai5hxB0OZ4o++7NEHQBDUlAukL0i/eVszi54PNYxlPex5UW5NQQwCtpT+hIFSMsG8xx4Sr8XckU4UJC8T5g0A=';
  it('downloads, decompresses and parses the summary; HTTP error throws', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from(BZ2, 'base64')));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const rows = await fetchFahSummary('http://fah.invalid/summary.bz2');
      expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('http://fah.invalid/summary.bz2');
      expect(rows).toEqual([
        { name: `alice_${CASHADDR}`, credit: 5000n, workUnits: 12n, team: 1066107 },
        { name: 'noaddress', credit: 100n, workUnits: 1n, team: 0 },
      ]);
      fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
      await expect(fetchFahSummary()).rejects.toThrow('F@H 404');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('state codecs reject malformed input', () => {
  it('encodeShardState / decodeShardState / decodePending / decodeReceipt', () => {
    expect(() => encodeShardState({ ...emptyShard(0), shardIndex: 128 })).toThrow('shardIndex must be 0..127');
    expect(() => encodeShardState({ ...emptyShard(0), shardIndex: -1 })).toThrow('shardIndex must be 0..127');
    expect(() => encodeShardState({ ...emptyShard(0), bitmap: new Uint8Array(3) })).toThrow('bad bitmap');
    expect(() => decodeShardState('00')).toThrow('bad shard state length');
    expect(() => decodePending('00'.repeat(36))).toThrow('bad pending length');
    expect(() => decodeReceipt('00'.repeat(13))).toThrow('bad receipt length');
    expect(decodePending(encodePending(3, 70000, 'ab'.repeat(32)))).toEqual({ shardIndex: 3, epoch: 70000, root: 'ab'.repeat(32) });
    expect(decodeReceipt(encodeReceipt(9, 2n ** 40n))).toEqual({ accountId: 9, claimedTotal: 2n ** 40n });
  });
});

describe('deployDrops guards', () => {
  it('throws when the authority has no BCH', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    const w = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    await expect(deployDrops({ provider, network: 'chipnet', authority: w, shards: 1, rootTimelock: 1, log: () => undefined })).rejects.toThrow(/No BCH at bchtest:/);
  });

  it('refuses a test reward token on mainnet BEFORE broadcasting anything', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    const w = walletFromPrivateKey(generatePrivateKey(), 'mainnet');
    provider.addUtxo(w.address, randomUtxo({ satoshis: 1_000_000n }));
    const send = vi.spyOn(provider, 'sendRawTransaction');
    await expect(deployDrops({ provider, network: 'mainnet', authority: w, shards: 1, rootTimelock: 1, log: () => undefined })).rejects.toThrow('refusing to mint a test reward token on mainnet');
    expect(send).not.toHaveBeenCalled();
  });

  it('with an existing rewardCategory skips the reward genesis and logs to console by default', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    const w = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    provider.addUtxo(w.address, randomUtxo({ satoshis: 1_000_000n }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const d = await deployDrops({ provider, network: 'chipnet', authority: w, shards: 1, rootTimelock: 1, rewardCategory: 'ef'.repeat(32) });
    expect(Object.keys(d.txids)).toEqual(['authorityGenesis', 'shardGenesis']);
    expect(d.config.rewardCategory).toBe('ef'.repeat(32));
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^authority genesis /), expect.stringMatching(/^shard genesis .*\(1 shards\)$/)]);
  });
});

describe('findShard / findReceipt', () => {
  it('findShard throws when the account shard is not among the UTXOs', () => {
    const shard0 = { ...randomUtxo({ satoshis: 2000n, token: { category: '11'.repeat(32), amount: 0n, nft: { capability: 'minting', commitment: encodeShardState(emptyShard(0)) } } }), lockingBytecode: '' } as S;
    const ctx = { shardUtxos: [{ ...randomUtxo(), lockingBytecode: '' } as S, shard0] } as unknown as ClaimContext;
    expect(findShard(ctx, 5).utxo).toBe(shard0);
    expect(() => findShard(ctx, 704)).toThrow('shard 1 not found');
  });

  it('skips other categories, non-"none" NFTs and malformed commitments', () => {
    const cat = '11'.repeat(32);
    const u = (token: Utxo['token']) => ({ ...randomUtxo({ satoshis: 1000n, token }), lockingBytecode: '' }) as S;
    const good = u({ category: cat, amount: 0n, nft: { capability: 'none', commitment: encodeReceipt(5, 77n) } });
    const utxos = [
      u({ category: '22'.repeat(32), amount: 0n, nft: { capability: 'none', commitment: encodeReceipt(5, 1n) } }),
      u({ category: cat, amount: 0n, nft: { capability: 'mutable', commitment: encodeReceipt(5, 2n) } }),
      u({ category: cat, amount: 0n, nft: { capability: 'none', commitment: 'abcd' } }), // not a receipt
      u({ category: cat, amount: 0n, nft: { capability: 'none', commitment: encodeReceipt(6, 3n) } }),
      u({ category: cat, amount: 10n }),
      good,
    ];
    expect(findReceipt(utxos, cat, 5)).toMatchObject({ utxo: good, accountId: 5, claimedTotal: 77n });
    expect(findReceipt(utxos, cat, 99)).toBeUndefined();
  });
});

describe('entry-point guards (tsx src/demo.ts, tsx src/cli.ts)', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
  });

  it('demo.ts runs the demo with argv[2] leaves and exits 0 when executed directly', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.argv = [argv[0], fileURLToPath(new URL('../packages/drops/src/demo.ts', import.meta.url)), '16'];
    vi.resetModules();
    await import('../packages/drops/src/demo');
    expect(log.mock.calls.some((c) => String(c[0]).startsWith('epoch 1: 16 leaves'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('cli.ts runs runCli(argv) and exits 0 when executed directly', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.argv = [argv[0], fileURLToPath(new URL('../packages/drops/src/cli.ts', import.meta.url)), 'cost', '--users', '7'];
    vi.resetModules();
    await import('../packages/drops/src/cli');
    expect(JSON.parse(String(log.mock.calls.at(-1)![0])).users).toBe(7);
    expect(exit).toHaveBeenCalledWith(0);
    expect(existsSync(new URL('../packages/drops/deployments/tree-1.json', import.meta.url))).toBe(true); // untouched
  });
});

describe('decimalToUnits (exact amount → base units)', () => {
  it('does not lose a unit to float error and truncates extra digits', async () => {
    const { decimalToUnits } = await import('../packages/drops/src/sources');
    expect(Math.floor(0.29 * 1e8)).toBe(28999999); // the bug this replaces
    expect(decimalToUnits(0.29, 8)).toBe(29000000n);
    expect(decimalToUnits(5465.2001826, 8)).toBe(546520018260n);
    expect(decimalToUnits(1.123456789, 8)).toBe(112345678n);
    expect(decimalToUnits(1e-7, 8)).toBe(10n);
    expect(decimalToUnits(1e-9, 8)).toBe(0n);
    expect(decimalToUnits(1e21, 2)).toBe(10n ** 23n);
    expect(decimalToUnits(42, 0)).toBe(42n);
    for (const bad of [0, -1, NaN, Infinity]) expect(decimalToUnits(bad, 8)).toBe(0n);
  });
});
