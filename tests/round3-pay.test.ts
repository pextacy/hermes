import { describe, expect, it } from 'vitest';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { generatePrivateKey } from '@bitauth/libauth';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubOf } from '@hermes/id';
import { walletFromPrivateKey } from '@hermes/chain';
import {
  addressGuard,
  buildBatchPayment,
  buildReceipt,
  contactDrift,
  contactFromCard,
  detectPayment,
  estimateP2pkhSize,
  findContact,
  looksAlike,
  normalizeContacts,
  parseBatch,
  parseScanned,
  previewBuilder,
  receiptFilename,
  receiptJson,
  removeContact,
  upsertContact,
  watchBaseline,
} from '@hermes/pay';

const TX = (c: string) => c.repeat(64).slice(0, 64);
const CAT = 'cd'.repeat(32);
const npub = () => npubOf(getPublicKey(generateSecretKey()));
const wallet = () => walletFromPrivateKey(generatePrivateKey(), 'chipnet');

describe('G1 payment request watcher', () => {
  const old = { txid: TX('a'), vout: 0, satoshis: 5000n };
  it('ignores outputs that were there when watching began', () => {
    expect(detectPayment(watchBaseline([old]), [old], { sats: 1000n })).toBeUndefined();
  });
  it('flips to paid when a new tx pays at least the amount (summed per tx)', () => {
    const utxos = [old, { txid: TX('b'), vout: 0, satoshis: 600n }, { txid: TX('b'), vout: 2, satoshis: 500n }];
    expect(detectPayment(watchBaseline([old]), utxos, { sats: 1000n })).toEqual({ txid: TX('b'), received: 1100n, outpoints: [`${TX('b')}:0`, `${TX('b')}:2`] });
  });
  it('does not accept an underpayment, and any amount when none was requested', () => {
    const u = [{ txid: TX('c'), vout: 1, satoshis: 999n }];
    expect(detectPayment([], u, { sats: 1000n })).toBeUndefined();
    expect(detectPayment([], u)?.txid).toBe(TX('c'));
  });
  it('counts only the requested token for token requests, and never token dust as BCH', () => {
    const tok = { txid: TX('d'), vout: 0, satoshis: 1000n, token: { category: CAT, amount: 250n } };
    expect(detectPayment([], [tok], { token: { category: CAT, amount: 250n } })?.received).toBe(250n);
    expect(detectPayment([], [tok], { token: { category: 'ef'.repeat(32), amount: 1n } })).toBeUndefined();
    expect(detectPayment([], [tok], { sats: 1n })).toBeUndefined();
  });
});

describe('G2 batch pay', () => {
  it('parses npub-or-name, amount lines with comments and mixed separators', () => {
    const a = npub();
    const b = npub();
    const r = parseBatch(`# payroll\n${a}, 0.001\n\nbob@x.example\t0.0002\n${b} 1`);
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([
      { line: 2, to: a, amount: '0.001' },
      { line: 4, to: 'bob@x.example', amount: '0.0002' },
      { line: 5, to: b, amount: '1' },
    ]);
  });
  it('reports bad lines by number: raw address, garbage, bad amount, duplicate', () => {
    const a = npub();
    const r = parseBatch(`bchtest:qq0000000000000000000000000000000000000000, 1\nhello, 1\n${a}, 1e5\n${a}, 1\n${a}, 2`);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 5]);
    expect(r.errors[0].message).toMatch(/raw address/);
    expect(r.errors[3].message).toMatch(/duplicate of line 4/);
  });
  it('builds ONE transaction with an output per recipient, memo and change; preview measures it exactly', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    const payer = wallet();
    provider.addUtxo(payer.address, randomUtxo({ satoshis: 100_000n }));
    const r1 = wallet().address;
    const r2 = wallet().address;
    const r3 = wallet().address;
    const b = buildBatchPayment({
      provider,
      from: payer.address,
      utxos: (await provider.getUtxos(payer.address)) as never,
      outputs: [{ to: r1, sats: 1000n }, { to: r2, sats: 2000n }, { to: r3, sats: 3000n }],
      memo: 'payroll nov',
      signer: payer.signer,
    });
    const p = previewBuilder(b, payer.address);
    expect(p.basis).toBe('exact');
    expect(p.inputs).toBe(1);
    expect(p.outputs).toBe(5); // 3 payments + OP_RETURN + change
    expect(p.inputSats).toBe(100_000n);
    expect(p.fee).toBe(p.inputSats - p.outputSats);
    expect(p.fee).toBeGreaterThan(0n);
    expect(p.fee).toBeLessThan(1000n);
    expect(p.changeSats).toBe(100_000n - 6000n - p.fee);
    expect(p.bytes).toBe(p.hex!.length / 2);
    expect(p.feeRate).toBeGreaterThanOrEqual(1);
    const sent = await b.send();
    for (const [a, v] of [[r1, 1000n], [r2, 2000n], [r3, 3000n]] as const) {
      const u = await provider.getUtxos(a);
      expect(u.map((x) => [x.txid, x.satoshis])).toEqual([[sent.txid, v]]);
    }
  });
  it('refuses dust, empty and unfunded batches', async () => {
    const provider = new MockNetworkProvider();
    const payer = wallet();
    provider.addUtxo(payer.address, randomUtxo({ satoshis: 3000n }));
    const utxos = (await provider.getUtxos(payer.address)) as never;
    const to = wallet().address;
    expect(() => buildBatchPayment({ provider, from: payer.address, utxos, outputs: [] })).toThrow(/no recipients/);
    expect(() => buildBatchPayment({ provider, from: payer.address, utxos, outputs: [{ to, sats: 100n }] })).toThrow(/dust/);
    expect(() => buildBatchPayment({ provider, from: payer.address, utxos, outputs: [{ to, sats: 2900n }] })).toThrow(/insufficient/);
  });
});

