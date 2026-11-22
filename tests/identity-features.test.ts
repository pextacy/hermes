/**
 * Identity features F1–F7: logic added for the web Identity tab, the "Verify any binding" tool,
 * the identity NFT status / nft-sync core, browser key backup, and the verification HTTP API.
 * Local only: in-memory relays (Discovery subclass / dev relay), CashScript's MockNetworkProvider.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { binToHex, encodePrivateKeyWif, generatePrivateKey } from '@bitauth/libauth';
import * as nip19 from 'nostr-tools/nip19';
import type { Event, Filter } from 'nostr-tools';
import {
  ChallengeVerifier,
  Discovery,
  LocalBchSigner,
  LocalNostrSigner,
  MemoryNonceStore,
  bindingReport,
  bindingVerdict,
  createBinding,
  identityCommitment,
  identityNftStatus,
  looksLikeEvent,
  nip39Claims,
  nip39ProfileTemplate,
  npubOf,
  parseVerifyInput,
  respondToChallenge,
  rotateBinding,
  verifyChain,
} from '@hermes/id';
import { walletFromPrivateKey } from '@hermes/chain';
import { buildMintIdentityNft, prepareIdentityGenesis } from '@hermes/pay';
import { changeLabel, nip39State, tamperedCopy, verifierEndpoint } from '../apps/web/src/lib/identity-ui';
import { backupText, decodeBchWif, ensureLocalBchKey, exportBchWif, getLocalBchKey, importBchWif, previousBchKeys, previousNsecs, setLocalBchKey, setLocalNsec, ensureLocalNostr } from '../apps/web/src/lib/keys';
import { createVerifierServer } from '../apps/verifier/src/server';
import { chainTokenUtxos, mintIdentityNftForBinding, nftStatusFor, syncIdentityNftForBinding } from '../apps/cli/src/id';
import { startDevRelay } from '../scripts/relay-core';

/** In-memory relay set: answers author and #i queries like a real relay, keeps replaceable semantics. */
class MemoryDiscovery extends Discovery {
  events: Event[] = [];
  constructor() {
    super({ relays: ['wss://a', 'wss://b', 'wss://c'] });
  }
  override async query(filter: Filter) {
    const ok = (e: Event) =>
      (!filter.kinds || filter.kinds.includes(e.kind)) &&
      (!filter.authors || filter.authors.includes(e.pubkey)) &&
      (!filter['#i'] || e.tags.some((t) => t[0] === 'i' && filter['#i']!.includes(t[1])));
    return { events: this.events.filter(ok), answered: 3 };
  }
  override async publish(event: Event) {
    // parameterised replaceable: a newer event by the same author replaces the older one
    this.events = this.events.filter((e) => !(e.pubkey === event.pubkey && e.kind === event.kind));
    this.events.push(event);
    return this.relays.map((relay) => ({ relay, ok: true }));
  }
}

const identity = async () => {
  const bchKey = generatePrivateKey();
  const bch = new LocalBchSigner(bchKey);
  const nostr = new LocalNostrSigner();
  const v0 = await createBinding({ bch, nostr, network: 'chipnet' });
  return { bchKey, bch, nostr, v0: v0.event };
};

// ---------- F1: rotations as the web tab performs them ----------

describe('F1 Nostr key rotation (web flow)', () => {
  it('old npub resolves to the rotated version; history labels each change', async () => {
    const d = new MemoryDiscovery();
    const id = await identity();
    await d.publish(id.v0);
    const fresh = new LocalNostrSigner();
    const { event: v1 } = await rotateBinding({ prevEvent: id.v0, currentBch: id.bch, currentNostr: id.nostr, newNostr: fresh, network: 'chipnet' });
    expect(verifyChain(v1).ok).toBe(true);
    await d.publish(v1);
    const viaOld = await d.resolve(npubOf(id.v0.pubkey));
    expect(viaOld.identity?.current.seq).toBe(1);
    expect(viaOld.identity?.current.nostr).toBe(await fresh.getPublicKey());
    expect(viaOld.identity?.warnings.map((w) => w.code)).toContain('rotated');
    const chain = viaOld.identity!.chain;
    expect(chain.map((b, i) => changeLabel(chain[i - 1], b))).toEqual(['original binding', 'Nostr key rotated']);
  });

  it('changeLabel covers BCH rotation, NFT attachment, re-issue and both keys', () => {
    const a = { nostr: 'n1', bch: 'b1', payload: undefined };
    expect(changeLabel(a, { ...a, bch: 'b2' })).toBe('BCH key rotated');
    expect(changeLabel(a, { ...a, payload: { idCategory: 'cc' } as never })).toBe('identity NFT attached');
    expect(changeLabel(a, { ...a })).toBe('re-issued');
    expect(changeLabel(a, { nostr: 'n2', bch: 'b2', payload: undefined })).toBe('both keys changed');
  });
});

