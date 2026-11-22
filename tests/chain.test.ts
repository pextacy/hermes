import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  binToHex,
  decodeCashAddress,
  encodeCashAddress,
  encodePrivateKeyWif,
  generatePrivateKey,
  hexToBin,
} from '@bitauth/libauth';

// No test here may touch the network: the Electrum provider class and readline are replaced,
// and `fetch` is stubbed per test.
const fake = vi.hoisted(() => ({
  providers: [] as { network: string; options: { hostname: string } }[],
  rl: {
    answer: '',
    questions: [] as string[],
    closed: 0,
    options: [] as { input: unknown; output: NodeJS.WritableStream; terminal?: boolean }[],
  },
}));

vi.mock('cashscript', async (importOriginal) => {
  const orig = await importOriginal<typeof import('cashscript')>();
  class FakeElectrumNetworkProvider {
    constructor(
      readonly network: string,
      readonly options: { hostname: string },
    ) {
      fake.providers.push(this);
    }
  }
  return { ...orig, ElectrumNetworkProvider: FakeElectrumNetworkProvider };
});

vi.mock('node:readline', () => ({
  createInterface: (options: { input: unknown; output: NodeJS.WritableStream; terminal?: boolean }) => {
    fake.rl.options.push(options);
    return {
      question(q: string, cb: (a: string) => void) {
        fake.rl.questions.push(q);
        // readline echoes what is typed through `output`; a secret prompt must swallow it.
        options.output.write('TYPED-SECRET');
        cb(fake.rl.answer);
      },
      close() {
        fake.rl.closed++;
      },
    };
  },
}));

import { MockNetworkProvider, SignatureTemplate, randomUtxo } from 'cashscript';
import {
  DUST_SATS,
  SATS_PER_BCH,
  bchConfig,
  buildPayment,
  electrumServers,
  explorerTxUrl,
  formatBch,
  formatUnits,
  getConfiguredToken,
  getProvider,
  getTokenMeta,
  parseBch,
  parseUnits,
  paymentForWallet,
  privateKeyFrom,
  sendLocal,
  setElectrumServers,
  stablecoins,
  toPlainAddress,
  toTokenAddress,
  tokenConfig,
  uniqueUtxos,
  walletFromPrivateKey,
  withFailover,
} from '@hermes/chain';
import { promptLine, promptSecret } from '@hermes/chain/prompt';

const CAT = (n: number) => n.toString(16).padStart(64, '0');
const jsonResponse = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

describe('tokens: parseUnits / formatUnits (integer base units)', () => {
  it('parses decimal strings exactly into base units', () => {
    expect(parseUnits('1.25', 2)).toBe(125n);
    expect(parseUnits('1', 2)).toBe(100n);
    expect(parseUnits('0.01', 2)).toBe(1n);
    expect(parseUnits('1.5', 2)).toBe(150n);
    expect(parseUnits('  3  ', 2)).toBe(300n);
    expect(parseUnits('7', 0)).toBe(7n);
    expect(parseUnits('0', 8)).toBe(0n);
    // beyond Number precision: still exact
    expect(parseUnits('12345678901234567890.12', 2)).toBe(1234567890123456789012n);
  });

  it('rejects excess precision instead of rounding', () => {
    expect(() => parseUnits('1.234', 2)).toThrow(/too many decimals \(max 2\)/);
    expect(() => parseUnits('0.001', 2)).toThrow(/too many decimals/);
    expect(() => parseUnits('1.0', 0)).toThrow(/too many decimals \(max 0\)/);
    expect(() => parseBch('0.000000001')).toThrow(/max 8/);
  });

  it('rejects anything that is not a plain non-negative decimal', () => {
    for (const bad of ['', ' ', '-1', '+1', '1e5', '.5', '1.', 'abc', '1,5', '1.2.3', '0x10', 'Infinity', 'NaN', '１']) {
      expect(() => parseUnits(bad, 2), bad).toThrow(/invalid amount/);
    }
  });

  it('formats base units without float rounding and trims trailing zeros', () => {
    expect(formatUnits(125n, 2)).toBe('1.25');
    expect(formatUnits(100n, 2)).toBe('1');
    expect(formatUnits(120n, 2)).toBe('1.2');
    expect(formatUnits(1n, 2)).toBe('0.01');
    expect(formatUnits(0n, 2)).toBe('0');
    expect(formatUnits(-125n, 2)).toBe('-1.25');
    expect(formatUnits(-1n, 8)).toBe('-0.00000001');
    expect(formatUnits(7n, 0)).toBe('7');
    expect(formatUnits(1234567890123456789012n, 2)).toBe('12345678901234567890.12');
  });

  it('parse ∘ format round-trips for many values and decimals', () => {
    for (const d of [0, 2, 6, 8, 18]) {
      for (const v of [0n, 1n, 9n, 10n, 99n, 100n, 101n, 123456789n, 10n ** 20n + 7n]) {
        expect(parseUnits(formatUnits(v, d), d)).toBe(v);
      }
    }
  });

  it('BCH helpers use 8 decimals', () => {
    expect(SATS_PER_BCH).toBe(100_000_000n);
    expect(parseBch('1')).toBe(SATS_PER_BCH);
    expect(parseBch('0.00000546')).toBe(546n);
    expect(formatBch(546n)).toBe('0.00000546');
    expect(formatBch(150_000_000n)).toBe('1.5');
  });
});

