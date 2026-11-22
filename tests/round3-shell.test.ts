/**
 * Round 3 web shell (G36–G42): theme, keyboard shortcuts, PWA routing, toasts, mainnet safety, deep links.
 * Pure logic + static files only; the browser behaviour is checked with a headless-Chrome harness.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CHORD_MS,
  MAINNET_CONFIRM,
  MAX_TOASTS,
  SHORTCUTS,
  SIM_DIRECTIONS,
  buildHash,
  defaultTtl,
  dropToast,
  isSimDirection,
  isThemePref,
  isTypingTarget,
  needsMainnetConfirm,
  nextTheme,
  parseHash,
  pushToast,
  resolveTheme,
  shortcutStep,
  type Toast,
} from '../apps/web/src/lib/shell';
import { swStrategy } from '../apps/web/src/sw/strategy';
import { THEME_KEY, applyTheme, loadTheme, saveTheme } from '../apps/web/src/lib/settings';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const web = (p: string) => readFileSync(`${ROOT}apps/web/${p}`, 'utf8');

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
}
const g = globalThis as unknown as Record<string, unknown>;
let store: MemoryStorage;
beforeEach(() => {
  store = new MemoryStorage();
  g.localStorage = store;
});
afterEach(() => {
  delete g.localStorage;
});

describe('G42 deep links', () => {
  it('parses #tab?key=value', () => {
    expect(parseHash('#claims?addr=bitcoincash%3Aqabc')).toEqual({ tab: 'claims', params: { addr: 'bitcoincash:qabc' } });
    expect(parseHash('#developers?tool=hashlock&x=1')).toEqual({ tab: 'developers', params: { tool: 'hashlock', x: '1' } });
    expect(parseHash('#swap')).toEqual({ tab: 'swap', params: {} });
    expect(parseHash('')).toEqual({ tab: '', params: {} });
    expect(parseHash('#')).toEqual({ tab: '', params: {} });
    expect(parseHash('#pay?')).toEqual({ tab: 'pay', params: {} });
    expect(parseHash('#swap?=x&sim=pusd-to-usdc')).toEqual({ tab: 'swap', params: { sim: 'pusd-to-usdc' } });
  });

  it('builds stable links and round-trips', () => {
    expect(buildHash('swap', { sim: 'usdc-to-pusd' })).toBe('#swap?sim=usdc-to-pusd');
    expect(buildHash('claims', { b: '2', a: '1', gone: undefined, empty: '' })).toBe('#claims?a=1&b=2');
    expect(buildHash('pay')).toBe('#pay');
    const addr = 'bitcoincash:zq0123456789abcdef&x=y #?';
    const h = buildHash('claims', { addr });
    expect(parseHash(h)).toEqual({ tab: 'claims', params: { addr } });
  });

  it('only accepts the two simulator directions', () => {
    expect(Object.keys(SIM_DIRECTIONS)).toEqual(['usdc-to-pusd', 'pusd-to-usdc']);
    expect(isSimDirection('pusd-to-usdc')).toBe(true);
    for (const bad of ['toString', '__proto__', 'USDC', '', undefined]) expect(isSimDirection(bad)).toBe(false);
  });
});

describe('G36 theme', () => {
  it('resolves and cycles', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect([nextTheme('system'), nextTheme('light'), nextTheme('dark')]).toEqual(['light', 'dark', 'system']);
    expect(isThemePref('dark')).toBe(true);
    expect(isThemePref('blue')).toBe(false);
  });

  it('persists the choice; system clears it; junk falls back to system', () => {
    expect(loadTheme()).toBe('system');
    saveTheme('dark');
    expect(store.getItem(THEME_KEY)).toBe('"dark"');
    expect(loadTheme()).toBe('dark');
    saveTheme('system');
    expect(store.getItem(THEME_KEY)).toBeNull();
    store.setItem(THEME_KEY, '"neon"');
    expect(loadTheme()).toBe('system');
    store.setItem(THEME_KEY, '{not json');
    expect(loadTheme()).toBe('system');
  });

  it('sets data-theme for manual choices and removes it for system', () => {
    const attrs = new Map<string, string>();
    const root = { setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) };
    applyTheme('light', root);
    expect(attrs.get('data-theme')).toBe('light');
    applyTheme('system', root);
    expect(attrs.has('data-theme')).toBe(false);
  });

  it('theme-init.js (pre-paint) reads the same key and the CSS has [data-theme] overrides', () => {
    const js = web('public/theme-init.js');
    expect(js).toContain(`'${THEME_KEY}'`);
    const html = web('index.html');
    expect(html).toMatch(/<script src="theme-init\.js"><\/script>/); // external: the CSP has no 'unsafe-inline' for scripts
    const css = web('src/styles.css');
    expect(css).toContain("/* Round 3 — Shell */");
    expect(css).toContain(":root[data-theme='dark']");
    expect(css).toContain(":root[data-theme='light']");
  });
});

