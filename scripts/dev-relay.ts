/**
 * pnpm dev:relay — minimal in-memory Nostr relay (NIP-01: EVENT, REQ, CLOSE; replaceable kinds)
 * for local demos and browser tests, so nothing is published to public relays.
 *   pnpm dev:relay -- --ports 7001,7002,7003
 * Then in the web app: Settings → relays ws://localhost:7001 ws://localhost:7002 ws://localhost:7003.
 */
import { startDevRelay } from './relay-core.js';
const ports = (process.argv.includes('--ports') ? process.argv[process.argv.indexOf('--ports') + 1] : '7001,7002,7003').split(',').map(Number);
const r = startDevRelay(ports);
console.log(`dev relay on ${r.urls.join(' ')}`);
