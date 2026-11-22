import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomToken, randomUtxo } from 'cashscript';
import { binToHex, generatePrivateKey } from '@bitauth/libauth';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { walletFromPrivateKey } from '@hermes/chain';
import {
  SAFETY_MARGIN_SECONDS,
  SwapTransitionError,
  apply,
  buildClaim,
  buildLock,
  buildRefund,
  checkPreimage,
  convert,
  extractPreimageFromBchTx,
  generateSecret,
  hashlockOf,
  htlcContract,
  initialState,
  nextAction,
  parseQuote,
  parseRfq,
  pkhOfPublicKey,
  quoteTemplate,
  rfqTemplate,
  validateTimeouts,
  type Quote,
  type Rfq,
} from '@hermes/swap';

const NOW = 1_800_000_000;

describe('timeout ordering (invariant 4)', () => {
  it('accepts T_first ≥ T_second + margin', () => {
    expect(validateTimeouts(NOW + 3 * 3600, NOW + 3600, NOW)).toEqual([]);
  });
  it('rejects a first leg that does not outlive the second by the margin', () => {
    expect(validateTimeouts(NOW + 3600 + SAFETY_MARGIN_SECONDS - 1, NOW + 3600, NOW).join()).toMatch(/T_first/);
    expect(validateTimeouts(NOW + 3600, NOW + 3 * 3600, NOW).length).toBeGreaterThan(0);
  });
  it('rejects block heights, past timeouts and far-future timeouts', () => {
    expect(validateTimeouts(900_000, 800_000, NOW).join()).toMatch(/timestamps/);
    expect(validateTimeouts(NOW + 3600, NOW + 60, NOW).join()).toMatch(/no time/);
    expect(validateTimeouts(NOW + 30 * 86400, NOW + 3600, NOW).join()).toMatch(/7 days/);
  });
});