describe('tokens: getTokenMeta (decimals come from metadata, never assumed)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads symbol, name and decimals from the BCMR indexer, then caches', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 'N'.repeat(100), token: { symbol: 'S'.repeat(30), decimals: 6 } }));
    const m = await getTokenMeta(CAT(1), { symbol: 'FB', decimals: 2 });
    expect(m).toEqual({ category: CAT(1), symbol: 'S'.repeat(16), name: 'N'.repeat(64), decimals: 6, source: 'bcmr' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://bcmr.paytaca.com/api/tokens/${CAT(1)}/`);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    // cached: no second request, same answer even with a different fallback
    expect(await getTokenMeta(CAT(1), { symbol: 'X', decimals: 0 })).toBe(m);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('metadata decimals win over the config fallback (0 is a real value)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token: { symbol: 'Z', decimals: 0 } }));
    const m = await getTokenMeta(CAT(2), { symbol: 'FB', decimals: 8 });
    expect(m.decimals).toBe(0);
    expect(m.source).toBe('bcmr');
    expect(m.name).toBeUndefined();
  });

  it('accepts an all-digit decimals string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token: { symbol: 'Q', decimals: '4' } }));
    expect((await getTokenMeta(CAT(3))).decimals).toBe(4);
  });

  it('non-string BCMR symbol falls back to the config symbol, or TOKEN', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ name: 42, token: { symbol: { evil: true }, decimals: 2 } }));
    const a = await getTokenMeta(CAT(4), { symbol: 'FB', decimals: 2 });
    expect(a.symbol).toBe('FB');
    expect(a.name).toBeUndefined();
    const b = await getTokenMeta(CAT(5));
    expect(b.symbol).toBe('TOKEN');
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['boolean', true],
    ['array', []],
    ['negative', -1],
    ['fractional', 2.5],
    ['too large', 19],
    ['NaN string', 'two'],
    ['missing', undefined],
  ])('invalid BCMR decimals (%s) are not trusted: config fallback is used', async (_label, decimals) => {
    const cat = CAT(100 + Math.floor(Math.random() * 1e9));
    fetchMock.mockResolvedValue(jsonResponse({ token: { symbol: 'BAD', decimals } }));
    const m = await getTokenMeta(cat, { symbol: 'FB', decimals: 2 });
    expect(m).toEqual({ category: cat, symbol: 'FB', decimals: 2, source: 'config' });
  });

  it('without a fallback, invalid or missing metadata is an error, not a guess', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token: { decimals: null } }));
    await expect(getTokenMeta(CAT(6))).rejects.toThrow(`No metadata for token ${CAT(6)}`);
    fetchMock.mockResolvedValue(jsonResponse({}, false));
    await expect(getTokenMeta(CAT(7))).rejects.toThrow(/No metadata/);
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(getTokenMeta(CAT(8))).rejects.toThrow(/No metadata/);
    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });
    await expect(getTokenMeta(CAT(9))).rejects.toThrow(/No metadata/);
  });

  it('HTTP error and network failure use the fallback', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token: { decimals: 6 } }, false));
    expect((await getTokenMeta(CAT(10), { symbol: 'A', decimals: 3 })).source).toBe('config');
    fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await getTokenMeta(CAT(11), { symbol: 'B', decimals: 1 })).toEqual({ category: CAT(11), symbol: 'B', decimals: 1, source: 'config' });
  });

  it('getConfiguredToken: no category → undefined without fetching; with one → metadata lookup', async () => {
    expect(await getConfiguredToken('chipnet', 'PUSD')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(jsonResponse({ token: { symbol: 'PUSD', decimals: 2 } }));
    const pusd = tokenConfig('mainnet', 'PUSD');
    const m = await getConfiguredToken('mainnet', 'PUSD');
    expect(m).toMatchObject({ category: pusd.category, symbol: 'PUSD', decimals: 2, source: 'bcmr' });
    expect(String(fetchMock.mock.calls[0][0])).toContain(pusd.category!);
  });
});

