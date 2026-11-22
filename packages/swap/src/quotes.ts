import type { Event, EventTemplate } from 'nostr-tools/pure';
import { verifyEventFresh } from '@hermes/id';
import type { Filter } from 'nostr-tools';
import { QUOTE_EXPIRY_SECONDS, validateTimeouts, type Direction } from './params.js';

/**
 * Hermes quote protocol over Nostr (docs/PLAN.md §4.1). Ephemeral kinds, so relays
 * forward but do not store them. Every message is a signed event; content is JSON.
 * Received events are data: they are validated field by field, never executed.
 */
export const RFQ_KIND = 25910;
export const QUOTE_KIND = 25911;
export const NOTICE_KIND = 25912;
export const SWAP_TAG = 'hermes-swap';

export interface Rfq {
  v: 1;
  id: string; // random 16-byte hex
  direction: Direction;
  /** Amount the taker gives, base units of the input token, decimal string. */
  amountIn: string;
  evmChainId: number;
  evmToken: string; // USDC address on that chain
  bchToken: string; // PUSD category
  takerEvm: string; // taker EVM address (receives USDC for pusd-to-usdc, sends for usdc-to-pusd)
  takerBch: string; // taker BCH token-aware cashaddr
  takerBchPkh: string; // hex 20 — HTLC recipient or refund key hash
  expiry: number; // unix seconds
}

export interface Quote {
  v: 1;
  rfqId: string;
  quoteId: string;
  direction: Direction;
  amountIn: string;
  amountOut: string; // base units of the output token
  ratePpm: string;
  feeOut: string; // already deducted from amountOut, in output token base units
  tFirst: number; // taker's lock timeout (longer)
  tSecond: number; // solver's lock timeout (shorter)
  solverEvm: string;
  solverBch: string; // token-aware cashaddr
  solverBchPkh: string;
  evmHtlc: string; // HTLC contract the solver will watch/use
  evmChainId: number;
  expiry: number;
}

/** Notice from the taker that the first leg is locked (the solver also watches chains). */
export interface LockNotice {
  v: 1;
  quoteId: string;
  hashlock: string;
  chain: 'evm' | 'bch';
  ref: string; // EVM lock id or BCH txid:vout
}

const now = () => Math.floor(Date.now() / 1000);
const hex = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);

export function rfqTemplate(rfq: Rfq): EventTemplate {
  return { kind: RFQ_KIND, created_at: now(), tags: [['t', SWAP_TAG], ['expiration', String(rfq.expiry)]], content: JSON.stringify(rfq) };
}

export function quoteTemplate(quote: Quote, rfqEvent: Event): EventTemplate {
  return {
    kind: QUOTE_KIND,
    created_at: now(),
    tags: [['t', SWAP_TAG], ['e', rfqEvent.id], ['p', rfqEvent.pubkey], ['expiration', String(quote.expiry)]],
    content: JSON.stringify(quote),
  };
}

export function noticeTemplate(n: LockNotice, solverPubkey: string): EventTemplate {
  return { kind: NOTICE_KIND, created_at: now(), tags: [['t', SWAP_TAG], ['p', solverPubkey]], content: JSON.stringify(n) };
}

function parse<T>(ev: Event, kind: number): T | undefined {
  if (ev.kind !== kind || !verifyEventFresh(ev)) return undefined;
  try {
    return JSON.parse(ev.content) as T;
  } catch {
    return undefined;
  }
}

const isAmount = (s: unknown) => typeof s === 'string' && /^\d{1,30}$/.test(s) && BigInt(s) > 0n;
const isDirection = (d: unknown): d is Direction => d === 'usdc-to-pusd' || d === 'pusd-to-usdc';
const isEvmAddr = (a: unknown) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const isCashAddr = (a: unknown) => typeof a === 'string' && /^(bitcoincash|bchtest):[02-9ac-hj-np-z]{42,}$/.test(a);

