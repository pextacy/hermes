import type { Event } from 'nostr-tools/pure';
import { verifyBinding, verifyRotation, parseBindingContent } from './binding.js';
import { embeddedChain } from './resolve.js';
import { verifyEventFresh } from './canonical.js';

export interface ReportStep {
  label: string;
  ok: boolean;
  detail?: string;
}

/**
 * Human-readable verification report for one binding event: every check a verifier runs,
 * for each version in its embedded rotation chain. Pure and offline.
 */
export function bindingReport(event: Event): { ok: boolean; steps: ReportStep[]; versions: number } {
  if (!looksLikeEvent(event)) return { ok: false, steps: [{ label: 'input is a Nostr event', ok: false }], versions: 0 };
  if (!parseBindingContent(event)) return { ok: false, steps: [{ label: 'content is a Hermes ID binding', ok: false }], versions: 0 };
  const chain = embeddedChain(event).reverse();
  const steps: ReportStep[] = [];
  let prev: ReturnType<typeof verifyBinding> | undefined;
  for (const ev of chain) {
    if (!looksLikeEvent(ev)) {
      steps.push({ label: 'embedded predecessor is a Nostr event', ok: false });
      break;
    }
    const v = verifyBinding(ev);
    const c = parseBindingContent(ev);
    const tag = `v${v.seq}`;
    steps.push({ label: `${tag}: event signed by the bound Nostr key`, ok: verifyEventFresh(ev) && ev.pubkey === v.nostr });
    steps.push({ label: `${tag}: BCH key proof (${c?.bchProof?.type ?? 'missing'}) over the same payload`, ok: !v.reasons.some((r) => r.includes('bch') || r.includes('tx-proof')) });
    steps.push({ label: `${tag}: addresses derived from the BCH key`, ok: !v.reasons.some((r) => r.includes('addr')), detail: v.addr });
    steps.push({ label: `${tag}: distinct keys, domain, version, tags`, ok: v.valid || v.reasons.every((r) => r.includes('bch') || r.includes('nostr signature') || r.includes('addr')), detail: v.reasons.join('; ') || undefined });
    if (prev) {
      const r = verifyRotation(prev, v);
      steps.push({ label: `${tag}: rotation from v${prev.seq} approved by the kept and the old key`, ok: r.length === 0, detail: r.join('; ') || undefined });
    } else if (v.seq !== 0) {
      steps.push({ label: `${tag}: chain reaches the original binding (v0)`, ok: false });
    }
    prev = v;
  }
  return { ok: steps.every((s) => s.ok), steps, versions: chain.length };
}

/** Structural check before running signature checks on untrusted JSON (never throws). */
export function looksLikeEvent(x: unknown): x is Event {
  const e = x as Record<string, unknown> | null;
  return (
    !!e &&
    typeof e === 'object' &&
    typeof e.id === 'string' &&
    typeof e.pubkey === 'string' &&
    typeof e.sig === 'string' &&
    typeof e.kind === 'number' &&
    typeof e.created_at === 'number' &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    (e.tags as unknown[]).every((t) => Array.isArray(t) && t.every((s) => typeof s === 'string'))
  );
}

export type VerifyInput = { kind: 'event'; event: Event } | { kind: 'lookup'; query: string } | { kind: 'invalid'; reason: string };

/**
 * What the user pasted into "Verify any binding": a raw event (JSON, also `{event: …}` as
 * returned by the verifier API, or `["EVENT", sub, ev]` relay frames) or a lookup string.
 */
export function parseVerifyInput(text: string): VerifyInput {
  const t = text.trim();
  if (!t) return { kind: 'invalid', reason: 'Paste an npub, name@domain, cashaddr or a binding event' };
  if (t.startsWith('{') || t.startsWith('[')) {
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch (e) {
      return { kind: 'invalid', reason: `Not valid JSON: ${(e as Error).message}` };
    }
    const candidates = [j, (j as { event?: unknown })?.event, Array.isArray(j) ? j[2] : undefined, Array.isArray(j) ? j[1] : undefined];
    const ev = candidates.find(looksLikeEvent);
    if (!ev) return { kind: 'invalid', reason: 'JSON is not a Nostr event (needs id, pubkey, sig, kind, created_at, tags, content)' };
    return { kind: 'event', event: ev };
  }
  if (/\s/.test(t)) return { kind: 'invalid', reason: 'One identity at a time (no spaces)' };
  return { kind: 'lookup', query: t };
}

export interface BindingVerdict {
  ok: boolean;
  /** valid | invalid | stale (valid, but relays hold a newer version of the identity) */
  status: 'valid' | 'invalid' | 'stale';
  headline: string;
  reasons: string[];
  steps: ReportStep[];
  versions: number;
  summary?: { nostr: string; bch: string; addr: string; tokenAddr: string; seq: number; network?: string; ts: number; idCategory?: string };
}

/**
 * Verdict for one binding event, with reasons. `currentSeq` (optional, from relays) turns a
 * valid but superseded event into `stale` — stale bindings must never be paid.
 */
export function bindingVerdict(event: unknown, opts: { currentSeq?: number; currentEventId?: string } = {}): BindingVerdict {
  if (!looksLikeEvent(event)) {
    return { ok: false, status: 'invalid', headline: 'Invalid — not a Nostr event', reasons: ['not a Nostr event'], steps: [], versions: 0 };
  }
  const content = parseBindingContent(event);
  if (!content) {
    return { ok: false, status: 'invalid', headline: 'Invalid — not a Hermes ID binding', reasons: ['content is not a Hermes binding'], steps: [], versions: 0 };
  }
  const rep = bindingReport(event);
  const v = verifyBinding(event);
  const reasons = rep.steps.filter((s) => !s.ok).map((s) => (s.detail ? `${s.label} (${s.detail})` : s.label));
  const summary = { nostr: v.nostr, bch: v.bch, addr: v.addr, tokenAddr: v.tokenAddr, seq: v.seq, network: v.network, ts: v.ts, idCategory: v.payload?.idCategory };
  if (!rep.ok) return { ok: false, status: 'invalid', headline: `Invalid — ${reasons.length} check(s) failed`, reasons, steps: rep.steps, versions: rep.versions, summary };
  if (opts.currentSeq !== undefined && opts.currentSeq > v.seq) {
    return {
      ok: false,
      status: 'stale',
      headline: `Stale — signatures are valid, but this is v${v.seq}; relays hold v${opts.currentSeq}`,
      reasons: [`superseded by version ${opts.currentSeq}: never pay this address`],
      steps: rep.steps,
      versions: rep.versions,
      summary,
    };
  }
  return {
    ok: true,
    status: 'valid',
    headline: `Valid — v${v.seq}, ${rep.versions} version(s) verified locally`,
    reasons: [],
    steps: rep.steps,
    versions: rep.versions,
    summary,
  };
}
