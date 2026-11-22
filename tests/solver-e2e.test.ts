/**
 * The real solver (apps/solver Solver class) and the real taker flow (apps/cli runTaker) trading
 * against each other over Nostr — through a local NIP-01 relay — with USDC on an anvil EVM node
 * and a CashToken stablecoin on the BCH 2026 VM. Exercises RFQ → quote → lock → notice →
 * counter-lock → claim → secret extraction → counter-claim, in both directions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { generatePrivateKey } from '@bitauth/libauth';
import { generateSecretKey } from 'nostr-tools/pure';
import { walletFromPrivateKey } from '@hermes/chain';
import { erc20Abi, evmChain, evmConfig, publicClientFor } from '@hermes/swap';
import { mockUsdcAbi } from '../packages/evm-htlc/abi';
import { deployHermesHtlc } from '../apps/cli/src/evm-deploy';
import { runTaker } from '../apps/cli/src/taker-core';
import { Solver } from '../apps/solver/src/solver';
import { startDevRelay } from '../scripts/relay-core';

/** Mock BCH chain that also answers Electrum `blockchain.address.get_history` (the solver watches claims with it). */
class HistoryMock extends MockNetworkProvider {
  readonly sent: { txid: string; hex: string }[] = [];
  override async sendRawTransaction(hex: string) {
    const txid = await super.sendRawTransaction(hex);
    this.sent.push({ txid, hex });
    return txid;
  }
  override async getRawTransaction(txid: string) {
    return this.sent.find((t) => t.txid === txid)?.hex ?? super.getRawTransaction(txid);
  }
  async performRequest(method: string) {
    if (method === 'blockchain.address.get_history') return this.sent.map((t) => ({ tx_hash: t.txid, height: 0 }));
    throw new Error(`unsupported ${method}`);
  }
}

const cfg = evmConfig('anvil');
const KEYS: Hex[] = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'];
let anvil: ChildProcess;
let relay: ReturnType<typeof startDevRelay>;
let solver: Solver;
const provider = new HistoryMock({ updateUtxoSet: true });
const client = publicClientFor(cfg);
const takerWallet = createWalletClient({ account: privateKeyToAccount(KEYS[0]), chain: evmChain(cfg), transport: http(cfg.rpc) });
const takerBch = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
const solverBch = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
const TPUSD = 'f0'.repeat(32);
let htlc: Address;
let usdc: Address;
const storeName = `e2e-${Date.now()}`;
const usdcOf = (a: Address) => client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
const pusdOf = async (w: typeof takerBch) => (await provider.getUtxos(w.tokenAddress)).reduce((n, u) => n + (u.token?.category === TPUSD ? u.token.amount : 0n), 0n);
const solverEvm = privateKeyToAccount(KEYS[1]).address;
const logs: string[] = [];

beforeAll(async () => {
  relay = startDevRelay([7111, 7112, 7113]);
  anvil = spawn('anvil', ['--port', '8545', '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const d = await deployHermesHtlc({ privateKey: KEYS[0], cfg, mockUsdc: true });
  htlc = d.htlc.address;
  usdc = d.usdc!.address;
  for (const who of [takerWallet.account!.address, solverEvm]) {
    await client.waitForTransactionReceipt({ hash: await takerWallet.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: 'mint', args: [who, 1_000_000_000n], account: takerWallet.account!, chain: takerWallet.chain }) });
  }
  for (const w of [takerBch, solverBch]) {
    provider.addUtxo(w.address, randomUtxo({ satoshis: 500_000n }));
    provider.addUtxo(w.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: TPUSD, amount: 1_000_000n } }));
  }
  solver = new Solver({
    bchNetwork: 'chipnet',
    evm: 'anvil',
    provider: provider as never,
    bch: solverBch,
    evmPrivateKey: KEYS[1],
    nostrSecret: generateSecretKey(),
    bchTokens: [{ category: TPUSD, decimals: 2, symbol: 'tPUSD' }],
    evmHtlc: htlc,
    usdc,
    spreadPpm: 5000,
    relays: relay.urls,
    tickMs: 800,
    storeName,
    log: (s) => logs.push(s),
  });
  await solver.start();
}, 60_000);

afterAll(() => {
  solver?.stop();
  anvil?.kill();
  relay?.close();
  rmSync(new URL(`../apps/solver/data/swaps-${storeName}.json`, import.meta.url), { force: true });
});

const waitFor = async (pred: () => boolean, ms = 30_000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error(`timeout; solver log:\n${logs.join('\n')}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};
const phases = () => [...solver.store.swaps.values()].map((s) => s.state.phase);

describe('solver ⇄ taker over Nostr (local relay, anvil, BCH VM)', () => {
  it('USDC → tPUSD: quote, both locks, both claims', async () => {
    const solverUsdc = await usdcOf(solverEvm);
    const takerPusd = await pusdOf(takerBch);
    const r = await runTaker({ relays: relay.urls, provider: provider as never, client, wallet: takerWallet, bch: takerBch, evmChainId: cfg.chainId, htlc, usdc, bchToken: TPUSD, direction: 'usdc-to-pusd', amountIn: 5_000_000n, quoteWaitMs: 2500, pollMs: 700, log: (s) => logs.push(`taker: ${s}`) });
    expect(r.quote.amountOut).toBe('497'); // 5 USDC at 0.5% spread → 4.97 tPUSD (rounded down)
    expect((await pusdOf(takerBch)) - takerPusd).toBe(497n);
    await waitFor(() => phases().includes('completed'));
    expect((await usdcOf(solverEvm)) - solverUsdc).toBe(5_000_000n);
  }, 90_000);

  it('tPUSD → USDC: taker locks on BCH first, claims USDC; solver claims tPUSD with the revealed secret', async () => {
    const takerUsdc = await usdcOf(takerWallet.account!.address);
    const solverPusd = await pusdOf(solverBch);
    const done = phases().filter((p) => p === 'completed').length;
    const r = await runTaker({ relays: relay.urls, provider: provider as never, client, wallet: takerWallet, bch: takerBch, evmChainId: cfg.chainId, htlc, usdc, bchToken: TPUSD, direction: 'pusd-to-usdc', amountIn: 1000n, quoteWaitMs: 2500, pollMs: 700, log: (s) => logs.push(`taker: ${s}`) });
    expect(r.quote.amountOut).toBe('9950000');
    expect((await usdcOf(takerWallet.account!.address)) - takerUsdc).toBe(9_950_000n);
    await waitFor(() => phases().filter((p) => p === 'completed').length === done + 1);
    expect((await pusdOf(solverBch)) - solverPusd).toBe(1000n);
  }, 90_000);
});