describe('config', () => {
  it('token config and stablecoins', () => {
    expect(tokenConfig('mainnet', 'PUSD')).toMatchObject({ symbol: 'PUSD', decimalsFallback: 2, stable: true });
    expect(tokenConfig('mainnet', 'NOPE')).toBeUndefined();
    const s = stablecoins('mainnet');
    expect(s[0].key).toBe('PUSD');
    for (const t of s) {
      expect(t.stable).toBe(true);
      expect(t.category).toMatch(/^[0-9a-f]{64}$/);
    }
    // non-stable FLDCH and category-less MUSD are excluded
    expect(s.map((t) => t.key)).not.toContain('FLDCH');
    expect(s.map((t) => t.key)).not.toContain('MUSD');
    for (const t of stablecoins('chipnet')) expect(t.category).toBeTruthy();
  });

  it('explorer URL', () => {
    expect(explorerTxUrl('chipnet', 'ab'.repeat(32))).toBe(`${bchConfig('chipnet').explorerTx}${'ab'.repeat(32)}`);
  });

  it('converts between plain and token-aware cashaddrs (p2pkh and p2sh)', () => {
    const payload = hexToBin('11'.repeat(20));
    const p2pkh = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload }).address;
    const p2pkhT = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload }).address;
    const p2sh = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2sh', payload }).address;
    const p2shT = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2shWithTokens', payload }).address;
    expect(toTokenAddress(p2pkh)).toBe(p2pkhT);
    expect(toTokenAddress(p2pkhT)).toBe(p2pkhT);
    expect(toPlainAddress(p2pkhT)).toBe(p2pkh);
    expect(toPlainAddress(p2pkh)).toBe(p2pkh);
    expect(toTokenAddress(p2sh)).toBe(p2shT);
    expect(toPlainAddress(p2shT)).toBe(p2sh);
    expect(toPlainAddress(p2sh)).toBe(p2sh);
  });

  it('rejects invalid cashaddrs', () => {
    expect(() => toTokenAddress('bchtest:qnotanaddress')).toThrow();
    expect(() => toPlainAddress('bitcoincash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cy4spdc2x')).toThrow(); // bad checksum
    expect(() => toPlainAddress('')).toThrow();
  });
});

