import { describe, expect, it } from 'vitest';
import { feeBreakdown, swapHistoryCsv, timeoutLadder, toCsv, verifyCounterLock, initialState, type Quote } from '@hermes/swap';
import { parseSimAmount, runSwapSimulation, simTranscript, validateSimInput, type SimScenario } from '../packages/swap/src/simulator';

const NOW = 1_800_000_000;
const H = 'ab'.repeat(32);
const agreed = { hashlock: H, recipient: 'aa'.repeat(20), amountOut: 497n, tFirst: NOW + 3 * 3600, tSecond: NOW + 3600 };

describe('G16 verifyCounterLock (taker refuses a bad counter-lock)', () => {
  it('accepts a counter-lock that matches the quote', () => {
    const v = verifyCounterLock(agreed, { found: true, hashlock: `0x${H}`, recipient: agreed.recipient, amount: 497n, timeout: agreed.tSecond }, NOW + 60);
    expect(v.ok).toBe(true);
    expect(v.checks.map((c) => c.name)).toEqual(['lock found', 'hashlock', 'recipient', 'amount', 'timeout']);
  });
  it('refuses wrong hashlock, short amount, wrong recipient, missing lock', () => {
    const ok = { found: true, hashlock: H, recipient: agreed.recipient, amount: 497n, timeout: agreed.tSecond };
    expect(verifyCounterLock(agreed, { ...ok, hashlock: 'cd'.repeat(32) }, NOW).checks.find((c) => !c.ok)?.name).toBe('hashlock');
    expect(verifyCounterLock(agreed, { ...ok, amount: 447n }, NOW).checks.find((c) => !c.ok)?.detail).toMatch(/short by 50/);
    expect(verifyCounterLock(agreed, { ...ok, recipient: 'bb'.repeat(20) }, NOW).ok).toBe(false);
    expect(verifyCounterLock(agreed, { found: false }, NOW).ok).toBe(false);
  });
  it('refuses a too-short timeout and one that breaks T₁ ≥ T₂ + margin', () => {
    const ok = { found: true, hashlock: H, recipient: agreed.recipient, amount: 497n };
    const short = verifyCounterLock(agreed, { ...ok, timeout: NOW + 600 }, NOW);
    expect(short.ok).toBe(false);
    expect(short.checks.at(-1)!.detail).toMatch(/no time to claim/);
    const late = verifyCounterLock({ ...agreed, tSecond: agreed.tFirst - 600 }, { ...ok, timeout: agreed.tFirst - 600 }, NOW);
    expect(late.ok).toBe(false);
    expect(late.checks.at(-1)!.detail).toMatch(/T_first .* must be ≥ T_second/);
  });
});

describe('G19 feeBreakdown', () => {
  it('USDC → PUSD: 5 USDC at 0.5% spread', () => {
    const f = feeBreakdown({ amountIn: 5_000_000n, amountOut: 497n, decimalsIn: 6, decimalsOut: 2 });
    expect(f).toMatchObject({ gross: 500n, spread: 3n, net: 497n });
    expect(f.spreadPct).toBeCloseTo(0.6, 5); // rounding down to cents makes it 0.6% effective
    expect(f.effectiveRate).toBeCloseTo(0.994, 6);
  });
  it('PUSD → USDC: 5.00 PUSD at 0.5% spread', () => {
    const f = feeBreakdown({ amountIn: 500n, amountOut: 4_975_000n, decimalsIn: 2, decimalsOut: 6 });
    expect(f).toMatchObject({ gross: 5_000_000n, spread: 25_000n, net: 4_975_000n });
    expect(f.spreadPct).toBeCloseTo(0.5, 6);
    expect(f.effectiveRate).toBeCloseTo(0.995, 6);
  });
});