describe('G6 fee and size estimate', () => {
  it('is close to a measured placeholder-signed transaction', async () => {
    const provider = new MockNetworkProvider();
    const payer = wallet();
    provider.addUtxo(payer.address, randomUtxo({ satoshis: 50_000n }));
    const b = buildBatchPayment({ provider, from: payer.address, utxos: (await provider.getUtxos(payer.address)) as never, outputs: [{ to: wallet().address, sats: 1000n }] });
    const p = previewBuilder(b, payer.address); // placeholders, no key: measured + unlock size, never broadcast
    expect(p.outputs).toBe(2);
    expect(p.basis).toBe('estimate');
    expect(p.hex).toBeUndefined();
    const signed = previewBuilder(buildBatchPayment({ provider, from: payer.address, utxos: (await provider.getUtxos(payer.address)) as never, outputs: [{ to: wallet().address, sats: 1000n }], signer: payer.signer }), payer.address);
    expect(signed.basis).toBe('exact');
    expect(Math.abs(signed.bytes - p.bytes)).toBeLessThanOrEqual(8);
    const est = estimateP2pkhSize({ inputs: 1, outputs: 2 });
    expect(Math.abs(est - p.bytes)).toBeLessThanOrEqual(10);
    expect(estimateP2pkhSize({ inputs: 2, outputs: 3, opReturnBytes: 10 })).toBeGreaterThan(est + 141 + 34);
  });
});

describe('G3 address-poisoning guard', () => {
  const alice = wallet();
  const cur = { nostr: 'aa'.repeat(32), addr: alice.address, tokenAddr: alice.tokenAddress, seq: 2 };
  it('names the owner when the reverse lookup resolves to this address (plain or token form)', () => {
    expect(addressGuard(alice.address, cur)).toMatchObject({ kind: 'owner', version: 2 });
    expect(addressGuard(alice.tokenAddress, cur).kind).toBe('owner');
  });
  it('says when the address belongs to an OLD version of the identity', () => {
    const g = addressGuard(wallet().address, cur);
    expect(g).toMatchObject({ kind: 'moved', currentAddr: alice.address });
  });
  it('warns when no identity claims it and flags look-alikes of known addresses', () => {
    const known = 'bchtest:qpabcd0000000000000000000000000000000000wxyz';
    const fake = 'bchtest:qpabcd1111111111111111111111111111111111wxyz';
    expect(looksAlike(fake, known)).toBe(true);
    expect(looksAlike(known, known)).toBe(false);
    expect(looksAlike(alice.address, wallet().address)).toBe(false);
    const g = addressGuard(fake, undefined, [{ addr: known, label: 'Alice' }, { addr: known, label: 'Alice' }]);
    expect(g.kind).toBe('unknown');
    expect(g.lookalikes).toEqual([{ addr: known, label: 'Alice' }]);
  });
});

