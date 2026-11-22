import { ElectrumNetworkProvider, type NetworkProvider } from 'cashscript';
import { ElectrumClient } from '@electrum-cash/network';
import { bchConfig, type BchNetwork } from './config.js';

const cache = new Map<string, ElectrumNetworkProvider>();
const overrides = new Map<BchNetwork, string[]>();

/** Use these Electrum (Fulcrum) hostnames instead of config/networks.json (e.g. user settings). */
export function setElectrumServers(network: BchNetwork, servers: string[] | undefined) {
  if (servers?.length) overrides.set(network, servers);
  else overrides.delete(network);
}

export const electrumServers = (network: BchNetwork) => overrides.get(network) ?? bchConfig(network).electrum;

/** `host` or `host:port` (Fulcrum WSS, default port 50004) → parts. */
export function parseElectrumServer(server: string): { host: string; port?: number } {
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(server.trim());
  const port = m?.[2] ? Number(m[2]) : undefined;
  return { host: m?.[1] ?? server, port: port && port > 0 && port < 65536 ? port : undefined };
}

/** A fresh (uncached) provider for one server; `host:port` uses that port instead of 50004. */
export function electrumProvider(network: BchNetwork, server: string): ElectrumNetworkProvider {
  const { host, port } = parseElectrumServer(server);
  return port
    ? new ElectrumNetworkProvider(network, { electrum: new ElectrumClient('Hermes', '1.5.0', host, { port }) })
    : new ElectrumNetworkProvider(network, { hostname: host });
}

/**
 * Electrum (Fulcrum) provider for a BCH network. Servers come from config/networks.json;
 * `serverIndex` lets callers fail over to the next server.
 */
export function getProvider(network: BchNetwork, serverIndex = 0): ElectrumNetworkProvider {
  const servers = electrumServers(network);
  const hostname = servers[serverIndex % servers.length];
  const key = `${network}:${hostname}`;
  let p = cache.get(key);
  if (!p) {
    p = electrumProvider(network, hostname);
    cache.set(key, p);
  }
  return p;
}

/** Run `fn` against providers in order until one succeeds. */
export async function withFailover<T>(network: BchNetwork, fn: (p: NetworkProvider) => Promise<T>): Promise<T> {
  const n = electrumServers(network).length;
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try {
      return await fn(getProvider(network, i));
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export type { NetworkProvider };
