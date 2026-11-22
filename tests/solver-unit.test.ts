/**
 * Solver unit tests (apps/solver): quote refusals (incl. the timeout-ordering invariant
 * T_first ≥ T_second + SAFETY_MARGIN), RFQ / notice handling, the swap advance loop's wait / expiry /
 * refund branches (BCH refunds evaluated in the BCH VM via cashscript's MockNetworkProvider; EVM
 * calls stubbed), the bookkeeping store, and the CLI entry (status / mint-test-tokens / run) with
 * keys, providers and the Solver injected — nothing touches a real network.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { binToHex, generatePrivateKey } from '@bitauth/libauth';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import type { Address, Hex } from 'viem';
import { HERMES, walletFromPrivateKey } from '@hermes/chain';
import * as swap from '@hermes/swap';
import type { EvmKey, Quote, Rfq, SwapState } from '@hermes/swap';
import { Solver } from '../apps/solver/src/solver';
import { SwapStore, type SolverSwap } from '../apps/solver/src/store';

/** Per-test overrides for @hermes/swap functions the solver calls (EVM chain access, timeouts). */
const hooks = vi.hoisted(() => ({}) as Record<string, ((...a: any[]) => any) | undefined>);
vi.mock('@hermes/swap', async (orig) => {
  const m = (await orig()) as Record<string, unknown>;
  const wrap = (name: string) => (...a: unknown[]) => (hooks[name] ?? (m[name] as (...x: unknown[]) => unknown))(...a);
  return { ...m, ...Object.fromEntries(['defaultTimeouts', 'findEvmLocks', 'readLock', 'evmRefund', 'evmLock', 'evmClaim', 'findEvmPreimage', 'findBchPreimage', 'tokenDecimals'].map((n) => [n, wrap(n)])) };
});

/** Mock chain that also answers `blockchain.address.get_history` (the solver looks for claims with it). */
class HistoryMock extends MockNetworkProvider {
  readonly sent: { txid: string; hex: string }[] = [];
  override async sendRawTransaction(hex: string) {
    const txid = await super.sendRawTransaction(hex);
    this.sent.push({ txid, hex });
    return txid;
  }
  override async getRawTransaction(txid: string) {
    return this.sent.find((t) => t.txid === txid)?.hex ?? super.getRawTransaction(txid);
  }
  async performRequest(method: string) {
    if (method === 'blockchain.address.get_history') return this.sent.map((t) => ({ tx_hash: t.txid, height: 0 }));
    throw new Error(`unsupported ${method}`);
  }
}

const KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TOKEN = 'f1'.repeat(32);
const USDC = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address;
const HTLC = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as Address;
const TAKER_EVM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const now = () => Math.floor(Date.now() / 1000);
const stores: string[] = [];
const storeFile = (name: string) => new URL(`../apps/solver/data/swaps-${name}.json`, import.meta.url);
const uniq = (p: string) => {
  const n = `${p}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  stores.push(n);
  return n;
};
afterAll(() => {
  for (const n of stores) rmSync(storeFile(n), { force: true });
});
afterEach(() => {
  for (const k of Object.keys(hooks)) delete hooks[k];
});

const taker = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
const takerSk = generateSecretKey();

function mkSolver(o: { bchNetwork?: 'chipnet' | 'mainnet'; evm?: EvmKey; provider?: HistoryMock; spreadPpm?: number } = {}) {
  const logs: string[] = [];
  const provider = o.provider ?? new HistoryMock({ updateUtxoSet: true });
  const bch = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
  const solver = new Solver({
    bchNetwork: o.bchNetwork ?? 'chipnet',
    evm: o.evm ?? 'anvil',
    provider: provider as never,
    bch,
    evmPrivateKey: KEY,
    nostrSecret: generateSecretKey(),
    bchTokens: [{ category: TOKEN, decimals: 2, symbol: 'tPUSD' }],
    evmHtlc: HTLC,
    usdc: USDC,
    spreadPpm: o.spreadPpm ?? 5000,
    relays: [],
    storeName: uniq('unit'),
    log: (s) => logs.push(s),
  });
  return { solver, logs, provider, bch };
}

const rfqOf = (o: Partial<Rfq> = {}): Rfq => ({
  v: 1,
  id: binToHex(crypto.getRandomValues(new Uint8Array(16))),
  direction: 'usdc-to-pusd',
  amountIn: '5000000',
  evmChainId: 31337,
  evmToken: USDC,
  bchToken: TOKEN,
  takerEvm: TAKER_EVM,
  takerBch: taker.tokenAddress,
  takerBchPkh: taker.pkh,
  expiry: now() + 120,
  ...o,
});
const rfqEvent = (r: Rfq, sk = takerSk) => finalizeEvent(swap.rfqTemplate(r), sk);

/** A stored swap in an arbitrary phase (bypasses the quote flow). */
function swapIn(solver: Solver, phase: SwapState['phase'], o: { direction?: Rfq['direction']; tFirst?: number; tSecond?: number; quoteExpiry?: number; hashlock?: string; secret?: string; evmLockId?: string; bchHtlcAddress?: string; usdValue?: number; createdAt?: number } = {}): SolverSwap {
  const rfq = rfqOf({ direction: o.direction ?? 'usdc-to-pusd' });
  const t = now();
  const quote: Quote = {
    v: 1,
    rfqId: rfq.id,
    quoteId: binToHex(crypto.getRandomValues(new Uint8Array(16))),
    direction: rfq.direction,
    amountIn: rfq.direction === 'usdc-to-pusd' ? '5000000' : '1000',
    amountOut: rfq.direction === 'usdc-to-pusd' ? '497' : '9950000',
    ratePpm: '995000',
    feeOut: '3',
    tFirst: o.tFirst ?? t + 3 * 3600,
    tSecond: o.tSecond ?? t + 3600,
    solverEvm: solver.evmAddress,
    solverBch: solver.o.bch.tokenAddress,
    solverBchPkh: solver.o.bch.pkh,
    evmHtlc: HTLC,
    evmChainId: 31337,
    expiry: o.quoteExpiry ?? t + 60,
  };
  const s: SolverSwap = {
    rfq,
    quote,
    rfqEventId: 'ee'.repeat(32),
    takerPubkey: getPublicKey(takerSk),
    state: { direction: rfq.direction, hashlock: o.hashlock ?? '', tFirst: quote.tFirst, tSecond: quote.tSecond, quoteExpiry: quote.expiry, phase, history: [], secret: o.secret },
    evmLockId: o.evmLockId,
    bchHtlcAddress: o.bchHtlcAddress,
    usdValue: o.usdValue ?? 5,
    createdAt: o.createdAt ?? t,
  };
  solver.store.put(s);
  return s;
}

describe('Solver.quoteFor — refusals', () => {
  it('quotes a valid RFQ with the spread deducted and correctly ordered timeouts', () => {
    const { solver } = mkSolver();
    const { quote, usd, reason } = solver.quoteFor(rfqOf());
    expect(reason).toBeUndefined();
    expect(usd).toBe(5);
    expect(quote!.amountOut).toBe('497'); // 5.000000 USDC → 4.97 tPUSD at 0.5 %, rounded down
    expect(quote!.feeOut).toBe('3');
    expect(quote!.ratePpm).toBe('995000');
    expect(quote!.tFirst - quote!.tSecond).toBeGreaterThanOrEqual(swap.SAFETY_MARGIN_SECONDS);
    expect(quote!.solverBchPkh).toBe(solver.o.bch.pkh);
    // reverse direction converts 2-decimals → 6-decimals
    expect(solver.quoteFor(rfqOf({ direction: 'pusd-to-usdc', amountIn: '1000' })).quote!.amountOut).toBe('9950000');
  });
  it('refuses unsupported token, dust, wrong chain and wrong EVM token', () => {
    const { solver } = mkSolver();
    expect(solver.quoteFor(rfqOf({ bchToken: 'aa'.repeat(32) }))).toEqual({ usd: 0, reason: 'unsupported BCH token' });
    expect(solver.quoteFor(rfqOf({ amountIn: '1' })).reason).toBe('amount too small');
    expect(solver.quoteFor(rfqOf({ evmChainId: 84532 })).reason).toBe('other chain');
    expect(solver.quoteFor(rfqOf({ evmToken: TAKER_EVM })).reason).toBe('other EVM token');
    // address comparison is case-insensitive
    expect(solver.quoteFor(rfqOf({ evmToken: USDC.toLowerCase() })).quote).toBeDefined();
  });
  it('enforces per-swap and hourly caps on mainnet (aborted and old swaps do not count)', () => {
    const { solver } = mkSolver({ bchNetwork: 'mainnet' });
    const cap = HERMES.swap.solverCapUsdPerSwap;
    expect(solver.quoteFor(rfqOf({ amountIn: String((cap + 1) * 1e6) })).reason).toBe('over per-swap cap');
    expect(solver.quoteFor(rfqOf({ amountIn: String(cap * 1e6) })).quote).toBeDefined();
    const hourly = HERMES.swap.solverCapUsdPerHour;
    swapIn(solver, 'completed', { usdValue: hourly - 50 });
    swapIn(solver, 'aborted', { usdValue: 1000 });
    swapIn(solver, 'completed', { usdValue: 1000, createdAt: now() - 3601 });
    expect(solver.store.usdLastHour(now())).toBe(hourly - 50);
    expect(solver.quoteFor(rfqOf({ amountIn: String(51 * 1e6) })).reason).toBe('over hourly cap');
    expect(solver.quoteFor(rfqOf({ amountIn: String(50 * 1e6) })).quote).toBeDefined();
  });
  it('testnet is uncapped (testnetUnlimited)', () => {
    const { solver } = mkSolver();
    expect(HERMES.swap.testnetUnlimited).toBe(true);
    expect(solver.quoteFor(rfqOf({ amountIn: String(1e6 * 1e6) })).quote).toBeDefined();
  });
  it('refuses to quote when the timeouts violate T_first ≥ T_second + SAFETY_MARGIN (invariant 4)', () => {
    const { solver } = mkSolver();
    const t = now();
    hooks.defaultTimeouts = () => ({ tFirst: t + 3600 + swap.SAFETY_MARGIN_SECONDS - 1, tSecond: t + 3600 });
    const r = solver.quoteFor(rfqOf());
    expect(r.quote).toBeUndefined();
    expect(r.reason).toMatch(/T_first .* must be ≥ T_second .* \+ 3600s/);
    hooks.defaultTimeouts = () => ({ tFirst: t + 2 * 3600, tSecond: t + 60 });
    expect(solver.quoteFor(rfqOf()).reason).toMatch(/T_second leaves no time to claim/);
    hooks.defaultTimeouts = () => ({ tFirst: 400_000, tSecond: 300_000 });
    expect(solver.quoteFor(rfqOf()).reason).toMatch(/not block heights/);
  });
});

describe('Solver.onRfq / onNotice', () => {
  it('ignores invalid or duplicate RFQs, logs refusals and inventory shortfalls, quotes and stores valid ones', async () => {
    const { solver, logs } = mkSolver();
    const inv = { bchToken: 0n, usdc: 0n };
    solver.inventory = async () => inv;
    // invalid: expired / malformed / wrong kind → silently ignored
    await solver.onRfq(rfqEvent(rfqOf({ expiry: now() - 1 })));
    await solver.onRfq({ ...rfqEvent(rfqOf()), content: '{' } as Event);
    await solver.onRfq(finalizeEvent({ kind: 1, created_at: now(), tags: [], content: JSON.stringify(rfqOf()) }, takerSk));
    expect(logs).toEqual([]);
    // refusal is logged
    const other = rfqOf({ evmChainId: 1 });
    await solver.onRfq(rfqEvent(other));
    expect(logs.pop()).toBe(`rfq ${other.id.slice(0, 8)} skipped: other chain`);
    // not enough tPUSD to pay out
    const r = rfqOf();
    await solver.onRfq(rfqEvent(r));
    expect(logs.pop()).toBe(`rfq ${r.id.slice(0, 8)} skipped: inventory`);
    // not enough USDC for the reverse direction
    const rev = rfqOf({ direction: 'pusd-to-usdc', amountIn: '1000' });
    inv.bchToken = 10_000n;
    await solver.onRfq(rfqEvent(rev));
    expect(logs.pop()).toBe(`rfq ${rev.id.slice(0, 8)} skipped: inventory`);
    // enough inventory → quoted, stored in phase quoted
    const ev = rfqEvent(r);
    await solver.onRfq(ev);
    expect(logs.pop()).toMatch(new RegExp(`^quoted usdc-to-pusd 5000000 → 497 \\(`));
    const stored = [...solver.store.swaps.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ rfqEventId: ev.id, takerPubkey: ev.pubkey, usdValue: 5 });
    expect(stored[0].state.phase).toBe('quoted');
    // duplicate RFQ id → ignored
    await solver.onRfq(rfqEvent(r));
    expect(solver.store.swaps.size).toBe(1);
    expect(existsSync(storeFile(solver.store.network))).toBe(true);
  });

  it('accepts a lock notice only from the quoted taker while still in phase quoted', async () => {
    const { solver, logs } = mkSolver();
    const s = swapIn(solver, 'quoted');
    const H = 'AB'.repeat(32);
    const notice = (o: Partial<swap.LockNotice>, sk = takerSk) => finalizeEvent(swap.noticeTemplate({ v: 1, quoteId: s.quote.quoteId, hashlock: H.toLowerCase(), chain: 'evm', ref: '0x' + '12'.repeat(32), ...o }, solver.nostrPubkey), sk);
    await solver.onNotice(notice({ hashlock: 'zz' })); // malformed
    await solver.onNotice(notice({ quoteId: 'ff'.repeat(16) })); // unknown quote
    await solver.onNotice(notice({}, generateSecretKey())); // someone else
    expect(s.state.hashlock).toBe('');
    expect(logs).toEqual([]);
    await solver.onNotice(notice({}));
    expect(s.state.hashlock).toBe('ab'.repeat(32));
    expect(s.evmLockId).toBe('0x' + '12'.repeat(32));
    expect(logs.pop()).toMatch(/^notice for .*: evm lock 0x/);
    // a BCH notice does not set an EVM lock id; and once past `quoted`, notices are ignored
    const s2 = swapIn(solver, 'quoted', { direction: 'pusd-to-usdc' });
    await solver.onNotice(finalizeEvent(swap.noticeTemplate({ v: 1, quoteId: s2.quote.quoteId, hashlock: 'cd'.repeat(32), chain: 'bch', ref: `${'34'.repeat(32)}:0` }, solver.nostrPubkey), takerSk));
    expect(s2.state.hashlock).toBe('cd'.repeat(32));
    expect(s2.evmLockId).toBeUndefined();
    s2.state = { ...s2.state, phase: 'first-locked' };
    await solver.onNotice(finalizeEvent(swap.noticeTemplate({ v: 1, quoteId: s2.quote.quoteId, hashlock: 'ef'.repeat(32), chain: 'bch', ref: 'x:0' }, solver.nostrPubkey), takerSk));
    expect(s2.state.hashlock).toBe('cd'.repeat(32));
  });
});

describe('Solver.advance', () => {
  it('quoted: waits for the taker, then expires the quote 10 min after its expiry', async () => {
    const { solver } = mkSolver();
    const fresh = swapIn(solver, 'quoted', { direction: 'pusd-to-usdc' }); // no hashlock yet → cannot observe
    await solver.advance(fresh);
    expect(fresh.state.phase).toBe('quoted');
    const stale = swapIn(solver, 'quoted', { direction: 'pusd-to-usdc', quoteExpiry: now() - 601 });
    await solver.advance(stale);
    expect(stale.state.phase).toBe('aborted');
    expect(stale.state.history.at(-1)?.fact).toBe('quote-expired');
  });

  it('quoted (usdc-to-pusd): skips EVM locks that do not match the quote; waits for confirmations', async () => {
    const { solver } = mkSolver({ evm: 'baseSepolia' }); // 3 confirmations
    const s = swapIn(solver, 'quoted');
    const base = { id: ('0x' + '01'.repeat(32)) as Hex, sender: TAKER_EVM, recipient: solver.evmAddress, token: USDC, amount: 5_000_000n, hashlock: ('0x' + 'AA'.repeat(32)) as Hex, timeout: BigInt(s.quote.tFirst), blockNumber: 100n };
    const locks = [
      { ...base, id: ('0x' + '02'.repeat(32)) as Hex, sender: '0x' + '99'.repeat(20) }, // other sender
      { ...base, id: ('0x' + '03'.repeat(32)) as Hex, token: '0x' + '98'.repeat(20) }, // other token
      { ...base, id: ('0x' + '04'.repeat(32)) as Hex, amount: 4_999_999n }, // too little
      { ...base, id: ('0x' + '05'.repeat(32)) as Hex, timeout: BigInt(s.quote.tFirst - 121) }, // timeout too short
      { ...base, id: ('0x' + '06'.repeat(32)) as Hex }, // already claimed on-chain
      base,
    ];
    hooks.findEvmLocks = async (_c, htlc, opts) => {
      expect(htlc).toBe(HTLC);
      expect(opts.recipient).toBe(solver.evmAddress);
      return locks;
    };
    const read: string[] = [];
    hooks.readLock = async (_c, _h, id: string) => (read.push(id), { state: id === locks[4].id ? 'claimed' : 'locked' });
    let block = 101n; // 2 confirmations
    Object.assign(solver, { client: { getBlockNumber: async () => block } });
    await solver.advance(s);
    expect(s.state.phase).toBe('quoted');
    expect(read).toEqual([locks[4].id, base.id]);
    block = 102n; // 3 confirmations
    await solver.advance(s);
    expect(s.state.phase).toBe('first-locked');
    expect(s.evmLockId).toBe(base.id);
    expect(s.state.hashlock).toBe('aa'.repeat(32));
    expect(s.state.firstRef).toBe(base.id);
  });

  it('quoted (usdc-to-pusd): one EVM lock is never matched to several quotes (stale quotes from the same taker, same amount)', async () => {
    // Regression (found in the browser E2E): 3 unaccepted quotes + 1 accepted quote for the same taker and
    // amount all matched the one USDC lock, so the solver counter-locked tPUSD 4× under one hashlock.
    const { solver } = mkSolver();
    const t = now();
    const stale1 = swapIn(solver, 'quoted', { tFirst: t + 3 * 3600 - 600 }); // quoted 10 min earlier
    const stale2 = swapIn(solver, 'quoted', { tFirst: t + 3 * 3600 }); // same minute, no notice
    const accepted = swapIn(solver, 'quoted', { tFirst: t + 3 * 3600 });
    const lockId = ('0x' + '0d'.repeat(32)) as Hex;
    accepted.evmLockId = lockId; // the taker's notice named the lock
    hooks.findEvmLocks = async () => [{ id: lockId, sender: TAKER_EVM, recipient: solver.evmAddress, token: USDC, amount: 5_000_000n, hashlock: '0x' + 'aa'.repeat(32), timeout: BigInt(accepted.quote.tFirst), blockNumber: 1n }];
    hooks.readLock = async () => ({ state: 'locked' });
    Object.assign(solver, { client: { getBlockNumber: async () => 100n } });
    await solver.advance(stale1); // other T_first → not this lock
    expect(stale1.state.phase).toBe('quoted');
    await solver.advance(accepted);
    expect(accepted.state.phase).toBe('first-locked');
    await solver.advance(stale2); // same T_first, but the lock already belongs to `accepted`
    expect(stale2.state.phase).toBe('quoted');
    expect(stale2.evmLockId).toBeUndefined();
  });

  it('quoted (usdc-to-pusd): when the notice named a lock id, other locks are ignored', async () => {
    const { solver } = mkSolver();
    const s = swapIn(solver, 'quoted', { evmLockId: '0x' + '07'.repeat(32) });
    hooks.findEvmLocks = async () => [{ id: '0x' + '08'.repeat(32), sender: TAKER_EVM, token: USDC, amount: 5_000_000n, hashlock: '0x' + 'aa'.repeat(32), timeout: BigInt(s.quote.tFirst), blockNumber: 1n }];
    hooks.readLock = async () => {
      throw new Error('must not read a non-matching lock');
    };
    await solver.advance(s);
    expect(s.state.phase).toBe('quoted');
  });

  it('quoted (pusd-to-usdc): finds the taker’s BCH lock at the HTLC once the hashlock is known (ignores NFTs / short amounts)', async () => {
    const { solver, provider } = mkSolver();
    const H = 'cd'.repeat(32);
    const s = swapIn(solver, 'quoted', { direction: 'pusd-to-usdc', hashlock: H });
    const c = swap.htlcContract({ recipientPkh: solver.o.bch.pkh, refundPkh: taker.pkh, hashlock: H, timeout: s.quote.tFirst }, provider);
    provider.addUtxo(c.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: TOKEN, amount: 999n } }));
    provider.addUtxo(c.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: TOKEN, amount: 5000n, nft: { capability: 'none', commitment: '' } } }));
    await solver.advance(s);
    expect(s.state.phase).toBe('quoted');
    const good = randomUtxo({ satoshis: 1000n, token: { category: TOKEN, amount: 1000n } });
    provider.addUtxo(c.tokenAddress, good);
    await solver.advance(s);
    expect(s.state.phase).toBe('first-locked');
    expect(s.state.firstRef).toBe(`${good.txid}:${good.vout}`);
    expect(s.bchHtlcAddress).toBe(c.tokenAddress);
  });

  it('first-locked too close to T_second: refuses to counter-lock', async () => {
    const { solver } = mkSolver();
    const t = now();
    const s = swapIn(solver, 'first-locked', { tSecond: t + 60, tFirst: t + 3700, hashlock: 'aa'.repeat(32) });
    hooks.evmLock = () => {
      throw new Error('must not lock');
    };
    await solver.advance(s);
    expect(s.state.phase).toBe('first-locked');
  });

  it('second-locked before T_second with no revealed secret: waits', async () => {
    const { solver } = mkSolver();
    const s = swapIn(solver, 'second-locked', { direction: 'pusd-to-usdc', hashlock: 'aa'.repeat(32), evmLockId: '0x' + '09'.repeat(32) });
    hooks.findEvmPreimage = async () => undefined;
    hooks.evmRefund = () => {
      throw new Error('must not refund early');
    };
    await solver.advance(s);
    expect(s.state.phase).toBe('second-locked');
  });

  it('second-locked after T_second (usdc-to-pusd): refunds its BCH lock in the VM and records second-refunded', async () => {
    const { solver, provider, bch } = mkSolver();
    const t = now();
    const H = 'ab'.repeat(32);
    const tSecond = t - 10;
    const s = swapIn(solver, 'second-locked', { hashlock: H, tSecond, tFirst: tSecond + 7200 });
    const c = swap.htlcContract({ recipientPkh: taker.pkh, refundPkh: bch.pkh, hashlock: H, timeout: tSecond }, provider);
    s.bchHtlcAddress = c.tokenAddress;
    provider.addUtxo(c.tokenAddress, randomUtxo({ satoshis: 5000n, token: { category: TOKEN, amount: 497n } }));
    await solver.advance(s);
    expect(s.state.phase).toBe('second-refunded');
    expect(await provider.getUtxos(c.tokenAddress)).toHaveLength(0);
    const back = (await provider.getUtxos(bch.tokenAddress)).filter((u) => u.token?.category === TOKEN);
    expect(back.map((u) => u.token!.amount)).toEqual([497n]);
    // HTLC already empty (e.g. re-run after a restart): no tx, still records the refund
    const s2 = swapIn(solver, 'second-locked', { hashlock: 'ac'.repeat(32), tSecond, tFirst: tSecond + 7200 });
    s2.bchHtlcAddress = swap.htlcContract({ recipientPkh: taker.pkh, refundPkh: bch.pkh, hashlock: 'ac'.repeat(32), timeout: tSecond }, provider).tokenAddress;
    const sent = provider.sent.length;
    await solver.advance(s2);
    expect(s2.state.phase).toBe('second-refunded');
    expect(provider.sent.length).toBe(sent);
  });

  it('second-locked after T_second, HTLC emptied by a late taker claim (usdc-to-pusd): claims the USDC instead of marking it refunded', async () => {
    const { solver, provider, bch } = mkSolver();
    const { secret, hashlock } = swap.generateSecret();
    const tSecond = now() - 10;
    const id = '0x' + '0c'.repeat(32);
    const s = swapIn(solver, 'second-locked', { hashlock, tSecond, tFirst: tSecond + 7200, evmLockId: id });
    s.bchHtlcAddress = swap.htlcContract({ recipientPkh: taker.pkh, refundPkh: bch.pkh, hashlock, timeout: tSecond }, provider).tokenAddress;
    let calls = 0;
    // first look (phase check) misses the claim, the re-check on the empty HTLC sees it
    hooks.findBchPreimage = async () => (++calls === 1 ? undefined : { secret, txid: 'ff'.repeat(32) });
    const claimed: { id: string; preimage: string }[] = [];
    hooks.evmClaim = async (a) => (claimed.push({ id: a.id, preimage: a.preimage }), '0xhash');
    const sent = provider.sent.length;
    await solver.advance(s);
    expect(provider.sent.length).toBe(sent);
    expect(claimed).toEqual([{ id, preimage: `0x${secret}` }]);
    expect(s.state.phase).not.toBe('second-refunded');
    expect(s.state.secret).toBe(secret);
  });

  it('second-locked after T_second (pusd-to-usdc): refunds its EVM lock', async () => {
    const { solver, logs } = mkSolver();
    const t = now();
    const id = '0x' + '0a'.repeat(32);
    const s = swapIn(solver, 'second-locked', { direction: 'pusd-to-usdc', hashlock: 'aa'.repeat(32), evmLockId: id, tSecond: t - 1, tFirst: t + 7199 });
    hooks.findEvmPreimage = async () => undefined;
    const refunded: unknown[] = [];
    hooks.evmRefund = async (a) => (refunded.push(a), '0xhash');
    await solver.advance(s);
    expect(refunded).toEqual([{ wallet: solver.wallet, client: solver.client, htlc: HTLC, id }]);
    expect(s.state.phase).toBe('second-refunded');
    expect(logs.pop()).toMatch(/second leg refunded$/);
  });

  it('second-locked with the secret revealed on EVM (pusd-to-usdc): claims the taker’s BCH lock in the VM', async () => {
    const { solver, provider, bch } = mkSolver();
    const { secret, hashlock } = swap.generateSecret();
    const s = swapIn(solver, 'second-locked', { direction: 'pusd-to-usdc', hashlock, evmLockId: '0x' + '0b'.repeat(32) });
    const c = swap.htlcContract({ recipientPkh: bch.pkh, refundPkh: taker.pkh, hashlock, timeout: s.quote.tFirst }, provider);
    provider.addUtxo(c.tokenAddress, randomUtxo({ satoshis: 5000n, token: { category: TOKEN, amount: 1000n } }));
    hooks.findEvmPreimage = async () => `0x${secret}`;
    await solver.advance(s);
    expect(s.state.phase).toBe('completed');
    expect(s.state.secret).toBe(secret);
    expect((await provider.getUtxos(bch.tokenAddress)).find((u) => u.token?.category === TOKEN)?.token?.amount).toBe(1000n);
  });

  it('tick: records advance errors on the swap and keeps going; persists the store', async () => {
    const { solver, logs } = mkSolver();
    const s = swapIn(solver, 'quoted');
    hooks.findEvmLocks = async () => {
      throw new Error('rpc down');
    };
    await solver.tick();
    expect(s.lastError).toBe('rpc down');
    expect(logs.pop()).toBe(`swap ${s.quote.quoteId.slice(0, 8)}: rpc down`);
    const reloaded = new SwapStore(solver.store.network);
    expect(reloaded.swaps.get(s.quote.quoteId)?.lastError).toBe('rpc down');
  });

  it('tick is not re-entrant', async () => {
    const { solver } = mkSolver();
    swapIn(solver, 'quoted');
    let calls = 0;
    let release!: () => void;
    hooks.findEvmLocks = () => (calls++, new Promise((r) => (release = () => r([])))); // eslint-disable-line no-return-assign
    const first = solver.tick();
    await new Promise((r) => setTimeout(r, 10));
    await solver.tick(); // returns immediately: busy
    expect(calls).toBe(1);
    release();
    await first;
  });
});

describe('Solver start / stop / inventory', () => {
  it('reads USDC decimals from the token, ticks, and stops cleanly', async () => {
    const { solver, logs } = mkSolver();
    hooks.tokenDecimals = async (_c, token) => (expect(token).toBe(USDC), 18);
    await solver.start();
    solver.stop();
    expect(solver.usdcDecimals).toBe(18);
    expect(logs[0]).toMatch(/USDC decimals 18$/);
  });
  it('inventory sums fungible tokens of the category (not NFTs) and reads USDC balance', async () => {
    const { solver, provider, bch } = mkSolver();
    provider.addUtxo(bch.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: TOKEN, amount: 300n } }));
    provider.addUtxo(bch.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: TOKEN, amount: 200n } }));
    provider.addUtxo(bch.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: TOKEN, amount: 0n, nft: { capability: 'none', commitment: '' } } }));
    provider.addUtxo(bch.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: 'aa'.repeat(32), amount: 7n } }));
    Object.assign(solver, { client: { readContract: async (a: { address: string; args: string[] }) => (expect(a.address).toBe(USDC), expect(a.args).toEqual([solver.evmAddress]), 42n) } });
    expect(await solver.inventory(TOKEN)).toEqual({ bchToken: 500n, usdc: 42n });
  });
});

describe('SwapStore', () => {
  it('persists swaps (bigint-safe) and reloads them by quote id', () => {
    const name = uniq('store');
    const a = new SwapStore(name);
    expect(a.swaps.size).toBe(0);
    const { solver } = mkSolver();
    const s = swapIn(solver, 'completed');
    a.put({ ...s, extra: 5n } as never);
    const b = new SwapStore(name);
    expect(b.swaps.size).toBe(1);
    expect(b.swaps.get(s.quote.quoteId)?.quote.amountOut).toBe(s.quote.amountOut);
    expect((b.swaps.get(s.quote.quoteId) as never as { extra: string }).extra).toBe('5');
  });
  it('throws on a corrupt bookkeeping file instead of silently starting empty', () => {
    const name = uniq('corrupt');
    writeFileSync(storeFile(name), '{not json');
    expect(() => new SwapStore(name)).toThrow();
  });
});

describe('solver CLI (apps/solver/src/index.ts)', () => {
  class Exit extends Error {
    constructor(readonly code?: number) {
      super(`exit ${code}`);
    }
  }
  const argv = process.argv;
  let sigint: Function[] = [];
  beforeEach(() => {
    sigint = process.listeners('SIGINT');
  });
  afterEach(() => {
    process.argv = argv;
    for (const l of process.listeners('SIGINT')) if (!sigint.includes(l)) process.off('SIGINT', l as never);
    vi.restoreAllMocks();
    vi.doUnmock('@hermes/chain/prompt');
    vi.doUnmock('@hermes/chain');
    vi.doUnmock('../apps/solver/src/solver');
    vi.resetModules();
  });
  const answers = (list: string[]) => {
    const asked: string[] = [];
    vi.doMock('@hermes/chain/prompt', () => ({ promptSecret: async (q: string) => (asked.push(q), list.shift() ?? '') }));
    return asked;
  };
  const runCli = async (args: string[]) => {
    vi.resetModules();
    process.argv = ['node', 'index.ts', ...args];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Exit(c);
    }) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = await import('../apps/solver/src/index').then(() => undefined, (x) => x);
    return { exit: e instanceof Exit ? e.code : e, log: log.mock.calls.map((c) => String(c[0])), err: err.mock.calls.map((c) => String(c[0])) };
  };

  it('refuses BCH mainnet without owner approval', async () => {
    const r = await runCli(['status', '--network', 'mainnet']);
    expect(r.exit).toBe(1);
    expect(r.err[0]).toMatch(/Refusing BCH mainnet/);
  });

  it('prints usage for an unknown command', async () => {
    const r = await runCli(['nope']);
    expect(r.exit).toBeUndefined();
    expect(r.log).toEqual(['usage: tsx src/index.ts run|status|mint-test-tokens --network chipnet [--evm baseSepolia]']);
  });

  it('status: lists swaps newest first with phase, timeouts and errors, plus totals (no keys asked)', async () => {
    const evm = uniq('status');
    const name = `chipnet-${evm}`;
    stores.push(name);
    const { solver } = mkSolver();
    const t = now();
    const mk = (phase: SwapState['phase'], createdAt: number, lastError?: string) => ({ ...swapIn(solver, phase, { createdAt, usdValue: 10 }), lastError });
    const rows = [mk('completed', t - 100), mk('first-locked', t - 50, 'x'.repeat(80)), mk('refunded', t - 7200), mk('second-refunded', t - 10), mk('quoted', t - 5)];
    writeFileSync(storeFile(name), JSON.stringify(rows));
    const asked = answers([]);
    const r = await runCli(['status', '--network', 'chipnet', '--evm', evm]);
    expect(r.exit).toBe(0);
    expect(asked).toEqual([]);
    expect(r.log).toHaveLength(6);
    expect(r.log.slice(0, 5).map((l) => l.slice(0, 8))).toEqual([rows[4], rows[3], rows[1], rows[0], rows[2]].map((s) => s.quote.quoteId.slice(0, 8)));
    expect(r.log[0]).toMatch(/usdc-to-pusd\s+5000000 → 497\s+quoted\s+T1 in 180 min {2}T2 in 60 min$/);
    expect(r.log[2]).toContain(`  ! ${'x'.repeat(60)}`);
    expect(r.log[2]).not.toContain('x'.repeat(61));
    expect(r.log[5]).toBe('5 swaps · completed 1 · open 1 · refunded 2 · USD last hour 40');
  });

  it('status: past timeouts are shown as "min ago"', async () => {
    const evm = uniq('status-ago');
    const name = `chipnet-${evm}`;
    stores.push(name);
    const { solver } = mkSolver();
    const t = now();
    writeFileSync(storeFile(name), JSON.stringify([swapIn(solver, 'refunded', { tFirst: t - 600, tSecond: t - 4200 })]));
    const r = await runCli(['status', '--evm', evm]);
    expect(r.log[0]).toMatch(/T1 10 min ago {2}T2 70 min ago$/);
  });

  it('mint-test-tokens: chipnet only', async () => {
    const r = await runCli(['mint-test-tokens', '--network', 'mainnet', '--i-have-owner-approval']);
    expect(r.exit).toBeInstanceOf(Error);
    expect((r.exit as Error).message).toBe('test tokens are testnet-only (chipnet or testnet4)');
  });

  it('mint-test-tokens: creates a token category with the given supply (BCH VM mock provider)', async () => {
    const key = generatePrivateKey();
    const w = walletFromPrivateKey(key, 'chipnet');
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    provider.addUtxo(w.address, randomUtxo({ satoshis: 100_000n }));
    provider.addUtxo(w.address, randomUtxo({ satoshis: 1000n, token: { category: 'aa'.repeat(32), amount: 1n } })); // token UTXOs are not spent as funding
    const nets: string[] = [];
    vi.doMock('@hermes/chain', async (orig) => ({ ...((await orig()) as object), getProvider: (n: string) => (nets.push(n), provider) }));
    const asked = answers([binToHex(key)]);
    const r = await runCli(['mint-test-tokens', '--network', 'chipnet', '--supply', '12345', '--symbol', 'MUSD']);
    expect(r.exit).toBe(0);
    expect(nets).toEqual(['chipnet']);
    expect(asked[0]).toMatch(/^BCH chipnet key/);
    const m = r.log[0].match(/^tMUSD category ([0-9a-f]{64}) \(genesis ([0-9a-f]{64})\); put it in config\/networks\.json → bch\.chipnet\.tokens\.MUSD\.category$/);
    expect(m).toBeTruthy();
    const minted = (await provider.getUtxos(w.tokenAddress)).find((u) => u.token?.category === m![1]);
    expect(minted?.token?.amount).toBe(12345n);
    expect(minted?.txid).toBe(m![2]);
  });

  it('run: refuses to start without HTLC / USDC / stablecoin config', async () => {
    const asked = answers([]);
    const r = await runCli(['run', '--network', 'chipnet', '--evm', 'anvil']);
    expect(r.exit).toBe(1);
    expect(r.err[0]).toMatch(/^Missing EVM HTLC \/ USDC address or PUSD category/);
    expect(asked).toEqual([]);
  });

  it('run: prompts for the three keys, starts the solver with CLI options, stops on SIGINT', async () => {
    const created: { opts: Record<string, unknown>; started: boolean; stopped: boolean }[] = [];
    vi.doMock('../apps/solver/src/solver', () => ({
      Solver: class {
        nostrPubkey = 'ab'.repeat(32);
        rec: (typeof created)[number];
        constructor(opts: Record<string, unknown>) {
          this.rec = { opts, started: false, stopped: false };
          created.push(this.rec);
        }
        async start() {
          this.rec.started = true;
        }
        stop() {
          this.rec.stopped = true;
        }
      },
    }));
    vi.doMock('@hermes/chain', async (orig) => ({ ...((await orig()) as object), getProvider: () => ({ fake: true }) }));
    const bchKey = generatePrivateKey();
    const nsec = generateSecretKey();
    const asked = answers([binToHex(bchKey), KEY, nip19.nsecEncode(nsec)]);
    const r = await runCli(['run', '--network', 'chipnet', '--evm', 'anvil', '--htlc', HTLC, '--usdc', USDC, '--pusd', TOKEN, '--pusd-decimals', '3', '--spread-ppm', '2500']);
    expect(r.exit).toBeUndefined();
    expect(asked.map((q) => q.split(' ')[0])).toEqual(['BCH', 'EVM', 'Nostr']);
    expect(created).toHaveLength(1);
    const o = created[0].opts as Record<string, any>;
    expect(o).toMatchObject({ bchNetwork: 'chipnet', evm: 'anvil', evmPrivateKey: KEY, evmHtlc: HTLC, usdc: USDC, spreadPpm: 2500, provider: { fake: true } });
    expect(o.bchTokens).toEqual([{ category: TOKEN, decimals: 3, symbol: 'PUSD' }]);
    expect(o.bch.address).toBe(walletFromPrivateKey(bchKey, 'chipnet').address);
    expect(binToHex(o.nostrSecret)).toBe(binToHex(nsec));
    expect(created[0].started).toBe(true);
    expect(r.log[0]).toMatch(new RegExp(`^solver npub ${nip19.npubEncode('ab'.repeat(32))} — caps: `));
    const handler = process.listeners('SIGINT').find((l) => !sigint.includes(l))!;
    expect(() => (handler as () => void)()).toThrow(Exit);
    expect(created[0].stopped).toBe(true);
  });

  it('run: an empty nsec means a fresh session key; defaults spread to 5000 ppm', async () => {
    const created: Record<string, any>[] = [];
    vi.doMock('../apps/solver/src/solver', () => ({
      Solver: class {
        nostrPubkey = 'cd'.repeat(32);
        constructor(opts: Record<string, unknown>) {
          created.push(opts);
        }
        async start() {}
        stop() {}
      },
    }));
    vi.doMock('@hermes/chain', async (orig) => ({ ...((await orig()) as object), getProvider: () => ({}) }));
    answers([binToHex(generatePrivateKey()), KEY, '']);
    const r = await runCli(['run', '--evm', 'anvil', '--htlc', HTLC, '--usdc', USDC, '--pusd', TOKEN]);
    expect(r.exit).toBeUndefined();
    expect(created[0].nostrSecret).toBeInstanceOf(Uint8Array);
    expect(created[0].nostrSecret).toHaveLength(32);
    expect(created[0].spreadPpm).toBe(5000);
    expect(created[0].bchTokens[0].decimals).toBe(2);
  });
});
