/**
 * Hermes Drops CLI.
 *   tsx src/cli.ts tree    --from 2026-09-01 --to 2026-11-01 [--leaves 400] [--include addr1,addr2] → deployments/tree-<epoch>.json
 *   tsx src/cli.ts deploy  --network chipnet|mock [--shards 8] [--timelock 144]           (key prompted)
 *   tsx src/cli.ts publish --network chipnet --epoch 1                                    (authority key prompted)
 *   tsx src/cli.ts promote --network chipnet                                              (any funder key)
 *   tsx src/cli.ts status  --network chipnet
 *   tsx src/cli.ts cancel  --network chipnet --epoch 2 [--shard 0]                        (authority veto before promotion)
 *   tsx src/cli.ts proof   --address <cashaddr> [--epoch N]                              → proof JSON for any client
 *   tsx src/cli.ts cost    [--users 3000]
 *   tsx src/cli.ts demo    [--leaves 400]
 * Non-secret outputs (categories, addresses, trees) go to deployments/. Keys never touch disk.
 */
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo, type NetworkProvider, type Utxo } from 'cashscript';
import { getProvider, privateKeyFrom, walletFromPrivateKey, HERMES, type BchNetwork } from '@hermes/chain';
import { promptSecret } from '@hermes/chain/prompt';
import { deployDrops, type Deployment } from './deploy.js';
import { dropsContracts } from './contracts.js';
import { MerkleTree, type Entitlement } from './merkle.js';
import { AccountRegistry, accumulate, fetchFoldingCashDistro, padWithSample, includeAddresses } from './sources.js';
import { proofFor, readPoolStatus, electrumHeights } from './status.js';
import { buildCancel, buildPublish, buildPromote } from './tx.js';
import { cashAddressToLockingBytecode, binToHex } from '@bitauth/libauth';
import { decodePending, decodeShardState } from './state.js';
import { costModel } from './cost.js';
import { runDemo } from './demo.js';

type S = Utxo & { lockingBytecode: string };

export const DEFAULT_DIR = new URL('../deployments/', import.meta.url);
export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