export function parseRfq(ev: Event, at = now()): { rfq?: Rfq; errors: string[] } {
  const r = parse<Rfq>(ev, RFQ_KIND);
  if (!r) return { errors: ['not a valid signed RFQ'] };
  const errors: string[] = [];
  if (r.v !== 1) errors.push('version');
  if (typeof r.id !== 'string' || !hex(32).test(r.id)) errors.push('id');
  if (!isDirection(r.direction)) errors.push('direction');
  if (!isAmount(r.amountIn)) errors.push('amountIn');
  if (!Number.isInteger(r.evmChainId)) errors.push('evmChainId');
  if (!isEvmAddr(r.evmToken) || !isEvmAddr(r.takerEvm)) errors.push('evm address');
  if (typeof r.bchToken !== 'string' || !hex(64).test(r.bchToken)) errors.push('bchToken');
  if (!isCashAddr(r.takerBch)) errors.push('takerBch');
  if (typeof r.takerBchPkh !== 'string' || !hex(40).test(r.takerBchPkh)) errors.push('takerBchPkh');
  if (!Number.isInteger(r.expiry) || r.expiry < at) errors.push('expired');
  return errors.length ? { errors } : { rfq: r, errors };
}

/**
 * Taker-side quote validation: signature, binding to our RFQ, freshness, and the
 * timeout-ordering invariant. A quote violating any rule is refused.
 */
export function parseQuote(ev: Event, rfq: Rfq, at = now(), expect: { evmHtlc?: string } = {}): { quote?: Quote; errors: string[] } {
  const q = parse<Quote>(ev, QUOTE_KIND);
  if (!q) return { errors: ['not a valid signed quote'] };
  const errors: string[] = [];
  if (q.v !== 1) errors.push('version');
  if (q.rfqId !== rfq.id) errors.push('rfq mismatch');
  if (q.direction !== rfq.direction) errors.push('direction mismatch');
  if (q.amountIn !== rfq.amountIn) errors.push('amountIn mismatch');
  if (!isAmount(q.amountOut)) errors.push('amountOut');
  if (q.evmChainId !== rfq.evmChainId) errors.push('chain mismatch');
  if (!isEvmAddr(q.solverEvm) || !isEvmAddr(q.evmHtlc)) errors.push('evm address');
  // The solver must watch the same EVM HTLC contract the taker locks in, or it never sees the lock.
  else if (expect.evmHtlc && q.evmHtlc.toLowerCase() !== expect.evmHtlc.toLowerCase()) errors.push('different EVM HTLC contract');
  if (!isCashAddr(q.solverBch)) errors.push('solverBch');
  if (typeof q.solverBchPkh !== 'string' || !hex(40).test(q.solverBchPkh)) errors.push('solverBchPkh');
  if (!Number.isInteger(q.expiry) || q.expiry < at) errors.push('quote expired');
  if (q.expiry > at + QUOTE_EXPIRY_SECONDS * 5) errors.push('quote expiry too long');
  errors.push(...validateTimeouts(q.tFirst, q.tSecond, at));
  return errors.length ? { errors } : { quote: q, errors };
}

export function parseNotice(ev: Event): LockNotice | undefined {
  const n = parse<LockNotice>(ev, NOTICE_KIND);
  if (!n || n.v !== 1 || typeof n.hashlock !== 'string' || !hex(64).test(n.hashlock)) return undefined;
  if (n.chain !== 'evm' && n.chain !== 'bch') return undefined;
  return n;
}

export const rfqFilter = (since = now() - 120): Filter => ({ kinds: [RFQ_KIND], '#t': [SWAP_TAG], since });
export const quoteFilter = (rfqEventId: string): Filter => ({ kinds: [QUOTE_KIND], '#e': [rfqEventId] });
export const noticeFilter = (solverPubkey: string, since = now() - 3600): Filter => ({
  kinds: [NOTICE_KIND],
  '#p': [solverPubkey],
  since,
});

/** Best quote first: largest amountOut, then the longest time left before the taker's lock expires. */
export function rankQuotes(quotes: Quote[]): Quote[] {
  return [...quotes].sort((a, b) => {
    const d = BigInt(b.amountOut) - BigInt(a.amountOut);
    if (d !== 0n) return d > 0n ? 1 : -1;
    return b.tFirst - a.tFirst;
  });
}
