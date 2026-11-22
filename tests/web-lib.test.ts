/**
 * apps/web/src/lib/* — browser helpers tested in node with a stubbed localStorage / window.
 * No network: providers, wallets and EIP-1193 objects are in-memory fakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { binToHex, encodePrivateKeyWif, generatePrivateKey, hexToBin, secp256k1 } from '@bitauth/libauth';
import * as nip19 from 'nostr-tools/nip19';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { NETWORKS, bchConfig, electrumServers, walletFromPrivateKey } from '@hermes/chain';
import { load, loadArray, loadChoice, remove, reviveBigints, save } from '../apps/web/src/lib/storage';
import { defaultSettings, loadSettings, saveSettings, type Settings } from '../apps/web/src/lib/settings';
import {
  ensureLocalBchKey,
  ensureLocalNostr,
  exportBchWif,
  forgetLocalBchKey,
  getLocalBchKey,
  getLocalNsec,
  importBchWif,
  localBchSigner,
  localWallet,
  nostrSigner,
  setLocalBchKey,
  setLocalNsec,
} from '../apps/web/src/lib/keys';
import { connectEvm, injected } from '../apps/web/src/lib/evm';
import { wcAddresses, wcSendOutputs, wcUtxos } from '../apps/web/src/lib/wizard';
import { WizardConnectBchSigner } from '../apps/web/src/lib/wcsigner';

// ---------- browser stubs ----------

class MemoryStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

let store: MemoryStorage;
const g = globalThis as unknown as Record<string, unknown>;
beforeEach(() => {
  store = new MemoryStorage();
  g.localStorage = store;
});
afterEach(() => {
  delete g.localStorage;
  delete g.ethereum;
  vi.restoreAllMocks();
});

// ---------- storage.ts ----------

describe('web storage', () => {
  it('round-trips JSON and bigints', () => {
    save('k', { a: 1, b: [1, 2], n: 5n });
    expect(load('k', null)).toEqual({ a: 1, b: [1, 2], n: '5n' });
    expect(reviveBigints(load('k', null))).toEqual({ a: 1, b: [1, 2], n: 5n });
    expect(reviveBigints({ neg: '-12n', s: 'hello', notBig: '12' })).toEqual({ neg: -12n, s: 'hello', notBig: '12' });
  });

  it('returns the fallback for missing keys and corrupted JSON', () => {
    expect(load('missing', 'fb')).toBe('fb');
    store.setItem('bad', '{not json');
    expect(load('bad', 42)).toBe(42);
  });

  it('never throws when storage is unavailable or full', () => {
    delete g.localStorage; // e.g. blocked storage: ReferenceError inside
    expect(load('k', 'fb')).toBe('fb');
    expect(() => save('k', 1)).not.toThrow();
    expect(() => remove('k')).not.toThrow();
    g.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(load('k', 'fb')).toBe('fb');
    expect(() => save('k', 1)).not.toThrow();
    expect(() => remove('k')).not.toThrow();
  });

  it('remove deletes a key', () => {
    save('k', 1);
    remove('k');
    expect(load('k', null)).toBeNull();
  });

  it('loadChoice only returns allowed values', () => {
    expect(loadChoice('mode', ['a', 'b'] as const, 'a')).toBe('a');
    save('mode', 'b');
    expect(loadChoice('mode', ['a', 'b'] as const, 'a')).toBe('b');
    save('mode', 'evil');
    expect(loadChoice('mode', ['a', 'b'] as const, 'a')).toBe('a');
    save('mode', 7);
    expect(loadChoice('mode', ['a', 'b'] as const, 'a')).toBe('a');
    store.setItem('mode', '{corrupt');
    expect(loadChoice('mode', ['a', 'b'] as const, 'b')).toBe('b');
  });

  it('loadArray tolerates non-array values', () => {
    expect(loadArray('list')).toEqual([]);
    save('list', [1, 2]);
    expect(loadArray('list')).toEqual([1, 2]);
    for (const bad of [{ length: 3 }, 'abc', 12, null]) {
      save('list', bad);
      expect(loadArray('list')).toEqual([]);
    }
  });
});

// ---------- settings.ts ----------

describe('web settings (custom relays / Electrum)', () => {
  const custom = (): Settings => ({
    relays: ['wss://relay.one', 'wss://relay.two/path', 'ws://localhost:7001'],
    electrum: { mainnet: ['fulcrum.example.org:50004'], chipnet: ['chipnet.example.org'], testnet4: ['testnet4.example.org'] },
  });

  it('defaults come from config/networks.json', () => {
    const d = defaultSettings();
    expect(d.relays).toEqual(NETWORKS.nostr.relays);
    expect(d.electrum.mainnet).toEqual(bchConfig('mainnet').electrum);
    expect(d.electrum.chipnet).toEqual(bchConfig('chipnet').electrum);
    expect(loadSettings()).toEqual(d);
  });

  it('persists custom settings and applies the Electrum override', () => {
    saveSettings(custom());
    const s = loadSettings();
    expect(s).toEqual(custom());
    expect(electrumServers('mainnet')).toEqual(['fulcrum.example.org:50004']);
    expect(electrumServers('chipnet')).toEqual(['chipnet.example.org']);
    // back to defaults for other tests in this process
    store.clear();
    loadSettings();
    expect(electrumServers('mainnet')).toEqual(bchConfig('mainnet').electrum);
  });

  it.each([
    ['http relay', { relays: ['http://relay.example'] }],
    ['plain ws to a remote host', { relays: ['ws://relay.example'] }],
    ['relay with whitespace', { relays: ['wss://a b'] }],
    ['non-string relay', { relays: [42] }],
    ['empty relay list', { relays: [] }],
    ['electrum URL instead of hostname', { electrum: { mainnet: ['wss://fulcrum.example.org'], chipnet: ['x.org'] } }],
    ['electrum host with path', { electrum: { mainnet: ['x.org/evil'], chipnet: ['x.org'] } }],
    ['missing chipnet electrum', { electrum: { mainnet: ['x.org'] } }],
  ])('rejects %s', (_label, patch) => {
    const s = { ...custom(), ...patch } as unknown as Settings;
    expect(() => saveSettings(s)).toThrow(/Relays must be wss/);
    expect(store.getItem('hermes.settings')).toBeNull();
  });

  it('keeps settings saved before testnet4 existed and fills testnet4 with the defaults', () => {
    const { testnet4: _t4, ...oldElectrum } = custom().electrum;
    store.setItem('hermes.settings', JSON.stringify({ relays: custom().relays, electrum: oldElectrum }));
    const s = loadSettings();
    expect(s.electrum.chipnet).toEqual(['chipnet.example.org']);
    expect(s.electrum.testnet4).toEqual(bchConfig('testnet4').electrum);
    expect(electrumServers('testnet4')).toEqual(bchConfig('testnet4').electrum);
    store.clear();
    loadSettings();
  });

  it('ignores corrupted or tampered stored settings', () => {
    for (const raw of ['{bad json', '"string"', '42', 'null', JSON.stringify({ relays: ['javascript:alert(1)'], electrum: custom().electrum }), JSON.stringify({ relays: 'wss://x' })]) {
      store.setItem('hermes.settings', raw);
      expect(loadSettings()).toEqual(defaultSettings());
    }
  });
});

// ---------- keys.ts ----------

describe('web keys (browser BCH key, WIF backup/import, Nostr key)', () => {
  it('creates, persists and reuses the BCH key per network', () => {
    expect(getLocalBchKey('chipnet')).toBeUndefined();
    const k = ensureLocalBchKey('chipnet');
    expect(k.length).toBe(32);
    expect(ensureLocalBchKey('chipnet')).toEqual(k);
    expect(getLocalBchKey('chipnet')).toEqual(k);
    expect(getLocalBchKey('mainnet')).toBeUndefined();
    expect(localWallet('chipnet').address).toBe(walletFromPrivateKey(k, 'chipnet').address);
    expect(localWallet('chipnet').address.startsWith('bchtest:')).toBe(true);
    forgetLocalBchKey('chipnet');
    expect(getLocalBchKey('chipnet')).toBeUndefined();
  });

  it('treats a corrupted stored key as missing and keeps the old value aside', () => {
    for (const bad of ['zz', 'abcd', 'g'.repeat(64), '00'.repeat(32), 'ff'.repeat(32), 12345]) {
      store.clear();
      save('hermes.bchkey.chipnet', bad);
      expect(getLocalBchKey('chipnet')).toBeUndefined();
      const fresh = ensureLocalBchKey('chipnet');
      expect(fresh.length).toBe(32);
      expect(load('hermes.bchkey.chipnet.corrupt', null)).toEqual(bad);
      expect(() => localWallet('chipnet')).not.toThrow();
    }
  });

  it('setLocalBchKey rejects invalid keys', () => {
    expect(() => setLocalBchKey('chipnet', new Uint8Array(31))).toThrow(/Invalid BCH private key/);
    expect(() => setLocalBchKey('chipnet', new Uint8Array(32))).toThrow(/Invalid BCH private key/); // zero key
    expect(() => setLocalBchKey('chipnet', hexToBin('ff'.repeat(32)))).toThrow(/Invalid BCH private key/); // > curve order
    const k = generatePrivateKey();
    setLocalBchKey('chipnet', k);
    expect(getLocalBchKey('chipnet')).toEqual(k);
  });

  it('WIF backup round-trips with the right network prefix', () => {
    const chip = exportBchWif('chipnet');
    const main = exportBchWif('mainnet');
    expect(chip[0]).toBe('c'); // compressed testnet WIF
    expect(['K', 'L']).toContain(main[0]); // compressed mainnet WIF
    const before = getLocalBchKey('chipnet')!;
    forgetLocalBchKey('chipnet');
    expect(importBchWif('chipnet', `  ${chip}\n`)).toEqual(before);
    expect(getLocalBchKey('chipnet')).toEqual(before);
  });

  it('importBchWif rejects invalid, uncompressed and wrong-network WIFs without touching the key', () => {
    const k = ensureLocalBchKey('chipnet');
    const other = generatePrivateKey();
    expect(() => importBchWif('chipnet', '')).toThrow(/Invalid WIF/);
    expect(() => importBchWif('chipnet', 'not-a-wif')).toThrow(/Invalid WIF/);
    const good = encodePrivateKeyWif(other, 'testnet');
    const badChecksum = good.slice(0, -1) + (good.endsWith('1') ? '2' : '1');
    expect(() => importBchWif('chipnet', badChecksum)).toThrow(/Invalid WIF/);
    expect(() => importBchWif('chipnet', encodePrivateKeyWif(other, 'testnetUncompressed'))).toThrow(/Uncompressed/);
    expect(() => importBchWif('chipnet', encodePrivateKeyWif(other, 'mainnet'))).toThrow(/mainnet WIF.*Mainnet/);
    expect(() => importBchWif('mainnet', encodePrivateKeyWif(other, 'testnet'))).toThrow(/testnet WIF.*Chipnet/);
    expect(getLocalBchKey('chipnet')).toEqual(k);
    expect(getLocalBchKey('mainnet')).toBeUndefined();
  });

  it('localBchSigner uses the browser key', async () => {
    const k = ensureLocalBchKey('chipnet');
    const pub = await localBchSigner('chipnet').getPublicKey();
    expect(binToHex(pub)).toBe(binToHex(secp256k1.derivePublicKeyCompressed(k) as Uint8Array));
  });

  it('creates, persists and imports the Nostr key', async () => {
    expect(getLocalNsec()).toBeUndefined();
    const s1 = ensureLocalNostr();
    const nsec = getLocalNsec()!;
    expect(nsec.startsWith('nsec1')).toBe(true);
    expect(await ensureLocalNostr().getPublicKey()).toBe(await s1.getPublicKey());
    expect(await nostrSigner('local').getPublicKey()).toBe(await s1.getPublicKey());

    const sk = generateSecretKey();
    setLocalNsec(`  ${nip19.nsecEncode(sk)} `);
    expect(await ensureLocalNostr().getPublicKey()).toBe(getPublicKey(sk));
  });

  it('setLocalNsec rejects non-nsec input and keeps the current key', () => {
    ensureLocalNostr();
    const nsec = getLocalNsec();
    expect(() => setLocalNsec('garbage')).toThrow(/not an nsec/);
    expect(() => setLocalNsec(nip19.npubEncode(getPublicKey(generateSecretKey())))).toThrow(/not an nsec/);
    expect(getLocalNsec()).toBe(nsec);
  });

  it('a corrupted stored nsec is replaced (old value kept aside), not a crash', async () => {
    save('hermes.nsec', 'nsec1garbage');
    expect(getLocalNsec()).toBeUndefined();
    await expect(ensureLocalNostr().getPublicKey()).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(load('hermes.nsec.corrupt', null)).toBe('nsec1garbage');
    expect(getLocalNsec()).toMatch(/^nsec1/);
  });
});

// ---------- evm.ts ----------

describe('web evm connect', () => {
  const cfg = { chainId: 84532, name: 'Base Sepolia', rpc: 'http://127.0.0.1:1', explorerTx: '', usdc: null, htlc: null, confirmations: 1 };
  const ADDR = '0x00000000000000000000000000000000000000a1';

  it('errors without an injected wallet', async () => {
    expect(injected()).toBeUndefined();
    await expect(connectEvm(cfg)).rejects.toThrow(/No EVM wallet/);
  });

  it('switches chain and returns the account', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => (method === 'eth_requestAccounts' ? [ADDR] : null));
    g.ethereum = { request };
    const { address, wallet } = await connectEvm(cfg);
    expect(address).toBe(ADDR);
    expect(wallet.chain?.id).toBe(84532);
    expect(request).toHaveBeenCalledWith({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
    expect(request.mock.calls.some(([a]) => a.method === 'wallet_addEthereumChain')).toBe(false);
  });

  it('adds the chain when the wallet does not know it (4902)', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [ADDR];
      if (method === 'wallet_switchEthereumChain') throw Object.assign(new Error('unknown chain'), { code: 4902 });
      return null;
    });
    g.ethereum = { request };
    await connectEvm(cfg);
    const add = request.mock.calls.find(([a]) => a.method === 'wallet_addEthereumChain')?.[0] as unknown as { params: [{ chainId: string; rpcUrls: string[] }] };
    expect(add.params[0]).toMatchObject({ chainId: '0x14a34', rpcUrls: [cfg.rpc] });
  });

  it('stops when the user rejects the switch (4001) and when no account is shared', async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [ADDR];
      throw Object.assign(new Error('User rejected'), { code: 4001 });
    });
    g.ethereum = { request };
    await expect(connectEvm(cfg)).rejects.toThrow(/rejected/);
    expect(request.mock.calls.some(([a]) => a.method === 'wallet_addEthereumChain')).toBe(false);

    g.ethereum = { request: async () => [] };
    await expect(connectEvm(cfg)).rejects.toThrow(/no account/);
  });
});

// ---------- wizard.ts / wcsigner.ts ----------

const keys = Array.from({ length: 16 }, () => generatePrivateKey());
const pubOf = (k: Uint8Array) => secp256k1.derivePublicKeyCompressed(k) as Uint8Array;

/** Fake WizardConnect manager: receive (0) and change (1) pubkeys, records sign requests. */
function fakeManager(opts: { count?: number; error?: string } = {}) {
  const signed: { inputPaths: unknown; transaction: unknown }[] = [];
  return {
    signed,
    getPubkey: (child: number, i: bigint) => (Number(i) < (opts.count ?? 8) ? pubOf(keys[child * 8 + Number(i)]) : undefined),
    signTransaction: async (req: { inputPaths: unknown; transaction: unknown }) => {
      signed.push(req);
      return opts.error ? { error: opts.error } : { signedTransaction: 'beef' };
    },
  };
}

