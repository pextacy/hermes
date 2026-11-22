import { apply, SwapTransitionError, type SwapFact, type SwapState } from './machine.js';
import { SAFETY_MARGIN_SECONDS, validateTimeouts, type Direction } from './params.js';
import { rankQuotes, type Quote } from './quotes.js';

/**
 * Pure taker-side helpers shared by the web Swap tab and the headless taker CLI:
 * quote ordering, solver reputation from local history, countdowns, and turning
 * chain observations into state-machine facts (so a reloaded page can resume).
 */

/** Rank quote entries (quote + its Nostr event, or any wrapper) best first, keeping the wrapper. */
export function rankQuoteEntries<T extends { quote: Quote }>(entries: T[]): T[] {
  const order = rankQuotes(entries.map((e) => e.quote)).map((q) => q.quoteId);
  return [...entries].sort((a, b) => order.indexOf(a.quote.quoteId) - order.indexOf(b.quote.quoteId));
}

/** What this taker saw from a solver before (local history only — no global reputation is claimed). */
export function solverStats(history: { solverPubkey: string; state: Pick<SwapState, 'phase'> }[], solverPubkey: string) {
  const mine = history.filter((h) => h.solverPubkey === solverPubkey);
  const completed = mine.filter((h) => h.state.phase === 'completed').length;
  const refunded = mine.filter((h) => h.state.phase.includes('refunded')).length;
  return { total: mine.length, completed, refunded };
}

/** "2h 05m", "4m 09s", "12s"; "0s" once passed. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(r).padStart(2, '0')}s`;
  return `${r}s`;
}

/** State of one HTLC leg as the taker can observe it on its chain. */
export type LegObservation = 'locked' | 'claimed' | 'refunded' | 'gone' | 'unknown';

export interface TakerObservation {
  /** The solver's counter-lock was found (EVM lock id or BCH txid). */
  secondLockRef?: string;
  /** First leg (the taker's own lock). `gone` = BCH output spent, spender unknown. */
  first?: LegObservation;
  /** Second leg (the solver's lock). `claimed` = claimed by us (e.g. the page reloaded mid-claim). */
  second?: LegObservation;
  /** Our secret, needed to record our own claim found on-chain. */
  secret?: string;
}

/**
 * Facts implied by an observation. Only facts that are certain are produced:
 * - first-locked + solver lock seen → second-locked
 * - second leg claimed by us (found on-chain) → second-claimed
 * - after our claim, the first leg spent by someone other than us → the solver claimed it → completed
 * - second leg gone/refunded without our claim, after T_second → the solver refunded
 */
export function takerFacts(state: SwapState, o: TakerObservation, now: number): SwapFact[] {
  const facts: SwapFact[] = [];
  if (state.phase === 'first-locked' && o.secondLockRef) facts.push({ type: 'second-locked', ref: o.secondLockRef, at: now });
  if (state.phase === 'second-locked' && o.second === 'claimed' && o.secret)
    facts.push({ type: 'second-claimed', secret: o.secret, at: Math.min(now, state.tSecond - 1) });
  if ((state.phase === 'second-claimed' || facts.some((f) => f.type === 'second-claimed')) && (o.first === 'claimed' || o.first === 'gone'))
    facts.push({ type: 'first-claimed', at: Math.min(now, state.tFirst - 1) });
  if (state.phase === 'second-locked' && (o.second === 'refunded' || o.second === 'gone') && now >= state.tSecond)
    facts.push({ type: 'second-refunded', at: now });
  return facts;
}

/** Apply facts, skipping any the state machine refuses (observations can race). */
export function applyAll(state: SwapState, facts: SwapFact[]): SwapState {
  let s = state;
  for (const f of facts) {
    try {
      s = apply(s, f);
    } catch (e) {
      if (!(e instanceof SwapTransitionError)) throw e;
    }
  }
  return s;
}

/** Chain reads the taker needs to observe both legs (injected so the logic is testable without a network). */
export interface TakerChainIO {
  /** State of an EVM HTLC lock by id. */
  evmLockState(id: string): Promise<'none' | 'locked' | 'claimed' | 'refunded'>;
  /** Whether the BCH HTLC address still holds the locked output. */
  bchLocked(address: string): Promise<boolean>;
  /** Preimage revealed by a spend from the BCH HTLC address, if any. */
  bchPreimage(address: string, hashlock: string): Promise<string | undefined>;
}

/**
 * Observe both legs of a taker swap. The BCH leg is the one HTLC at `bchHtlcAddress`; the EVM leg is
 * `evmLockId` (the taker's own lock for USDC → PUSD, the solver's lock for PUSD → USDC).
 */
