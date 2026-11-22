import { createWalletClient, custom, type Address, type WalletClient } from 'viem';
import { evmChain, type EvmChainConfig } from '@hermes/swap';

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export const injected = () => (globalThis as unknown as { ethereum?: Eip1193 }).ethereum;

/** Connect an injected EVM wallet (MetaMask, Rabby, …) and switch it to the configured chain. */
export async function connectEvm(cfg: EvmChainConfig): Promise<{ wallet: WalletClient; address: Address }> {
  const eth = injected();
  if (!eth) throw new Error('No EVM wallet found in this browser (MetaMask, Rabby, …).');
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as Address[] | undefined;
  const address = accounts?.[0];
  if (!address) throw new Error('The EVM wallet shared no account.');
  const chainHex = `0x${cfg.chainId.toString(16)}`;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
  } catch (e) {
    // Only an unknown chain (EIP-3326 code 4902) should be added; a user rejection (4001) stops here.
    const code = (e as { code?: number })?.code;
    if (code === 4001) throw new Error(`Switch to ${cfg.name} was rejected in the wallet.`);
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: chainHex, chainName: cfg.name, rpcUrls: [cfg.rpc], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }],
    });
  }
  const wallet = createWalletClient({ account: address, chain: evmChain(cfg), transport: custom(eth) });
  return { wallet, address };
}
