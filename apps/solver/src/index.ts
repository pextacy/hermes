/**
 * Hermes solver — liquidity provider for USDC ⇄ PUSD swaps (docs/PLAN.md §4.5).
 *
 *   pnpm --filter solver dev -- --network chipnet --evm baseSepolia [--htlc 0x…] [--usdc 0x…] [--rpc URL]
 *        [--token PUSD|MUSD | --pusd <category>] [--spread-ppm 5000]
 *   pnpm --filter solver status -- --network chipnet --evm baseSepolia
 *   pnpm --filter solver mint-test-tokens -- --network chipnet [--supply 100000000]
 *
 * Keys (BCH key, EVM key, Nostr key) are typed in at start and kept in memory only.
 * Mainnet BCH is refused unless the owner approved it in chat (--i-have-owner-approval).
 */

import { TransactionBuilder, type Utxo } from 'cashscript';
import { generateSecretKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import type { Address, Hex } from 'viem';
import { HERMES, getProvider, getTokenMeta, privateKeyFrom, stablecoins, tokenConfig, walletFromPrivateKey, type BchNetwork } from '@hermes/chain';
import { promptSecret } from '@hermes/chain/prompt';
import { evmConfig, type EvmKey } from '@hermes/swap';
import { Solver } from './solver.js';
import { SwapStore } from './store.js';

type S = Utxo & { lockingBytecode: string };
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n: string, d?: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const network = opt('network', 'chipnet') as BchNetwork;
if (network === 'mainnet' && !args.includes('--i-have-owner-approval')) {
  console.error('Refusing BCH mainnet without the owner’s explicit approval (CLAUDE.md).');
  process.exit(1);
}

async function bchWallet() {
  return walletFromPrivateKey(privateKeyFrom(await promptSecret(`BCH ${network} key (WIF / hex / mnemonic): `)), network);
}

if (cmd === 'status') {
  // Bookkeeping only (no keys): every swap this solver quoted, its phase and timeouts.
  const store = new SwapStore(`${network}-${opt('evm', 'baseSepolia')}`);
  const rows = [...store.swaps.values()].sort((a, b) => b.createdAt - a.createdAt);
  const t = Math.floor(Date.now() / 1000);
  const fmt = (x: number) => (x > t ? `in ${Math.round((x - t) / 60)} min` : `${Math.round((t - x) / 60)} min ago`);
  for (const s of rows) {
    console.log(`${s.quote.quoteId.slice(0, 8)}  ${s.rfq.direction.padEnd(13)} ${s.quote.amountIn.padStart(12)} → ${s.quote.amountOut.padEnd(12)} ${s.state.phase.padEnd(15)} T1 ${fmt(s.quote.tFirst)}  T2 ${fmt(s.quote.tSecond)}${s.lastError ? `  ! ${s.lastError.slice(0, 60)}` : ''}`);
  }
  const by = (p: string) => rows.filter((s) => s.state.phase === p).length;
  console.log(`${rows.length} swaps · completed ${by('completed')} · open ${rows.filter((s) => ['first-locked', 'second-locked', 'second-claimed'].includes(s.state.phase)).length} · refunded ${by('refunded') + by('first-refunded') + by('second-refunded')} · USD last hour ${store.usdLastHour(t)}`);
  process.exit(0);
}

if (cmd === 'mint-test-tokens') {
  // Mint a test stablecoin (tPUSD by default, --symbol MUSD for tMUSD) on chipnet for demo inventory (never on mainnet).
  if (network === 'mainnet') throw new Error('test tokens are testnet-only (chipnet or testnet4)');
  const w = await bchWallet();
  const provider = getProvider(network);
  const utxos = ((await provider.getUtxos(w.address)) as S[]).filter((u) => !u.token);
  const prep = await new TransactionBuilder({ provider })
    .addInputs(utxos, w.signer.unlockP2PKH())
    .addOutput({ to: w.address, amount: 5000n })
    .addBchChangeOutputIfNeeded({ to: w.address, feeRate: 1 })
    .send();
  const category = prep.txid;
  const supply = BigInt(opt('supply', '100000000')!); // 1,000,000.00 tPUSD at 2 decimals
  const tx = await new TransactionBuilder({ provider })
    .addInput({ txid: prep.txid, vout: 0, satoshis: 5000n, lockingBytecode: w.lockingBytecode }, w.signer.unlockP2PKH())
    .addOutput({ to: w.tokenAddress, amount: 1000n, token: { category, amount: supply } })
    .addBchChangeOutputIfNeeded({ to: w.address, feeRate: 1 })
    .send();
  console.log(`t${opt('symbol', 'PUSD')} category ${category} (genesis ${tx.txid}); put it in config/networks.json → bch.${network}.tokens.${opt('symbol', 'PUSD')}.category`);
  process.exit(0);
}

if (cmd === 'run') {
  const evm = opt('evm', 'baseSepolia') as EvmKey;
  const ec = evmConfig(evm);
  const htlc = (opt('htlc') ?? ec.htlc) as Address | null;
  const usdc = (opt('usdc') ?? ec.usdc) as Address | null;
  // Every configured BCH stablecoin (PUSD, MoriaUSD, …) or only the one passed with --pusd / --token.
  // Decimals come from token metadata (BCMR); the config value is only the fallback (invariant 6).
  const only = opt('token');
  const wanted = opt('pusd')
    ? [{ category: opt('pusd')!, symbol: 'PUSD', decimalsFallback: Number(opt('pusd-decimals', '2')) }]
    : stablecoins(network).filter((t) => !only || t.key === only);
  const bchTokens = await Promise.all(
    wanted.map(async (t) => {
      const m = await getTokenMeta(t.category, { symbol: t.symbol, decimals: t.decimalsFallback });
      return { category: t.category, decimals: m.decimals, symbol: t.symbol };
    }),
  );
  if (!htlc || !usdc || !bchTokens.length) {
    console.error('Missing EVM HTLC / USDC address or PUSD category: deploy/mint first, then set them in config/networks.json or pass --htlc/--usdc/--pusd.');
    process.exit(1);
  }
  const bch = await bchWallet();
  const evmKey = (await promptSecret(`EVM private key for ${ec.name} (0x…): `)) as Hex;
  const nsecIn = await promptSecret('Nostr nsec for the solver (empty = fresh key for this session): ');
  const nostrSecret = nsecIn ? (nip19.decode(nsecIn).data as Uint8Array) : generateSecretKey();
  const solver = new Solver({
    bchNetwork: network,
    evm,
    provider: getProvider(network),
    bch,
    evmPrivateKey: evmKey,
    nostrSecret,
    bchTokens,
    evmHtlc: htlc,
    usdc,
    evmRpc: opt('rpc'),
    spreadPpm: Number(opt('spread-ppm', '5000')),
  });
  await solver.start();
  console.log(`solver npub ${nip19.npubEncode(solver.nostrPubkey)} — caps: ${HERMES.swap.solverCapUsdPerSwap}/swap, ${HERMES.swap.solverCapUsdPerHour}/h (testnet unlimited: ${HERMES.swap.testnetUnlimited})`);
  process.on('SIGINT', () => {
    solver.stop();
    process.exit(0);
  });
} else if (cmd !== 'mint-test-tokens' && cmd !== 'status') {
  console.log('usage: tsx src/index.ts run|status|mint-test-tokens --network chipnet [--evm baseSepolia]');
}