describe('G37 keyboard shortcuts', () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key, ...mods });

  it('g then a letter goes to the tab', () => {
    expect(SHORTCUTS).toMatchObject({ p: 'pay', i: 'identity', s: 'swap', c: 'claims', d: 'developers' });
    let s = shortcutStep(null, k('g'), 1000);
    expect(s).toEqual({ pendingG: 1000, action: null });
    s = shortcutStep(s.pendingG, k('c'), 1500);
    expect(s).toEqual({ pendingG: null, action: { go: 'claims' } });
    expect(shortcutStep(1000, k('P'), 1100).action).toEqual({ go: 'pay' }); // caps lock / shift
  });

  it('the chord expires and unknown second keys reset it', () => {
    expect(shortcutStep(1000, k('s'), 1000 + CHORD_MS + 1).action).toBeNull();
    expect(shortcutStep(1000, k('x'), 1100)).toEqual({ pendingG: null, action: null });
    expect(shortcutStep(null, k('p'), 1100).action).toBeNull(); // no g first
    expect(shortcutStep(1000, k('g'), 1100).pendingG).toBe(1100); // g g restarts
  });

  it('? opens help, Esc closes, modifier chords never fire', () => {
    expect(shortcutStep(null, k('?'), 0).action).toEqual({ help: true });
    expect(shortcutStep(500, k('Escape'), 600)).toEqual({ pendingG: null, action: { close: true } });
    expect(shortcutStep(1000, k('p', { metaKey: true }), 1100).action).toBeNull();
    expect(shortcutStep(null, k('g', { ctrlKey: true }), 1100).pendingG).toBeNull();
    expect(shortcutStep(1000, k('d', { altKey: true }), 1100).action).toBeNull();
  });

  it('is ignored while typing', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BODY' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('G38 service worker routing', () => {
  const O = 'https://hermes.example';
  const s = (url: string, method = 'GET', mode?: string) => swStrategy({ url, method, mode }, O);

  it('never touches cross-origin traffic (Electrum, relays, RPC, fonts, explorers)', () => {
    expect(s('https://fonts.googleapis.com/css2?family=Inter')).toBe('bypass');
    expect(s('https://fonts.gstatic.com/s/inter.woff2')).toBe('bypass');
    expect(s('wss://relay.damus.io/')).toBe('bypass');
    expect(s('wss://bch.imaginary.cash:50004')).toBe('bypass');
    expect(s('https://sepolia.base.org/')).toBe('bypass');
    expect(s('https://hermes.example.evil.com/assets/x.js')).toBe('bypass');
    expect(s('http://hermes.example/assets/x.js')).toBe('bypass'); // different origin (scheme)
    expect(s('not a url')).toBe('bypass');
  });

  it('never caches non-GET or the worker itself', () => {
    expect(s(`${O}/api`, 'POST')).toBe('bypass');
    expect(s(`${O}/sw.js`)).toBe('bypass');
  });

  it('routes the same-origin shell', () => {
    expect(s(`${O}/`, 'GET', 'navigate')).toBe('network-first');
    expect(s(`${O}/sub/index.html`, 'GET', 'navigate')).toBe('network-first');
    expect(s(`${O}/assets/index-abc123.js`)).toBe('cache-first');
    expect(s(`${O}/sub/path/assets/Swap-x.js`)).toBe('cache-first');
    expect(s(`${O}/hermes-logo.png`)).toBe('stale-while-revalidate');
    expect(s(`${O}/manifest.webmanifest`)).toBe('stale-while-revalidate');
  });

  it('manifest is relative (works under base ./) and the CSP allows a same-origin worker', () => {
    const m = JSON.parse(web('public/manifest.webmanifest')) as { start_url: string; scope: string; display: string; icons: { src: string; sizes: string }[] };
    expect(m.scope).toBe('./');
    expect(m.start_url.startsWith('./')).toBe(true);
    expect(m.display).toBe('standalone');
    for (const i of m.icons) expect(i.src).not.toMatch(/^\/|^https?:/);
    expect(m.icons.some((i) => i.sizes === '512x512')).toBe(true);
    expect(web('index.html')).toContain('<link rel="manifest" href="manifest.webmanifest" />');
    expect(web('public/_headers')).toMatch(/worker-src 'self'/);
    expect(web('public/_headers')).toMatch(/\/sw\.js\n\s+Cache-Control: no-cache/);
    expect(web('vite.config.ts')).toContain('hermesServiceWorker()');
    expect(web('src/main.tsx')).toMatch(/register\('sw\.js'/);
  });
});

