/**
 * Identity tools (Round 3, G8–G14): pure helpers behind the badge, relay consistency audit,
 * rotation timeline, reverse lookup by address, portable proof bundle and binding diff.
 * Nothing here talks to the network — callers pass in what relays returned.
 */
import * as nip19 from 'nostr-tools/nip19';
import type { Event } from 'nostr-tools/pure';
import { parseBindingContent, type VerifiedBinding } from './binding.js';
import { looksLikeEvent } from './report.js';
import { resolveIdentity, verifyChain, type ResolvedIdentity } from './resolve.js';

const npub = (hex: string) => (/^[0-9a-f]{64}$/.test(hex) ? nip19.npubEncode(hex) : hex);
const shorten = (s: string, a = 10, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[^\x20-\x7e]/g, (c) => `&#${c.codePointAt(0)};`);

// ───────────────────────────── G8 badge ─────────────────────────────

export interface BadgeInput {
  nostr: string; // hex or npub
  addr: string;
  seq: number;
  network?: string;
  /** unix seconds of the binding version */
  ts: number;
}

/** "Verified on Hermes" badge as a standalone SVG string (ASCII only, safe to inline or save). */
export function badgeSvg(b: BadgeInput): string {
  const left = 'Hermes ID';
  const right = `verified v${b.seq} · ${shorten(b.addr.replace(/^(bitcoincash|bchtest):/, ''), 6, 6)}`;
  const sub = `${shorten(npub(b.nostr), 12, 6)} · ${b.network ?? 'bch'} · ${new Date(b.ts * 1000).toISOString().slice(0, 10)}`;
  const lw = 116;
  const rw = Math.max(170, Math.ceil(right.length * 7.6) + 24, Math.ceil(sub.length * 6.4) + 24);
  const w = lw + rw;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="44" viewBox="0 0 ${w} 44" role="img" aria-label="Verified on Hermes">`,
    `<title>${xml(`Verified on Hermes: ${npub(b.nostr)} is bound to ${b.addr} (v${b.seq})`)}</title>`,
    `<rect width="${w}" height="44" rx="6" fill="#1f2328"/>`,
    `<rect x="${lw}" width="${rw}" height="44" rx="6" fill="#0a7d4f"/>`,
    `<rect x="${lw}" width="8" height="44" fill="#0a7d4f"/>`,
    `<g font-family="Verdana,DejaVu Sans,sans-serif" fill="#fff">`,
    `<text x="12" y="27" font-size="13" font-weight="bold">&#10003; ${xml(left)}</text>`,
    `<text x="${lw + 10}" y="19" font-size="12" font-weight="bold">${xml(right)}</text>`,
    `<text x="${lw + 10}" y="35" font-size="10" fill-opacity=".85">${xml(sub)}</text>`,
    `</g></svg>`,
  ].join('');
}

export const svgDataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** HTML snippet for a website / README: the badge linking to the identity's Hermes pay page. */
export function badgeEmbed(b: BadgeInput, appOrigin: string): string {
  const href = `${appOrigin.replace(/\/+$/, '')}/#pay?to=${npub(b.nostr)}`;
  return `<a href="${xml(href)}" title="Verify and pay on Hermes"><img alt="Verified on Hermes: ${xml(b.addr)} (v${b.seq})" src="${svgDataUri(badgeSvg(b))}"/></a>`;
}

// ───────────────────────────── G9 relay audit ─────────────────────────────

export type RelayStatus = 'current' | 'stale' | 'missing' | 'unreachable' | 'conflict';

export interface RelayAuditRow {
  relay: string;
  status: RelayStatus;
  /** highest valid version of this identity the relay holds */
  seq?: number;
  eventId?: string;
  /** number of binding events of this lineage the relay returned */
  events: number;
}

export interface RelayAudit {
  latestSeq: number;
  rows: RelayAuditRow[];
  /** relays that answered but do not hold the latest version — targets for a republish */
  needRepublish: string[];
  consistent: boolean;
}

