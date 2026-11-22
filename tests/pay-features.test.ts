import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import {
  PAYMENT_NOTE_TAG,
  addToHistory,
  amountProblem,
  checkNip05,
  localNoteDecrypt,
  normalizeHistory,
  parsePayAsset,
  parsePayLink,
  parsePaymentNote,
  payLinkUrl,
  paymentNoteTemplate,
  paymentNoteText,
  readPaymentNotes,
  splitNip05,
  type PaidEntry,
} from '@hermes/pay';

const TXID = 'ab'.repeat(32);
const CAT = 'cd'.repeat(32);

describe('F8 pay links', () => {
  it('carry any CashToken category as the asset and keep a base path', () => {
    const url = payLinkUrl('https://x.example/hermes/', { to: 'alice@x.example', amount: '5', asset: CAT, memo: 'inv 9' });
    expect(url).toBe(`https://x.example/hermes/#pay?to=alice%40x.example&amount=5&asset=${CAT}&memo=inv+9`);
    expect(parsePayLink(url.slice(url.indexOf('#')))).toEqual({ to: 'alice@x.example', amount: '5', asset: CAT, memo: 'inv 9' });
  });

  it('accepts only BCH, PUSD or a 64-hex category', () => {
    expect(parsePayAsset('BCH')).toBe('BCH');
    expect(parsePayAsset('PUSD')).toBe('PUSD');
    expect(parsePayAsset(CAT.toUpperCase())).toBe(CAT);
    expect(parsePayAsset('cd'.repeat(31))).toBeUndefined();
    expect(parsePayAsset('javascript:alert(1)')).toBeUndefined();
    expect(parsePayAsset(null)).toBeUndefined();
  });
});

describe('F10 NIP-05 check', () => {
  const pk = 'aa'.repeat(32);
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it('splits names and rejects junk', () => {
    expect(splitNip05('Alice@Example.com')).toEqual({ local: 'alice', domain: 'example.com' });
    expect(splitNip05('example.com')).toEqual({ local: '_', domain: 'example.com' });
    expect(splitNip05('a@b@c.com')).toBeUndefined();
    expect(splitNip05('a b@c.com')).toBeUndefined();
    expect(splitNip05('alice@localhost')).toBeUndefined();
  });

  it('distinguishes match, mismatch, not-found and unreachable', async () => {
    let asked = '';
    const ok = async (u: string) => {
      asked = u;
      return new Response(JSON.stringify({ names: { alice: pk.toUpperCase() } }));
    };
    expect(await checkNip05('alice@x.example', pk, ok)).toBe('match');
    expect(asked).toBe('https://x.example/.well-known/nostr.json?name=alice');
    expect(await checkNip05('alice@x.example', 'bb'.repeat(32), ok)).toBe('mismatch');
    expect(await checkNip05('bob@x.example', pk, ok)).toBe('not-found');
    expect(await checkNip05('alice@x.example', pk, reply(404, {}))).toBe('not-found');
    expect(await checkNip05('alice@x.example', pk, reply(500, {}))).toBe('unreachable');
    expect(await checkNip05('alice@x.example', pk, async () => Promise.reject(new TypeError('CORS')))).toBe('unreachable');
    expect(await checkNip05('alice@x.example', pk, reply(200, { names: 'nope' }))).toBe('not-found');
    expect(await checkNip05('not a name', pk, ok)).toBe('invalid');
  });
});

