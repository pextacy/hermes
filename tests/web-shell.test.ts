/**
 * Web shell (F31–F35): settings validation/persistence, connectivity status logic, Electrum host:port,
 * static hosting config, and the `pnpm check:submission` checks. Node only, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeCashAddress, hash160, hexToBin, secp256k1, encodePrivateKeyWif, generatePrivateKey } from '@bitauth/libauth';
import { generateSecretKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { bchConfig, electrumServers, parseElectrumServer, electrumProvider } from '@hermes/chain';
import {
  MIN_RELAYS,
  defaultSettings,
  isCustom,
  isElectrumHost,
  isRelayUrl,
  loadSettings,
  parseList,
  resetSettings,
  saveSettings,
  validateSettings,
  type Settings,
} from '../apps/web/src/lib/settings';
import { behind, overall, type Probe } from '../apps/web/src/lib/health';
import { collectChecks, format, isTokenAwareMainnetAddress, scanSecrets } from '../scripts/check-submission';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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
const g = globalThis as unknown as Record<string, unknown>;
let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  g.localStorage = store;
});
afterEach(() => {
  delete g.localStorage;
  loadSettings(); // Electrum overrides back to config defaults
});

const good = (): Settings => ({
  relays: ['wss://a.example', 'wss://b.example/sub', 'ws://localhost:7251'],
  electrum: { mainnet: ['fulcrum.example.org', 'f2.example.org:50004'], chipnet: ['chipnet.example.org'], testnet4: ['testnet4.example.org'] },
});

describe('F33 settings', () => {
  it('parses a textarea into a de-duplicated list (newlines, spaces, commas)', () => {
    expect(parseList(' wss://a\n\nwss://b, wss://a  wss://c \n')).toEqual(['wss://a', 'wss://b', 'wss://c']);
    expect(parseList('   ')).toEqual([]);
  });

  it('accepts wss relays anywhere and ws only on localhost', () => {
    for (const ok of ['wss://relay.damus.io', 'wss://x.org/path', 'ws://localhost:7001', 'ws://127.0.0.1:7253/']) expect(isRelayUrl(ok)).toBe(true);
    for (const bad of ['ws://relay.example', 'https://x.org', 'wss://', 'wss://a b', 'javascript:alert(1)', 42, null]) expect(isRelayUrl(bad)).toBe(false);
  });

  it('accepts Electrum hostnames with an optional port, nothing else', () => {
    for (const ok of ['bch.imaginary.cash', 'localhost', 'f.example.org:50004', '10.0.0.1:1']) expect(isElectrumHost(ok)).toBe(true);
    for (const bad of ['wss://f.example.org', 'f.example.org/x', 'f.example.org:99999', 'f.example.org:', '-bad.org', 'a..b', '', 7]) expect(isElectrumHost(bad)).toBe(false);
  });

  it('reports a message per field', () => {
    expect(validateSettings(good())).toEqual({});
    const e = validateSettings({ relays: ['http://x'], electrum: { mainnet: [], chipnet: ['wss://c.org'] } });
    expect(e.relays).toMatch(/Not a relay URL: http:\/\/x/);
    expect(e.mainnet).toMatch(/at least one mainnet/);
    expect(e.chipnet).toMatch(/Not a hostname: wss:\/\/c\.org/);
    expect(validateSettings({ ...good(), relays: good().relays.slice(0, MIN_RELAYS - 1) }).relays).toMatch(new RegExp(`at least ${MIN_RELAYS} relays`));
    expect(validateSettings(null).relays).toBeDefined();
    expect(validateSettings('x').relays).toBeDefined();
  });

  it('persists across a reload, drives @hermes/chain, and resets to defaults', () => {
    expect(isCustom(loadSettings())).toBe(false);
    saveSettings(good());
    const s = loadSettings(); // what a fresh page load does
    expect(s).toEqual(good());
    expect(isCustom(s)).toBe(true);
    expect(electrumServers('mainnet')).toEqual(['fulcrum.example.org', 'f2.example.org:50004']);
    const d = resetSettings();
    expect(store.getItem('hermes.settings')).toBeNull();
    expect(d).toEqual(defaultSettings());
    expect(electrumServers('mainnet')).toEqual(bchConfig('mainnet').electrum);
  });

  it('refuses to save invalid settings and keeps the previous ones', () => {
    saveSettings(good());
    expect(() => saveSettings({ ...good(), relays: ['wss://only.one'] })).toThrow(/at least/);
    expect(loadSettings()).toEqual(good());
  });

  it('falls back to defaults when stored settings are too few relays or have extra junk shapes', () => {
    store.setItem('hermes.settings', JSON.stringify({ ...good(), relays: ['wss://a.example'] }));
    expect(loadSettings()).toEqual(defaultSettings());
    store.setItem('hermes.settings', JSON.stringify({ ...good(), extra: '<script>' }));
    expect(loadSettings()).toEqual(good()); // extra keys are dropped
  });

  it('defaults are copies (editing them does not mutate config)', () => {
    const d = defaultSettings();
    d.relays.push('wss://mutated');
    expect(defaultSettings().relays).not.toContain('wss://mutated');
  });
});

describe('Electrum host:port (used by Settings)', () => {
  it('splits host and port', () => {
    expect(parseElectrumServer('bch.imaginary.cash')).toEqual({ host: 'bch.imaginary.cash', port: undefined });
    expect(parseElectrumServer('f.example.org:50004')).toEqual({ host: 'f.example.org', port: 50004 });
    expect(parseElectrumServer('f.example.org:0')).toEqual({ host: 'f.example.org', port: undefined });
  });

  it('builds a provider on the given port without connecting', () => {
    type E = { electrum: { socketOrHostname: string; options?: { port?: number } } };
    const p = electrumProvider('chipnet', 'f.example.org:50010') as unknown as E;
    expect(p.electrum.socketOrHostname).toBe('f.example.org');
    expect(p.electrum.options?.port).toBe(50010);
    const q = electrumProvider('chipnet', 'g.example.org') as unknown as E;
    expect(q.electrum.socketOrHostname).toBe('g.example.org');
    expect(q.electrum.options?.port).toBeUndefined(); // library default: 50004 (WSS)
  });
});

describe('F32 connectivity status', () => {
  const r = (state: Probe<true>['state']): Probe<true> => ({ target: `wss://${Math.random()}`, state, value: state === 'ok' ? true : undefined });
  const e = (state: Probe<number>['state'], value?: number): Probe<number> => ({ target: `e${Math.random()}`, state, value });

  it('is "checking" until the first result', () => {
    expect(overall({ relays: [], electrum: [] })).toBe('checking');
    expect(overall({ relays: [r('checking')], electrum: [e('checking')] })).toBe('checking');
  });
  it('is ok with enough relays for discovery and one Electrum server', () => {
    expect(overall({ relays: [r('ok'), r('ok'), r('ok'), r('down')], electrum: [e('down'), e('ok', 10)] })).toBe('ok');
  });
  it('warns when below the relay minimum or while results are still coming in', () => {
    expect(overall({ relays: [r('ok'), r('down'), r('down'), r('down')], electrum: [e('ok', 10)] })).toBe('warn');
    expect(overall({ relays: [r('ok'), r('ok'), r('ok')], electrum: [e('checking')] })).toBe('warn');
  });
  it('is an error when no Electrum server or no relay answers', () => {
    expect(overall({ relays: [r('ok'), r('ok'), r('ok')], electrum: [e('down'), e('down')] })).toBe('err');
    expect(overall({ relays: [r('down'), r('down'), r('down')], electrum: [e('ok', 5)] })).toBe('err');
  });
  it('flags Electrum servers behind the best tip', () => {
    const list = [e('ok', 100), e('ok', 99), e('ok', 90), e('down')];
    expect([...behind(list)]).toEqual([list[2].target]);
  });
});

describe('F34 static hosting config', () => {
  const web = (p: string) => readFileSync(join(ROOT, 'apps/web', p), 'utf8');
  const cspOf = (headers: string) => /Content-Security-Policy:\s*(.+)/.exec(headers)?.[1].trim();

  it('vite builds with a relative base (root, sub-path, IPFS)', () => {
    expect(web('vite.config.ts')).toMatch(/base:\s*'\.\/'/);
  });

  it('_headers (Netlify/Cloudflare) and vercel.json send the same CSP and security headers', () => {
    const h = web('public/_headers');
    const vercel = JSON.parse(web('vercel.json')) as { headers: { source: string; headers: { key: string; value: string }[] }[]; outputDirectory: string };
    const all = vercel.headers.find((x) => x.source === '/(.*)')!.headers;
    const v = Object.fromEntries(all.map((x) => [x.key, x.value]));
    expect(cspOf(h)).toBe(v['Content-Security-Policy']);
    for (const k of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Permissions-Policy']) expect(h).toContain(`${k}: ${v[k]}`);
    expect(vercel.outputDirectory).toBe('dist');
    expect(vercel.headers.some((x) => x.source.startsWith('/assets') && x.headers.some((y) => /immutable/.test(y.value)))).toBe(true);
  });

  it('CSP allows what the app needs: wasm, user relays/Electrum/RPC, local dev relay, fonts', () => {
    const csp = cspOf(web('public/_headers'))!;
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval'/);
    expect(csp).not.toMatch(/'unsafe-eval'(?!.*wasm)/);
    expect(csp).toMatch(/connect-src [^;]*wss:/);
    expect(csp).toMatch(/connect-src [^;]*https:/);
    expect(csp).toMatch(/connect-src [^;]*ws:\/\/localhost:\*/);
    expect(csp).toMatch(/fonts\.googleapis\.com/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });

  it('netlify.toml publishes dist from apps/web and does not duplicate the CSP', () => {
    const n = web('netlify.toml');
    expect(n).toMatch(/publish = "dist"/);
    expect(n).toMatch(/pnpm --filter web build/);
    expect(n).not.toMatch(/Content-Security-Policy/); // two CSP headers would be intersected by the browser
  });
});