// ---------- F2 / F3: identity NFT ----------

describe('F3 identityNftStatus', () => {
  const nostrA = 'aa'.repeat(32);
  const nostrB = 'bb'.repeat(32);
  const cat = 'cd'.repeat(32);
  const b = (seq: number, nostr: string, tokenAddr: string, withCat = true) => ({ seq, nostr, tokenAddr, payload: withCat ? { idCategory: cat } : {} });
  const nft = (nostr: string, seq: number, address: string, category = cat) => ({ address, token: { category, nft: { capability: 'mutable', commitment: identityCommitment(nostr, seq) } } });

  it('none when the binding names no NFT', () => {
    expect(identityNftStatus([b(0, nostrA, 'T0', false)], []).state).toBe('none');
    expect(identityNftStatus([], []).state).toBe('none');
  });
  it('synced / behind / ahead at the current token address', () => {
    const chain = [b(0, nostrA, 'T0'), b(1, nostrA, 'T0')];
    expect(identityNftStatus(chain, [nft(nostrA, 1, 'T0')])).toMatchObject({ state: 'synced', pinned: 1, needsSync: false });
    expect(identityNftStatus(chain, [nft(nostrA, 0, 'T0')])).toMatchObject({ state: 'behind', pinned: 0, current: 1, needsSync: true });
    expect(identityNftStatus(chain, [nft(nostrA, 5, 'T0')])).toMatchObject({ state: 'ahead', pinned: 5, needsSync: false });
  });
  it('moved (still at the old BCH key) and old-nostr (commitment hashes the previous Nostr key)', () => {
    expect(identityNftStatus([b(1, nostrA, 'T0'), b(2, nostrA, 'T1')], [nft(nostrA, 1, 'T0')])).toMatchObject({ state: 'moved', at: 'T0', needsSync: true });
    expect(identityNftStatus([b(1, nostrA, 'T0'), b(2, nostrB, 'T0')], [nft(nostrA, 1, 'T0')])).toMatchObject({ state: 'old-nostr', pinned: 1, needsSync: true });
  });
  it('missing: other categories, foreign commitments, malformed commitments are ignored', () => {
    const chain = [b(0, nostrA, 'T0')];
    const foreign = nft('ee'.repeat(32), 0, 'T0');
    const other = nft(nostrA, 0, 'T0', 'ff'.repeat(32));
    const bad = { address: 'T0', token: { category: cat, nft: { capability: 'mutable', commitment: 'abcd' } } };
    expect(identityNftStatus(chain, [foreign, other, bad, { token: null }]).state).toBe('missing');
  });
});