export async function observeTakerSwap(
  s: { direction: SwapState['direction']; hashlock: string; secret: string; evmLockId?: string; bchHtlcAddress: string },
  io: TakerChainIO,
): Promise<TakerObservation> {
  const evmLeg = async (): Promise<LegObservation> => {
    if (!s.evmLockId) return 'unknown';
    const st = await io.evmLockState(s.evmLockId);
    return st === 'none' ? 'unknown' : st;
  };
  const bchLeg = async (): Promise<LegObservation> => {
    if (await io.bchLocked(s.bchHtlcAddress)) return 'locked';
    return (await io.bchPreimage(s.bchHtlcAddress, s.hashlock)) ? 'claimed' : 'gone';
  };
  const [first, second] = s.direction === 'usdc-to-pusd' ? [await evmLeg(), await bchLeg()] : [await bchLeg(), await evmLeg()];
  return { first, second, secret: second === 'claimed' ? s.secret : undefined };
}

/** Human-readable timing for a taker swap: what happens next and when. */
export function takerTimeline(state: SwapState, now: number): string[] {
  const out: string[] = [];
  const left = (t: number) => (t > now ? `in ${countdown(t - now)}` : 'passed');
  if (state.phase === 'first-locked' || state.phase === 'second-locked')
    out.push(`your lock refundable ${left(state.tFirst)}`, `solver's lock expires ${left(state.tSecond)}`);
  if (state.phase === 'second-refunded') out.push(`your lock refundable ${left(state.tFirst)}`);
  return out;
}

// ── Round 3: counter-lock verification, fee breakdown, history export, timeout ladder ─────────

/** What the taker agreed to in the quote, for checking the solver's counter-lock. */
export interface AgreedCounterLock {
  hashlock: string;
  /** Who must be able to claim: the taker's BCH pkh or EVM address. */
  recipient: string;
  amountOut: bigint;
  tFirst: number;
  tSecond: number;
}

/** What the taker actually finds on the chain for the solver's lock. */
export interface ObservedCounterLock {
  /** The lock exists where the taker expects it (BCH: the covenant address it derived itself; EVM: lock id in Locked state). */
  found: boolean;
  hashlock?: string;
  recipient?: string;
  amount?: bigint;
  timeout?: number;
}

export interface LockCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The taker's last line of defence before revealing its secret: every parameter of the solver's
 * counter-lock must match the quote, and the timeout ordering T₁ ≥ T₂ + margin with room to act
 * must hold for the timeout actually on-chain. Claiming reveals the secret, so any failed check
 * means: do not claim, wait for T₁, refund.
 */
