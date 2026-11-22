import type { Event } from 'nostr-tools/pure';
import { parseBindingContent, verifyBinding, verifyRotation, type VerifiedBinding } from './binding.js';
import { RECENT_CHANGE_WARNING_SECONDS } from './constants.js';

export interface ChainVerdict {
  /** Verified chain, genesis (seq 0) first. */
  chain: VerifiedBinding[];
  ok: boolean;
  reasons: string[];
}

/** Flatten an event and its embedded predecessors, newest first. */
export function embeddedChain(event: Event, maxDepth = 64): Event[] {
  const out: Event[] = [];
  let current: Event | undefined = event;
  while (current && out.length < maxDepth) {
    out.push(current);
    const content = parseBindingContent(current);
    current = content?.history?.[content.history.length - 1];
  }
  return out;
}

/** Verify one binding and its embedded rotation chain back to seq 0. */
export function verifyChain(event: Event): ChainVerdict {
  const events = embeddedChain(event).reverse();
  const chain = events.map(verifyBinding);
  const reasons: string[] = [];
  chain.forEach((b, i) => {
    if (!b.valid) reasons.push(`v${b.seq}: ${b.reasons.join(', ')}`);
  });
  if (chain[0] && chain[0].seq !== 0) reasons.push('chain does not reach seq 0');
  for (let i = 1; i < chain.length; i++) {
    for (const r of verifyRotation(chain[i - 1], chain[i])) reasons.push(`v${chain[i].seq}: ${r}`);
  }
  return { chain, ok: reasons.length === 0, reasons };
}

export type IdentityWarning =
  | { code: 'recent-change'; message: string }
  | { code: 'rotated'; message: string }
  | { code: 'fork'; message: string }
  | { code: 'nft-mismatch'; message: string }
  | { code: 'nft-pinned'; message: string }
  | { code: 'single-relay'; message: string };

export interface ResolvedIdentity {
  current: VerifiedBinding;
  chain: VerifiedBinding[];
  genesisHash: string;
  firstSeen: number;
  warnings: IdentityWarning[];
  /** Whether it is safe to pay without extra confirmation. */
  payable: boolean;
}

export interface ResolveAnchor {
  nostr?: string;
  bch?: string;
  addr?: string;
}

const matches = (b: VerifiedBinding, anchor: ResolveAnchor) =>
  (!!anchor.nostr && b.nostr === anchor.nostr) ||
  (!!anchor.bch && b.bch === anchor.bch) ||
  (!!anchor.addr && (b.addr === anchor.addr || b.tokenAddr === anchor.addr));

/**
 * Pick the current binding for an identity from a bag of events gathered from relays.
 * Current = the highest `seq` whose chain verifies back to seq 0 within the lineage
 * (same genesis) that contains the anchor. Stale versions never resolve. Two different
 * valid bindings at the top `seq` are a fork and are flagged as not payable.
 * `pinnedSeq`, when the identity NFT exists, overrides: any other seq is stale.
 */
export function resolveIdentity(
  events: Event[],
  anchor: ResolveAnchor,
  opts: { now?: number; pinnedSeq?: (genesisHash: string, current: VerifiedBinding) => number | undefined; relaysAnswered?: number } = {},
): ResolvedIdentity | undefined {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const lineages = new Map<string, VerifiedBinding[][]>();
  const seen = new Set<string>();
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    const verdict = verifyChain(ev);
    if (!verdict.ok) continue;
    const genesis = verdict.chain[0].payloadHash;
    const list = lineages.get(genesis) ?? [];
    list.push(verdict.chain);
    lineages.set(genesis, list);
  }
  const candidates = [...lineages.entries()].filter(([, chains]) => chains.some((c) => c.some((b) => matches(b, anchor))));
  if (candidates.length === 0) return undefined;
  // If the same anchor appears in several independent lineages (e.g. someone re-bound a key
  // from scratch), prefer the lineage whose genesis is oldest and flag it.
  candidates.sort(([, a], [, b]) => a[0][0].ts - b[0][0].ts);
  const [genesisHash, chains] = candidates[0];
  const warnings: IdentityWarning[] = [];
  if (candidates.length > 1) {
    warnings.push({ code: 'fork', message: 'This key appears in more than one independent identity lineage.' });
  }
  const topSeq = Math.max(...chains.map((c) => c[c.length - 1].seq));
  const tops = new Map<string, VerifiedBinding[]>();
  for (const c of chains) {
    const last = c[c.length - 1];
    if (last.seq === topSeq) tops.set(last.payloadHash, c);
  }
  if (tops.size > 1) warnings.push({ code: 'fork', message: `Two different bindings claim version ${topSeq}.` });
  let chain = [...tops.values()][0];
  let current = chain[chain.length - 1];

  if (opts.pinnedSeq) {
    const pinned = opts.pinnedSeq(genesisHash, current);
    if (pinned !== undefined && pinned !== current.seq) {
      const longest = chains.sort((a, b) => b.length - a.length)[0];
      const atPin = longest.find((b) => b.seq === pinned);
      if (atPin) {
        warnings.push({
          code: 'nft-pinned',
          message: `Identity NFT pins version ${pinned}; newer version ${current.seq} on relays is not yet pinned and is ignored.`,
        });
        chain = longest.slice(0, longest.indexOf(atPin) + 1);
        current = atPin;
      } else {
        warnings.push({
          code: 'nft-mismatch',
          message: `Identity NFT pins version ${pinned}, which no relay could produce (relays show ${current.seq}).`,
        });
      }
    }
  }

  if (anchor.nostr && current.nostr !== anchor.nostr) {
    warnings.push({ code: 'rotated', message: 'This Nostr key was rotated; paying the identity’s current key.' });
  }
  if (anchor.bch && current.bch !== anchor.bch) {
    warnings.push({ code: 'rotated', message: 'This BCH key was rotated; paying the identity’s current key.' });
  }
  if (current.seq > 0 && now - current.ts < RECENT_CHANGE_WARNING_SECONDS) {
    warnings.push({ code: 'recent-change', message: 'Binding changed in the last 24 h.' });
  }
  if (opts.relaysAnswered !== undefined && opts.relaysAnswered < 2) {
    warnings.push({ code: 'single-relay', message: 'Only one relay answered; discovery is less certain.' });
  }
  const payable = !warnings.some((w) => w.code === 'fork' || w.code === 'nft-mismatch');
  return { current, chain, genesisHash, firstSeen: chain[0].ts, warnings, payable };
}