type FakeUtxo = { txid: string; vout: number; satoshis: bigint; token?: { category: string; amount: bigint; nft?: unknown } };
function fakeProvider(byAddress: Record<string, FakeUtxo[]>) {
  const sent: string[] = [];
  return {
    sent,
    network: 'chipnet',
    getUtxos: async (a: string) => byAddress[a] ?? [],
    sendRawTransaction: async (hex: string) => {
      sent.push(hex);
      return 'f'.repeat(64);
    },
    getBlockHeight: async () => 1,
    getRawTransaction: async () => '',
    performRequest: async () => null,
  };
}
const tx = (n: number) => n.toString(16).padStart(64, '0');
const CAT = 'ab'.repeat(32);

describe('web WizardConnect adapter (wizard.ts)', () => {
  it('derives receive/change addresses matching the keys', () => {
    const m = fakeManager();
    const a = wcAddresses(m as never, 'chipnet');
    expect(a).toHaveLength(16);
    expect(a[0]).toMatchObject({ path: 'receive', childIndex: 0, index: 0 });
    expect(a[8]).toMatchObject({ path: 'change', childIndex: 1, index: 0 });
    const w = walletFromPrivateKey(keys[0], 'chipnet');
    expect(a[0].address).toBe(w.address);
    expect(a[0].tokenAddress).toBe(w.tokenAddress);
    expect(a[0].lockingBytecode).toBe(w.lockingBytecode);
    expect(wcAddresses(m as never, 'mainnet', 1)[0].address).toBe(walletFromPrivateKey(keys[0], 'mainnet').address);
    expect(wcAddresses(fakeManager({ count: 0 }) as never, 'chipnet')).toEqual([]);
  });

  it('wcUtxos gathers coins per address with their owner', async () => {
    const m = fakeManager({ count: 2 });
    const addrs = wcAddresses(m as never, 'chipnet');
    const p = fakeProvider({ [addrs[1].address]: [{ txid: tx(1), vout: 0, satoshis: 5000n }] });
    const all = await wcUtxos(p as never, addrs);
    expect(all).toHaveLength(1);
    expect(all[0].owner.index).toBe(1);
  });

  it('builds, signs with the right input paths and broadcasts', async () => {
    const m = fakeManager({ count: 2 });
    const addrs = wcAddresses(m as never, 'chipnet');
    const coin = (n: number, sats: bigint, owner = addrs[0]) => ({ txid: tx(n), vout: 0, satoshis: sats, lockingBytecode: owner.lockingBytecode });
    const change1 = addrs.find((x) => x.path === 'change' && x.index === 1)!;
    const p = fakeProvider({ [addrs[0].address]: [coin(1, 2_000n)], [change1.address]: [coin(2, 100_000n, change1)] });
    const to = walletFromPrivateKey(generatePrivateKey(), 'chipnet').address;
    const r = await wcSendOutputs({ manager: m as never, provider: p as never, network: 'chipnet', outputs: [{ to, amount: 10_000n }], userPrompt: 'test' });
    expect(r).toEqual({ txid: 'f'.repeat(64), hex: 'beef' });
    expect(p.sent).toEqual(['beef']);
    // the largest coin (change/1) is enough: one input, signed on change path index 1
    expect(m.signed[0].inputPaths).toEqual([[0, 'change', 1]]);
  });

  it('broadcast:false returns the signed hex only', async () => {
    const m = fakeManager({ count: 1 });
    const [a] = wcAddresses(m as never, 'chipnet');
    const p = fakeProvider({ [a.address]: [{ txid: tx(1), vout: 0, satoshis: 50_000n, lockingBytecode: a.lockingBytecode } as FakeUtxo] });
    const r = await wcSendOutputs({ manager: m as never, provider: p as never, network: 'chipnet', outputs: [{ to: a.address, amount: 1_000n }], userPrompt: 't', broadcast: false });
    expect(r).toEqual({ txid: '', hex: 'beef' });
    expect(p.sent).toEqual([]);
  });

  it('error paths: no addresses, not enough BCH, not enough tokens, wallet refusal', async () => {
    const to = walletFromPrivateKey(generatePrivateKey(), 'chipnet').address;
    const base = { network: 'chipnet' as const, outputs: [{ to, amount: 10_000n }], userPrompt: 't' };
    await expect(wcSendOutputs({ ...base, manager: fakeManager({ count: 0 }) as never, provider: fakeProvider({}) as never })).rejects.toThrow(/no addresses/);

    const m = fakeManager({ count: 1 });
    const [a] = wcAddresses(m as never, 'chipnet');
    const poor = fakeProvider({ [a.address]: [{ txid: tx(1), vout: 0, satoshis: 1_000n, lockingBytecode: a.lockingBytecode } as FakeUtxo] });
    await expect(wcSendOutputs({ ...base, manager: m as never, provider: poor as never })).rejects.toThrow(/Not enough BCH/);

    const tokenPoor = fakeProvider({
      [a.address]: [{ txid: tx(2), vout: 0, satoshis: 1_000n, token: { category: CAT, amount: 5n }, lockingBytecode: a.lockingBytecode } as FakeUtxo],
    });
    await expect(wcSendOutputs({ ...base, manager: m as never, provider: tokenPoor as never, tokenInputs: { category: CAT, amount: 6n } })).rejects.toThrow(/Not enough tokens/);

    const rich = fakeProvider({ [a.address]: [{ txid: tx(3), vout: 0, satoshis: 90_000n, lockingBytecode: a.lockingBytecode } as FakeUtxo] });
    await expect(wcSendOutputs({ ...base, manager: fakeManager({ count: 1, error: 'user rejected' }) as never, provider: rich as never })).rejects.toThrow('Wallet: user rejected');
    expect(rich.sent).toEqual([]);
  });
});