export function verifyCounterLock(
  agreed: AgreedCounterLock,
  seen: ObservedCounterLock,
  now: number,
  o: { margin?: number; timeoutToleranceSeconds?: number } = {},
): { ok: boolean; checks: LockCheck[] } {
  const norm = (h?: string) => (h ?? '').replace(/^0x/, '').toLowerCase();
  const tol = o.timeoutToleranceSeconds ?? 120;
  const checks: LockCheck[] = [{ name: 'lock found', ok: seen.found, detail: seen.found ? 'the counter-lock exists where we derived it' : 'no counter-lock at the expected place' }];
  if (seen.found) {
    checks.push({ name: 'hashlock', ok: norm(seen.hashlock) === norm(agreed.hashlock), detail: norm(seen.hashlock) === norm(agreed.hashlock) ? 'same SHA-256 hashlock as ours' : `hashlock ${norm(seen.hashlock).slice(0, 12)}… ≠ ours ${norm(agreed.hashlock).slice(0, 12)}… — our secret would not open it` });
    checks.push({ name: 'recipient', ok: norm(seen.recipient) === norm(agreed.recipient), detail: norm(seen.recipient) === norm(agreed.recipient) ? 'claimable by us' : 'claimable by someone else' });
    const amt = seen.amount ?? 0n;
    checks.push({ name: 'amount', ok: amt >= agreed.amountOut, detail: amt >= agreed.amountOut ? `${amt} ≥ quoted ${agreed.amountOut}` : `${amt} < quoted ${agreed.amountOut} (short by ${agreed.amountOut - amt})` });
    const t = seen.timeout ?? 0;
    const errs = validateTimeouts(agreed.tFirst, t, now, o.margin);
    const close = Math.abs(t - agreed.tSecond) <= tol;
    checks.push({
      name: 'timeout',
      ok: close && errs.length === 0,
      detail: !close ? `timeout ${t} ≠ quoted T₂ ${agreed.tSecond}${errs.length ? ` — ${errs.join('; ')}` : ''}` : errs.length ? errs.join('; ') : 'T₁ ≥ T₂ + margin and time left to claim',
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export interface FeeBreakdown {
  /** Input converted 1:1 into output base units (what a zero-spread quote would give). */
  gross: bigint;
  /** gross − net: the solver's spread, in output base units. */
  spread: bigint;
  /** What the taker receives (the quote's amountOut). */
  net: bigint;
  /** Spread as a percentage of gross. */
  spreadPct: number;
  /** Output per 1 unit of input, after the spread. */
  effectiveRate: number;
}

/** Fee breakdown of a quote: gross, spread, net and the effective rate, in output-token units. */
export function feeBreakdown(q: { amountIn: bigint; amountOut: bigint; decimalsIn: number; decimalsOut: number }): FeeBreakdown {
  const gross = (q.amountIn * 10n ** BigInt(q.decimalsOut)) / 10n ** BigInt(q.decimalsIn);
  const spread = gross - q.amountOut;
  const inUnits = Number(q.amountIn) / 10 ** q.decimalsIn;
  const outUnits = Number(q.amountOut) / 10 ** q.decimalsOut;
  return { gross, spread, net: q.amountOut, spreadPct: gross > 0n ? (Number(spread) / Number(gross)) * 100 : 0, effectiveRate: inUnits > 0 ? outUnits / inUnits : 0 };
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** RFC 4180 CSV; cells starting with = + - @ are quoted so spreadsheets do not run them as formulas. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const iso = (t?: number) => (t ? new Date(t * 1000).toISOString() : '');
const fmtUnits = (v: string | bigint, dec?: number) => {
  if (dec === undefined) return String(v);
  const s = BigInt(v).toString().padStart(dec + 1, '0');
  return dec ? `${s.slice(0, -dec)}.${s.slice(-dec)}` : s;
};

/** Swap history as CSV (one row per swap). Decimals are optional: without them amounts stay in base units. */
export function swapHistoryCsv(
  swaps: {
    rfq: { direction: Direction };
    quote: Quote;
    solverPubkey: string;
    state: Pick<SwapState, 'phase' | 'tFirst' | 'tSecond' | 'hashlock'>;
    evmLockId?: string;
    bchLockTxid?: string;
    claimTx?: string;
    refundTx?: string;
    evmTxs?: { label: string; hash: string }[];
    bchSymbol?: string;
  }[],
  o: { usdcDecimals?: number; pusdDecimals?: number; bchSymbol?: string } = {},
): string {
  const header = ['quote_id', 'direction', 'amount_in', 'token_in', 'amount_out', 'token_out', 'rate_ppm', 'spread_pct', 'phase', 't_first_utc', 't_second_utc', 'hashlock', 'solver_pubkey', 'evm_lock_id', 'bch_lock_txid', 'claim_tx', 'refund_tx', 'evm_txs'];
  const rows = swaps.map((s) => {
    const sym = s.bchSymbol ?? o.bchSymbol ?? 'PUSD';
    const usdcIn = s.rfq.direction === 'usdc-to-pusd';
    const [decIn, decOut] = usdcIn ? [o.usdcDecimals, o.pusdDecimals] : [o.pusdDecimals, o.usdcDecimals];
    return [
      s.quote.quoteId,
      s.rfq.direction,
      fmtUnits(s.quote.amountIn, decIn),
      usdcIn ? 'USDC' : sym,
      fmtUnits(s.quote.amountOut, decOut),
      usdcIn ? sym : 'USDC',
      s.quote.ratePpm,
      ((1_000_000 - Number(s.quote.ratePpm)) / 1e4).toFixed(2),
      s.state.phase,
      iso(s.state.tFirst),
      iso(s.state.tSecond),
      s.state.hashlock,
      s.solverPubkey,
      s.evmLockId,
      s.bchLockTxid,
      s.claimTx,
      s.refundTx,
      (s.evmTxs ?? []).map((t) => `${t.label}:${t.hash}`).join(' '),
    ];
  });
  return toCsv(header, rows);
}

export interface TimeoutLadder {
  /** Positions on a 0..1 axis from `start` to `end`. */
  now: number;
  t2: number;
  t1: number;
  /** Safety margin band [T₂, T₂ + margin]; it must end at or before T₁. */
  marginEnd: number;
  start: number;
  end: number;
  /** T₁ ≥ T₂ + margin. */
  orderingOk: boolean;
  phase: 'before-t2' | 'between' | 'after-t1';
}

/** Geometry for the timeout ladder diagram (now, T₂, T₂ + margin, T₁). */
export function timeoutLadder(o: { now: number; tFirst: number; tSecond: number; margin?: number; start?: number }): TimeoutLadder {
  const margin = o.margin ?? SAFETY_MARGIN_SECONDS;
  const start = Math.min(o.start ?? o.now, o.now, o.tSecond);
  const last = Math.max(o.tFirst, o.tSecond + margin, o.now);
  const end = last + Math.max(60, (last - start) * 0.06);
  const pos = (t: number) => (end === start ? 0 : (t - start) / (end - start));
  return {
    now: pos(o.now),
    t2: pos(o.tSecond),
    t1: pos(o.tFirst),
    marginEnd: pos(o.tSecond + margin),
    start,
    end,
    orderingOk: o.tFirst >= o.tSecond + margin,
    phase: o.now < o.tSecond ? 'before-t2' : o.now < o.tFirst ? 'between' : 'after-t1',
  };
}