describe('keys', () => {
  const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  it('accepts a 64-hex private key (any case, trimmed)', () => {
    const k = generatePrivateKey();
    expect(binToHex(privateKeyFrom(binToHex(k)))).toBe(binToHex(k));
    expect(binToHex(privateKeyFrom(`  ${binToHex(k).toUpperCase()}\n`))).toBe(binToHex(k));
  });

  it('rejects hex keys outside the secp256k1 range', () => {
    expect(() => privateKeyFrom('0'.repeat(64))).toThrow(/invalid private key/);
    expect(() => privateKeyFrom('f'.repeat(64))).toThrow(/invalid private key/);
  });

  it('accepts mainnet and testnet WIFs, rejects a corrupted one', () => {
    const k = generatePrivateKey();
    const wifMain = encodePrivateKeyWif(k, 'mainnet');
    const wifTest = encodePrivateKeyWif(k, 'testnet');
    expect(wifMain).toMatch(/^[KL]/);
    expect(wifTest).toMatch(/^c/);
    expect(binToHex(privateKeyFrom(wifMain))).toBe(binToHex(k));
    expect(binToHex(privateKeyFrom(wifTest))).toBe(binToHex(k));
    const last = wifMain.at(-1) === '1' ? '2' : '1';
    expect(() => privateKeyFrom(wifMain.slice(0, -1) + last)).toThrow();
  });

  it('derives a deterministic key from a BIP39 mnemonic, path-sensitive, whitespace-tolerant', () => {
    const a = privateKeyFrom(MNEMONIC);
    expect(a).toHaveLength(32);
    expect(binToHex(privateKeyFrom(`  ${MNEMONIC.replaceAll(' ', '   ')}\n`))).toBe(binToHex(a));
    expect(binToHex(privateKeyFrom(MNEMONIC, "m/44'/145'/0'/0/1"))).not.toBe(binToHex(a));
    expect(() => privateKeyFrom(MNEMONIC, 'not/a/path')).toThrow();
  });

  it('rejects a mnemonic with a bad checksum or unknown words', () => {
    expect(() => privateKeyFrom(MNEMONIC.replace(/about$/, 'abandon'))).toThrow(/invalid BIP39 mnemonic/);
    expect(() => privateKeyFrom(MNEMONIC.replace(/^abandon/, 'abandonn'))).toThrow(/invalid BIP39 mnemonic/);
  });

  it('rejects unrecognised input', () => {
    for (const bad of ['', 'hello', 'ab'.repeat(31), 'one two three', '5'.repeat(20)]) {
      expect(() => privateKeyFrom(bad), bad).toThrow(/Unrecognised key format/);
    }
  });

  it('walletFromPrivateKey: key 1 gives the well-known pubkey/pkh and consistent addresses', () => {
    const one = hexToBin('00'.repeat(31) + '01');
    const w = walletFromPrivateKey(one, 'mainnet');
    expect(binToHex(w.publicKey)).toBe('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    expect(w.pkh).toBe('751e76e8199196d454941c45d1b3a323f1433bd6');
    expect(w.lockingBytecode).toBe(`76a914${w.pkh}88ac`);
    const d = decodeCashAddress(w.address);
    const dt = decodeCashAddress(w.tokenAddress);
    if (typeof d === 'string' || typeof dt === 'string') throw new Error('decode failed');
    expect(d).toMatchObject({ prefix: 'bitcoincash', type: 'p2pkh' });
    expect(dt).toMatchObject({ prefix: 'bitcoincash', type: 'p2pkhWithTokens' });
    expect(binToHex(d.payload)).toBe(w.pkh);
    expect(binToHex(dt.payload)).toBe(w.pkh);
    expect(w.signer).toBeInstanceOf(SignatureTemplate);
    expect(walletFromPrivateKey(one, 'chipnet').address.startsWith('bchtest:')).toBe(true);
    expect(walletFromPrivateKey(one, 'mock').address.startsWith('bchtest:')).toBe(true);
  });

  it('walletFromPrivateKey refuses an invalid private key instead of producing an unspendable address', () => {
    expect(() => walletFromPrivateKey(new Uint8Array(32), 'chipnet')).toThrow(/invalid private key/i);
  });
});

describe('provider (Electrum client mocked)', () => {
  afterEach(() => {
    setElectrumServers('chipnet', undefined);
    setElectrumServers('mainnet', undefined);
  });

  it('servers come from config unless overridden; empty override clears', () => {
    expect(electrumServers('chipnet')).toEqual(bchConfig('chipnet').electrum);
    setElectrumServers('chipnet', ['a.example', 'b.example']);
    expect(electrumServers('chipnet')).toEqual(['a.example', 'b.example']);
    expect(electrumServers('mainnet')).toEqual(bchConfig('mainnet').electrum);
    setElectrumServers('chipnet', []);
    expect(electrumServers('chipnet')).toEqual(bchConfig('chipnet').electrum);
  });

  it('getProvider builds one cached provider per network:hostname, index wraps around', () => {
    setElectrumServers('chipnet', ['p1.example', 'p2.example']);
    const before = fake.providers.length;
    const p0 = getProvider('chipnet');
    const p1 = getProvider('chipnet', 1);
    expect(p0).not.toBe(p1);
    expect(getProvider('chipnet', 2)).toBe(p0);
    expect(getProvider('chipnet', 0)).toBe(p0);
    const created = fake.providers.slice(before);
    expect(created.map((p) => [p.network, p.options.hostname])).toEqual([
      ['chipnet', 'p1.example'],
      ['chipnet', 'p2.example'],
    ]);
    // same hostname on another network is a different provider
    setElectrumServers('mainnet', ['p1.example']);
    const m = getProvider('mainnet');
    expect(m).not.toBe(p0);
    expect((m as unknown as { network: string }).network).toBe('mainnet');
  });

  it('withFailover returns the first success and skips failing servers', async () => {
    setElectrumServers('chipnet', ['f1.example', 'f2.example', 'f3.example']);
    const seen: string[] = [];
    const r = await withFailover('chipnet', async (p) => {
      const host = (p as unknown as { options: { hostname: string } }).options.hostname;
      seen.push(host);
      if (host !== 'f2.example') throw new Error(`down ${host}`);
      return 42;
    });
    expect(r).toBe(42);
    expect(seen).toEqual(['f1.example', 'f2.example']);
  });

  it('withFailover rethrows the last error when every server fails (wrapping non-Errors)', async () => {
    setElectrumServers('chipnet', ['g1.example', 'g2.example']);
    let n = 0;
    await expect(
      withFailover('chipnet', async () => {
        n++;
        throw new Error(`fail ${n}`);
      }),
    ).rejects.toThrow('fail 2');
    expect(n).toBe(2);
    await expect(withFailover('chipnet', () => Promise.reject('plain string'))).rejects.toThrow('plain string');
  });
});

describe('payment builder', () => {
  const sender = walletFromPrivateKey(generatePrivateKey(), 'mock');
  const recipient = walletFromPrivateKey(generatePrivateKey(), 'mock');
  const category = 'cd'.repeat(32);

  const spendable = (u: ReturnType<typeof randomUtxo>) => ({ ...u, lockingBytecode: sender.lockingBytecode });

  it('uniqueUtxos de-duplicates by outpoint, keeping the first', () => {
    const a = { txid: 'aa', vout: 0, tag: 1 };
    const out = uniqueUtxos([a, { txid: 'aa', vout: 0, tag: 2 }, { txid: 'aa', vout: 1, tag: 3 }, { txid: 'bb', vout: 0, tag: 4 }]);
    expect(out.map((u) => u.tag)).toEqual([1, 3, 4]);
  });

  it('rejects below-dust BCH, insufficient BCH and insufficient tokens', () => {
    const provider = new MockNetworkProvider();
    const utxos = [spendable(randomUtxo({ satoshis: 5_000n }))];
    const base = { provider, from: sender.address, to: recipient.address, utxos };
    expect(() => buildPayment({ ...base, asset: { kind: 'bch', satoshis: 545n } })).toThrow(/below dust/);
    expect(() => buildPayment({ ...base, asset: { kind: 'bch', satoshis: 10_000n } })).toThrow(/insufficient BCH|Not enough funds/);
    expect(() => buildPayment({ ...base, to: recipient.tokenAddress, asset: { kind: 'token', category, amount: 1n } })).toThrow(/insufficient token|Not enough fungible tokens/);
  });

  it('paymentForWallet: placeholder-signed WC object, not broadcast, with the user prompt, outputs and memo', () => {
    const provider = new MockNetworkProvider();
    const u = spendable(randomUtxo({ satoshis: 100_000n }));
    const wc = paymentForWallet(
      { provider, from: sender.address, to: recipient.address, utxos: [u, { ...u }], asset: { kind: 'bch', satoshis: 10_000n }, memo: 'inv-7' },
      'Pay Alice',
    );
    expect(wc.broadcast).toBe(false);
    expect(wc.userPrompt).toBe('Pay Alice');
    expect(wc.sourceOutputs).toHaveLength(1); // duplicate outpoint dropped
    const outs = wc.transaction.outputs;
    expect(outs[0].valueSatoshis).toBe(10_000n);
    expect(binToHex(outs[0].lockingBytecode)).toBe(recipient.lockingBytecode);
    // OP_RETURN 'HRMS' 'inv-7'
    expect(binToHex(outs[1].lockingBytecode)).toContain(binToHex(new TextEncoder().encode('HRMS')));
    expect(binToHex(outs[1].lockingBytecode)).toContain(binToHex(new TextEncoder().encode('inv-7')));
    // change returns to the sender; inputs - outputs = a small fee
    const change = outs.find((o) => binToHex(o.lockingBytecode) === sender.lockingBytecode);
    expect(change).toBeDefined();
    const fee = 100_000n - outs.reduce((s, o) => s + o.valueSatoshis, 0n);
    expect(fee).toBeGreaterThan(0n);
    expect(fee).toBeLessThan(1_000n);
  });

  it('sendLocal signs and submits to the (mock) provider; token payment keeps token change', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    provider.addUtxo(sender.address, randomUtxo({ satoshis: 100_000n }));
    provider.addUtxo(sender.tokenAddress, randomUtxo({ satoshis: 1_000n, token: { category, amount: 500n } }));
    const utxos = [...(await provider.getUtxos(sender.address)), ...(await provider.getUtxos(sender.tokenAddress))] as never[];
    const tx = await sendLocal({
      provider,
      from: sender.address,
      fromTokenAddr: sender.tokenAddress,
      to: recipient.tokenAddress,
      utxos,
      asset: { kind: 'token', category, amount: 120n },
      signer: sender.signer,
    });
    expect(tx.txid).toMatch(/^[0-9a-f]{64}$/);
    const recv = await provider.getUtxos(recipient.tokenAddress);
    expect(recv).toHaveLength(1);
    expect(recv[0].token).toMatchObject({ category, amount: 120n });
    expect(recv[0].satoshis).toBe(DUST_SATS);
    const back = (await provider.getUtxos(sender.tokenAddress)).filter((u) => u.token);
    expect(back.reduce((s, u) => s + u.token!.amount, 0n)).toBe(380n);
  });
});

