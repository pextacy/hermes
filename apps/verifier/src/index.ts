import { getProvider } from '@hermes/chain';
import { Discovery } from '@hermes/id';
import { createVerifierServer } from './server.js';

/**
 *   pnpm --filter verifier start [-- --port 8787 --audience https://wallet.example --relays ws://localhost:7001,ws://localhost:7002,ws://localhost:7003 --no-nft]
 * --relays: discovery relays (default config/networks.json). --no-nft: skip the identity NFT lookup (Electrum).
 */
const arg = (n: string) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const port = Number(arg('port') ?? 8787);
const audience = arg('audience') ?? `http://localhost:${port}`;
const relays = arg('relays')?.split(',').map((r) => r.trim()).filter(Boolean);
const discovery = new Discovery(relays ? { relays } : {});
const nftUtxos = process.argv.includes('--no-nft') ? undefined : async (addr: string, network: 'mainnet' | 'chipnet' | 'testnet4') => getProvider(network).getUtxos(addr);
createVerifierServer({ audience, discovery, nftUtxos }).listen(port, () =>
  console.log(`hermes verifier on http://localhost:${port} (audience ${audience}; relays ${discovery.relays.join(' ')})`),
);