describe('G20 swap history CSV', () => {
  it('escapes cells and neutralises formulas', () => {
    expect(toCsv(['a', 'b'], [['x,y', '=SUM(A1)'], ['he said "hi"', 3]])).toBe('a,b\r\n"x,y","=SUM(A1)"\r\n"he said ""hi""",3\r\n');
  });
  it('one row per swap with formatted amounts', () => {
    const quote = { quoteId: 'q1', amountIn: '5000000', amountOut: '497', ratePpm: '995000', tFirst: NOW + 10800, tSecond: NOW + 3600 } as unknown as Quote;
    const state = initialState({ direction: 'usdc-to-pusd', hashlock: H, tFirst: NOW + 10800, tSecond: NOW + 3600, quoteExpiry: NOW + 60 });
    const csv = swapHistoryCsv([{ rfq: { direction: 'usdc-to-pusd' }, quote, solverPubkey: 'ff'.repeat(32), state, evmLockId: '0x01', evmTxs: [{ label: 'USDC lock', hash: '0xaa' }], bchSymbol: 'tPUSD' }], { usdcDecimals: 6, pusdDecimals: 2 });
    const [head, row] = csv.trim().split('\r\n');
    expect(head!.split(',')[0]).toBe('quote_id');
    expect(row).toContain('q1,usdc-to-pusd,5.000000,USDC,4.97,tPUSD,995000,0.50,quoted,');
    expect(row).toContain('USDC lock:0xaa');
    expect(row).toContain(new Date((NOW + 10800) * 1000).toISOString());
  });
});

describe('G21 timeoutLadder', () => {
  it('orders now < T₂ < T₂+margin ≤ T₁ on a 0..1 axis', () => {
    const l = timeoutLadder({ now: NOW, tFirst: NOW + 10800, tSecond: NOW + 3600, margin: 3600 });
    expect(l.now).toBe(0);
    expect(l.t2).toBeGreaterThan(l.now);
    expect(l.marginEnd).toBeGreaterThan(l.t2);
    expect(l.t1).toBeGreaterThanOrEqual(l.marginEnd);
    expect(l.t1).toBeLessThan(1);
    expect(l.orderingOk).toBe(true);
    expect(l.phase).toBe('before-t2');
  });
  it('flags a broken ordering and tracks the phase', () => {
    expect(timeoutLadder({ now: NOW, tFirst: NOW + 3600, tSecond: NOW + 3000, margin: 3600 }).orderingOk).toBe(false);
    expect(timeoutLadder({ now: NOW + 5000, start: NOW, tFirst: NOW + 10800, tSecond: NOW + 3600 }).phase).toBe('between');
    expect(timeoutLadder({ now: NOW + 20000, start: NOW, tFirst: NOW + 10800, tSecond: NOW + 3600 }).phase).toBe('after-t1');
  });
});

describe('G15 simulator: custom amount and spread', () => {
  it('parses and validates inputs', () => {
    expect(parseSimAmount('12.5', 6)).toBe(12_500_000n);
    expect(parseSimAmount('1.234', 2)).toBeUndefined();
    expect(validateSimInput({ direction: 'usdc-to-pusd', amount: 0n })).not.toEqual([]);
    expect(validateSimInput({ direction: 'usdc-to-pusd', amount: 5_000_001_000n })[0]).toMatch(/limit/);
    expect(validateSimInput({ direction: 'usdc-to-pusd', spreadPpm: 200_000 })[0]).toMatch(/spread/);
    expect(validateSimInput({ direction: 'usdc-to-pusd', amount: 1n })[0]).toMatch(/too small/);
  });
  it('usdc-to-pusd 250 USDC at 1.25% settles 246.87 tPUSD', async () => {
    const r = await runSwapSimulation({ direction: 'usdc-to-pusd', amount: 250_000_000n, spreadPpm: 12_500 });
    expect(r.steps.filter((s) => !s.ok).map((s) => s.title)).toEqual([]);
    expect(r.balances.taker.pusd - r.start.taker.pusd).toBe(24_687n);
    expect(r.plan.fee).toMatchObject({ gross: 25_000n, net: 24_687n, spread: 313n });
  }, 60_000);
  it('pusd-to-usdc 1,234.56 tPUSD at 0% settles 1:1', async () => {
    const r = await runSwapSimulation({ direction: 'pusd-to-usdc', amount: 123_456n, spreadPpm: 0 });
    expect(r.passed).toBe(true);
    expect(r.balances.taker.usdc - r.start.taker.usdc).toBe(1_234_560_000n);
  }, 60_000);
  it('rejects invalid input before running', async () => {
    await expect(runSwapSimulation({ direction: 'usdc-to-pusd', amount: -1n })).rejects.toThrow(/positive/);
  });
});