describe('F2 identity NFT mint → rotate → nft-sync (dev relay + BCH VM)', () => {
  const relay = startDevRelay([7211, 7212, 7213]);
  afterAll(() => relay.close());

  it('after a Nostr rotation nft-sync re-pins to the new Nostr key; after a BCH rotation it moves the NFT', async () => {
    const discovery = new Discovery({ relays: relay.urls, timeoutMs: 1500 });
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    const k0 = generatePrivateKey();
    const w0 = walletFromPrivateKey(k0, 'chipnet');
    provider.addUtxo(w0.address, randomUtxo({ satoshis: 300_000n }));
    const bch0 = new LocalBchSigner(k0);
    const nostrA = new LocalNostrSigner();
    const { event } = await createBinding({ bch: bch0, nostr: nostrA, network: 'chipnet' });
    await discovery.publish(event);
    const minted = await mintIdentityNftForBinding({ discovery, provider, network: 'chipnet', wallet: w0, bch: bch0, nostr: nostrA });
    const npubA = npubOf(await nostrA.getPublicKey());

    // A second mint is refused while the NFT exists.
    await expect(mintIdentityNftForBinding({ discovery, provider, network: 'chipnet', wallet: w0, bch: bch0, nostr: nostrA })).rejects.toThrow(/already has NFT/);
    expect((await nftStatusFor(discovery, provider, npubA)).status.state).toBe('synced');

    // Rotate the Nostr key → NFT commitment hashes the old key.
    const nostrB = new LocalNostrSigner();
    let cur = (await discovery.resolve(npubA)).identity!;
    const v2 = await rotateBinding({ prevEvent: cur.current.event, currentBch: bch0, currentNostr: nostrA, newNostr: nostrB, network: 'chipnet' });
    await discovery.publish(v2.event);
    const npubB = npubOf(await nostrB.getPublicKey());
    expect((await nftStatusFor(discovery, provider, npubB)).status).toMatchObject({ state: 'old-nostr', pinned: 1, current: 2 });
    const s1 = await syncIdentityNftForBinding({ discovery, provider, npub: npubB, holder: w0 });
    expect(s1).toMatchObject({ already: false, seq: 2, to: w0.tokenAddress });
    expect((await nftStatusFor(discovery, provider, npubB)).status.state).toBe('synced');
    expect(await syncIdentityNftForBinding({ discovery, provider, npub: npubB, holder: w0 })).toMatchObject({ already: true, seq: 2 });

    // Rotate the BCH key → the NFT sits at the old key until nft-sync moves it.
    const k1 = generatePrivateKey();
    const w1 = walletFromPrivateKey(k1, 'chipnet');
    cur = (await discovery.resolve(npubB)).identity!;
    const v3 = await rotateBinding({ prevEvent: cur.current.event, currentBch: bch0, currentNostr: nostrB, newBch: new LocalBchSigner(k1), network: 'chipnet' });
    await discovery.publish(v3.event);
    const st = await nftStatusFor(discovery, provider, npubB);
    expect(st.status).toMatchObject({ state: 'moved', at: w0.tokenAddress, current: 3 });
    expect((await chainTokenUtxos(provider, st.identity)).some((u) => u.token?.category === minted.category)).toBe(true);
    await expect(syncIdentityNftForBinding({ discovery, provider, npub: npubB, holder: w1 })).rejects.toThrow(/^NFT not found at this key/);
    const s2 = await syncIdentityNftForBinding({ discovery, provider, npub: npubB, holder: w0 });
    expect(s2).toMatchObject({ already: false, seq: 3, to: w1.tokenAddress });
    expect((await nftStatusFor(discovery, provider, npubB)).status).toMatchObject({ state: 'synced', pinned: 3, at: w1.tokenAddress });
    discovery.close();
  }, 60_000);
});

// ---------- F4: NIP-39 ----------

describe('F4 NIP-39 profile status', () => {
  it('current / stale / none from the profile claims', async () => {
    const id = await identity();
    const v = verifyChain(id.v0).chain[0];
    const profile = await id.nostr.signEvent(nip39ProfileTemplate({ kind: 0, tags: [['i', 'github:someone', 'x']], content: '{"name":"a"}', created_at: 1 } as never, v));
    expect(nip39State(nip39Claims(profile), v)).toMatchObject({ state: 'current' });
    expect(nip39State(nip39Claims(profile), v).text).toMatch(/with this binding event as proof/);
    expect(nip39State([{ addr: 'bchtest:qold' }], v)).toMatchObject({ state: 'stale' });
    expect(nip39State(nip39Claims(undefined), v)).toMatchObject({ state: 'none' });
    expect(profile.tags).toContainEqual(['i', 'github:someone', 'x']);
  });
});

// ---------- F5: verify any binding ----------