/**
 * Compare what each relay holds against the latest known version of an identity.
 * `perRelay[i].events` are the binding events one relay returned (any author of the chain).
 */
export function relayAudit(latest: Pick<VerifiedBinding, 'seq' | 'payloadHash' | 'event'>, genesisHash: string, perRelay: { relay: string; answered: boolean; events: Event[] }[]): RelayAudit {
  const rows = perRelay.map(({ relay, answered, events }): RelayAuditRow => {
    if (!answered) return { relay, status: 'unreachable', events: 0 };
    let top: VerifiedBinding | undefined;
    let n = 0;
    for (const ev of events) {
      const v = verifyChain(ev);
      if (!v.ok || v.chain[0].payloadHash !== genesisHash) continue;
      n++;
      const last = v.chain[v.chain.length - 1];
      if (!top || last.seq > top.seq || (last.seq === top.seq && last.payloadHash === latest.payloadHash)) top = last;
    }
    if (!top) return { relay, status: 'missing', events: 0 };
    const status: RelayStatus = top.seq < latest.seq ? 'stale' : top.payloadHash === latest.payloadHash ? 'current' : 'conflict';
    return { relay, status, seq: top.seq, eventId: top.event.id, events: n };
  });
  const needRepublish = rows.filter((r) => r.status === 'stale' || r.status === 'missing').map((r) => r.relay);
  return { latestSeq: latest.seq, rows, needRepublish, consistent: rows.every((r) => r.status === 'current') };
}

// ───────────────────────────── G10 timeline ─────────────────────────────

export interface TimelineEntry {
  seq: number;
  ts: number;
  label: string;
  nostrChanged: boolean;
  bchChanged: boolean;
  nftAttached: boolean;
  /** index of the Nostr / BCH key among the distinct keys of the chain (for colouring lanes) */
  nostrKey: number;
  bchKey: number;
  nostr: string;
  addr: string;
  /** seconds since the previous version */
  sincePrev?: number;
}

export function rotationTimeline(chain: Pick<VerifiedBinding, 'seq' | 'ts' | 'nostr' | 'bch' | 'addr' | 'payload'>[]): TimelineEntry[] {
  const nKeys: string[] = [];
  const bKeys: string[] = [];
  return chain.map((b, i) => {
    const prev = chain[i - 1];
    if (!nKeys.includes(b.nostr)) nKeys.push(b.nostr);
    if (!bKeys.includes(b.bch)) bKeys.push(b.bch);
    const nostrChanged = !!prev && prev.nostr !== b.nostr;
    const bchChanged = !!prev && prev.bch !== b.bch;
    const nftAttached = !!b.payload?.idCategory && b.payload.idCategory !== prev?.payload?.idCategory;
    const label = !prev
      ? 'original binding'
      : nostrChanged && bchChanged
        ? 'both keys changed'
        : nostrChanged
          ? 'Nostr key rotated'
          : bchChanged
            ? 'BCH key rotated'
            : nftAttached
              ? 'identity NFT attached'
              : 're-issued';
    return {
      seq: b.seq,
      ts: b.ts,
      label,
      nostrChanged,
      bchChanged,
      nftAttached,
      nostrKey: nKeys.indexOf(b.nostr),
      bchKey: bKeys.indexOf(b.bch),
      nostr: b.nostr,
      addr: b.addr,
      sincePrev: prev ? b.ts - prev.ts : undefined,
    };
  });
}

/** "3 min", "2 h", "5 d" */
export function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

// ───────────────────────────── G11 reverse lookup ─────────────────────────────

export interface AddressOwner {
  genesisHash: string;
  identity: ResolvedIdentity;
  /** versions of this identity that named the address */
  seqs: number[];
  /** the address is in the identity's current version (safe to pay), or only in older ones */
  isCurrent: boolean;
}

