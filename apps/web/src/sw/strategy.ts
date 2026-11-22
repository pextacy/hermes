/** G38: request routing for the service worker. Imported only by sw.ts and tests, never by the app. */

export type SwStrategy = 'bypass' | 'network-first' | 'cache-first' | 'stale-while-revalidate';

/**
 * How the service worker treats a request. Anything cross-origin (Electrum, relays, EVM RPC, fonts, explorers),
 * non-GET, or non-http(s) is never touched or cached. Same-origin: page navigations go to the network first
 * (fresh deploys win, the cached shell is the offline fallback), hashed /assets/ files are immutable → cache
 * first, everything else (icon, manifest) → stale-while-revalidate.
 */
export function swStrategy(req: { url: string; method: string; mode?: string }, origin: string): SwStrategy {
  if (req.method !== 'GET') return 'bypass';
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return 'bypass';
  }
  if (u.origin !== origin || !/^https?:$/.test(u.protocol)) return 'bypass';
  if (req.mode === 'navigate') return 'network-first';
  if (/\/sw\.js$/.test(u.pathname)) return 'bypass';
  if (/\/assets\/[^/]+$/.test(u.pathname)) return 'cache-first';
  return 'stale-while-revalidate';
}