describe('G39 toasts', () => {
  const t = (id: number, text = `t${id}`, kind: Toast['kind'] = 'info'): Toast => ({ id, text, kind, ttl: 1000 });

  it('keeps at most MAX_TOASTS, newest last, and de-duplicates', () => {
    let l: Toast[] = [];
    for (let i = 1; i <= MAX_TOASTS + 2; i++) l = pushToast(l, t(i));
    expect(l.map((x) => x.id)).toEqual([3, 4, 5, 6]);
    l = pushToast(l, t(9, 't4'));
    expect(l.map((x) => x.id)).toEqual([3, 5, 6, 9]);
    l = pushToast(l, t(10, 't5', 'err')); // same text, different kind → both kept
    expect(l.map((x) => x.id)).toEqual([5, 6, 9, 10]);
    expect(dropToast(l, 6).map((x) => x.id)).toEqual([5, 9, 10]);
  });

  it('errors linger longest', () => {
    expect(defaultTtl('err')).toBeGreaterThan(defaultTtl('warn'));
    expect(defaultTtl('warn')).toBeGreaterThan(defaultTtl('ok'));
  });

  it('the toast() function works before any <Toaster/> mounts', async () => {
    const { toast, useToast } = await import('../apps/web/src/components/Toast');
    const a = toast('one');
    const b = toast('two', 'err', { ttl: 0 });
    expect(b).toBeGreaterThan(a);
    expect(useToast()).toBe(toast);
  });
});

describe('G40 mainnet safety', () => {
  it('only switching onto mainnet needs confirmation', () => {
    expect(needsMainnetConfirm('chipnet', 'mainnet')).toBe(true);
    expect(needsMainnetConfirm('mainnet', 'mainnet')).toBe(false);
    expect(needsMainnetConfirm('mainnet', 'chipnet')).toBe(false);
    expect(needsMainnetConfirm('chipnet', 'chipnet')).toBe(false);
    expect(MAINNET_CONFIRM).toMatch(/real BCH/);
  });
});

describe('G41 accessibility', () => {
  it('Status is a polite live region; the shell has a skip link to #main-content', () => {
    expect(web('src/components/ui.tsx')).toMatch(/role="status" aria-live="polite"/);
    expect(web('src/App.tsx')).toContain('<main id="main-content" tabIndex={-1}>');
    expect(web('src/components/ShellExtras.tsx')).toContain('href="#main-content"');
    expect(web('src/styles.css')).toMatch(/\.skip-link:focus/);
    expect(web('src/styles.css')).toMatch(/button:focus-visible/);
  });
});