/**
 * Who claims a BCH address? Groups relay events (already followed to successors) by lineage and,
 * for each lineage that ever named the address, resolves the current version.
 */
export function addressOwners(events: Event[], address: string): AddressOwner[] {
  const lineages = new Map<string, Event[]>();
  for (const ev of events) {
    const v = verifyChain(ev);
    if (!v.ok) continue;
    const g = v.chain[0].payloadHash;
    lineages.set(g, [...(lineages.get(g) ?? []), ev]);
  }
  const out: AddressOwner[] = [];
  for (const [genesisHash, evs] of lineages) {
    const named = new Set<number>();
    for (const ev of evs) for (const b of verifyChain(ev).chain) if (b.addr === address || b.tokenAddr === address) named.add(b.seq);
    if (!named.size) continue;
    const identity = resolveIdentity(evs, { addr: address });
    if (!identity) continue;
    const isCurrent = identity.current.addr === address || identity.current.tokenAddr === address;
    out.push({ genesisHash, identity, seqs: [...named].sort((a, b) => a - b), isCurrent });
  }
  return out.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.identity.firstSeen - b.identity.firstSeen);
}

// ───────────────────────────── G12 proof bundle ─────────────────────────────

export const PROOF_BUNDLE_FORMAT = 'hermes-proof-bundle';

export interface ProofBundle {
  format: typeof PROOF_BUNDLE_FORMAT;
  v: 1;
  /** when the bundle was made (unix seconds) — the proof is only as fresh as this */
  createdAt: number;
  npub: string;
  addr: string;
  tokenAddr: string;
  seq: number;
  network?: string;
  genesisHash: string;
  /** the current binding event; it embeds every earlier version (the full chain) */
  event: Event;
  chain: { seq: number; ts: number; eventId: string; payloadHash: string; npub: string; addr: string }[];
  /** optional: which relays held which version when the bundle was made */
  relays?: { relay: string; status: string; seq?: number }[];
  howToVerify: string;
}

export function makeProofBundle(event: Event, opts: { now?: number; relays?: ProofBundle['relays'] } = {}): ProofBundle {
  const v = verifyChain(event);
  if (!v.ok) throw new Error(`Binding does not verify: ${v.reasons.join(', ')}`);
  const cur = v.chain[v.chain.length - 1];
  return {
    format: PROOF_BUNDLE_FORMAT,
    v: 1,
    createdAt: opts.now ?? Math.floor(Date.now() / 1000),
    npub: npub(cur.nostr),
    addr: cur.addr,
    tokenAddr: cur.tokenAddr,
    seq: cur.seq,
    network: cur.network,
    genesisHash: v.chain[0].payloadHash,
    event,
    chain: v.chain.map((b) => ({ seq: b.seq, ts: b.ts, eventId: b.event.id, payloadHash: b.payloadHash, npub: npub(b.nostr), addr: b.addr })),
    ...(opts.relays ? { relays: opts.relays } : {}),
    howToVerify: 'Upload this file in Hermes → Identity → Verify any binding, or run `hermes id verify` on the event. Every signature and the rotation chain back to v0 are checked offline.',
  };
}

export interface BundleVerdict {
  ok: boolean;
  reasons: string[];
  bundle?: ProofBundle;
  /** verified chain (genesis first) recomputed from the embedded event */
  chain: VerifiedBinding[];
}

