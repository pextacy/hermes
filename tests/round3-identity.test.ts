/**
 * Round 3 identity features G8–G14 (pure logic in packages/id/src/tools.ts):
 * badge + embed, relay consistency audit, rotation timeline, reverse lookup by address,
 * portable proof bundle, binding diff. Local only: keys generated in memory, no relays.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey } from '@bitauth/libauth';
import type { Event } from 'nostr-tools/pure';
import {
  LocalBchSigner,
  LocalNostrSigner,
  addressOwners,
  badgeEmbed,
  badgeSvg,
  bindingDiff,
  createBinding,
  humanDuration,
  makeProofBundle,
  npubOf,
  relayAudit,
  rotateBinding,
  rotationTimeline,
  svgDataUri,
  verifyChain,
  verifyProofBundle,
} from '@hermes/id';
import { tamperedCopy } from '../apps/web/src/lib/identity-ui';

let v0: Event, v1: Event, v2: Event, other: Event;
const chainOf = (e: Event) => verifyChain(e).chain;
const top = (e: Event) => chainOf(e)[chainOf(e).length - 1];
const genesis = () => chainOf(v2)[0].payloadHash;

beforeAll(async () => {
  const bch = new LocalBchSigner(generatePrivateKey());
  const nostrA = new LocalNostrSigner();
  v0 = (await createBinding({ bch, nostr: nostrA, network: 'chipnet' })).event;
  const nostrB = new LocalNostrSigner();
  v1 = (await rotateBinding({ prevEvent: v0, currentBch: bch, currentNostr: nostrA, newNostr: nostrB, network: 'chipnet' })).event;
  v2 = (await rotateBinding({ prevEvent: v1, currentBch: bch, currentNostr: nostrB, newBch: new LocalBchSigner(generatePrivateKey()), network: 'chipnet' })).event;
  other = (await createBinding({ bch: new LocalBchSigner(generatePrivateKey()), nostr: new LocalNostrSigner(), network: 'chipnet' })).event;
});

describe('G8 badge', () => {
  it('renders an ASCII-only SVG naming the version and address, and an embed snippet', () => {
    const b = top(v2);
    const svg = badgeSvg({ nostr: b.nostr, addr: b.addr, seq: b.seq, network: b.network, ts: b.ts });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('verified v2');
    expect(svg).toContain(npubOf(b.nostr)); // full npub in <title>
    expect(/^[\x20-\x7e]*$/.test(svg)).toBe(true);
    const embed = badgeEmbed({ nostr: b.nostr, addr: b.addr, seq: b.seq, ts: b.ts }, 'https://hermes.example/');
    expect(embed).toContain(`href="https://hermes.example/#pay?to=${npubOf(b.nostr)}"`);
    expect(embed).toContain(svgDataUri(svg).slice(0, 40));
    expect(decodeURIComponent(svgDataUri(svg).split(',')[1])).toBe(svg);
  });
  it('escapes markup in fields', () => {
    expect(badgeSvg({ nostr: 'x', addr: '<script>&"', seq: 0, ts: 0 })).not.toContain('<script>');
  });
});

describe('G9 relay audit', () => {
  it('classifies current, stale, missing, unreachable and conflicting relays', () => {
    const latest = top(v2);
    const a = relayAudit(latest, genesis(), [
      { relay: 'r1', answered: true, events: [v0, v2] },
      { relay: 'r2', answered: true, events: [v0] },
      { relay: 'r3', answered: true, events: [other] },
      { relay: 'r4', answered: false, events: [] },
    ]);
    expect(a.rows.map((r) => r.status)).toEqual(['current', 'stale', 'missing', 'unreachable']);
    expect(a.rows[1].seq).toBe(0);
    expect(a.needRepublish).toEqual(['r2', 'r3']);
    expect(a.consistent).toBe(false);
    const ok = relayAudit(latest, genesis(), [{ relay: 'r1', answered: true, events: [v2, v1] }]);
    expect(ok.consistent).toBe(true);
    expect(ok.needRepublish).toEqual([]);
  });
  it('ignores tampered events', () => {
    const a = relayAudit(top(v2), genesis(), [{ relay: 'r', answered: true, events: [tamperedCopy(v2), v1] }]);
    expect(a.rows[0]).toMatchObject({ status: 'stale', seq: 1 });
  });
});

describe('G10 rotation timeline', () => {
  it('marks which key changed per version and colours keys by identity', () => {
    const t = rotationTimeline(chainOf(v2));
    expect(t.map((e) => e.label)).toEqual(['original binding', 'Nostr key rotated', 'BCH key rotated']);
    expect(t.map((e) => [e.nostrChanged, e.bchChanged])).toEqual([
      [false, false],
      [true, false],
      [false, true],
    ]);
    expect(t.map((e) => e.nostrKey)).toEqual([0, 1, 1]);
    expect(t.map((e) => e.bchKey)).toEqual([0, 0, 1]);
    expect(t[0].sincePrev).toBeUndefined();
    expect(t[2].sincePrev).toBeGreaterThanOrEqual(0);
    expect([humanDuration(5), humanDuration(120), humanDuration(7200), humanDuration(3 * 86400)]).toEqual(['5 s', '2 min', '2 h', '3 d']);
  });
});

describe('G11 reverse lookup by address', () => {
  it('finds the current owner and flags an old address', () => {
    const oldAddr = top(v0).addr;
    const newAddr = top(v2).addr;
    const events = [v0, v2, other]; // what relays hold after a Nostr then a BCH rotation
    const cur = addressOwners(events, newAddr);
    expect(cur).toHaveLength(1);
    expect(cur[0]).toMatchObject({ isCurrent: true, seqs: [2] });
    const old = addressOwners(events, oldAddr);
    expect(old).toHaveLength(1);
    expect(old[0].isCurrent).toBe(false);
    expect(old[0].seqs).toEqual([0, 1]);
    expect(old[0].identity.current.addr).toBe(newAddr);
    expect(addressOwners(events, top(other).tokenAddr)[0].isCurrent).toBe(true);
    expect(addressOwners(events, 'bchtest:qnobody')).toEqual([]);
  });
});

describe('G12 proof bundle', () => {
  it('round-trips and verifies offline', () => {
    const b = makeProofBundle(v2, { now: 1_700_000_000, relays: [{ relay: 'r1', status: 'current', seq: 2 }] });
    expect(b).toMatchObject({ format: 'hermes-proof-bundle', v: 1, seq: 2, createdAt: 1_700_000_000 });
    expect(b.chain.map((c) => c.seq)).toEqual([0, 1, 2]);
    const v = verifyProofBundle(JSON.stringify(b));
    expect(v.ok).toBe(true);
    expect(v.chain).toHaveLength(3);
  });
  it('rejects tampering of the event or the summary', () => {
    const b = makeProofBundle(v2);
    expect(verifyProofBundle({ ...b, event: tamperedCopy(v2) }).ok).toBe(false);
    const lied = verifyProofBundle({ ...b, addr: top(other).addr });
    expect(lied.ok).toBe(false);
    expect(lied.reasons.join()).toMatch(/summary address/);
    expect(verifyProofBundle({ ...b, chain: b.chain.slice(1) }).reasons.join()).toMatch(/lists 2 versions/);
    expect(verifyProofBundle({ ...b, event: v1 }).ok).toBe(false); // summary says v2
    expect(verifyProofBundle('{nope').reasons[0]).toMatch(/not JSON/);
    expect(verifyProofBundle({ hello: 1 }).reasons[0]).toMatch(/not a Hermes proof bundle/);
    expect(() => makeProofBundle(tamperedCopy(v2))).toThrow(/does not verify/);
  });
});

describe('G14 binding diff', () => {
  it('lists every field and flags what changed', () => {
    const [a, b, c] = chainOf(v2);
    const d01 = bindingDiff(a, b);
    const changed = (rows: ReturnType<typeof bindingDiff>) => rows.filter((r) => r.changed).map((r) => r.field);
    expect(changed(d01)).toContain('Nostr key (npub)');
    expect(changed(d01)).not.toContain('BCH address');
    expect(changed(d01)).toContain('rotation approved by (Nostr)');
    const d12 = bindingDiff(b, c);
    expect(changed(d12)).toEqual(expect.arrayContaining(['BCH address', 'BCH public key', 'token address', 'version (seq)']));
    expect(changed(d12)).not.toContain('Nostr key (npub)');
    expect(changed(bindingDiff(c, c))).toEqual([]);
    expect(d01.find((r) => r.field === 'previous payload (prev)')!.a).toMatch(/genesis/);
  });
});
