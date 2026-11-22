import { createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORKS, getProvider, parseUnits, privateKeyFrom, stablecoins, tokenConfig, walletFromPrivateKey, type BchNetwork } from '@hermes/chain';
import { promptSecret } from '@hermes/chain/prompt';
import { evmChain, evmConfig, publicClientFor, tokenDecimals, type Direction, type EvmKey } from '@hermes/swap';
import { opt, guardMainnet } from './args.js';
import { runTaker } from './taker-core.js';

/** hermes swap take — taker side of the Hermes quote protocol (keys typed at runtime). */
export async function take() {
  const network = opt('network', 'chipnet') as BchNetwork;
  guardMainnet(network);
  const ec = evmConfig(opt('evm', 'baseSepolia') as EvmKey);
  const coin = stablecoins(network).find((t) => t.key === opt('token', 'PUSD')) ?? tokenConfig(network, 'PUSD');
  if (!ec.htlc || !ec.usdc || !coin.category) throw new Error('Configure evm htlc/usdc and the stablecoin category first (config/networks.json).');
  const client = publicClientFor(ec);
  const bch = walletFromPrivateKey(privateKeyFrom(await promptSecret(`BCH ${network} key: `)), network);
  const account = privateKeyToAccount((await promptSecret(`EVM key for ${ec.name}: `)) as Hex);
  const wallet = createWalletClient({ account, chain: evmChain(ec), transport: http(ec.rpc) });
  const direction = opt('direction', 'usdc-to-pusd') as Direction;
  const decIn = direction === 'usdc-to-pusd' ? await tokenDecimals(client, ec.usdc as Address) : coin.decimalsFallback;
  await runTaker({
    relays: opt('relays')?.split(',') ?? NETWORKS.nostr.relays,
    provider: getProvider(network),
    client,
    wallet,
    bch,
    evmChainId: ec.chainId,
    htlc: ec.htlc as Address,
    usdc: ec.usdc as Address,
    bchToken: coin.category!,
    direction,
    amountIn: parseUnits(opt('amount', '5')!, decIn),
  });
}