/** Verify a proof bundle with no network: signatures, chain, and that the summary matches the event. */
export function verifyProofBundle(input: unknown): BundleVerdict {
  let j = input;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j);
    } catch (e) {
      return { ok: false, reasons: [`not JSON: ${(e as Error).message}`], chain: [] };
    }
  }
  const b = j as Partial<ProofBundle> | null;
  if (!b || typeof b !== 'object' || b.format !== PROOF_BUNDLE_FORMAT) return { ok: false, reasons: ['not a Hermes proof bundle (format field missing)'], chain: [] };
  if (!looksLikeEvent(b.event)) return { ok: false, reasons: ['bundle has no valid Nostr event'], chain: [] };
  if (!parseBindingContent(b.event)) return { ok: false, reasons: ['event is not a Hermes binding'], chain: [] };
  const v = verifyChain(b.event);
  const reasons = [...v.reasons];
  const cur = v.chain[v.chain.length - 1];
  if (cur) {
    if (b.seq !== cur.seq) reasons.push(`summary says v${b.seq}, event is v${cur.seq}`);
    if (b.addr !== cur.addr) reasons.push(`summary address ${b.addr} differs from the signed address ${cur.addr}`);
    if (b.npub !== npub(cur.nostr)) reasons.push('summary npub differs from the signing key');
    if (b.genesisHash !== v.chain[0]?.payloadHash) reasons.push('summary genesis hash differs from the chain');
    const listed = b.chain ?? [];
    if (listed.length !== v.chain.length) reasons.push(`summary lists ${listed.length} versions, event embeds ${v.chain.length}`);
    else
      listed.forEach((c, i) => {
        if (c.payloadHash !== v.chain[i].payloadHash || c.eventId !== v.chain[i].event.id) reasons.push(`summary entry v${c.seq} does not match the embedded chain`);
      });
  }
  return { ok: reasons.length === 0, reasons, bundle: b as ProofBundle, chain: v.chain };
}

// ───────────────────────────── G14 diff ─────────────────────────────

export interface DiffRow {
  field: string;
  a: string;
  b: string;
  changed: boolean;
}

function proofKind(ev: Event, which: 'bch' | 'rotBch' | 'rotNostr'): string {
  const c = parseBindingContent(ev);
  if (!c) return '—';
  if (which === 'bch') return c.bchProof?.type ?? '—';
  if (which === 'rotBch') return c.rotation?.prevBchProof ? `old BCH key (${c.rotation.prevBchProof.type})` : '—';
  return c.rotation?.prevNostrEvent ? `old Nostr key ${shorten(npub(c.rotation.prevNostrEvent.pubkey), 12, 6)}` : '—';
}

/** Field-by-field comparison of two versions of a binding. */
export function bindingDiff(a: VerifiedBinding, b: VerifiedBinding): DiffRow[] {
  const iso = (ts: number) => (ts > 0 ? new Date(ts * 1000).toISOString().replace('.000Z', 'Z') : '—');
  const rows: [string, string, string][] = [
    ['version (seq)', `v${a.seq}`, `v${b.seq}`],
    ['Nostr key (npub)', npub(a.nostr), npub(b.nostr)],
    ['BCH public key', a.bch, b.bch],
    ['BCH address', a.addr, b.addr],
    ['token address', a.tokenAddr, b.tokenAddr],
    ['network', a.network ?? '—', b.network ?? '—'],
    ['signed at', iso(a.ts), iso(b.ts)],
    ['previous payload (prev)', a.payload?.prev ?? '— (genesis)', b.payload?.prev ?? '— (genesis)'],
    ['identity NFT category', a.payload?.idCategory ?? '—', b.payload?.idCategory ?? '—'],
    ['payload hash', a.payloadHash, b.payloadHash],
    ['event id', a.event.id, b.event.id],
    ['BCH proof', proofKind(a.event, 'bch'), proofKind(b.event, 'bch')],
    ['rotation approved by (BCH)', proofKind(a.event, 'rotBch'), proofKind(b.event, 'rotBch')],
    ['rotation approved by (Nostr)', proofKind(a.event, 'rotNostr'), proofKind(b.event, 'rotNostr')],
    ['valid', a.valid ? 'yes' : 'no', b.valid ? 'yes' : 'no'],
  ];
  return rows.map(([field, x, y]) => ({ field, a: x, b: y, changed: x !== y }));
}