/** `--name value` lookup: the token after the flag, or the default. */
export const optFrom = (args: string[]) => (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

/** Network flag; mainnet is refused here (owner approval required, CLAUDE.md). */
export function parseNetwork(n = 'chipnet'): BchNetwork | 'mock' {
  if (n === 'mainnet') {
    throw new Error('Mainnet Drops deployment needs the owner’s explicit approval in chat first (CLAUDE.md). This CLI is chipnet-only until then.');
  }
  return n as BchNetwork | 'mock';
}

/** Number of set bits in a shard bitmap = accounts that claimed at least once. */
export const claimedCount = (bitmap: Uint8Array) => [...bitmap].reduce((n, b) => n + b.toString(2).split('1').length - 1, 0);

/** Epoch for `proof`: `--epoch N`, or the latest tree-N.json present. */
export function latestEpoch(dir: URL) {
  let epoch = 1;
  while (existsSync(new URL(`tree-${epoch + 1}.json`, dir))) epoch++;
  return epoch;
}

export interface CliDeps {
  dir: URL;
  getProvider: (n: BchNetwork) => NetworkProvider;
  promptSecret: (q: string) => Promise<string>;
  fetchDistro: typeof fetchFoldingCashDistro;
  runDemo: typeof runDemo;
  log: (s: string) => void;
}

export async function runCli(args: string[], deps: Partial<CliDeps> = {}) {
  const cmd = args[0];
  const opt = optFrom(args);
  const dir = deps.dir ?? DEFAULT_DIR;
  const file = (n: string) => new URL(n, dir);
  const log = deps.log ?? console.log;
  const providerFor = deps.getProvider ?? getProvider;
  const prompt = deps.promptSecret ?? promptSecret;
  const fetchDistro = deps.fetchDistro ?? fetchFoldingCashDistro;
  const network = () => parseNetwork(opt('network', 'chipnet'));
  switch (cmd) {
    case 'demo':
      await (deps.runDemo ?? runDemo)({ log, leaves: Number(opt('leaves', '400')) });
      return;
    case 'cost': {
      const users = Number(opt('users', '3000'));
      const r = costModel({ users, epochs: 12, claimRate: Number(opt('claim-rate', '0.25')), feeRate: 1, tokenDust: 1000, shards: HERMES.drops.shards });
      log(json({ users, ...r }));
      return;
    }
    case 'tree': {
      const from = new Date(opt('from', '2026-09-01')!);
      const to = new Date(opt('to', '2026-11-01')!);
      const leaves = Number(opt('leaves', String(HERMES.drops.demoLeaves)));
      const decimals = Number(opt('decimals', '8'));
      const monthly = Number(opt('amount', '1000000'));
      const regFile = file('registry.json');
      const registry = new AccountRegistry(existsSync(regFile) ? JSON.parse(readFileSync(regFile, 'utf8')) : {});
      let cumulative = new Map<string, bigint>();
      let epoch = 0;
      let entries: Entitlement[] = [];
      for (let start = new Date(from); start < to; epoch++) {
        const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
        const distro = await fetchDistro(start, end, monthly);
        const r = accumulate(cumulative, distro, decimals, registry);
        cumulative = r.cumulative;
        entries = padWithSample(includeAddresses(r.entries, (opt('include') ?? '').split(',').filter(Boolean), BigInt(opt('include-amount', '100000')!) * BigInt(epoch + 1), registry), leaves, registry);
        const tree = new MerkleTree(entries);
        // `params` lets the watcher recompute this exact root (including demo addresses added with --include).
        const params = { decimals, monthly, leaves, include: (opt('include') ?? '').split(',').filter(Boolean), includeAmount: opt('include-amount', '100000') };
        writeFileSync(file(`tree-${epoch + 1}.json`), json({ epoch: epoch + 1, window: [start, end], params, realMembers: r.entries.length, skipped: r.skipped, leaves: entries.length, depth: tree.depth, root: tree.root, entries }));
        log(`epoch ${epoch + 1}: ${r.entries.length} FoldingCash members + ${entries.length - r.entries.length} sample = ${entries.length} leaves, root ${tree.root}`);
        start = end;
      }
      writeFileSync(regFile, json(registry.toJSON()));
      return;
    }
    case 'deploy': {
      const net = network();
      const shards = Number(opt('shards', String(HERMES.drops.shards)));
      const timelock = Number(opt('timelock', String(HERMES.drops.rootTimelockBlocks)));
      let provider;
      let key: Uint8Array;
      if (net === 'mock') {
        provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
        key = generatePrivateKey();
        provider.addUtxo(walletFromPrivateKey(key, 'mock').address, randomUtxo({ satoshis: 1_000_000n }));
      } else {
        provider = providerFor(net);
        key = privateKeyFrom(await prompt(`Drops authority key for ${net} (WIF / hex / mnemonic): `));
      }
      const w = walletFromPrivateKey(key, net);
      const d = await deployDrops({ provider, network: net, authority: w, shards, rootTimelock: timelock, rewardCategory: opt('reward-category') });
      writeFileSync(file(`${net}.json`), json(d));
      log(`deployment written to deployments/${net}.json`);
      return;
    }
    case 'publish': {
      const net = network() as BchNetwork;
      const d: Deployment = JSON.parse(readFileSync(file(`${net}.json`), 'utf8'));
      const epoch = Number(opt('epoch', '1'));
      const tree = JSON.parse(readFileSync(file(`tree-${epoch}.json`), 'utf8'));
      const provider = providerFor(net);
      const w = walletFromPrivateKey(privateKeyFrom(await prompt('Authority key: ')), net);
      const c = dropsContracts(d.config, provider);
      const utxos = [...(await provider.getUtxos(w.address)), ...(await provider.getUtxos(w.tokenAddress))] as S[];
      const tx = await buildPublish({ provider, contracts: c, authority: w.signer, authorityAddress: w.address, authorityTokenAddress: w.tokenAddress, authorityUtxos: utxos, pendingCategory: d.config.pendingCategory, epoch, root: tree.root, shards: d.shards }).send();
      log(`published epoch ${epoch} root ${tree.root}: ${tx.txid} — promotable after ${d.config.rootTimelock} blocks`);
      return;
    }
    case 'promote': {
      const net = network() as BchNetwork;
      const d: Deployment = JSON.parse(readFileSync(file(`${net}.json`), 'utf8'));
      const provider = providerFor(net);
      const c = dropsContracts(d.config, provider);
      const w = walletFromPrivateKey(privateKeyFrom(await prompt('Funder key (pays the fee): ')), net);
      const shards = (await provider.getUtxos(c.shard.tokenAddress)) as S[];
      const pendings = (await provider.getUtxos(c.pending.tokenAddress)) as S[];
      for (const p of pendings) {
        if (p.token?.category !== d.config.pendingCategory || !p.token.nft) continue;
        const pend = decodePending(p.token.nft.commitment);
        const shard = shards.find((s) => s.token?.category === d.config.receiptCategory && s.token.nft && decodeShardState(s.token.nft.commitment).shardIndex === pend.shardIndex);
        if (!shard) continue;
        try {
          const tx = await buildPromote({ provider, contracts: c, receiptCategory: d.config.receiptCategory, shardUtxo: shard, pendingUtxo: p, rootTimelock: d.config.rootTimelock, funder: { address: w.address, utxos: (await provider.getUtxos(w.address)) as S[], signer: w.signer } }).send();
          log(`shard ${pend.shardIndex} → epoch ${pend.epoch}: ${tx.txid}`);
        } catch (e) {
          log(`shard ${pend.shardIndex}: not promotable yet (${(e as Error).message.slice(0, 120)})`);
        }
      }
      return;
    }
    case 'cancel': {
      const net = network() as BchNetwork;
      const d: Deployment = JSON.parse(readFileSync(file(`${net}.json`), 'utf8'));
      const provider = providerFor(net);
      const c = dropsContracts(d.config, provider);
      const w = walletFromPrivateKey(privateKeyFrom(await prompt('Authority key: ')), net);
      const epoch = Number(opt('epoch'));
      if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('--epoch required (the pending epoch to cancel)');
      const shard = opt('shard');
      let cancelled = 0;
      for (const p of (await provider.getUtxos(c.pending.tokenAddress)) as S[]) {
        if (p.token?.category !== d.config.pendingCategory || !p.token.nft) continue;
        const pend = decodePending(p.token.nft.commitment);
        if (pend.epoch !== epoch || (shard !== undefined && pend.shardIndex !== Number(shard))) continue;
        const tx = await buildCancel({ provider, contracts: c, authority: w.signer, authorityAddress: w.address, pendingUtxo: p, funding: ((await provider.getUtxos(w.address)) as S[]).filter((u) => !u.token) }).send();
        log(`cancelled pending root epoch ${epoch} shard ${pend.shardIndex}: ${tx.txid}`);
        cancelled++;
      }
      if (!cancelled) log(`no pending root for epoch ${epoch}${shard !== undefined ? ` shard ${shard}` : ''} (already promoted, cancelled, or never published)`);
      return;
    }
    case 'proof': {
      const addr = opt('address');
      if (!addr) throw new Error('--address required');
      const lb = cashAddressToLockingBytecode(addr);
      if (typeof lb === 'string') throw new Error(lb);
      let epoch = Number(opt('epoch', '0'));
      if (!epoch) epoch = latestEpoch(dir);
      const p = proofFor(JSON.parse(readFileSync(file(`tree-${epoch}.json`), 'utf8')), binToHex(lb.bytecode));
      if (!p) throw new Error(`address not in epoch ${epoch}`);
      log(json(p));
      return;
    }
    case 'status': {
      const net = network() as BchNetwork;
      const d: Deployment = JSON.parse(readFileSync(file(`${net}.json`), 'utf8'));
      const provider = providerFor(net);
      const c = dropsContracts(d.config, provider);
      for (const s of (await provider.getUtxos(c.shard.tokenAddress)) as S[]) {
        if (s.token?.category !== d.config.receiptCategory || !s.token.nft) continue;
        const st = decodeShardState(s.token.nft.commitment);
        const claimed = claimedCount(st.bitmap);
        log(`shard ${st.shardIndex}: epoch ${st.epoch} root ${st.root.slice(0, 16)}… claimed accounts ${claimed}`);
      }
      const vault = ((await provider.getUtxos(c.vault.tokenAddress)) as S[]).filter((u) => u.token?.category === d.config.rewardCategory);
      log(`vault: ${vault.reduce((n, u) => n + (u.token?.amount ?? 0n), 0n)} reward units in ${vault.length} UTXOs`);
      const pend = ((await provider.getUtxos(c.pending.tokenAddress)) as S[]).filter((u) => u.token?.category === d.config.pendingCategory && u.token.nft);
      log(`pending roots: ${pend.length}`);
      const trees = [];
      for (let e = 1; existsSync(file(`tree-${e}.json`)); e++) trees.push(JSON.parse(readFileSync(file(`tree-${e}.json`), 'utf8')));
      const pool = await readPoolStatus({ provider, config: d.config, trees, heights: electrumHeights(provider) });
      for (const p of pool.pending) {
        const audit = p.matchesTree === undefined ? 'no tree file for this epoch' : p.matchesTree ? `matches tree-${p.epoch}.json` : `DOES NOT MATCH tree-${p.epoch}.json (cancel --epoch ${p.epoch})`;
        const wait = p.remaining === undefined ? 'age unknown' : p.remaining ? `promotable in ${p.remaining} block(s)` : 'promotable now';
        log(`  pending shard ${p.shardIndex} epoch ${p.epoch} root ${p.root.slice(0, 16)}… ${audit}; ${wait}`);
      }
      return;
    }
    default:
      log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 11).join('\n'));
  }
}

/** True when this module is the process entry point (tsx src/cli.ts …), not an import. */
export function isEntry(moduleUrl: string, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}

if (isEntry(import.meta.url)) {
  await runCli(process.argv.slice(2));
  process.exit(0);
}
