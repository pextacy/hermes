/**
 * hermes swap demo — both swap directions and a refund across two real VMs: a local anvil node
 * (Solidity HTLC + 6-decimal token) and the BCH 2026 VM (CashScript HTLC + CashToken), printed
 * step by step. Needs Foundry's `anvil` on PATH. Uses anvil's public development keys only.
 */
import { spawn } from 'node:child_process';
import { createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { MockNetworkProvider, SignatureTemplate, randomUtxo, type Utxo } from 'cashscript';
import { generatePrivateKey } from '@bitauth/libauth';
import { walletFromPrivateKey, formatUnits } from '@hermes/chain';
import { buildClaim, buildLock, erc20Abi, evmChain, evmClaim, evmLock, evmRefund, extractPreimageFromBchTx, findEvmPreimage, generateSecret, htlcContract, publicClientFor, validateTimeouts, type EvmChainConfig } from '@hermes/swap';
import { hermesHtlcAbi, hermesHtlcBytecode, mockUsdcAbi, mockUsdcBytecode } from '../../../packages/evm-htlc/abi.js';

type S = Utxo & { lockingBytecode: string };
const PORT = 8548;
const cfg: EvmChainConfig = { chainId: 31337, name: 'Anvil', rpc: `http://127.0.0.1:${PORT}`, explorerTx: '', usdc: null, htlc: null, confirmations: 1 };
const KEYS: Hex[] = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'];

export async function swapDemo() {
  const anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  try {
    const client = publicClientFor(cfg);
    for (let i = 0; i < 50; i++) { try { await client.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
    const [taker, solver] = KEYS.map((k) => createWalletClient({ account: privateKeyToAccount(k), chain: evmChain(cfg), transport: http(cfg.rpc) }));
    const deploy = async (abi: readonly unknown[], bytecode: string) =>
      (await client.waitForTransactionReceipt({ hash: await taker.deployContract({ abi, bytecode: bytecode as Hex, account: taker.account!, chain: taker.chain } as never) })).contractAddress as Address;
    const usdc = await deploy(mockUsdcAbi, mockUsdcBytecode);
    const htlc = await deploy(hermesHtlcAbi, hermesHtlcBytecode);
    for (const w of [taker, solver]) await client.waitForTransactionReceipt({ hash: await taker.writeContract({ address: usdc, abi: mockUsdcAbi, functionName: 'mint', args: [w.account!.address, 100_000_000n], account: taker.account!, chain: taker.chain }) });
    const bal = async (a: Address) => formatUnits(await client.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a] }), 6);
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    const [tb, sb] = [walletFromPrivateKey(generatePrivateKey(), 'chipnet'), walletFromPrivateKey(generatePrivateKey(), 'chipnet')];
    const PUSD = 'ee'.repeat(32);
    for (const w of [tb, sb]) { provider.addUtxo(w.address, randomUtxo({ satoshis: 100_000n })); provider.addUtxo(w.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: PUSD, amount: 10_000n } })); }
    const utx = async (w: typeof tb) => [...(await provider.getUtxos(w.address)), ...(await provider.getUtxos(w.tokenAddress))] as S[];
    const pusd = async (w: typeof tb) => formatUnits((await provider.getUtxos(w.tokenAddress)).reduce((n, u) => n + (u.token?.category === PUSD ? u.token.amount : 0n), 0n), 2);
    const t0 = Number((await client.getBlock()).timestamp);
    const tFirst = t0 + 3 * 3600, tSecond = t0 + 3600;
    console.log(`timeouts ok: ${validateTimeouts(tFirst, tSecond, t0).length === 0} (T_first = T_second + 2 h)`);

    console.log('\n— USDC → PUSD —');
    let { secret, hashlock } = generateSecret();
    const { id } = await evmLock({ wallet: taker, client, htlc, token: usdc, amount: 5_000_000n, recipient: solver.account!.address, hashlock: `0x${hashlock}`, timeout: BigInt(tFirst) });
    console.log(`1 taker locks 5 USDC on EVM (${id.slice(0, 14)}…)`);
    let c = htlcContract({ recipientPkh: tb.pkh, refundPkh: sb.pkh, hashlock, timeout: tSecond }, provider);
    await buildLock({ provider, contract: c, from: sb.address, utxos: await utx(sb), token: { category: PUSD, amount: 497n }, signer: new SignatureTemplate(sb.signer.privateKey) }).send();
    console.log('2 solver locks 4.97 PUSD on BCH');
    const claim = await buildClaim({ provider, contract: c, utxo: (await c.getUtxos())[0] as S, recipient: tb.signer, recipientTokenAddr: tb.tokenAddress, preimage: secret }).send();
    console.log(`3 taker claims PUSD on BCH, revealing the secret (taker PUSD ${await pusd(tb)})`);
    await evmClaim({ wallet: solver, client, htlc, id, preimage: `0x${extractPreimageFromBchTx(claim.hex, hashlock)}` });
    console.log(`4 solver reads the secret from BCH and claims USDC (solver USDC ${await bal(solver.account!.address)})`);

    console.log('\n— PUSD → USDC —');
    ({ secret, hashlock } = generateSecret());
    c = htlcContract({ recipientPkh: sb.pkh, refundPkh: tb.pkh, hashlock, timeout: tFirst }, provider);
    await buildLock({ provider, contract: c, from: tb.address, utxos: await utx(tb), token: { category: PUSD, amount: 1000n }, signer: new SignatureTemplate(tb.signer.privateKey) }).send();
    console.log('1 taker locks 10.00 PUSD on BCH');
    const l2 = await evmLock({ wallet: solver, client, htlc, token: usdc, amount: 9_950_000n, recipient: taker.account!.address, hashlock: `0x${hashlock}`, timeout: BigInt(tSecond) });
    console.log('2 solver locks 9.95 USDC on EVM');
    await evmClaim({ wallet: taker, client, htlc, id: l2.id, preimage: `0x${secret}` });
    console.log(`3 taker claims USDC (taker USDC ${await bal(taker.account!.address)})`);
    const s2 = (await findEvmPreimage(client, htlc, l2.id))!.slice(2);
    await buildClaim({ provider, contract: c, utxo: (await c.getUtxos())[0] as S, recipient: sb.signer, recipientTokenAddr: sb.tokenAddress, preimage: s2 }).send();
    console.log(`4 solver reads the secret from the EVM event and claims PUSD (solver PUSD ${await pusd(sb)})`);

    console.log('\n— refund —');
    const l3 = await evmLock({ wallet: taker, client, htlc, token: usdc, amount: 1_000_000n, recipient: solver.account!.address, hashlock: `0x${generateSecret().hashlock}`, timeout: BigInt(tFirst) });
    try { await evmRefund({ wallet: taker, client, htlc, id: l3.id }); console.log('BUG: early refund'); } catch { console.log('early refund rejected ✔'); }
    await client.request({ method: 'evm_increaseTime' as never, params: [3 * 3600 + 1] as never });
    await client.request({ method: 'evm_mine' as never, params: [] as never });
    await evmRefund({ wallet: taker, client, htlc, id: l3.id });
    console.log(`refund after T_first ✔ (taker USDC ${await bal(taker.account!.address)})`);
  } finally {
    anvil.kill();
  }
}
