import { describe, expect, it } from 'vitest';
import { runSwapSimulation } from '../packages/swap/src/simulator';

describe('swap simulator: real HermesHTLC bytecode (ethereumjs EVM) + real BCH covenant (BCH 2026 VM)', () => {
  for (const direction of ['usdc-to-pusd', 'pusd-to-usdc'] as const) {
    it(`${direction}: happy path settles both legs, every attack is rejected, value is conserved`, async () => {
      const r = await runSwapSimulation({ direction });
      const failed = r.steps.filter((s) => !s.ok).map((s) => `${s.n} ${s.title}: ${s.detail}`);
      expect(failed).toEqual([]);
      expect(r.passed).toBe(true);
      expect(r.steps.filter((s) => s.expect === 'rejected').length).toBeGreaterThanOrEqual(2);
      if (direction === 'usdc-to-pusd') {
        expect(r.balances.taker.usdc).toBe(r.start.taker.usdc - 5_000_000n);
        expect(r.balances.taker.pusd).toBe(r.start.taker.pusd + 497n); // 5 USDC at 0.5% → 4.97 tPUSD
        expect(r.balances.solver.usdc).toBe(r.start.solver.usdc + 5_000_000n);
      } else {
        expect(r.balances.taker.pusd).toBe(r.start.taker.pusd - 500n);
        expect(r.balances.taker.usdc).toBe(r.start.taker.usdc + 4_975_000n);
        expect(r.balances.solver.pusd).toBe(r.start.solver.pusd + 500n);
      }
    }, 60_000);
    it(`${direction}: solver never locks → taker refunds after T₁, early/foreign refunds rejected`, async () => {
      const r = await runSwapSimulation({ direction, scenario: 'refund' });
      expect(r.steps.filter((s) => !s.ok).map((s) => `${s.n} ${s.title}: ${s.detail}`)).toEqual([]);
      expect(r.balances.taker).toEqual(r.start.taker);
      expect(r.balances.solver).toEqual(r.start.solver);
    }, 60_000);
  }
  it('streams steps with balances to the UI callback', async () => {
    const seen: number[] = [];
    await runSwapSimulation({ direction: 'usdc-to-pusd', onStep: (s) => seen.push(s.n) });
    expect(seen).toEqual(seen.map((_, i) => i + 1));
    expect(seen.length).toBeGreaterThan(8);
  }, 60_000);
});
