/**
 * G38: Hermes service worker — a small hand-written app-shell cache.
 *
 * Built by the `hermes-sw` plugin in vite.config.ts into dist/sw.js (classic script, no imports); the
 * placeholders below are replaced at build time with the shell files and a build hash. Registered from
 * main.tsx in production only. Relative URLs throughout because the app is served from any base path.
 *
 * Never caches anything cross-origin (Electrum, Nostr relays, EVM RPCs, fonts, explorers) — see strategy.ts.
 */
import { swStrategy } from './strategy';

const PRECACHE = '__HERMES_PRECACHE__' as unknown as string[];
const VERSION = '__HERMES_SW_VERSION__' as string;
const CACHE = `hermes-shell-${VERSION}`;

/* Minimal typings so this file compiles under the DOM lib used by the rest of the app. */
interface FetchEv {
  request: Request;
  respondWith(r: Promise<Response> | Response): void;
  waitUntil(p: Promise<unknown>): void;
}
interface ExtEv {
  waitUntil(p: Promise<unknown>): void;
}
interface MsgEv {
  data: unknown;
}
const sw = self as unknown as {
  location: Location;
  addEventListener(t: 'install' | 'activate', f: (e: ExtEv) => void): void;
  addEventListener(t: 'fetch', f: (e: FetchEv) => void): void;
  addEventListener(t: 'message', f: (e: MsgEv) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
};

const scope = new URL('./', sw.location.href).href;
const indexUrl = new URL('index.html', scope).href;

sw.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE.map((p) => new URL(p, scope).href)))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hermes-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim()),
  );
});

const okToCache = (r: Response) => r.ok && r.type === 'basic';

async function networkFirst(req: Request): Promise<Response> {
  const c = await caches.open(CACHE);
  try {
    const r = await fetch(req);
    // Every navigation renders index.html (hash routing), so it is stored under one key.
    if (okToCache(r)) void c.put(indexUrl, r.clone());
    return r;
  } catch {
    return (await c.match(indexUrl)) ?? (await c.match(scope)) ?? Response.error();
  }
}

async function cacheFirst(req: Request): Promise<Response> {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (okToCache(r)) void c.put(req, r.clone());
  return r;
}

async function staleWhileRevalidate(req: Request, e: FetchEv): Promise<Response> {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  const fresh = fetch(req)
    .then((r) => {
      if (okToCache(r)) void c.put(req, r.clone());
      return r;
    })
    .catch(() => undefined);
  e.waitUntil(fresh);
  return hit ?? (await fresh) ?? Response.error();
}

sw.addEventListener('fetch', (e) => {
  const s = swStrategy(e.request, sw.location.origin);
  if (s === 'bypass') return; // the browser handles it; nothing stored
  e.respondWith(s === 'network-first' ? networkFirst(e.request) : s === 'cache-first' ? cacheFirst(e.request) : staleWhileRevalidate(e.request, e));
});

sw.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') void sw.skipWaiting();
});