describe('prompt (readline mocked)', () => {
  let writes: string[];
  let ttyDesc: PropertyDescriptor | undefined;
  beforeEach(() => {
    writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    ttyDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    fake.rl.questions = [];
    fake.rl.options = [];
    fake.rl.closed = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (ttyDesc) Object.defineProperty(process.stdin, 'isTTY', ttyDesc);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  it('promptSecret refuses to run without a terminal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    await expect(promptSecret('Key: ')).rejects.toThrow(/Key: : a terminal is required/);
    expect(fake.rl.options).toHaveLength(0);
  });

  it('promptSecret prints the question, never echoes the typed secret, trims the answer, closes readline', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    fake.rl.answer = '  my secret words \n';
    const s = await promptSecret('Mnemonic: ');
    expect(s).toBe('my secret words');
    expect(fake.rl.options[0]).toMatchObject({ input: process.stdin, terminal: true });
    expect(fake.rl.options[0].output).not.toBe(process.stdout);
    expect(writes.join('')).toBe('Mnemonic: \n');
    expect(writes.join('')).not.toContain('TYPED-SECRET');
    expect(fake.rl.closed).toBe(1);
  });

  it('promptLine asks via stdout and trims', async () => {
    fake.rl.answer = '  chipnet  ';
    expect(await promptLine('Network? ')).toBe('chipnet');
    expect(fake.rl.questions).toEqual(['Network? ']);
    expect(fake.rl.options[0].output).toBe(process.stdout);
    expect(fake.rl.closed).toBe(1);
  });
});