describe('G16 simulator: malicious solver — taker verifies, refuses, refunds after T₁', () => {
  for (const direction of ['usdc-to-pusd', 'pusd-to-usdc'] as const)
    for (const scenario of ['bad-hashlock', 'short-timeout', 'short-amount'] as SimScenario[])
      it(`${direction} / ${scenario}`, async () => {
        const r = await runSwapSimulation({ direction, scenario });
        expect(r.steps.filter((s) => !s.ok).map((s) => `${s.title}: ${s.detail}`)).toEqual([]);
        expect(r.passed).toBe(true);
        const v = r.steps.find((s) => s.checks)!;
        expect(v.expect).toBe('rejected');
        const failed = v.checks!.filter((c) => !c.ok).map((c) => c.name);
        expect(failed).toContain(scenario === 'bad-hashlock' ? 'hashlock' : scenario === 'short-timeout' ? 'timeout' : 'amount');
        // The taker never claimed: no step reveals the secret, and both sides end where they started.
        expect(r.steps.some((s) => /revealing the secret/.test(s.title))).toBe(false);
        expect(r.steps.some((s) => s.title === 'The secret was never revealed' && s.ok)).toBe(true);
        expect(JSON.stringify(r.steps.flatMap((s) => [...(s.bch ?? []), ...(s.evm ?? [])]))).not.toContain(r.secret);
        expect(r.balances.taker).toEqual(r.start.taker);
        expect(r.balances.solver.usdc).toBe(r.start.solver.usdc);
        expect(r.balances.solver.pusd).toBe(r.start.solver.pusd);
        // The taker's refund happens after T₁.
        const refund = r.steps.find((s) => s.title.startsWith('After T₁: taker refunds'))!;
        expect(refund.at).toBeGreaterThan(r.plan.tFirst);
      }, 60_000);
});

describe('G17 step-through + G18 transcript', () => {
  it('waits for onStep promises, every step has an explanation', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    let n = 0;
    const p = runSwapSimulation({
      direction: 'usdc-to-pusd',
      onStep: (s) => {
        order.push(`step ${s.n}`);
        n = s.n;
        return new Promise<void>((r) => (release = r));
      },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(n).toBe(1); // paused on the first step
    order.push('released');
    for (let i = 0; i < 100 && order.length < 40; i++) {
      release();
      await new Promise((r) => setTimeout(r, 20));
    }
    const r = await Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('stuck')), 30_000))]).catch(async () => {
      for (let i = 0; i < 50; i++) { release(); await new Promise((x) => setTimeout(x, 50)); }
      return p;
    });
    expect(order.slice(0, 2)).toEqual(['step 1', 'released']);
    expect(r.passed).toBe(true);
    expect(r.steps.every((s) => typeof s.explain === 'string' && s.explain.length > 20)).toBe(true);
  }, 60_000);
  it('transcript carries BCH tx hex and EVM calldata/logs and is JSON-serialisable', async () => {
    for (const direction of ['usdc-to-pusd', 'pusd-to-usdc'] as const) {
      const r = await runSwapSimulation({ direction });
      const t = JSON.parse(JSON.stringify(simTranscript(r)));
      expect(t.kind).toBe('hermes-swap-simulation');
      expect(t.plan.amountIn).toBe(direction === 'usdc-to-pusd' ? '5000000' : '500');
      expect(t.setup.evm.map((c: { fn: string }) => c.fn)).toContain('mint');
      const bchSteps = t.steps.filter((s: { chain: string; ref?: string }) => s.chain === 'BCH' && s.ref);
      expect(bchSteps.length).toBeGreaterThan(0);
      for (const s of bchSteps) expect(s.bch[0].hex).toMatch(/^[0-9a-f]{100,}$/);
      const lock = t.steps.find((s: { evm?: { fn: string }[] }) => s.evm?.some((c) => c.fn === 'lock'));
      const call = lock.evm.find((c: { fn: string }) => c.fn === 'lock');
      expect(call.calldata).toMatch(/^0x[0-9a-f]{8}/);
      expect(call.logs[0].event).toBe('Locked');
      const rejected = t.steps.filter((s: { expect: string }) => s.expect === 'rejected');
      expect(rejected.some((s: { bch?: { accepted: boolean; hex?: string }[]; evm?: { ok: boolean; revert?: string }[] }) => s.bch?.some((x) => !x.accepted && x.hex) || s.evm?.some((x) => !x.ok && x.revert))).toBe(true);
    }
  }, 60_000);
});
