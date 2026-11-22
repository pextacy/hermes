import networks from '../../../config/networks.json' with { type: 'json' };
import hermes from '../../../config/hermes.json' with { type: 'json' };

export type BchNetwork = 'mainnet' | 'chipnet' | 'testnet4';
export type EvmNetworkKey = keyof typeof networks.evm;

export interface TokenConfig {
  category: string | null;
  stable?: boolean;
  symbol: string;
  decimalsFallback: number;
  source: string;
}

export const NETWORKS = networks;
export const HERMES = hermes;

export function bchConfig(network: BchNetwork) {
  return networks.bch[network] as {
    name: string;
    cashaddrPrefix: string;
    electrum: string[];
    explorerTx: string;
    faucets?: string[];
    tokens: Record<string, TokenConfig>;
  };
}

export function tokenConfig(network: BchNetwork, symbol: 'PUSD' | 'FLDCH' | 'MUSD' | string): TokenConfig {
  return bchConfig(network).tokens[symbol];
}

/** Configured BCH stablecoins with a known category (PUSD first, then MoriaUSD, …). */
export function stablecoins(network: BchNetwork): (TokenConfig & { key: string; category: string })[] {
  return Object.entries(bchConfig(network).tokens)
    .filter(([, t]) => t.stable && t.category)
    .map(([key, t]) => ({ ...t, key, category: t.category! }));
}

export const explorerTxUrl = (network: BchNetwork, txid: string) => `${bchConfig(network).explorerTx}${txid}`;

import { decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';

/** Token-aware form of a P2PKH/P2SH cashaddr (same payload, token-support type). */
export function toTokenAddress(address: string): string {
  const d = decodeCashAddress(address);
  if (typeof d === 'string') throw new Error(d);
  const type = d.type === 'p2pkh' || d.type === 'p2pkhWithTokens' ? 'p2pkhWithTokens' : 'p2shWithTokens';
  return encodeCashAddress({ prefix: d.prefix, type, payload: d.payload }).address;
}

/** Plain (non-token) form of a cashaddr. */
export function toPlainAddress(address: string): string {
  const d = decodeCashAddress(address);
  if (typeof d === 'string') throw new Error(d);
  const type = d.type === 'p2pkh' || d.type === 'p2pkhWithTokens' ? 'p2pkh' : 'p2sh';
  return encodeCashAddress({ prefix: d.prefix, type, payload: d.payload }).address;
}
