/**
 * End-to-end atomic swaps across two real VMs: an anvil EVM node (Foundry) running the
 * Solidity HTLC with a 6-decimal token, and the BCH 2026 VM (CashScript mock network)
 * running the CashScript HTLC with a CashToken. Exercises both directions and a refund,
 * using the same library calls the solver and the web app use.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWalletClient, http, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MockNetworkProvider, SignatureTemplate, randomUtxo, type Utxo } from 'cashscript';
import { generatePrivateKey } from '@bitauth/libauth';
import { walletFromPrivateKey } from '@hermes/chain';
import {
  buildClaim,
  buildLock,
  erc20Abi,
  evmChain,
  evmClaim,
  evmLock,
  evmRefund,
  extractPreimageFromBchTx,
  findEvmLocks,
  findEvmPreimage,
  generateSecret,
  htlcContract,
  publicClientFor,
  readLock,
  validateTimeouts,
  type EvmChainConfig,
} from '@hermes/swap';
import { hermesHtlcAbi, hermesHtlcBytecode, mockUsdcAbi, mockUsdcBytecode } from '../packages/evm-htlc/abi';
import { deployHermesHtlc, recordEvmDeployment } from '../apps/cli/src/evm-deploy';
import { copyFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type S = Utxo & { lockingBytecode: string };
const PORT = 8547;
const cfg: EvmChainConfig = { chainId: 31337, name: 'Anvil', rpc: `http://127.0.0.1:${PORT}`, explorerTx: '', usdc: null, htlc: null, confirmations: 1 };
// Anvil's well-known development keys (public, test only).
const TAKER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SOLVER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

let anvil: ChildProcess;
let client: PublicClient;
let taker: WalletClient;
let solver: WalletClient;
let usdc: Address;
let htlc: Address;
const takerAddr = privateKeyToAccount(TAKER_KEY).address;
const solverAddr = privateKeyToAccount(SOLVER_KEY).address;

const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: evmChain(cfg), transport: http(cfg.rpc) });

async function deploy(abi: readonly unknown[], bytecode: Hex) {
  const hash = await taker.deployContract({ abi, bytecode, account: taker.account!, chain: taker.chain } as never);
  const r = await client.waitForTransactionReceipt({ hash });
  return r.contractAddress as Address;
}

const evmNow = async () => Number((await client.getBlock()).timestamp);
const balance = (who: Address) => client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] });

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  client = publicClientFor(cfg);
  for (let i = 0; i < 50; i++) {
    try {
      await client.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  taker = wallet(TAKER_KEY);
  solver = wallet(SOLVER_KEY);
  usdc = await deploy(mockUsdcAbi, mockUsdcBytecode as Hex);
  htlc = await deploy(hermesHtlcAbi, hermesHtlcBytecode as Hex);
  for (const who of [takerAddr, solverAddr]) {
    const h = await taker.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: 'mint', args: [who, 1_000_000_000n], account: taker.account!, chain: taker.chain });
    await client.waitForTransactionReceipt({ hash: h });
  }
}, 60_000);

afterAll(() => anvil?.kill());

function bchSide() {
  const provider = new MockNetworkProvider({ updateUtxoSet: true });
  const takerBch = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
  const solverBch = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
  const PUSD = 'ee'.repeat(32);
  for (const w of [takerBch, solverBch]) {
    provider.addUtxo(w.address, randomUtxo({ satoshis: 100_000n }));
    provider.addUtxo(w.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: PUSD, amount: 100_000n } }));
  }
  const utxosOf = async (w: typeof takerBch) => [...(await provider.getUtxos(w.address)), ...(await provider.getUtxos(w.tokenAddress))] as S[];
  const pusdOf = async (w: typeof takerBch) => (await provider.getUtxos(w.tokenAddress)).reduce((n, u) => n + (u.token?.category === PUSD ? u.token.amount : 0n), 0n);
  return { provider, takerBch, solverBch, PUSD, utxosOf, pusdOf };
}

describe('USDC ⇄ PUSD atomic swaps (anvil + BCH VM)', () => {
  it('USDC → PUSD: taker locks USDC, solver locks PUSD, taker claims PUSD, solver claims USDC with the revealed secret', async () => {
    const b = bchSide();
    const now = await evmNow();
    const tFirst = now + 3 * 3600;
    const tSecond = now + 3600;
    expect(validateTimeouts(tFirst, tSecond, now)).toEqual([]);
    const { secret, hashlock } = generateSecret();
    const usdcIn = 5_000_000n; // 5.000000 USDC
    const pusdOut = 497n; // 4.97 PUSD

    // 1. taker locks USDC for the solver (longer timeout)
    const solverBefore = await balance(solverAddr);
    const { id } = await evmLock({ wallet: taker, client, htlc, token: usdc, amount: usdcIn, recipient: solverAddr, hashlock: `0x${hashlock}`, timeout: BigInt(tFirst) });
    // 2. solver sees the lock on chain and checks its terms
    const seen = (await findEvmLocks(client, htlc, { recipient: solverAddr })).find((l) => l.id === id)!;
    expect(seen.amount).toBe(usdcIn);
    expect(Number(seen.timeout)).toBe(tFirst);
    // 3. solver locks PUSD on BCH for the taker (shorter timeout)
    const c = htlcContract({ recipientPkh: b.takerBch.pkh, refundPkh: b.solverBch.pkh, hashlock: seen.hashlock.slice(2), timeout: tSecond }, b.provider);
    await buildLock({ provider: b.provider, contract: c, from: b.solverBch.address, utxos: await b.utxosOf(b.solverBch), token: { category: b.PUSD, amount: pusdOut }, signer: new SignatureTemplate(b.solverBch.signer.privateKey) }).send();
    // 4. taker claims PUSD, revealing the secret on BCH
    const [htlcUtxo] = (await c.getUtxos()) as S[];
    const claimTx = await buildClaim({ provider: b.provider, contract: c, utxo: htlcUtxo, recipient: b.takerBch.signer, recipientTokenAddr: b.takerBch.tokenAddress, preimage: secret }).send();
    expect(await b.pusdOf(b.takerBch)).toBe(100_000n + pusdOut);
    // 5. solver reads the secret from the BCH transaction and claims USDC
    const revealed = extractPreimageFromBchTx(claimTx.hex, hashlock);
    expect(revealed).toBe(secret);
    await evmClaim({ wallet: solver, client, htlc, id, preimage: `0x${revealed}` });
    expect((await balance(solverAddr)) - solverBefore).toBe(usdcIn);
    expect((await readLock(client, htlc, id)).state).toBe('claimed');
  });

  it('PUSD → USDC: taker locks PUSD, solver locks USDC, taker claims USDC, solver claims PUSD', async () => {
    const b = bchSide();
    const now = await evmNow();
    const tFirst = now + 3 * 3600;
    const tSecond = now + 3600;
    const { secret, hashlock } = generateSecret();
    const pusdIn = 1_000n; // 10.00 PUSD
    const usdcOut = 9_950_000n;

    const c = htlcContract({ recipientPkh: b.solverBch.pkh, refundPkh: b.takerBch.pkh, hashlock, timeout: tFirst }, b.provider);
    await buildLock({ provider: b.provider, contract: c, from: b.takerBch.address, utxos: await b.utxosOf(b.takerBch), token: { category: b.PUSD, amount: pusdIn }, signer: new SignatureTemplate(b.takerBch.signer.privateKey) }).send();
    const takerBefore = await balance(takerAddr);
    const { id } = await evmLock({ wallet: solver, client, htlc, token: usdc, amount: usdcOut, recipient: takerAddr, hashlock: `0x${hashlock}`, timeout: BigInt(tSecond) });
    await evmClaim({ wallet: taker, client, htlc, id, preimage: `0x${secret}` });
    expect((await balance(takerAddr)) - takerBefore).toBe(usdcOut);
    const revealed = await findEvmPreimage(client, htlc, id);
    expect(revealed?.slice(2)).toBe(secret);
    const [u] = (await c.getUtxos()) as S[];
    await buildClaim({ provider: b.provider, contract: c, utxo: u, recipient: b.solverBch.signer, recipientTokenAddr: b.solverBch.tokenAddress, preimage: revealed!.slice(2) }).send();
    expect(await b.pusdOf(b.solverBch)).toBe(100_000n + pusdIn);
  });

  it('refund: the solver never locks, the taker gets the USDC back after T_first (and not before)', async () => {
    const now = await evmNow();
    const { hashlock } = generateSecret();
    const before = await balance(takerAddr);
    const { id } = await evmLock({ wallet: taker, client, htlc, token: usdc, amount: 2_000_000n, recipient: solverAddr, hashlock: `0x${hashlock}`, timeout: BigInt(now + 3 * 3600) });
    expect(await balance(takerAddr)).toBe(before - 2_000_000n);
    await expect(evmRefund({ wallet: taker, client, htlc, id })).rejects.toThrow();
    await client.request({ method: 'evm_increaseTime' as never, params: [3 * 3600 + 1] as never });
    await client.request({ method: 'evm_mine' as never, params: [] as never });
    await evmRefund({ wallet: taker, client, htlc, id });
    expect(await balance(takerAddr)).toBe(before);
    expect((await readLock(client, htlc, id)).state).toBe('refunded');
  });

  it('hermes evm deploy: deploys HTLC + mock token and records them in a networks.json', async () => {
    const { htlc: h, usdc: u } = await deployHermesHtlc({ privateKey: SOLVER_KEY, cfg, mockUsdc: true });
    expect(await client.getCode({ address: h.address })).toMatch(/^0x[0-9a-f]{100,}/);
    expect(await client.readContract({ address: u!.address, abi: erc20Abi, functionName: 'decimals' })).toBe(6);
    const file = join(mkdtempSync(join(tmpdir(), 'hermes-')), 'networks.json');
    copyFileSync(new URL('../config/networks.json', import.meta.url), file);
    recordEvmDeployment(file, 'anvil', h.address, u!.address);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    expect(j.evm.anvil.htlc).toBe(h.address);
    expect(j.evm.anvil.usdc).toBe(u!.address);
  });
});
