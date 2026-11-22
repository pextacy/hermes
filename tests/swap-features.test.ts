import { describe, expect, it } from 'vitest';
import {
  applyAll,
  countdown,
  initialState,
  observeTakerSwap,
  rankQuoteEntries,
  solverStats,
  takerFacts,
  takerTimeline,
  apply,
  type Quote,
  type SwapState,
  type TakerChainIO,
} from '@hermes/swap';

const NOW = 1_800_000_000;
const H = 'ab'.repeat(32);
const SECRET = 'cd'.repeat(32);
const base = (direction: SwapState['direction'] = 'usdc-to-pusd') =>
  initialState({ direction, hashlock: H, tFirst: NOW + 7200, tSecond: NOW + 3600, quoteExpiry: NOW + 60 });
const locked = (d?: SwapState['direction']) => apply(apply(base(d), { type: 'first-locked', ref: 'a', at: NOW }), { type: 'second-locked', ref: 'b', at: NOW + 1 });

function io(o: { evm?: 'none' | 'locked' | 'claimed' | 'refunded'; bchLocked?: boolean; preimage?: string }): TakerChainIO {
  return {
    evmLockState: async () => o.evm ?? 'none',
    bchLocked: async () => o.bchLocked ?? false,
    bchPreimage: async () => o.preimage,
  };
}

describe('F14 quote ordering and countdown', () => {
  it('ranks quote entries best first and keeps the wrapper', () => {
    const q = (id: string, out: string): { quote: Quote; tag: string } => ({ quote: { quoteId: id, amountOut: out } as Quote, tag: id });
    const ranked = rankQuoteEntries([q('a', '90'), q('b', '120'), q('c', '100')]);
    expect(ranked.map((r) => r.tag)).toEqual(['b', 'c', 'a']);
  });
  it('formats countdowns and clamps passed deadlines', () => {
    expect(countdown(12)).toBe('12s');
    expect(countdown(249)).toBe('4m 09s');
    expect(countdown(7500)).toBe('2h 05m');
    expect(countdown(-5)).toBe('0s');
  });
  it('timeline says when each lock opens for refund', () => {
    expect(takerTimeline(locked(), NOW + 3000)).toEqual(['your lock refundable in 1h 10m', "solver's lock expires in 10m 00s"]);
    expect(takerTimeline(locked(), NOW + 8000)).toEqual(['your lock refundable passed', "solver's lock expires passed"]);
    expect(takerTimeline(base(), NOW)).toEqual([]);
  });
});

describe('F13 solver identity: local record', () => {
  it('counts completed and refunded swaps per solver', () => {
    const h = [
      { solverPubkey: 'x', state: { phase: 'completed' as const } },
      { solverPubkey: 'x', state: { phase: 'first-refunded' as const } },
      { solverPubkey: 'x', state: { phase: 'second-locked' as const } },
      { solverPubkey: 'y', state: { phase: 'completed' as const } },
    ];
    expect(solverStats(h, 'x')).toEqual({ total: 3, completed: 1, refunded: 1 });
    expect(solverStats(h, 'z')).toEqual({ total: 0, completed: 0, refunded: 0 });
  });
});

describe('taker resumes from chain observations (reload-safe)', () => {
  it('USDC → PUSD: our BCH claim found on-chain + solver claimed our EVM lock → completed', async () => {
    const s = locked('usdc-to-pusd');
    const o = await observeTakerSwap({ direction: 'usdc-to-pusd', hashlock: H, secret: SECRET, evmLockId: '0x1', bchHtlcAddress: 'bch' }, io({ evm: 'claimed', preimage: SECRET }));
    expect(o).toEqual({ first: 'claimed', second: 'claimed', secret: SECRET });
    const next = applyAll(s, takerFacts(s, o, NOW + 100));
    expect(next.phase).toBe('completed');
    expect(next.secret).toBe(SECRET);
  });
  it('USDC → PUSD: after our claim, the solver has not claimed yet → stays second-claimed', async () => {
    const s = apply(locked(), { type: 'second-claimed', secret: SECRET, at: NOW + 10 });
    const o = await observeTakerSwap({ direction: 'usdc-to-pusd', hashlock: H, secret: SECRET, evmLockId: '0x1', bchHtlcAddress: 'bch' }, io({ evm: 'locked', preimage: SECRET }));
    expect(takerFacts(s, o, NOW + 20)).toEqual([]);
  });
  it('PUSD → USDC: our EVM claim found + our BCH lock spent → completed', async () => {
    const s = locked('pusd-to-usdc');
    const o = await observeTakerSwap({ direction: 'pusd-to-usdc', hashlock: H, secret: SECRET, evmLockId: '0x2', bchHtlcAddress: 'bch' }, io({ evm: 'claimed', bchLocked: false }));
    expect(o).toEqual({ first: 'gone', second: 'claimed', secret: SECRET });
    expect(applyAll(s, takerFacts(s, o, NOW + 100)).phase).toBe('completed');
  });
  it('solver refunded its lock: recorded only after T_second, then the taker refunds after T_first', async () => {
    const s = locked('usdc-to-pusd');
    const o = await observeTakerSwap({ direction: 'usdc-to-pusd', hashlock: H, secret: SECRET, evmLockId: '0x1', bchHtlcAddress: 'bch' }, io({ evm: 'locked', bchLocked: false }));
    expect(o.second).toBe('gone');
    expect(takerFacts(s, o, NOW + 100)).toEqual([]); // before T_second: could be a lagging indexer — no conclusion
    const after = applyAll(s, takerFacts(s, o, NOW + 3600));
    expect(after.phase).toBe('second-refunded');
  });
  it('both legs still locked → no facts; missing EVM lock id → unknown', async () => {
    const s = locked('pusd-to-usdc');
    const o = await observeTakerSwap({ direction: 'pusd-to-usdc', hashlock: H, secret: SECRET, bchHtlcAddress: 'bch' }, io({ bchLocked: true }));
    expect(o).toEqual({ first: 'locked', second: 'unknown', secret: undefined });
    expect(takerFacts(s, o, NOW + 10)).toEqual([]);
  });
  it('applyAll skips facts the state machine refuses (racing observations)', () => {
    const s = base();
    expect(applyAll(s, [{ type: 'first-claimed', at: NOW }]).phase).toBe('quoted');
  });
});
