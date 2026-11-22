/**
 * Hermes CLI (keys are typed at runtime, never stored).
 *   pnpm --filter cli hermes id nft-mint --network chipnet
 *   pnpm --filter cli hermes id nft-sync --network chipnet --npub npub1…
 *   pnpm --filter cli hermes id nft-status npub1… --network chipnet
 *   pnpm --filter cli hermes id verify <npub|name@domain|event.json>   (all id commands take --relays ws://a,ws://b,ws://c)
 *   pnpm --filter cli hermes evm deploy --evm baseSepolia [--mock-usdc]
 *   pnpm --filter cli hermes swap demo      (anvil + BCH VM, no keys)
 *   pnpm --filter cli hermes swap take --direction usdc-to-pusd --amount 5 --network chipnet --evm baseSepolia
 */
import { argv } from './args.js';
const [area, cmd] = argv;
const run = async () => {
  if (area === 'id' && cmd === 'nft-mint') return (await import('./id.js')).idNftMint();
  if (area === 'id' && cmd === 'nft-sync') return (await import('./id.js')).idNftSync();
  if (area === 'id' && cmd === 'nft-status') return (await import('./id.js')).idNftStatus(argv[2]);
  if (area === 'id' && cmd === 'verify') return (await import('./verify.js')).verifyCmd(argv[2]);
  if (area === 'evm' && cmd === 'deploy') return (await import('./evm-deploy.js')).evmDeploy();
  if (area === 'swap' && cmd === 'demo') return (await import('./swap-demo.js')).swapDemo();
  if (area === 'swap' && cmd === 'take') return (await import('./taker.js')).take();
  console.log((await import('node:fs')).readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 10).join('\n'));
};
run().then(() => process.exit(0), (e) => { console.error(e.message ?? e); process.exit(1); });