describe('G4 contacts', () => {
  const card = { npub: npub(), nostr: 'bb'.repeat(32), addr: 'bchtest:qa', tokenAddr: 'bchtest:za', version: 0, network: 'chipnet', profile: { name: 'alice' } };
  const c = contactFromCard(card, 'ee'.repeat(32), 1000);
  it('saves, replaces and removes by npub; survives corrupt storage', () => {
    expect(c).toMatchObject({ name: 'alice', version: 0, bindingId: 'ee'.repeat(32), savedAt: 1000 });
    let l = upsertContact([], c);
    l = upsertContact(l, { ...c, version: 1 });
    expect(l).toHaveLength(1);
    expect(l[0].version).toBe(1);
    expect(normalizeContacts(JSON.parse(JSON.stringify(l)))).toEqual(l);
    expect(normalizeContacts('x')).toEqual([]);
    expect(normalizeContacts([{ npub: 'x' }, null, c])).toEqual([c]);
    expect(removeContact(l, c.npub)).toEqual([]);
  });
  it('re-verification flags a changed binding version / address / key', () => {
    expect(contactDrift(c, card)).toBeUndefined();
    const d = contactDrift(c, { ...card, version: 1, addr: 'bchtest:qb' })!;
    expect(d).toMatchObject({ from: 0, to: 1, addrChanged: true, nostrChanged: false });
    expect(d.message).toMatch(/version 0 → 1 \(BCH address changed\)/);
    expect(contactDrift(c, { ...card, version: 1, nostr: 'cc'.repeat(32) })!.nostrChanged).toBe(true);
  });
  it('finds the contact by saved npub or by current key', () => {
    expect(findContact([c], { npub: 'other', nostr: card.nostr })).toBe(c);
    expect(findContact([c], { npub: 'other', nostr: 'x' }, c.npub)).toBe(c);
    expect(findContact([c], { npub: 'other', nostr: 'x' })).toBeUndefined();
  });
});

describe('G5 receipt', () => {
  it('carries the recipient binding event id + version, txid, amount, memo', () => {
    const r = buildReceipt({
      network: 'chipnet',
      txid: TX('f'),
      asset: 'BCH',
      memo: 'inv 7',
      fee: 250n,
      bytes: 250,
      at: 0,
      recipients: [{ to: 'npub1x', address: 'bchtest:qa', amount: '0.001', bindingEventId: 'ee'.repeat(32), bindingVersion: 3 }],
    });
    expect(r).toEqual({
      type: 'hermes.receipt',
      v: 1,
      network: 'chipnet',
      txid: TX('f'),
      at: '1970-01-01T00:00:00.000Z',
      asset: 'BCH',
      memo: 'inv 7',
      fee: '250',
      bytes: 250,
      recipients: [{ to: 'npub1x', address: 'bchtest:qa', amount: '0.001', bindingEventId: 'ee'.repeat(32), bindingVersion: 3 }],
    });
    expect(JSON.parse(receiptJson(r))).toEqual(r);
    expect(receiptFilename(r)).toBe(`hermes-receipt-${TX('f').slice(0, 12)}.json`);
    const base = { network: 'chipnet', asset: 'BCH', recipients: r.recipients, txid: TX('f') };
    expect(() => buildReceipt({ ...base, txid: 'nope' })).toThrow(/txid/);
    expect(() => buildReceipt({ ...base, recipients: [] })).toThrow(/recipient/);
  });
});

describe('G7 scanned QR content', () => {
  it('understands pay links, nostr: URIs, npubs, names and BIP21 BCH URIs', () => {
    const a = npub();
    expect(parseScanned(`https://hermes.example/app/#pay?to=${a}&amount=0.5&memo=x`)).toEqual({ kind: 'paylink', link: { to: a, amount: '0.5', asset: undefined, memo: 'x' } });
    expect(parseScanned(`nostr:${a}`)).toEqual({ kind: 'recipient', value: a });
    expect(parseScanned(` ${a} `)).toEqual({ kind: 'recipient', value: a });
    expect(parseScanned('alice@x.example')).toEqual({ kind: 'recipient', value: 'alice@x.example' });
    expect(parseScanned('BITCOINCASH:QPABC?amount=0.01&label=x')).toEqual({ kind: 'recipient', value: 'bitcoincash:qpabc', amount: '0.01' });
    expect(parseScanned('bchtest:qpabc?amount=1e9')).toEqual({ kind: 'recipient', value: 'bchtest:qpabc', amount: undefined });
  });
  it('rejects anything else', () => {
    expect(parseScanned('').kind).toBe('invalid');
    expect(parseScanned('javascript:alert(1)').kind).toBe('invalid');
    expect(parseScanned('https://evil.example/#pay?amount=1').kind).toBe('invalid');
    expect(parseScanned('x'.repeat(3000)).kind).toBe('invalid');
  });
});