describe('F35 check:submission', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-sub-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (p: string, content: unknown) => {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), typeof content === 'string' ? content : JSON.stringify(content));
  };
  const tokenAddr = () => {
    const pkh = hash160(secp256k1.derivePublicKeyCompressed(generatePrivateKey()) as Uint8Array);
    return encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: pkh }).address;
  };

  it('recognises token-aware mainnet addresses only', () => {
    const pkh = hexToBin('00'.repeat(20));
    expect(isTokenAwareMainnetAddress(tokenAddr())).toBe(true);
    expect(isTokenAwareMainnetAddress(encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: pkh }).address)).toBe(false);
    expect(isTokenAwareMainnetAddress(encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address)).toBe(false);
    expect(isTokenAwareMainnetAddress('bitcoincash:zqplaceholder')).toBe(false);
    expect(isTokenAwareMainnetAddress(null)).toBe(false);
  });

  it('an empty repo has every required item open, with a hint for each', () => {
    const rows = collectChecks(dir);
    const required = rows.filter((r) => r.required);
    expect(required.length).toBeGreaterThan(15);
    expect(required.filter((r) => r.ok).map((r) => r.item)).toEqual(['No secrets in the repo (.env, WIF, nsec, PEM, mnemonic)']);
    for (const r of required.filter((x) => !x.ok)) expect(r.hint, r.item).toBeTruthy();
    // every line of the PHASES.md submission checklist has a row
    const items = rows.map((r) => r.item).join('\n');
    for (const re of [/Mainnet tx usable by judges/, /Live demo link/, /presentation/, /Repository link/, /EMBER2026/, /WizardConnect/, /XO templates/, /Telegram/, /Roll-call/, /XO feedback/, /Media-track/, /No secrets/]) expect(items).toMatch(re);
    expect(format(rows)).toMatch(/required item\(s\) open/);
  });

  it('a complete repo passes every required item', () => {
    put('config/hermes.json', { web: { payNetwork: 'mainnet', banner: { presentationUrl: 'https://slides.example/x', presentationIsDraft: false, repoUrl: 'https://git.example/hermes', ember2026Address: tokenAddr() } } });
    put('config/networks.json', { bch: { mainnet: { tokens: { PUSD: { category: 'aa' } } }, chipnet: { tokens: { PUSD: { category: 'bb' } } } }, evm: { baseSepolia: { htlc: '0x1' } } });
    put('config/submission.json', { liveDemoUrl: 'https://hermes.example', mainnetDemoTxids: ['ab'.repeat(32)], telegramConfirmed: true, rollCall: 'joined team X', xoFeedbackWrittenByOwner: true, mediaUrl: 'https://media.example', bountyDeliverables: { 'FoldingCash demo video': true } });
    put('apps/web/src/components/Banner.tsx', '');
    put('apps/web/src/lib/wizard.ts', '');
    put('apps/web/package.json', { dependencies: { '@wizardconnect/react': '1' } });
    put('apps/web/dist/index.html', '<script type="module" crossorigin src="./assets/index-x.js"></script>');
    put('apps/web/netlify.toml', '[build]');
    put('apps/web/public/_headers', '/*\n  Content-Security-Policy: default-src \'self\'');
    put('apps/web/vercel.json', { headers: [{ source: '/(.*)', headers: [] }] });
    for (const t of ['hermes-htlc', 'hermes-identity', 'hermes-drops-claim']) put(`packages/xo/templates/${t}.json`, {});
    put('packages/drops/deployments/chipnet.json', {});
    put('packages/drops/deployments/tree-1.json', {});
    put('packages/solid/deployments/mainnet.json', {});
    const rows = collectChecks(dir);
    expect(rows.filter((r) => !r.ok).map((r) => r.item)).toEqual([]);
    expect(format(rows)).toMatch(/all required items done/);
  });

  it('a draft presentation, a non-token address or a bad txid stay open', () => {
    put('config/hermes.json', { web: { banner: { presentationUrl: 'https://slides.example/x', presentationIsDraft: true, ember2026Address: 'bitcoincash:qq' } } });
    put('config/submission.json', { mainnetDemoTxids: ['nothex'], rollCall: '  ' });
    const open = collectChecks(dir).filter((r) => !r.ok).map((r) => r.item);
    expect(open.some((i) => /presentation/.test(i))).toBe(true);
    expect(open.some((i) => /EMBER2026/.test(i))).toBe(true);
    expect(open.some((i) => /Mainnet tx/.test(i))).toBe(true);
    expect(open.some((i) => /Roll-call/.test(i))).toBe(true);
  });

  it('the secret scan finds .env files, WIFs, nsecs and PEM keys, and skips node_modules', () => {
    put('README.md', 'nothing here');
    expect(scanSecrets(dir)).toEqual([]);
    const wif = encodePrivateKeyWif(generatePrivateKey(), 'mainnet');
    const nsec = nip19.nsecEncode(generateSecretKey());
    put('.env.local', 'X=1');
    put('a/keys.ts', `const k = '${wif}';`);
    put('b/n.json', JSON.stringify({ nsec }));
    put('c/k.md', ['-----BEGIN', 'EC PRIVATE KEY-----'].join(' '));
    put(`node_modules/x/${'leak'}.ts`, `'${wif}'`);
    const hits = scanSecrets(dir).map((h) => `${h.file}:${h.what}`).sort();
    expect(hits).toEqual(['.env.local:.env file', 'a/keys.ts:BCH WIF private key', 'b/n.json:Nostr nsec', 'c/k.md:PEM private key']);
    expect(collectChecks(dir).find((r) => /No secrets/.test(r.item))!.ok).toBe(false);
  });

  it('runs against this repo without throwing and finds no secrets', () => {
    const rows = collectChecks(ROOT);
    expect(rows.find((r) => /No secrets/.test(r.item))!.ok).toBe(true);
    expect(rows.find((r) => /WizardConnect/.test(r.item))!.ok).toBe(true);
    expect(rows.find((r) => /Static hosting/.test(r.item))!.ok).toBe(true);
  });
});