describe('secrets and amounts', () => {
  it('secrets are 32 random bytes, hashlock is SHA-256', () => {
    const { secret, hashlock } = generateSecret();
    expect(secret).toHaveLength(64);
    expect(hashlock).toBe(createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex'));
    expect(hashlockOf(secret)).toBe(hashlock);
    expect(checkPreimage(secret, hashlock)).toBe(true);
    expect(checkPreimage(secret.slice(2), hashlock)).toBe(false);
  });
  it('cross-chain vector matches the Solidity test (sha256 of 0x01..0x20)', () => {
    expect(hashlockOf(binToHex(Uint8Array.from({ length: 32 }, (_, i) => i + 1)))).toBe('ae216c2ef5247a3782c135efa279a3e4cdc61094270f5d2be58c6204b7a612c9');
  });
  it('converts integer base units between decimals and rounds down', () => {
    expect(convert(5_000_000n, 6, 2, 1_000_000n)).toBe(500n); // 5 USDC → 5.00 PUSD
    expect(convert(5_000_000n, 6, 2, 995_000n)).toBe(497n); // 0.5% spread, rounded down
    expect(convert(500n, 2, 6, 995_000n)).toBe(4_975_000n);
  });
});

describe('swap state machine', () => {
  const base = () => initialState({ direction: 'usdc-to-pusd', hashlock: 'aa'.repeat(32), tFirst: NOW + 3 * 3600, tSecond: NOW + 3600, quoteExpiry: NOW + 60 });

  it('happy path, USDC → PUSD', () => {
    let s = base();
    expect(nextAction(s, 'taker', NOW)).toEqual({ do: 'lock', chain: 'evm' });
    s = apply(s, { type: 'first-locked', ref: 'evm-lock', at: NOW + 10 });
    expect(nextAction(s, 'solver', NOW + 20)).toEqual({ do: 'lock', chain: 'bch' });
    s = apply(s, { type: 'second-locked', ref: 'bch-lock', at: NOW + 600 });
    expect(nextAction(s, 'taker', NOW + 700)).toEqual({ do: 'claim', chain: 'bch' });
    s = apply(s, { type: 'second-claimed', secret: 'bb'.repeat(32), at: NOW + 800 });
    expect(nextAction(s, 'solver', NOW + 900)).toEqual({ do: 'claim', chain: 'evm' });
    s = apply(s, { type: 'first-claimed', at: NOW + 1000 });
    expect(s.phase).toBe('completed');
  });

  it('happy path, PUSD → USDC locks BCH first', () => {
    let s = initialState({ direction: 'pusd-to-usdc', hashlock: 'aa'.repeat(32), tFirst: NOW + 3 * 3600, tSecond: NOW + 3600, quoteExpiry: NOW + 60 });
    expect(nextAction(s, 'taker', NOW)).toEqual({ do: 'lock', chain: 'bch' });
    s = apply(s, { type: 'first-locked', ref: 'x', at: NOW });
    expect(nextAction(s, 'solver', NOW)).toEqual({ do: 'lock', chain: 'evm' });
  });

  it('refunds only after their timeouts', () => {
    let s = apply(base(), { type: 'first-locked', ref: 'x', at: NOW });
    expect(() => apply(s, { type: 'first-refunded', at: NOW + 3600 })).toThrow(SwapTransitionError);
    s = apply(s, { type: 'second-locked', ref: 'y', at: NOW + 60 });
    expect(() => apply(s, { type: 'second-refunded', at: NOW + 3599 })).toThrow(SwapTransitionError);
    expect(nextAction(s, 'solver', NOW + 3600)).toMatchObject({ do: 'refund', chain: 'bch' });
    s = apply(s, { type: 'second-refunded', at: NOW + 3600 });
    expect(nextAction(s, 'taker', NOW + 3601)).toMatchObject({ do: 'refund', chain: 'evm', notBefore: NOW + 3 * 3600 });
    s = apply(s, { type: 'first-refunded', at: NOW + 3 * 3600 });
    expect(s.phase).toBe('refunded');
  });

  it('the solver does not counter-lock too close to T_second, and the taker does not claim too late', () => {
    const s = apply(base(), { type: 'first-locked', ref: 'x', at: NOW });
    expect(nextAction(s, 'solver', NOW + 3600 - 60).do).toBe('wait');
    const s2 = apply(s, { type: 'second-locked', ref: 'y', at: NOW + 60 });
    expect(nextAction(s2, 'taker', NOW + 3600 - 60).do).toBe('wait');
  });

  it('rejects out-of-order and late transitions', () => {
    expect(() => apply(base(), { type: 'second-locked', ref: 'x', at: NOW })).toThrow(SwapTransitionError);
    expect(() => apply(base(), { type: 'first-locked', ref: 'x', at: NOW + 61 })).toThrow(/quote expiry/);
    const s = apply(apply(base(), { type: 'first-locked', ref: 'x', at: NOW }), { type: 'second-locked', ref: 'y', at: NOW });
    expect(() => apply(s, { type: 'second-claimed', secret: 'x', at: NOW + 3600 })).toThrow(/after T_second/);
  });
});

describe('quote protocol', () => {
  const taker = generateSecretKey();
  const solver = generateSecretKey();
  const rfq: Rfq = {
    v: 1,
    id: 'ab'.repeat(16),
    direction: 'usdc-to-pusd',
    amountIn: '5000000',
    evmChainId: 84532,
    evmToken: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    bchToken: 'cd'.repeat(32),
    takerEvm: '0x000000000000000000000000000000000000dEaD',
    takerBch: 'bchtest:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    takerBchPkh: '11'.repeat(20),
    expiry: NOW + 120,
  };
  const now = Math.floor(Date.now() / 1000);
  const q = (over: Partial<Quote> = {}): Quote => ({
    v: 1,
    rfqId: rfq.id,
    quoteId: 'ef'.repeat(16),
    direction: rfq.direction,
    amountIn: rfq.amountIn,
    amountOut: '497',
    ratePpm: '995000',
    feeOut: '3',
    tFirst: now + 3 * 3600,
    tSecond: now + 3600,
    solverEvm: '0x000000000000000000000000000000000000bEEF',
    solverBch: 'bchtest:zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    solverBchPkh: '22'.repeat(20),
    evmHtlc: '0x000000000000000000000000000000000000c0De',
    evmChainId: 84532,
    expiry: now + 60,
    ...over,
  });

  it('round-trips a signed RFQ and a valid quote', () => {
    const rfqEv = finalizeEvent(rfqTemplate({ ...rfq, expiry: now + 120 }), taker);
    expect(parseRfq(rfqEv, now).rfq?.id).toBe(rfq.id);
    const qe = finalizeEvent(quoteTemplate(q(), rfqEv), solver);
    expect(parseQuote(qe, rfq, now).errors).toEqual([]);
  });

  it('refuses quotes that break timeout ordering, are expired, or do not match the RFQ', () => {
    const rfqEv = finalizeEvent(rfqTemplate({ ...rfq, expiry: now + 120 }), taker);
    const bad = (over: Partial<Quote>) => parseQuote(finalizeEvent(quoteTemplate(q(over), rfqEv), solver), rfq, now).errors.join(' ');
    expect(bad({ tFirst: now + 3600 + 10 })).toMatch(/T_first/);
    expect(bad({ expiry: now - 1 })).toMatch(/expired/);
    expect(bad({ amountIn: '1' })).toMatch(/amountIn/);
    expect(bad({ rfqId: '00'.repeat(16) })).toMatch(/rfq/);
  });

  it('rejects tampered events', () => {
    const rfqEv = finalizeEvent(rfqTemplate({ ...rfq, expiry: now + 120 }), taker);
    const qe = finalizeEvent(quoteTemplate(q(), rfqEv), solver);
    const t = { ...qe, content: qe.content.replace('"497"', '"9999"') };
    expect(parseQuote(t, rfq, now).quote).toBeUndefined();
  });
});

describe('BCH HTLC covenant (CashScript)', () => {
  const setup = (opts: { timeout: number; secret?: Uint8Array; token?: boolean }) => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    const locker = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    const claimer = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    const secret = opts.secret ?? randomBytes(32);
    const hashlock = createHash('sha256').update(secret).digest('hex');
    const c = htlcContract({ recipientPkh: claimer.pkh, refundPkh: locker.pkh, hashlock, timeout: opts.timeout }, provider);
    const token = opts.token ? randomToken({ amount: 777n }) : undefined;
    provider.addUtxo(c.tokenAddress, randomUtxo({ satoshis: 3000n, token }));
    return { provider, locker, claimer, secret, hashlock, c, token };
  };

  it('claim with the secret pays the recipient and keeps tokens; the secret is extractable', async () => {
    const t = setup({ timeout: NOW, token: true });
    const [utxo] = await t.c.getUtxos();
    const b = buildClaim({ provider: t.provider, contract: t.c, utxo, recipient: t.claimer.signer, recipientTokenAddr: t.claimer.tokenAddress, preimage: binToHex(t.secret) });
    const tx = await b.send();
    expect(extractPreimageFromBchTx(tx.hex, t.hashlock)).toBe(binToHex(t.secret));
    const got = await t.provider.getUtxos(t.claimer.tokenAddress);
    expect(got[0].token?.amount).toBe(777n);
  });

  it('wrong secret, wrong-length secret, wrong signer and redirected payout all fail', async () => {
    const t = setup({ timeout: NOW });
    const [utxo] = await t.c.getUtxos();
    const claim = (preimage: string, signer = t.claimer.signer, to = t.claimer.tokenAddress) =>
      buildClaim({ provider: t.provider, contract: t.c, utxo, recipient: signer, recipientTokenAddr: to, preimage });
    expect(() => claim(binToHex(randomBytes(32))).debug()).toThrow();
    expect(() => claim(binToHex(t.secret), t.locker.signer).debug()).toThrow();
    expect(() => claim(binToHex(t.secret), t.claimer.signer, t.locker.tokenAddress).debug()).toThrow();
    // 33-byte preimage whose SHA-256 *is* the hashlock: rejected by the length check alone.
    const long = randomBytes(33);
    const t2 = setup({ timeout: NOW, secret: long });
    const [u2] = await t2.c.getUtxos();
    expect(() => buildClaim({ provider: t2.provider, contract: t2.c, utxo: u2, recipient: t2.claimer.signer, recipientTokenAddr: t2.claimer.tokenAddress, preimage: binToHex(long) }).debug()).toThrow();
  });

  it('refund works only from the timeout on', async () => {
    const t = setup({ timeout: 500_000_100 });
    const [utxo] = await t.c.getUtxos();
    const early = new TransactionBuilder({ provider: t.provider })
      .setLocktime(500_000_099)
      .addInput(utxo, t.c.unlock.refund(t.locker.signer.publicKey, t.locker.signer), { sequence: 0xfffffffe })
      .addOutput({ to: t.locker.address, amount: utxo.satoshis - 1500n });
    expect(() => early.debug()).toThrow();
    const ok = buildRefund({ provider: t.provider, contract: t.c, utxo, timeout: 500_000_100, refunder: t.locker.signer, refundTokenAddr: t.locker.tokenAddress });
    expect(() => ok.debug()).not.toThrow();
    const other = buildRefund({ provider: t.provider, contract: t.c, utxo, timeout: 500_000_100, refunder: t.claimer.signer, refundTokenAddr: t.claimer.tokenAddress });
    expect(() => other.debug()).toThrow();
  });

  it('buildLock funds the HTLC with tokens and returns token change', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    const w = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    const category = 'cd'.repeat(32);
    provider.addUtxo(w.address, randomUtxo({ satoshis: 50_000n }));
    provider.addUtxo(w.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category, amount: 1000n } }));
    const c = htlcContract({ recipientPkh: pkhOfPublicKey(walletFromPrivateKey(generatePrivateKey(), 'chipnet').publicKey), refundPkh: w.pkh, hashlock: '00'.repeat(32), timeout: NOW }, provider);
    const utxos = [...(await provider.getUtxos(w.address)), ...(await provider.getUtxos(w.tokenAddress))] as never[];
    await buildLock({ provider, contract: c, from: w.address, utxos, token: { category, amount: 400n }, signer: new SignatureTemplate(w.signer.privateKey) }).send();
    expect((await c.getUtxos())[0].token?.amount).toBe(400n);
    expect((await provider.getUtxos(w.tokenAddress)).find((u) => u.token)?.token?.amount).toBe(600n);
  });
});