describe('F5 verify any binding', () => {
  it('parseVerifyInput: lookups, raw events, API / relay wrappers and bad input', async () => {
    const id = await identity();
    expect(parseVerifyInput('  npub1abc ')).toEqual({ kind: 'lookup', query: 'npub1abc' });
    expect(parseVerifyInput('')).toMatchObject({ kind: 'invalid' });
    expect(parseVerifyInput('a b')).toMatchObject({ kind: 'invalid', reason: /no spaces/ });
    expect(parseVerifyInput('{nope')).toMatchObject({ kind: 'invalid', reason: /Not valid JSON/ });
    expect(parseVerifyInput('{"hello":1}')).toMatchObject({ kind: 'invalid', reason: /not a Nostr event/ });
    // compare with a JSON copy: nostr-tools tags signed events with a hidden Symbol(verified)
    const plain = JSON.parse(JSON.stringify(id.v0));
    expect(parseVerifyInput(JSON.stringify(id.v0))).toEqual({ kind: 'event', event: plain });
    expect(parseVerifyInput(JSON.stringify({ event: id.v0 }))).toEqual({ kind: 'event', event: plain });
    expect(parseVerifyInput(JSON.stringify(['EVENT', 'sub', id.v0]))).toEqual({ kind: 'event', event: plain });
    expect(looksLikeEvent({ ...id.v0, tags: [[1]] })).toBe(false);
  });

  it('valid, stale (newer version on relays) and invalid verdicts with reasons', async () => {
    const id = await identity();
    const ok = bindingVerdict(id.v0);
    expect(ok).toMatchObject({ ok: true, status: 'valid', reasons: [], versions: 1 });
    expect(ok.summary?.addr).toMatch(/^bchtest:/);
    const stale = bindingVerdict(id.v0, { currentSeq: 2 });
    expect(stale).toMatchObject({ ok: false, status: 'stale' });
    expect(stale.reasons[0]).toMatch(/superseded by version 2/);
    expect(bindingVerdict(id.v0, { currentSeq: 0 }).status).toBe('valid');

    const bad = bindingVerdict(tamperedCopy(id.v0));
    expect(bad.status).toBe('invalid');
    expect(bad.reasons.join(' ')).toMatch(/signed by the bound Nostr key/);
    expect(bad.reasons.join(' ')).toMatch(/addresses derived/);
    expect(bindingVerdict({ foo: 1 })).toMatchObject({ status: 'invalid', headline: 'Invalid — not a Nostr event' });
    const notBinding = await id.nostr.signEvent({ kind: 1, created_at: 1, tags: [], content: 'hi' });
    expect(bindingVerdict(notBinding)).toMatchObject({ status: 'invalid', headline: 'Invalid — not a Hermes ID binding' });
  });

  it('bindingReport never throws on malformed events or embedded history', async () => {
    const id = await identity();
    expect(bindingReport({} as never)).toMatchObject({ ok: false, versions: 0 });
    expect(bindingReport({ ...id.v0, content: 'not json' })).toMatchObject({ ok: false });
    const content = JSON.parse(id.v0.content);
    content.history = [{ junk: true }];
    const ev = await id.nostr.signEvent({ kind: id.v0.kind, created_at: id.v0.created_at, tags: id.v0.tags, content: JSON.stringify(content) });
    const r = bindingReport(ev);
    expect(r.ok).toBe(false);
    expect(r.steps.some((s) => s.label === 'embedded predecessor is a Nostr event')).toBe(true);
  });

  it('tamperedCopy changes the address in content and tags only', async () => {
    const id = await identity();
    const t = tamperedCopy(id.v0);
    expect(t.id).toBe(id.v0.id);
    expect(t.content).not.toBe(id.v0.content);
    expect(t.tags).not.toEqual(id.v0.tags);
    expect(tamperedCopy({ content: 'x', tags: [] }).content).toBe('x ');
  });
});

// ---------- F6: browser key backup / import ----------

class MemoryStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe('F6 browser key backup, import and previous keys', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
  });
  afterEach(() => {
    delete g.localStorage;
  });

  it('replacing the BCH key (rotation or import) keeps the old one as a previous key with WIF + address', () => {
    const k0 = ensureLocalBchKey('chipnet');
    const w0 = walletFromPrivateKey(k0, 'chipnet');
    const k1 = generatePrivateKey();
    setLocalBchKey('chipnet', k1);
    setLocalBchKey('chipnet', k1); // same key: no duplicate entry
    const k2 = generatePrivateKey();
    importBchWif('chipnet', encodePrivateKeyWif(k2, 'testnet'));
    const prev = previousBchKeys('chipnet');
    expect(prev.map((p) => p.address)).toEqual([walletFromPrivateKey(k1, 'chipnet').address, w0.address]);
    expect(prev[1].wif).toBe(encodePrivateKeyWif(k0, 'testnet'));
    expect(previousBchKeys('mainnet')).toEqual([]);
    expect(getLocalBchKey('chipnet')).toEqual(k2);
  });

  it('decodeBchWif validates without storing', () => {
    const k = generatePrivateKey();
    expect(decodeBchWif('chipnet', encodePrivateKeyWif(k, 'testnet'))).toEqual(k);
    expect(getLocalBchKey('chipnet')).toBeUndefined();
    expect(() => decodeBchWif('chipnet', encodePrivateKeyWif(k, 'mainnet'))).toThrow(/mainnet WIF/);
  });

  it('replacing the nsec keeps the old one; corrupted previous lists are ignored', async () => {
    ensureLocalNostr();
    const a = nip19.nsecEncode(new LocalNostrSigner().secretKey);
    setLocalNsec(a);
    expect(previousNsecs()).toHaveLength(1);
    expect(previousNsecs()[0].npub.startsWith('npub1')).toBe(true);
    (g.localStorage as MemoryStorage).setItem('hermes.nsec.previous', '"garbage"');
    expect(previousNsecs()).toEqual([]);
    (g.localStorage as MemoryStorage).setItem('hermes.bchkey.chipnet.previous', JSON.stringify([{ key: 'zz', ts: 1 }, null]));
    expect(previousBchKeys('chipnet')).toEqual([]);
  });

  it('backupText lists the current keys, previous keys and the recovery rules', () => {
    ensureLocalNostr();
    const k0 = ensureLocalBchKey('chipnet');
    setLocalBchKey('chipnet', generatePrivateKey());
    const t = backupText('chipnet', { npub: 'npub1me', addr: 'bchtest:qme', seq: 3 });
    expect(t).toContain(`BCH key (WIF, chipnet): ${exportBchWif('chipnet')}`);
    expect(t).toContain('Nostr key (nsec): nsec1');
    expect(t).toContain('identity npub: npub1me');
    expect(t).toContain('bound BCH address: bchtest:qme (binding v3)');
    expect(t).toContain(encodePrivateKeyWif(k0, 'testnet'));
    expect(t).toMatch(/Lost both\? The identity cannot be recovered/);
    expect(t).not.toMatch(/\n\n\n/);
  });
});

// ---------- F7: verification HTTP API ----------

