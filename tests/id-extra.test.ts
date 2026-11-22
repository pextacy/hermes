import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import { useFetchImplementation } from 'nostr-tools/nip05';
import { binToHex, cashAddressToLockingBytecode, generatePrivateKey, secp256k1 } from '@bitauth/libauth';
import {
  AUTH_DOMAIN,
  AUTH_EVENT_KIND,
  CHALLENGE_FRESHNESS_SECONDS,
  ChallengeVerifier,
  LocalBchSigner,
  LocalNostrSigner,
  MemoryNonceStore,
  Nip07Signer,
  NIP39_PLATFORMS,
  addressForLockingBytecode,
  addressesForPublicKey,
  bchMessageHash,
  canonicalJson,
  cashAddrPrefix,
  createBinding,
  createChallenge,
  isCompressedPublicKeyHex,
  lockingBytecodeForAddress,
  networkOfAddress,
  nip39Claims,
  nip39ProfileTemplate,
  publicKeyFromPrivate,
  respondToChallenge,
  sha256Bytes,
  sha256Hex,
  signBchMessage,
  verifyBchMessage,
  verifyBinding,
  verifyEventFresh,
  type ChallengeResponse,
  type VerifiedBinding,
} from '@hermes/id';
import { verifyNip05 } from '../packages/pay/src/links.js';

const AUD = 'https://hermes.example';
const now = () => Math.floor(Date.now() / 1000);

async function boundIdentity() {
  const bch = new LocalBchSigner();
  const nostr = new LocalNostrSigner();
  const { event } = await createBinding({ bch, nostr, network: 'chipnet' });
  const binding = verifyBinding(event);
  expect(binding.valid).toBe(true);
  return { bch, nostr, binding };
}

describe('canonicalJson edge cases', () => {
  it('rejects unsupported types anywhere in the value', () => {
    expect(() => canonicalJson(1n)).toThrow(/unsupported type bigint/);
    expect(() => canonicalJson({ a: [1, 2n] })).toThrow(/bigint/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/unsupported type function/);
    expect(() => canonicalJson(Symbol('x'))).toThrow(/unsupported type symbol/);
    expect(() => canonicalJson(undefined)).toThrow(/unsupported type undefined/);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson([-Infinity])).toThrow(/non-finite/);
  });

  it('serialises primitives and nested structures deterministically', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson('é"\n')).toBe(JSON.stringify('é"\n'));
    expect(canonicalJson({ b: [{ d: 1, c: null }], a: false })).toBe('{"a":false,"b":[{"c":null,"d":1}]}');
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });
});

describe('verifyEventFresh', () => {
  const sk = generateSecretKey();
  const ev = () => finalizeEvent({ kind: 1, created_at: 1_700_000_000, tags: [['t', 'x']], content: 'hi' }, sk);

  it('accepts a genuine event and rejects a mutated copy even after nostr-tools cached "verified"', () => {
    const e = ev();
    expect(verifyEvent(e)).toBe(true); // sets the cached flag
    expect(verifyEventFresh(e)).toBe(true);
    expect(verifyEventFresh({ ...e, content: 'tampered' })).toBe(false);
    expect(verifyEventFresh({ ...e, tags: [['t', 'y']] })).toBe(false);
    expect(verifyEventFresh({ ...e, sig: '00'.repeat(64) })).toBe(false);
    expect(verifyEventFresh({ ...e, pubkey: getPublicKey(generateSecretKey()) })).toBe(false);
  });

  it('returns false (never throws) for malformed input', () => {
    expect(verifyEventFresh(null as never)).toBe(false);
    expect(verifyEventFresh('event' as never)).toBe(false);
    expect(verifyEventFresh({ ...ev(), tags: undefined } as never)).toBe(false);
    expect(verifyEventFresh({ ...ev(), tags: [[1n]] } as never)).toBe(false);
  });
});