describe('web WizardConnect BCH proof signer (wcsigner.ts)', () => {
  it('exposes receive/0 and requires a coin to prove', async () => {
    const m = fakeManager({ count: 1 });
    const [a] = wcAddresses(m as never, 'chipnet');
    const s = new WizardConnectBchSigner(m as never, fakeProvider({}) as never, 'chipnet');
    expect(s.address).toBe(a.address);
    expect(binToHex(await s.getPublicKey())).toBe(binToHex(pubOf(keys[0])));
    await expect(s.prove('hello')).rejects.toThrow(/needs a small BCH coin/);
  });

  it('signs a never-broadcast proof spending the largest plain coin', async () => {
    const m = fakeManager({ count: 1 });
    const [a] = wcAddresses(m as never, 'chipnet');
    const coins = [
      { txid: tx(1), vout: 0, satoshis: 3_000n, lockingBytecode: a.lockingBytecode },
      { txid: tx(2), vout: 1, satoshis: 9_000n, lockingBytecode: a.lockingBytecode },
      { txid: tx(3), vout: 0, satoshis: 99_000n, lockingBytecode: a.lockingBytecode, token: { category: CAT, amount: 1n } },
    ];
    const p = fakeProvider({ [a.address]: coins });
    const proof = await new WizardConnectBchSigner(m as never, p as never, 'chipnet').prove('hello');
    expect(proof).toEqual({ type: 'tx-commit', tx: 'beef', sourceOutputs: [{ lockingBytecode: a.lockingBytecode, valueSatoshis: '9000' }] });
    expect(m.signed[0].inputPaths).toEqual([[0, 'receive', 0]]);
    expect((m.signed[0].transaction as { broadcast: boolean }).broadcast).toBe(false);
    expect(p.sent).toEqual([]);
  });

  it('errors when the wallet shared no receive key or refuses', async () => {
    await expect(new WizardConnectBchSigner(fakeManager({ count: 0 }) as never, fakeProvider({}) as never, 'chipnet').getPublicKey()).rejects.toThrow(/did not share its receive key/);
    const m = fakeManager({ count: 1, error: 'nope' });
    const [a] = wcAddresses(m as never, 'chipnet');
    const p = fakeProvider({ [a.address]: [{ txid: tx(1), vout: 0, satoshis: 9_000n, lockingBytecode: a.lockingBytecode } as FakeUtxo] });
    await expect(new WizardConnectBchSigner(m as never, p as never, 'chipnet').prove('x')).rejects.toThrow('Wallet: nope');
  });
});

// ---------- context.tsx ----------

describe('web context', () => {
  it('useHermes outside the provider throws a clear error', async () => {
    const req = createRequire(new URL('../apps/web/package.json', import.meta.url));
    // react lives in apps/web/node_modules (not hoisted); resolve it from there.
    const React = req('react') as { createElement: (c: () => null) => unknown };
    const { renderToString } = req('react-dom/server') as { renderToString: (el: unknown) => string };
    const { useHermes } = await import('../apps/web/src/lib/context');
    function Probe() {
      useHermes();
      return null;
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => renderToString(React.createElement(Probe))).toThrow('HermesProvider missing');
  });
});
