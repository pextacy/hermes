import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Event, Filter } from 'nostr-tools';
import { Discovery, LocalBchSigner, LocalNostrSigner, createBinding, npubOf, respondToChallenge } from '@hermes/id';
import { createVerifierServer } from '../apps/verifier/src/server';

class MemoryDiscovery extends Discovery {
  constructor(readonly events: Event[]) {
    super({ relays: ['wss://a', 'wss://b', 'wss://c'] });
  }
  override async query(filter: Filter) {
    const ok = (e: Event) => (!filter.authors || filter.authors.includes(e.pubkey)) && (!filter['#i'] || e.tags.some((t) => t[0] === 'i' && filter['#i']!.includes(t[1])));
    return { events: this.events.filter(ok), answered: 3 };
  }
}

const bch = new LocalBchSigner();
const nostr = new LocalNostrSigner();
let event: Event;
let base: string;
let server: ReturnType<typeof createVerifierServer>;

beforeAll(async () => {
  event = (await createBinding({ bch, nostr, network: 'mainnet' })).event;
  server = createVerifierServer({ audience: 'https://wallet.test', discovery: new MemoryDiscovery([event]) });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));

describe('verification API', () => {
  it('resolves an npub to the verified binding', async () => {
    const r = await fetch(`${base}/resolve?q=${npubOf(event.pubkey)}`).then((x) => x.json());
    expect(r.addr).toBe(JSON.parse(event.content).payload.addr);
    expect(r.payable).toBe(true);
  });
  it('verifies raw events and reports failures', async () => {
    expect((await post('/verify', { event })).json.ok).toBe(true);
    const bad = { ...event, content: event.content.replace('"seq":0', '"seq":0 ') };
    expect((await post('/verify', { event: bad })).json.ok).toBe(false);
  });
  it('runs challenge-response login against the current binding', async () => {
    const ch = (await post('/challenge', {})).json;
    expect(ch.audience).toBe('https://wallet.test');
    const response = await respondToChallenge(ch, bch, nostr);
    expect((await post('/challenge/verify', { response })).json.ok).toBe(true);
    expect((await post('/challenge/verify', { response })).json.reasons).toContain('nonce already used');
  });
  it('rejects bad input', async () => {
    expect((await fetch(`${base}/resolve`)).status).toBe(400);
    expect((await post('/verify', {})).status).toBe(400);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