describe('bch helpers', () => {
  it('network and prefix helpers', () => {
    expect(cashAddrPrefix('mainnet')).toBe('bitcoincash');
    expect(cashAddrPrefix('chipnet')).toBe('bchtest');
    expect(networkOfAddress('bitcoincash:qq')).toBe('mainnet');
    expect(networkOfAddress('bchtest:qq')).toBe('chipnet');
    expect(networkOfAddress('bchreg:qq')).toBeUndefined();
    expect(networkOfAddress('qq')).toBeUndefined();
  });

  it('isCompressedPublicKeyHex accepts only 33-byte lowercase 02/03 keys', () => {
    const pk = binToHex(publicKeyFromPrivate(generatePrivateKey()));
    expect(isCompressedPublicKeyHex(pk)).toBe(true);
    expect(isCompressedPublicKeyHex(`04${pk.slice(2)}`)).toBe(false);
    expect(isCompressedPublicKeyHex(pk.toUpperCase())).toBe(false);
    expect(isCompressedPublicKeyHex(pk.slice(0, -2))).toBe(false);
    expect(isCompressedPublicKeyHex(`${pk}00`)).toBe(false);
  });

  it('addresses from a public key (hex or bytes) round-trip through locking bytecode', () => {
    const pk = publicKeyFromPrivate(generatePrivateKey());
    const a = addressesForPublicKey(pk, 'mainnet');
    expect(addressesForPublicKey(binToHex(pk), 'mainnet')).toEqual(a);
    expect(a.addr.startsWith('bitcoincash:q')).toBe(true);
    expect(a.tokenAddr.startsWith('bitcoincash:z')).toBe(true);
    const lb = lockingBytecodeForAddress(a.addr);
    expect(binToHex(lb)).toBe(`76a914${a.pkh}88ac`);
    expect(binToHex(lockingBytecodeForAddress(a.tokenAddr))).toBe(binToHex(lb));
    expect(addressForLockingBytecode(lb, 'mainnet')).toBe(a.addr);
    expect(addressForLockingBytecode(lb, 'mainnet', true)).toBe(a.tokenAddr);
    expect(addressForLockingBytecode(lb, 'chipnet')).toBe(addressesForPublicKey(pk, 'chipnet').addr);
  });

  it('rejects invalid addresses and non-standard locking bytecode', () => {
    expect(() => lockingBytecodeForAddress('bitcoincash:qinvalid')).toThrow(/invalid cashaddr/);
    expect(() => lockingBytecodeForAddress('not an address')).toThrow(/invalid cashaddr/);
    expect(() => addressForLockingBytecode(Uint8Array.of(0x6a, 0x01, 0x00), 'mainnet')).toThrow(/unknown locking bytecode/);
    expect(() => addressForLockingBytecode(new Uint8Array(), 'chipnet')).toThrow();
  });

  it('refuses to derive or sign with an invalid private key', () => {
    expect(() => publicKeyFromPrivate(new Uint8Array(32))).toThrow();
    expect(() => publicKeyFromPrivate(new Uint8Array(32).fill(0xff))).toThrow();
    expect(() => signBchMessage(new Uint8Array(32), 'm')).toThrow();
  });

  it('message signatures: valid, and rejected for wrong message / key / length / garbage', () => {
    const sk = generatePrivateKey();
    const pk = binToHex(publicKeyFromPrivate(sk));
    const sig = binToHex(signBchMessage(sk, 'hello'));
    expect(sig).toHaveLength(128);
    expect(bchMessageHash('hello')).toHaveLength(32);
    expect(verifyBchMessage(pk, 'hello', sig)).toBe(true);
    expect(verifyBchMessage(pk, 'hello!', sig)).toBe(false);
    expect(verifyBchMessage(binToHex(publicKeyFromPrivate(generatePrivateKey())), 'hello', sig)).toBe(false);
    expect(verifyBchMessage(pk, 'hello', sig.slice(0, 126))).toBe(false);
    expect(verifyBchMessage(pk, 'hello', `${sig}00`)).toBe(false);
    expect(verifyBchMessage(pk, 'hello', '')).toBe(false);
    expect(verifyBchMessage('zz', 'hello', sig)).toBe(false);
    // untrusted JSON can carry non-strings: must be false, not an exception
    expect(verifyBchMessage(pk, 'hello', undefined as never)).toBe(false);
    expect(verifyBchMessage(undefined as never, 'hello', sig)).toBe(false);
    expect(verifyBchMessage(pk, '', binToHex(signBchMessage(sk, '')))).toBe(true);
    // the domain prefix matters: a Schnorr signature over the bare sha256(message) does not verify
    const bare = secp256k1.signMessageHashSchnorr(sk, sha256Bytes('hello'));
    if (typeof bare === 'string') throw new Error(bare);
    expect(verifyBchMessage(pk, 'hello', binToHex(bare))).toBe(false);
  });
});

