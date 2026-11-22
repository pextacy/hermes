import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import { queryProfile } from 'nostr-tools/nip05';
import type { Event, Filter } from 'nostr-tools';
import networks from '../../../config/networks.json' with { type: 'json' };
import { BINDING_D_TAG, BINDING_KIND, MIN_RELAYS } from './constants.js';
import { TAG_ADDR, TAG_BCHPK, TAG_GENESIS, TAG_PREV, genesisHashOf, parseBindingContent, verifyBinding, type VerifiedBinding } from './binding.js';
import { resolveIdentity, type ResolveAnchor, type ResolvedIdentity } from './resolve.js';

export const DEFAULT_RELAYS: string[] = networks.nostr.relays;

export type ParsedRecipient =
  | { kind: 'nostr'; pubkey: string; relays?: string[] }
  | { kind: 'nip05'; name: string }
  | { kind: 'bch'; address: string }
  | { kind: 'invalid'; reason: string };

/** Accepts npub, nprofile, 64-hex pubkey, NIP-05 name, or a cashaddr. */
export function parseRecipient(input: string): ParsedRecipient {
  const s = input.trim();
  if (!s) return { kind: 'invalid', reason: 'empty' };
  if (/^(nostr:)?(npub|nprofile)1/.test(s)) {
    try {
      const decoded = nip19.decode(s.replace(/^nostr:/, ''));
      if (decoded.type === 'npub') return { kind: 'nostr', pubkey: decoded.data as string };
      if (decoded.type === 'nprofile') {
        const d = decoded.data as { pubkey: string; relays?: string[] };
        return { kind: 'nostr', pubkey: d.pubkey, relays: d.relays };
      }
    } catch (error) {
      return { kind: 'invalid', reason: `bad bech32: ${String(error)}` };
    }
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return { kind: 'nostr', pubkey: s.toLowerCase() };
  if (/^(bitcoincash|bchtest):/.test(s)) return { kind: 'bch', address: s };
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) return { kind: 'nip05', name: s };
  return { kind: 'invalid', reason: 'not an npub, hex key, NIP-05 name or cashaddr' };
}

export const npubOf = (hex: string) => nip19.npubEncode(hex);

export interface DiscoveryOptions {
  relays?: string[];
  pool?: SimplePool;
  timeoutMs?: number;
}

/**
 * Relay discovery with no Hermes server: query several relays by author, by address
 * or key tag, then follow successor links (rotations) and resolve the current binding.
 */
export class Discovery {
  readonly relays: string[];
  readonly pool: SimplePool;
  readonly timeoutMs: number;

  constructor(opts: DiscoveryOptions = {}) {
    this.relays = opts.relays ?? DEFAULT_RELAYS;
    if (this.relays.length < MIN_RELAYS) console.warn(`Hermes ID: fewer than ${MIN_RELAYS} relays configured`);
    this.pool = opts.pool ?? new SimplePool();
    this.timeoutMs = opts.timeoutMs ?? 6000;
  }

  /** Query each relay separately so we can count how many answered. */
  async query(filter: Filter, relays = this.relays): Promise<{ events: Event[]; answered: number }> {
    const results = await Promise.allSettled(
      relays.map((r) => this.pool.querySync([r], filter, { maxWait: this.timeoutMs })),
    );
    const byId = new Map<string, Event>();
    let answered = 0;
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      answered++;
      for (const ev of r.value) byId.set(ev.id, ev);
    }
    return { events: [...byId.values()], answered };
  }

  private base(): Filter {
    return { kinds: [BINDING_KIND], '#d': [BINDING_D_TAG] };
  }

  byAuthor(pubkey: string, relays?: string[]) {
    return this.query({ ...this.base(), authors: [pubkey] }, relays);
  }

  byAddress(address: string) {
    return this.query({ ...this.base(), '#i': [`${TAG_ADDR}${address}`] });
  }

  byBchKey(pubkey: string) {
    return this.query({ ...this.base(), '#i': [`${TAG_BCHPK}${pubkey}`] });
  }

  /**
   * Follow successors: by lineage (`i` = hermesgen:<genesis>) — which survives replaceable
   * events overwriting intermediate versions — and by direct links (`i` = hermesprev:<hash>).
   */
  async followSuccessors(events: Event[], maxHops = 8): Promise<Event[]> {
    const all = new Map(events.map((e) => [e.id, e]));
    let frontier = events;
    for (let hop = 0; hop < maxHops && frontier.length; hop++) {
      const valid = frontier.map((e) => verifyBinding(e)).filter((b) => b.valid);
      const hashes = [
        ...valid.map((b) => `${TAG_PREV}${b.payloadHash}`),
        ...valid.map((b) => {
          const c = parseBindingContent(b.event);
          return c ? `${TAG_GENESIS}${genesisHashOf(c)}` : '';
        }),
      ].filter((h, i, a) => h && a.indexOf(h) === i);
      if (!hashes.length) break;
      const { events: next } = await this.query({ ...this.base(), '#i': hashes });
      frontier = next.filter((e) => !all.has(e.id));
      for (const e of frontier) all.set(e.id, e);
    }
    return [...all.values()];
  }

  async resolveNip05(name: string): Promise<{ pubkey: string; relays?: string[] } | undefined> {
    const profile = await queryProfile(name);
    return profile ?? undefined;
  }

  /** Resolve any accepted recipient string to the current verified binding. */
  async resolve(
    input: string,
    opts: { pinnedSeq?: (genesisHash: string, current: VerifiedBinding) => number | undefined } = {},
  ): Promise<{ parsed: ParsedRecipient; identity?: ResolvedIdentity; answered: number; error?: string }> {
    let parsed = parseRecipient(input);
    if (parsed.kind === 'invalid') return { parsed, answered: 0, error: parsed.reason };
    let anchor: ResolveAnchor;
    let found: { events: Event[]; answered: number };
    if (parsed.kind === 'nip05') {
      const p = await this.resolveNip05(parsed.name).catch(() => undefined);
      if (!p) return { parsed, answered: 0, error: `NIP-05 name ${parsed.name} not found` };
      parsed = { kind: 'nostr', pubkey: p.pubkey, relays: p.relays };
    }
    if (parsed.kind === 'nostr') {
      anchor = { nostr: parsed.pubkey };
      const relays = [...new Set([...(parsed.relays ?? []), ...this.relays])];
      found = await this.byAuthor(parsed.pubkey, relays);
    } else {
      anchor = { addr: parsed.address };
      found = await this.byAddress(parsed.address);
    }
    const events = await this.followSuccessors(found.events);
    const identity = resolveIdentity(events, anchor, { relaysAnswered: found.answered, pinnedSeq: opts.pinnedSeq });
    if (!identity) {
      return {
        parsed,
        answered: found.answered,
        error: found.answered === 0 ? 'No relay answered' : 'No valid Hermes ID binding found for this identity',
      };
    }
    return { parsed, identity, answered: found.answered };
  }

  /** Publish to every relay (or the given subset, e.g. a republish to stale relays); returns per-relay outcome. */
  async publish(event: Event, relays: string[] = this.relays): Promise<{ relay: string; ok: boolean; message?: string }[]> {
    const results = await Promise.allSettled(this.pool.publish(relays, event));
    return results.map((r, i) => ({
      relay: relays[i],
      ok: r.status === 'fulfilled',
      message: r.status === 'fulfilled' ? String(r.value) : String((r as PromiseRejectedResult).reason),
    }));
  }

  close() {
    this.pool.close(this.relays);
  }
}