describe('F7 verifier API', () => {
  let base: string;
  let server: ReturnType<typeof createVerifierServer>;
  const discovery = new MemoryDiscovery();
  const provider = new MockNetworkProvider({ updateUtxoSet: true });
  let id: Awaited<ReturnType<typeof identity>>;
  let v1: Event;

  beforeAll(async () => {
    id = await identity();
    await discovery.publish(id.v0);
    server = createVerifierServer({ audience: 'https://wallet.test', discovery, nftUtxos: async (addr) => provider.getUtxos(addr) as never });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));

  it('/verify reports valid, then stale once relays hold a newer version; offline skips the relay check', async () => {
    let r = await post('/verify', { event: id.v0 });
    expect(r.json).toMatchObject({ ok: true, status: 'valid', current: { seq: 0, eventId: id.v0.id } });
    v1 = (await rotateBinding({ prevEvent: id.v0, currentBch: id.bch, currentNostr: id.nostr, newBch: new LocalBchSigner(), network: 'chipnet' })).event;
    await discovery.publish(v1);
    r = await post('/verify', { event: id.v0 });
    expect(r.json).toMatchObject({ ok: true, status: 'stale', current: { seq: 1 } });
    expect(r.json.reasons[0]).toMatch(/superseded/);
    r = await post('/verify?offline=1', { event: id.v0 });
    expect(r.json.status).toBe('valid');
    expect(r.json.current).toBeUndefined();
    expect((await post('/verify', { event: tamperedCopy(v1) })).json).toMatchObject({ ok: false, status: 'invalid' });
    expect(await post('/verify', { event: { kind: 1 } })).toMatchObject({ status: 400, json: { error: /not a Nostr event/ } });
  });

  it('/verify of an event whose identity is unknown to relays still verifies, with the relay note', async () => {
    const other = await identity();
    const r = await post('/verify', { event: other.v0 });
    expect(r.json).toMatchObject({ ok: true, status: 'valid', current: { error: expect.any(String) } });
  });

  it('/resolve reports the identity NFT and follows its pin', async () => {
    const plain = await fetch(`${base}/resolve?q=${npubOf(id.v0.pubkey)}`).then((x) => x.json());
    expect(plain.version).toBe(1);
    expect(plain.nft).toBeUndefined(); // no idCategory in the binding

    // Mint an NFT for a fresh identity, then publish a newer version without syncing the NFT.
    const key = generatePrivateKey();
    const wallet = walletFromPrivateKey(key, 'chipnet');
    provider.addUtxo(wallet.address, randomUtxo({ satoshis: 100_000n }));
    const bch = new LocalBchSigner(key);
    const nostr = new LocalNostrSigner();
    await discovery.publish((await createBinding({ bch, nostr, network: 'chipnet' })).event);
    const m = await mintIdentityNftForBinding({ discovery, provider, network: 'chipnet', wallet, bch, nostr });
    const npub = npubOf(await nostr.getPublicKey());
    let r = await fetch(`${base}/resolve?q=${npub}`).then((x) => x.json());
    expect(r).toMatchObject({ version: 1, nft: { state: 'synced', pinned: 1, category: m.category } });

    const cur = (await discovery.resolve(npub)).identity!;
    const { event } = await createBinding({ bch, nostr, network: 'chipnet', prev: cur.current.payload!, idCategory: m.category, history: [cur.current.event] });
    await discovery.publish(event);
    r = await fetch(`${base}/resolve?q=${npub}`).then((x) => x.json());
    // Relays show v2, the NFT pins v1: payers are given v1 with the warning.
    expect(r.nft).toMatchObject({ state: 'behind', pinned: 1, current: 2 });
    expect(r.version).toBe(1);
    expect(r.warnings.map((w: { code: string }) => w.code)).toContain('nft-pinned');
  });

  it('/challenge/verify: login with the current keys; refreshed timestamps and malformed responses are refused', async () => {
    const cur = (await discovery.resolve(npubOf(id.v0.pubkey))).identity!;
    expect(cur.current.event.id).toBe(v1.id);
    // v1 rotated the BCH key: the old key can no longer log in.
    const ch = (await post('/challenge', {})).json;
    const stale = await respondToChallenge(ch, id.bch, id.nostr);
    expect((await post('/challenge/verify', { response: stale })).json.reasons).toContain('bch key is not the current binding');

    const ch2 = (await post('/challenge', {})).json;
    const altered = await respondToChallenge({ ...ch2, ts: ch2.ts + 30 }, id.bch, id.nostr);
    expect((await post('/challenge/verify', { response: altered })).json.reasons).toContain('challenge timestamp altered');
    expect(await post('/challenge/verify', { response: { nostrEvent: { pubkey: 'ab' } } })).toMatchObject({ status: 400, json: { error: /must have challenge/ } });
  });
});

describe('F7 challenge nonce store', () => {
  it('prunes nonces older than maxAge (they read as unknown) and records the issued ts', () => {
    const s = new MemoryNonceStore(10);
    const now = Math.floor(Date.now() / 1000);
    s.issue('old', now - 100);
    expect(s.issued('old')).toBe(true);
    s.issue('fresh', now); // issuing prunes everything older than maxAge
    expect(s.issued('old')).toBe(false);
    expect(s.size).toBe(1);
    s.issue('next', now);
    expect(s.issuedAt('fresh')).toBe(now);
    expect(s.size).toBe(2);
    s.issue('untimed'); // nonces without a timestamp are never pruned
    expect(s.issued('untimed')).toBe(true);
  });
  it('a refreshed challenge timestamp is rejected even inside the window', async () => {
    const id = await identity();
    const v = new ChallengeVerifier('aud');
    const ch = v.issue();
    const resp = await respondToChallenge({ ...ch, ts: ch.ts - 5 }, id.bch, id.nostr);
    expect(v.verify(resp, verifyChain(id.v0).chain[0]).reasons).toEqual(['challenge timestamp altered']);
  });
});

describe('verifierEndpoint (web challenge against the API)', () => {
  it('normalises URLs and rejects junk', () => {
    expect(verifierEndpoint('')).toBeUndefined();
    expect(verifierEndpoint(' http://localhost:8787/ ')).toBe('http://localhost:8787');
    expect(verifierEndpoint('localhost:8787')).toBe('http://localhost:8787');
    expect(verifierEndpoint('https://v.example/api/')).toBe('https://v.example/api');
    expect(() => verifierEndpoint('http://')).toThrow(/not a URL/);
  });
});

void binToHex;
void buildMintIdentityNft;
void prepareIdentityGenesis;