describe('signers', () => {
  afterEach(() => {
    delete (globalThis as { nostr?: unknown }).nostr;
  });

  it('LocalBchSigner: fromHex keeps the key; proofs verify against its public key', async () => {
    const sk = generatePrivateKey();
    const s = LocalBchSigner.fromHex(binToHex(sk));
    expect(binToHex(s.privateKey)).toBe(binToHex(sk));
    const pk = binToHex(await s.getPublicKey());
    expect(pk).toBe(binToHex(publicKeyFromPrivate(sk)));
    const proof = await s.prove('msg');
    expect(proof.type).toBe('schnorr-msg');
    expect(verifyBchMessage(pk, 'msg', (proof as { sig: string }).sig)).toBe(true);
    expect(binToHex(new LocalBchSigner().privateKey)).not.toBe(binToHex(new LocalBchSigner().privateKey));
  });

  it('LocalNostrSigner: uses the given secret key and produces valid events', async () => {
    const sk = generateSecretKey();
    const s = new LocalNostrSigner(sk);
    expect(await s.getPublicKey()).toBe(getPublicKey(sk));
    const e = await s.signEvent({ kind: 1, created_at: 1, tags: [], content: 'x' });
    expect(e.pubkey).toBe(getPublicKey(sk));
    expect(verifyEventFresh(e)).toBe(true);
  });

  it('Nip07Signer delegates to window.nostr and fails clearly without it', async () => {
    expect(Nip07Signer.available()).toBe(false);
    const signer = new Nip07Signer();
    expect(() => signer.getPublicKey()).toThrow(/No NIP-07 extension/);
    expect(() => signer.signEvent({ kind: 1, created_at: 1, tags: [], content: '' })).toThrow(/No NIP-07 extension/);

    const sk = generateSecretKey();
    const ext = {
      getPublicKey: vi.fn(async () => getPublicKey(sk)),
      signEvent: vi.fn(async (t: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(t, sk)),
    };
    (globalThis as { nostr?: unknown }).nostr = ext;
    expect(Nip07Signer.available()).toBe(true);
    expect(await signer.getPublicKey()).toBe(getPublicKey(sk));
    const tmpl = { kind: 1, created_at: 2, tags: [['a', 'b']], content: 'c' };
    const e = await signer.signEvent(tmpl);
    expect(ext.signEvent).toHaveBeenCalledWith(tmpl);
    expect(verifyEventFresh(e)).toBe(true);
  });
});

describe('NIP-39 profile cross-reference', () => {
  const fakeBinding = (addr: string, id = 'e'.repeat(64)) => ({ addr, event: { id } }) as unknown as VerifiedBinding;

  it('creates a fresh profile when there is none', () => {
    const t = nip39ProfileTemplate(undefined, fakeBinding('bchtest:qabc'));
    expect(t.kind).toBe(0);
    expect(t.content).toBe('{}');
    expect(t.tags).toEqual([['i', 'bchtest:qabc', 'e'.repeat(64)]]);
    expect(Math.abs(t.created_at - now())).toBeLessThanOrEqual(2);
  });

  it('replaces only our i-tags, preserves content and unrelated tags, and always moves created_at forward', () => {
    const future = now() + 10_000;
    const current = {
      kind: 0,
      created_at: future,
      content: '{"name":"alice"}',
      tags: [
        ['i', 'bitcoincash:qold', 'old'],
        ['i', 'bchtest:qold2'],
        ['i', 'github:alice', 'gist'],
        ['i', 42],
        ['p', 'bitcoincash:qnot-an-i-tag'],
        ['i', 'bitcoincashx:qlookalike'],
      ],
    } as unknown as Event;
    const t = nip39ProfileTemplate(current, fakeBinding('bitcoincash:qnew', 'f'.repeat(64)));
    expect(t.content).toBe('{"name":"alice"}');
    expect(t.created_at).toBe(future + 1);
    expect(t.tags).toEqual([
      ['i', 'github:alice', 'gist'],
      ['i', 42],
      ['p', 'bitcoincash:qnot-an-i-tag'],
      ['i', 'bitcoincashx:qlookalike'],
      ['i', 'bitcoincash:qnew', 'f'.repeat(64)],
    ]);
    // an old profile does not hold created_at back
    const old = nip39ProfileTemplate({ ...current, created_at: 5 }, fakeBinding('bitcoincash:qnew'));
    expect(old.created_at).toBeGreaterThanOrEqual(now() - 1);
  });

  it('nip39Claims lists only BCH cashaddr i-tags', () => {
    expect(NIP39_PLATFORMS).toEqual(['bitcoincash', 'bchtest']);
    expect(nip39Claims(undefined)).toEqual([]);
    expect(nip39Claims({ tags: undefined } as unknown as Event)).toEqual([]);
    const profile = {
      tags: [['i', 'bitcoincash:qa', 'id1'], ['i', 'bchtest:qb'], ['i', 'github:x', 'y'], ['i', 7], ['r', 'bitcoincash:qc']],
    } as unknown as Event;
    expect(nip39Claims(profile)).toEqual([
      { addr: 'bitcoincash:qa', proof: 'id1' },
      { addr: 'bchtest:qb', proof: undefined },
    ]);
  });
});

describe('challenge-response login', () => {
  it('createChallenge has the auth domain, a 16-byte random nonce and the given time', () => {
    const a = createChallenge(AUD, 123);
    const b = createChallenge(AUD, 123);
    expect(a).toMatchObject({ domain: AUTH_DOMAIN, ts: 123, audience: AUD });
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('MemoryNonceStore: issued vs consumed', () => {
    const s = new MemoryNonceStore();
    expect(s.issued('n')).toBe(false);
    s.issue('n');
    expect(s.issued('n')).toBe(true);
    expect(s.consume('n')).toBe(true);
    expect(s.consume('n')).toBe(false);
  });

  it('accepts a correct response once; a replay is rejected', async () => {
    const id = await boundIdentity();
    const v = new ChallengeVerifier(AUD);
    const resp = await respondToChallenge(v.issue(), id.bch, id.nostr);
    expect(resp.nostrEvent.kind).toBe(AUTH_EVENT_KIND);
    expect(resp.nostrEvent.tags).toEqual([['challenge', resp.challenge.nonce], ['audience', AUD]]);
    const r1 = v.verify(resp, id.binding);
    expect(r1).toEqual({ ok: true, reasons: [], nostr: id.binding.nostr, bch: id.binding.bch });
    const r2 = v.verify(resp, id.binding);
    expect(r2.ok).toBe(false);
    expect(r2.reasons).toEqual(['nonce already used']);
  });

  it('expiry: outside the freshness window either way is rejected; the boundary is accepted', async () => {
    const id = await boundIdentity();
    const v = new ChallengeVerifier(AUD);
    const t = now();
    const past = await respondToChallenge(v.issue(t - CHALLENGE_FRESHNESS_SECONDS - 1), id.bch, id.nostr);
    expect(v.verify(past, id.binding, t).reasons).toEqual(['challenge expired']);
    const future = await respondToChallenge(v.issue(t + CHALLENGE_FRESHNESS_SECONDS + 1), id.bch, id.nostr);
    expect(v.verify(future, id.binding, t).reasons).toEqual(['challenge expired']);
    const edge = await respondToChallenge(v.issue(t - CHALLENGE_FRESHNESS_SECONDS), id.bch, id.nostr);
    expect(v.verify(edge, id.binding, t).ok).toBe(true);
    // custom window
    const strict = new ChallengeVerifier(AUD, undefined, 5);
    const r = await respondToChallenge(strict.issue(t - 6), id.bch, id.nostr);
    expect(strict.verify(r, id.binding, t).reasons).toContain('challenge expired');
  });

  it('rejects a challenge issued for another audience / not issued here / wrong domain', async () => {
    const id = await boundIdentity();
    const mine = new ChallengeVerifier(AUD);
    const other = new ChallengeVerifier('https://evil.example');
    const foreign = await respondToChallenge(other.issue(), id.bch, id.nostr);
    expect(mine.verify(foreign, id.binding).reasons).toEqual(['wrong audience', 'unknown nonce']);

    const forged = { ...createChallenge(AUD), domain: 'hermes-id' };
    mine.nonces.issue(forged.nonce);
    const wrongDomain = await respondToChallenge(forged, id.bch, id.nostr);
    expect(mine.verify(wrongDomain, id.binding).reasons).toEqual(['wrong domain']);
  });

  it('rejects invalid or mismatched Nostr signatures', async () => {
    const id = await boundIdentity();
    const v = new ChallengeVerifier(AUD);
    const resp = await respondToChallenge(v.issue(), id.bch, id.nostr);

    const badSig: ChallengeResponse = { ...resp, nostrEvent: { ...resp.nostrEvent, sig: '00'.repeat(64) } };
    expect(v.verify(badSig, id.binding).reasons).toEqual(['nostr signature invalid']);

    const wrongKind = { ...resp, nostrEvent: await id.nostr.signEvent({ kind: 1, created_at: now(), tags: [], content: resp.nostrEvent.content }) };
    expect(v.verify(wrongKind, id.binding).reasons).toEqual(['wrong nostr event kind']);

    const otherContent = { ...resp, nostrEvent: await id.nostr.signEvent({ kind: AUTH_EVENT_KIND, created_at: now(), tags: [], content: '{}' }) };
    expect(v.verify(otherContent, id.binding).reasons).toEqual(['nostr event does not sign this challenge']);

    // challenge swapped after signing: both halves stop matching
    const swapped = { ...resp, challenge: { ...resp.challenge, ts: resp.challenge.ts + 1 } };
    expect(v.verify(swapped, id.binding).reasons).toEqual(['challenge timestamp altered', 'nostr event does not sign this challenge', 'bch signature invalid']);
  });

  it('rejects a missing, invalid or foreign BCH proof', async () => {
    const id = await boundIdentity();
    const v = new ChallengeVerifier(AUD);
    const resp = await respondToChallenge(v.issue(), id.bch, id.nostr);
    expect(v.verify({ ...resp, bchProof: undefined as never }, id.binding).reasons).toEqual(['bch proof missing']);
    expect(v.verify({ ...resp, bchProof: { type: 'schnorr-msg', sig: '11'.repeat(64) } }, id.binding).reasons).toEqual(['bch signature invalid']);
    expect(v.verify({ ...resp, bchProof: { type: 'nope' } as never }, id.binding).reasons).toEqual(['bch proof: unknown type']);
    // another BCH key proving the challenge correctly is still not the bound key
    const intruder = new LocalBchSigner();
    const r = await respondToChallenge(resp.challenge, intruder, id.nostr);
    expect(v.verify(r, id.binding).reasons).toEqual(['bch key is not the current binding']);
  });

  it('rejects when there is no current valid binding, or it belongs to someone else', async () => {
    const id = await boundIdentity();
    const someoneElse = await boundIdentity();
    const v = new ChallengeVerifier(AUD);
    const resp = await respondToChallenge(v.issue(), id.bch, id.nostr);
    expect(v.verify(resp, undefined).reasons).toEqual(['no current binding for this identity']);
    expect(v.verify(resp, { ...id.binding, valid: false }).reasons).toEqual(['no current binding for this identity']);
    expect(v.verify(resp, someoneElse.binding).reasons).toEqual(['nostr key is not the current binding', 'bch key is not the current binding']);
    // none of the failed attempts burned the nonce
    expect(v.verify(resp, id.binding).ok).toBe(true);
  });

  it('a failed attempt does not consume the nonce (custom store sees no consume call)', async () => {
    const id = await boundIdentity();
    const store = { issue: vi.fn(), issued: vi.fn(() => true), consume: vi.fn(() => true) };
    const v = new ChallengeVerifier(AUD, store);
    const resp = await respondToChallenge(v.issue(), id.bch, id.nostr);
    expect(store.issue).toHaveBeenCalledWith(resp.challenge.nonce, resp.challenge.ts);
    v.verify(resp, undefined);
    expect(store.consume).not.toHaveBeenCalled();
    expect(v.verify(resp, id.binding).ok).toBe(true);
    expect(store.consume).toHaveBeenCalledWith(resp.challenge.nonce);
  });
});

describe('pay links: NIP-05 verification (fetch mocked)', () => {
  afterEach(() => useFetchImplementation(globalThis.fetch));

  it('true only when the domain maps the name to this pubkey right now', async () => {
    const pk = getPublicKey(generateSecretKey());
    const calls: string[] = [];
    useFetchImplementation(async (url: string) => {
      calls.push(url);
      if (url.includes('down.example')) return { status: 500, json: async () => ({}) };
      return { status: 200, json: async () => ({ names: { alice: pk, _: pk } }) };
    });
    expect(await verifyNip05('alice@ok.example', pk)).toBe(true);
    expect(calls[0]).toBe('https://ok.example/.well-known/nostr.json?name=alice');
    expect(await verifyNip05('ok.example', pk)).toBe(true); // bare domain = "_"
    expect(await verifyNip05('alice@ok.example', getPublicKey(generateSecretKey()))).toBe(false);
    expect(await verifyNip05('bob@ok.example', pk)).toBe(false);
    expect(await verifyNip05('alice@down.example', pk)).toBe(false);
  });

  it('false without a name, for malformed names, and when the lookup throws', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline');
    });
    useFetchImplementation(fetchSpy);
    expect(await verifyNip05(undefined, 'pk')).toBe(false);
    expect(await verifyNip05('', 'pk')).toBe(false);
    expect(await verifyNip05('not a nip05', 'pk')).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await verifyNip05('alice@ok.example', 'pk')).toBe(false);
    // a non-string from untrusted input makes nostr-tools throw synchronously: still false
    expect(await verifyNip05(42 as never, 'pk')).toBe(false);
  });
});

describe('cross-check with libauth', () => {
  it('lockingBytecodeForAddress matches libauth directly', () => {
    const { addr } = addressesForPublicKey(publicKeyFromPrivate(generatePrivateKey()), 'chipnet');
    const direct = cashAddressToLockingBytecode(addr);
    if (typeof direct === 'string') throw new Error(direct);
    expect(binToHex(lockingBytecodeForAddress(addr))).toBe(binToHex(direct.bytecode));
  });
});
