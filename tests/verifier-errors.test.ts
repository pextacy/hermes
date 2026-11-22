/** Verifier API (apps/verifier) error branches, CORS preflight, rate limiting and the entry point's flags. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Event, Filter } from 'nostr-tools';
import { Discovery, LocalBchSigner, LocalNostrSigner, respondToChallenge } from '@hermes/id';
import { createVerifierServer } from '../apps/verifier/src/server';

class MemoryDiscovery extends Discovery {
  fail = false;
  constructor(readonly events: Event[] = []) {
    super({ relays: ['wss://a', 'wss://b', 'wss://c'] });
  }
  override async query(filter: Filter) {
    if (this.fail) throw new Error('relays unreachable');
    const ok = (e: Event) => !filter.authors || filter.authors.includes(e.pubkey);
    return { events: this.events.filter(ok), answered: 3 };
  }
}

const servers: ReturnType<typeof createVerifierServer>[] = [];
const start = async (opts: Partial<Parameters<typeof createVerifierServer>[0]> = {}) => {
  const discovery = new MemoryDiscovery();
  const server = createVerifierServer({ audience: 'https://wallet.test', discovery, ...opts });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, discovery };
};
afterAll(() => servers.forEach((s) => s.close()));

let base: string;
let discovery: MemoryDiscovery;
beforeAll(async () => ({ base, discovery } = await start({ maxBody: 64 })));
const post = (path: string, body: string) => fetch(base + path, { method: 'POST', body }).then(async (r) => ({ status: r.status, json: await r.json() }));

describe('verifier error branches', () => {
  it('answers CORS preflight with 204 and allow headers', async () => {
    const r = await fetch(`${base}/verify`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-headers')).toBe('content-type');
  });
  it('describes itself at /', async () => {
    const r = await fetch(`${base}/`).then((x) => x.json());
    expect(r).toEqual({ service: 'hermes-id verifier', endpoints: ['/resolve', '/verify', '/challenge', '/challenge/verify'] });
  });
  it('rejects invalid JSON bodies with 400', async () => {
    expect(await post('/verify', '{nope')).toEqual({ status: 400, json: { error: 'invalid JSON' } });
    expect(await post('/challenge/verify', 'not json')).toEqual({ status: 400, json: { error: 'invalid JSON' } });
  });
  it('treats an empty body as {} (→ field required)', async () => {
    expect(await post('/verify', '')).toEqual({ status: 400, json: { error: 'event required' } });
    expect(await post('/challenge/verify', '')).toEqual({ status: 400, json: { error: 'response required' } });
    expect(await post('/challenge/verify', JSON.stringify({ response: { nostrEvent: {} } }))).toEqual({ status: 400, json: { error: 'response required' } });
  });
  it('rejects bodies over maxBody', async () => {
    expect(await post('/verify', JSON.stringify({ event: 'x'.repeat(200) }))).toEqual({ status: 400, json: { error: 'body too large' } });
  });
  it('404s unknown identities with the relay count, and unknown routes / methods', async () => {
    const r = await fetch(`${base}/resolve?q=${'ab'.repeat(32)}`);
    expect(r.status).toBe(404);
    expect((await r.json()).relaysAnswered).toBe(3);
    expect((await fetch(`${base}/verify`)).status).toBe(404); // GET on a POST route
    expect((await fetch(`${base}/resolve`, { method: 'POST' })).status).toBe(404);
  });
  it('turns discovery failures into 400 with the message', async () => {
    discovery.fail = true;
    try {
      const r = await fetch(`${base}/resolve?q=${'ab'.repeat(32)}`);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toMatch(/relays unreachable/);
    } finally {
      discovery.fail = false;
    }
  });
  it('challenge/verify fails when the keys have no current binding', async () => {
    const { base: b } = await start(); // default maxBody
    const ch = await fetch(`${b}/challenge`, { method: 'POST' }).then((r) => r.json());
    const response = await respondToChallenge(ch, new LocalBchSigner(), new LocalNostrSigner());
    const r = await fetch(`${b}/challenge/verify`, { method: 'POST', body: JSON.stringify({ response }) });
    expect(r.status).toBe(200);
    const v = await r.json();
    expect(v.ok).toBe(false);
    expect(v.reasons.length).toBeGreaterThan(0);
  });
});

describe('verifier rate limiting', () => {
  it('allows 60 requests per minute per IP, then answers 429', async () => {
    const { base: b } = await start();
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await fetch(`${b}/`)).status);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes.slice(60)).toEqual([429, 429]);
    expect(await fetch(`${b}/`).then((r) => r.json())).toEqual({ error: 'rate limited' });
  });
  it('the window slides: requests older than a minute no longer count', async () => {
    const { base: b } = await start();
    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      for (let i = 0; i < 60; i++) await fetch(`${b}/`);
      expect((await fetch(`${b}/`)).status).toBe(429);
      spy.mockReturnValue(t0 + 60_001);
      expect((await fetch(`${b}/`)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('verifier entry point (apps/verifier/src/index.ts)', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
    vi.doUnmock('../apps/verifier/src/server');
    vi.resetModules();
  });
  const boot = async (args: string[]) => {
    vi.resetModules();
    process.argv = ['node', 'index.ts', ...args];
    const created: { opts: unknown; port?: number }[] = [];
    vi.doMock('../apps/verifier/src/server', () => ({
      createVerifierServer: (opts: unknown) => {
        const rec: { opts: unknown; port?: number } = { opts };
        created.push(rec);
        return { listen: (port: number, cb: () => void) => ((rec.port = port), cb()) };
      },
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await import('../apps/verifier/src/index');
    return { created, log: log.mock.calls.map((c) => String(c[0])) };
  };
  it('defaults to :8787 with a localhost audience', async () => {
    const r = await boot([]);
    expect(r.created).toMatchObject([{ opts: { audience: 'http://localhost:8787' }, port: 8787 }]);
    expect(typeof (r.created[0].opts as { nftUtxos?: unknown }).nftUtxos).toBe('function');
    expect(r.log[0]).toMatch(/^hermes verifier on http:\/\/localhost:8787 \(audience http:\/\/localhost:8787; relays wss:\/\//);
  });
  it('honours --port and --audience', async () => {
    const r = await boot(['--port', '9999', '--audience', 'https://wallet.example']);
    expect(r.created).toMatchObject([{ opts: { audience: 'https://wallet.example' }, port: 9999 }]);
  });
  it('honours --relays and --no-nft', async () => {
    const r = await boot(['--relays', 'ws://localhost:7001, ws://localhost:7002,ws://localhost:7003', '--no-nft']);
    const opts = r.created[0].opts as { discovery: { relays: string[] }; nftUtxos?: unknown };
    expect(opts.discovery.relays).toEqual(['ws://localhost:7001', 'ws://localhost:7002', 'ws://localhost:7003']);
    expect(opts.nftUtxos).toBeUndefined();
  });
});
