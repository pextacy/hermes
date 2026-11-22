/** Round 3 — Developers tab (G29–G35): pure logic in apps/web/src/lib/devtools.ts. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyEvent } from 'nostr-tools/pure';
import {
  AUTH_EVENT_KIND,
  BINDING_KIND,
  LocalBchSigner,
  LocalNostrSigner,
  ROTATION_EVENT_KIND,
  addressesForPublicKey,
  bchMessageHash,
  createBinding,
  payloadHash,
  verifyBchMessage,
} from '@hermes/id';
import { NOTICE_KIND, QUOTE_KIND, RFQ_KIND } from '@hermes/swap';
import { MerkleTree, lockingBytecodeOf } from '@hermes/drops';
import { binToHex } from '@bitauth/libauth';
import {
  checkPreimage,
  cleanHex,
  curlOf,
  encodeDropsLeaf,
  explorePayload,
  hashlockOf,
  newSecret,
  nostrKinds,
  runVerifierRequest,
  summarizeVitest,
  verifierRequest,
} from '../apps/web/src/lib/devtools';
import { createVerifierServer } from '../apps/verifier/src/server';
import { Discovery } from '@hermes/id';
import report from '../apps/web/src/generated/test-report.json';

const sha = (hex: string) => createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const ADDR = addressesForPublicKey('02' + '79' + '11'.repeat(31), 'chipnet').addr;

describe('G33 hashlock tool', () => {
  it('generates 32-byte secrets and hashes the bytes, not the text', () => {
    const s = newSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(newSecret()).not.toBe(s);
    expect(hashlockOf(s)).toBe(sha(s));
    expect(hashlockOf('0x' + s.toUpperCase())).toBe(sha(s));
  });
  it('checks preimages', () => {
    const s = newSecret();
    expect(checkPreimage(s, hashlockOf(s))).toEqual({ ok: true, computed: sha(s) });
    const wrong = checkPreimage(newSecret(), hashlockOf(s));
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.reason).toMatch(/does not equal/);
    expect(checkPreimage('zz', hashlockOf(s))).toMatchObject({ ok: false, reason: 'preimage: not hex' });
    expect(checkPreimage(s, 'abcd')).toMatchObject({ ok: false, reason: 'hashlock: expected 32 bytes, got 2' });
    // a short preimage that matches is still flagged: the HTLCs require 32 bytes
    expect(checkPreimage('ab', sha('ab'))).toMatchObject({ ok: false, computed: sha('ab') });
    expect(() => cleanHex('abc')).toThrow(/odd/);
  });
});

describe('G32 canonical payload explorer', () => {
  it('canonicalises a payload and shows the message each key signs, matching the real signatures', async () => {
    const { event, content } = await createBinding({ bch: new LocalBchSigner(), nostr: new LocalNostrSigner(), network: 'chipnet' });
    const p = content.payload;
    const shuffled = JSON.stringify({ ts: p.ts, addr: p.addr, seq: p.seq, v: p.v, nostr: p.nostr, bch: p.bch, tokenAddr: p.tokenAddr, prev: p.prev, domain: p.domain }, null, 2);
    const r = explorePayload(shuffled);
    expect(r.input).toBe('payload');
    expect(r.canonical).toBe(JSON.stringify(Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)))));
    expect(r.payloadHash).toBe(payloadHash(p));
    expect(r.warnings).toEqual([]);
    const bch = r.signed[0];
    expect(bch.message.startsWith('Hermes ID signed message:\n')).toBe(true);
    expect(bch.digest).toBe(binToHex(bchMessageHash(r.canonical)));
    expect(content.bchProof.type === 'schnorr-msg' && verifyBchMessage(p.bch, r.canonical, content.bchProof.sig)).toBe(true);

    // whole event: the reconstructed NIP-01 serialisation hashes to the real event id
    const e = explorePayload(JSON.stringify(event));
    expect(e.input).toBe('event');
    expect(e.payloadHash).toBe(payloadHash(p));
    expect(e.signed[1].digest).toBe(event.id);
    expect(e.signed[1].note).toContain('Matches');
    // binding content with its bchProof gives the exact same event id too
    expect(explorePayload(event.content).signed[1].digest).toBe(event.id);
    expect(verifyEvent(event)).toBe(true);

    const tampered = { ...event, id: '00'.repeat(32) };
    expect(explorePayload(JSON.stringify(tampered)).signed[1].note).toContain('NOT match');
  });
  it('flags problems and rotation approvals', () => {
    const r = explorePayload('{"domain":"other","v":2,"seq":3,"extra":1}');
    expect(r.warnings.join(' ')).toMatch(/missing payload field.*nostr/);
    expect(r.warnings.join(' ')).toMatch(/unknown field.*extra/);
    expect(r.warnings.join(' ')).toMatch(/domain is "other"/);
    expect(r.signed.map((s) => s.key)).toContain('Previous keys (rotation)');
    expect(() => explorePayload('{nope')).toThrow(/Not valid JSON/);
    expect(() => explorePayload('[1]')).toThrow(/JSON object/);
  });
});

describe('G35 drops leaf encoder', () => {
  it('encodes address + cumulative + account id exactly like the Merkle tree', () => {
    const lb = lockingBytecodeOf(ADDR);
    const r = encodeDropsLeaf(ADDR, '1000', 7);
    expect(r.lockingBytecode).toBe(lb);
    expect(r.cumulativeLE).toBe('e803000000000000');
    expect(r.accountIdLE).toBe('07000000');
    expect(r.leafBytes).toBe(lb + 'e803000000000000' + '07000000');
    expect(r.leafHash).toBe(sha(r.leafBytes));
    // single-leaf tree root = the leaf hash
    expect(new MerkleTree([{ lockingBytecode: lb, cumulative: 1000n, accountId: 7 }]).root).toBe(r.leafHash);
  });
  it('rejects bad input', () => {
    expect(() => encodeDropsLeaf('nope', '1', 0)).toThrow(/address/);
    expect(() => encodeDropsLeaf(ADDR, '1.5', 0)).toThrow(/whole number/);
    expect(() => encodeDropsLeaf(ADDR, '0', 0)).toThrow(/cumulative out of range/);
    expect(() => encodeDropsLeaf(ADDR, '1', -1)).toThrow(/accountId/);
  });
});

describe('G34 nostr kinds reference', () => {
  it('lists every kind from the package constants, with examples built by the real templates', () => {
    const rows = nostrKinds();
    const kinds = rows.map((r) => r.kind);
    for (const k of [BINDING_KIND, ROTATION_EVENT_KIND, AUTH_EVENT_KIND, RFQ_KIND, QUOTE_KIND, NOTICE_KIND, 4, 0]) expect(kinds).toContain(k);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const r of rows) {
      expect(r.example.kind).toBe(r.kind);
      // every tag name used in the example is documented
      for (const t of r.example.tags) expect(r.tags.some((d) => d.tag.split(/[=,]/)[0] === t[0] || d.tag === t[0]), `${r.kind} ${t[0]}`).toBe(true);
    }
    const binding = rows.find((r) => r.kind === BINDING_KIND)!;
    expect(binding.example.tags.find((t) => t[0] === 'd')?.[1]).toBe('hermes-id');
    expect(binding.example.tags.some((t) => t[0] === 'i' && t[1].startsWith('hermesgen:'))).toBe(true);
  });
});

describe('G29 verifier playground', () => {
  it('builds requests and curl lines', () => {
    expect(verifierRequest('http://localhost:8787/', 'info')).toEqual({ method: 'GET', url: 'http://localhost:8787/' });
    expect(verifierRequest('http://x:1', 'resolve', { q: ' a@b.c ' }).url).toBe('http://x:1/resolve?q=a%40b.c');
    const v = verifierRequest('http://x:1', 'verify', { event: '{"id":"1"}', offline: true });
    expect(v).toMatchObject({ method: 'POST', url: 'http://x:1/verify?offline=1' });
    expect(JSON.parse(v.body!)).toEqual({ event: { id: '1' } });
    expect(verifierRequest('http://x:1', 'challenge-verify', { response: '{}' }).url).toBe('http://x:1/challenge/verify');
    expect(() => verifierRequest('nope', 'info')).toThrow(/valid URL/);
    expect(() => verifierRequest('ftp://x', 'info')).toThrow(/http/);
    expect(() => verifierRequest('http://x', 'resolve', {})).toThrow(/npub/);
    expect(() => verifierRequest('http://x', 'verify', { event: '{' })).toThrow(/not valid JSON/);
    expect(curlOf({ method: 'POST', url: 'http://x/verify', body: `{"a":"it's"}` })).toBe(`curl -X POST 'http://x/verify' -H 'content-type: application/json' -d '{"a":"it'\\''s"}'`);
  });
  it('never throws: unreachable, non-JSON and timeouts become readable errors', async () => {
    const down = await runVerifierRequest({ method: 'GET', url: 'http://127.0.0.1:9/' }, (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch);
    expect(down.ok).toBe(false);
    expect(down.error).toMatch(/could not reach the verifier.*CORS/);
    const html = await runVerifierRequest({ method: 'GET', url: 'http://x/' }, (async () => new Response('<html>', { status: 200 })) as typeof fetch);
    expect(html).toMatchObject({ ok: false, status: 200, text: '<html>' });
    const slow = await runVerifierRequest(
      { method: 'GET', url: 'http://x/' },
      ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch,
      50,
    );
    expect(slow.error).toMatch(/no answer within/);
  });
  it('round-trips against the real verifier server (info, offline verify, challenge)', async () => {
    const server = createVerifierServer({ audience: 'http://test', discovery: new Discovery({ relays: ['ws://127.0.0.1:1', 'ws://127.0.0.1:2', 'ws://127.0.0.1:3'] }) });
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const info = await runVerifierRequest(verifierRequest(base, 'info'));
      expect(info).toMatchObject({ ok: true, status: 200, body: { service: 'hermes-id verifier' } });
      const { event } = await createBinding({ bch: new LocalBchSigner(), nostr: new LocalNostrSigner(), network: 'chipnet' });
      const v = await runVerifierRequest(verifierRequest(base, 'verify', { event: JSON.stringify(event), offline: true }));
      expect(v).toMatchObject({ ok: true, body: { ok: true, status: 'valid' } });
      const c = await runVerifierRequest(verifierRequest(base, 'challenge'));
      expect(c.body).toMatchObject({ domain: 'hermes-auth', audience: 'http://test' });
      const bad = await runVerifierRequest(verifierRequest(base, 'challenge-verify', { response: '{}' }));
      expect(bad).toMatchObject({ ok: false, status: 400, body: { error: 'response required' } });
    } finally {
      server.close();
    }
  });
});

describe('G31 test report', () => {
  it('summarises vitest JSON per suite', () => {
    const r = summarizeVitest(
      {
        testResults: [
          { name: '/repo/tests/b.test.ts', startTime: 0, endTime: 1500, assertionResults: [{ status: 'passed' }, { status: 'failed' }, { status: 'skipped' }] },
          { name: '/repo/tests/a.test.ts', startTime: 10, endTime: 20, assertionResults: [{ status: 'passed' }] },
        ],
      },
      '/repo',
      'T',
    );
    expect(r).toEqual({
      generatedAt: 'T',
      runner: 'vitest',
      totals: { suites: 2, tests: 4, passed: 2, failed: 1, skipped: 1 },
      suites: [
        { file: 'tests/a.test.ts', tests: 1, passed: 1, failed: 0, skipped: 0, ms: 10 },
        { file: 'tests/b.test.ts', tests: 3, passed: 1, failed: 1, skipped: 1, ms: 1500 },
      ],
    });
  });
  it('the committed report comes from a real run and is self-consistent', () => {
    expect(report.totals.suites).toBe(report.suites.length);
    expect(report.totals.tests).toBe(report.suites.reduce((s, x) => s + x.tests, 0));
    expect(report.totals.tests).toBeGreaterThan(100);
    expect(report.suites.every((s) => s.file.startsWith('tests/'))).toBe(true);
  });
});