describe('F11 payment notes, recipient side', () => {
  it('round-trips the note text, including token categories and no reference', () => {
    expect(parsePaymentNote(paymentNoteText({ amount: '0.001', asset: 'BCH', txid: TXID, memo: 'rent (nov)' }))).toEqual({
      amount: '0.001',
      asset: 'BCH',
      memo: 'rent (nov)',
      txid: TXID,
    });
    expect(parsePaymentNote(paymentNoteText({ amount: '5', asset: CAT, txid: TXID }))).toEqual({ amount: '5', asset: CAT, memo: undefined, txid: TXID });
    expect(parsePaymentNote('hey, lunch tomorrow?')).toBeUndefined();
    expect(parsePaymentNote(`Hermes Pay: sent you 1 BCH. Transaction ${TXID.slice(2)}`)).toBeUndefined();
  });

  it('the recipient decrypts only Hermes notes addressed to them, newest first', async () => {
    const payer = generateSecretKey();
    const me = generateSecretKey();
    const mePk = getPublicKey(me);
    const sign = async (tpl: Parameters<typeof finalizeEvent>[0], at: number) => finalizeEvent({ ...tpl, created_at: at }, payer);
    const n1 = await sign(await paymentNoteTemplate({ senderSecret: payer, recipientPubkey: mePk, amount: '0.001', asset: 'BCH', txid: TXID, memo: 'rent' }), 100);
    const n2 = await sign(await paymentNoteTemplate({ senderSecret: payer, recipientPubkey: mePk, amount: '2', asset: 'PUSD', txid: 'cd'.repeat(32) }), 200);
    expect(n1.tags).toContainEqual(['t', PAYMENT_NOTE_TAG]);
    // An ordinary DM, a note for someone else, and garbage ciphertext are skipped, not thrown.
    const { encrypt } = await import('nostr-tools/nip04');
    const dm = await sign({ kind: 4, tags: [['p', mePk]], content: await encrypt(payer, mePk, 'hello'), created_at: 0 }, 150);
    const other = await sign(await paymentNoteTemplate({ senderSecret: payer, recipientPubkey: getPublicKey(generateSecretKey()), amount: '9', asset: 'BCH', txid: TXID }), 300);
    const garbage = { ...dm, id: 'ff'.repeat(32), content: 'not?iv=cipher' } as Event;
    const notes = await readPaymentNotes([n1, dm, n2, other, garbage, n1], mePk, localNoteDecrypt(me));
    expect(notes.map((n) => [n.amount, n.asset, n.memo])).toEqual([
      ['2', 'PUSD', undefined],
      ['0.001', 'BCH', 'rent'],
    ]);
    expect(notes[1].from).toBe(getPublicKey(payer));
    // A third party can't read them.
    expect(await readPaymentNotes([n1], mePk, localNoteDecrypt(generateSecretKey()))).toEqual([]);
  });
});

describe('F9 local payment history', () => {
  const e = (txid: string, at = 1): PaidEntry => ({ at, to: 'npub1x', amount: '0.1', asset: 'BCH', txid, network: 'mainnet' });

  it('drops malformed stored entries instead of crashing the tab', () => {
    const good = { ...e(TXID), memo: 'm', note: true };
    expect(normalizeHistory('oops')).toEqual([]);
    expect(normalizeHistory([null, 1, { txid: 'short' }, { ...e(TXID), network: 'testnet3' }, { ...e(TXID), at: 'x' }, good])).toEqual([
      { ...good, name: undefined },
    ]);
  });

  it('adds newest first, de-duplicates by txid and caps the list', () => {
    let h: PaidEntry[] = [];
    for (let i = 0; i < 5; i++) h = addToHistory(h, e(i.toString(16).padStart(64, '0'), i), 3);
    expect(h.map((x) => x.at)).toEqual([4, 3, 2]);
    h = addToHistory(h, { ...e(h[2].txid, 9) }, 3);
    expect(h.map((x) => x.at)).toEqual([9, 4, 3]);
  });
});

describe('amount validation', () => {
  it('explains why an amount cannot be sent', () => {
    expect(amountProblem('0.0002', 8, 546n)).toBeUndefined();
    expect(amountProblem('0.000001', 8, 546n)).toMatch(/dust/);
    expect(amountProblem('0', 2)).toMatch(/more than zero/);
    expect(amountProblem('1.234', 2)).toMatch(/too many decimals/);
    expect(amountProblem('1e3', 2)).toMatch(/invalid amount/);
    expect(amountProblem('12', 0)).toBeUndefined();
  });
});
