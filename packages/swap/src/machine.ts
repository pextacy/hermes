import { ACTION_MARGIN_SECONDS, firstChain, secondChain, type Chain, type Direction } from './params.js';

/**
 * Swap state machine (both directions). The taker creates the secret and locks first
 * (longer timeout T_first); the solver locks second (T_second); the taker claims the
 * second leg revealing the secret; the solver claims the first leg with it.
 *
 * Pure: `apply` folds observed facts; `nextAction` says what a role should do now.
 */
export type SwapPhase =
  | 'quoted'
  | 'first-locked'
  | 'second-locked'
  | 'second-claimed' // secret public
  | 'completed' // both legs claimed
  | 'first-refunded' // taker got their money back (solver never locked, or after second refunded)
  | 'second-refunded' // solver refunded, taker must refund first
  | 'refunded' // both refunded
  | 'aborted'; // quote expired before any lock

export interface SwapState {
  direction: Direction;
  hashlock: string;
  tFirst: number;
  tSecond: number;
  quoteExpiry: number;
  phase: SwapPhase;
  secret?: string;
  firstRef?: string;
  secondRef?: string;
  history: { at: number; fact: SwapFact['type'] }[];
}

export type SwapFact =
  | { type: 'first-locked'; ref: string; at: number }
  | { type: 'second-locked'; ref: string; at: number }
  | { type: 'second-claimed'; secret: string; at: number }
  | { type: 'first-claimed'; at: number }
  | { type: 'first-refunded'; at: number }
  | { type: 'second-refunded'; at: number }
  | { type: 'quote-expired'; at: number };

export function initialState(args: { direction: Direction; hashlock: string; tFirst: number; tSecond: number; quoteExpiry: number }): SwapState {
  return { ...args, phase: 'quoted', history: [] };
}

const ALLOWED: Record<SwapFact['type'], SwapPhase[]> = {
  'first-locked': ['quoted'],
  'second-locked': ['first-locked'],
  'second-claimed': ['second-locked'],
  'first-claimed': ['second-claimed'],
  'first-refunded': ['first-locked', 'second-locked', 'second-refunded'],
  'second-refunded': ['second-locked', 'first-refunded'],
  'quote-expired': ['quoted'],
};

export class SwapTransitionError extends Error {}

/** Apply a fact. Refunds are only valid after the corresponding timeout. */
export function apply(state: SwapState, fact: SwapFact): SwapState {
  if (!ALLOWED[fact.type].includes(state.phase)) {
    throw new SwapTransitionError(`${fact.type} not allowed in phase ${state.phase}`);
  }
  const next: SwapState = { ...state, history: [...state.history, { at: fact.at, fact: fact.type }] };
  switch (fact.type) {
    case 'first-locked':
      if (fact.at > state.quoteExpiry) throw new SwapTransitionError('first lock after quote expiry');
      next.phase = 'first-locked';
      next.firstRef = fact.ref;
      break;
    case 'second-locked':
      next.phase = 'second-locked';
      next.secondRef = fact.ref;
      break;
    case 'second-claimed':
      if (fact.at >= state.tSecond) throw new SwapTransitionError('second leg claim after T_second');
      next.phase = 'second-claimed';
      next.secret = fact.secret;
      break;
    case 'first-claimed':
      if (fact.at >= state.tFirst) throw new SwapTransitionError('first leg claim after T_first');
      next.phase = 'completed';
      break;
    case 'first-refunded':
      if (fact.at < state.tFirst) throw new SwapTransitionError('first leg refund before T_first');
      next.phase = state.phase === 'second-refunded' ? 'refunded' : 'first-refunded';
      break;
    case 'second-refunded':
      if (fact.at < state.tSecond) throw new SwapTransitionError('second leg refund before T_second');
      next.phase = state.phase === 'first-refunded' ? 'refunded' : 'second-refunded';
      break;
    case 'quote-expired':
      if (fact.at <= state.quoteExpiry) throw new SwapTransitionError('quote not expired yet');
      next.phase = 'aborted';
      break;
  }
  return next;
}

export type Role = 'taker' | 'solver';
export type Action =
  | { do: 'lock'; chain: Chain }
  | { do: 'claim'; chain: Chain }
  | { do: 'refund'; chain: Chain; notBefore: number }
  | { do: 'wait'; reason: string }
  | { do: 'nothing' };

/**
 * What a role should do now. Encodes the safety rules: the solver only counter-locks if
 * the first leg still has ≥ SAFETY_MARGIN after its own T_second; the taker only claims
 * while enough time is left before T_second; refunds only after timeouts.
 */
export function nextAction(state: SwapState, role: Role, now: number): Action {
  const first = firstChain(state.direction);
  const second = secondChain(state.direction);
  switch (state.phase) {
    case 'quoted':
      if (role === 'taker' && now < state.quoteExpiry) return { do: 'lock', chain: first };
      return { do: 'wait', reason: 'waiting for the taker to lock' };
    case 'first-locked':
      if (role === 'solver') {
        if (now + ACTION_MARGIN_SECONDS < state.tSecond) return { do: 'lock', chain: second };
        return { do: 'wait', reason: 'too late to counter-lock safely; taker will refund after T_first' };
      }
      if (now >= state.tFirst) return { do: 'refund', chain: first, notBefore: state.tFirst };
      return { do: 'wait', reason: 'waiting for the solver to lock the second leg' };
    case 'second-locked':
      if (role === 'taker') {
        if (now + ACTION_MARGIN_SECONDS < state.tSecond) return { do: 'claim', chain: second };
        if (now >= state.tFirst) return { do: 'refund', chain: first, notBefore: state.tFirst };
        return { do: 'wait', reason: 'too close to T_second to claim; refund first leg after T_first' };
      }
      if (now >= state.tSecond) return { do: 'refund', chain: second, notBefore: state.tSecond };
      return { do: 'wait', reason: 'waiting for the taker to claim' };
    case 'second-claimed':
      if (role === 'solver') return { do: 'claim', chain: first };
      return { do: 'nothing' };
    case 'second-refunded':
      if (role === 'taker') return { do: 'refund', chain: first, notBefore: state.tFirst };
      return { do: 'nothing' };
    case 'first-refunded':
      if (role === 'solver') return { do: 'refund', chain: second, notBefore: state.tSecond };
      return { do: 'nothing' };
    default:
      return { do: 'nothing' };
  }
}
