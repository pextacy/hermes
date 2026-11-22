import { HERMES, NETWORKS, bchConfig, setElectrumServers, type BchNetwork } from '@hermes/chain';
import { load, remove, save } from './storage';
import { isThemePref, type ThemePref } from './shell';

export interface Settings {
  relays: string[];
  electrum: Record<BchNetwork, string[]>;
}

const KEY = 'hermes.settings';
const NETS = ['mainnet', 'chipnet', 'testnet4'] as const;
/** Discovery needs this many relays (config/hermes.json → id.minRelays). */
export const MIN_RELAYS: number = HERMES.id.minRelays ?? 3;

export const defaultSettings = (): Settings => ({
  relays: [...NETWORKS.nostr.relays],
  electrum: { mainnet: [...bchConfig('mainnet').electrum], chipnet: [...bchConfig('chipnet').electrum], testnet4: [...bchConfig('testnet4').electrum] },
});

/** wss:// anywhere, or plain ws:// only to this machine (a `pnpm dev:relay` relay). */
export const isRelayUrl = (r: unknown): r is string =>
  typeof r === 'string' && (/^wss:\/\/[^\s/?#]+[^\s]*$/.test(r) || /^ws:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/?$/.test(r));
/** A Fulcrum hostname, optionally `:port` (WSS; default 50004). No scheme, no path. */
export const isElectrumHost = (h: unknown): h is string =>
  typeof h === 'string' && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(h) && !(h.includes(':') && Number(h.split(':')[1]) > 65535);

/** One entry per line (or whitespace/comma separated), trimmed, de-duplicated. */
export const parseList = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

export type SettingsErrors = Partial<Record<'relays' | BchNetwork, string>>;

/** Field-level problems; an empty object means the settings are usable. */
export function validateSettings(s: unknown): SettingsErrors {
  const e: SettingsErrors = {};
  const v = s as Partial<Settings> | null;
  if (!v || typeof v !== 'object') return { relays: 'Settings are missing' };
  if (!Array.isArray(v.relays) || v.relays.length === 0) e.relays = 'Add at least one relay';
  else {
    const bad = v.relays.filter((r) => !isRelayUrl(r));
    if (bad.length) e.relays = `Not a relay URL: ${bad.map(String).join(', ')} — use wss://… (ws:// only for localhost)`;
    else if (v.relays.length < MIN_RELAYS) e.relays = `Use at least ${MIN_RELAYS} relays: discovery cross-checks bindings across relays`;
  }
  for (const n of NETS) {
    const list = v.electrum?.[n];
    if (!Array.isArray(list) || list.length === 0) e[n] = `Add at least one ${n} Electrum server`;
    else {
      const bad = list.filter((h) => !isElectrumHost(h));
      if (bad.length) e[n] = `Not a hostname: ${bad.map(String).join(', ')} — use host or host:port, no wss:// or path`;
    }
  }
  return e;
}

const valid = (s: unknown): s is Settings => Object.keys(validateSettings(s)).length === 0;

/** Stored settings when valid, else the defaults; also points @hermes/chain at the chosen Electrum servers. */
export function loadSettings(): Settings {
  let s = load<unknown>(KEY, null);
  // Settings saved before testnet4 existed: keep them and fill testnet4 with the default servers.
  const st = s as { electrum?: Record<string, unknown> } | null;
  if (st && typeof st === 'object' && st.electrum && typeof st.electrum === 'object' && st.electrum.testnet4 === undefined)
    s = { ...st, electrum: { ...st.electrum, testnet4: defaultSettings().electrum.testnet4 } };
  const out = valid(s) ? { relays: s.relays, electrum: { mainnet: s.electrum.mainnet, chipnet: s.electrum.chipnet, testnet4: s.electrum.testnet4 } } : defaultSettings();
  for (const n of NETS) setElectrumServers(n, out.electrum[n]);
  return out;
}

export function saveSettings(s: Settings) {
  const e = validateSettings(s);
  if (Object.keys(e).length) throw new Error(`Relays must be wss:// URLs (ws://localhost for a dev relay) and Electrum servers plain hostnames: ${Object.values(e).join('; ')}`);
  save(KEY, { relays: s.relays, electrum: { mainnet: s.electrum.mainnet, chipnet: s.electrum.chipnet, testnet4: s.electrum.testnet4 } });
}

/** Forget custom settings: the next load uses config/networks.json again. */
export function resetSettings(): Settings {
  remove(KEY);
  return loadSettings();
}

/** True when the stored settings differ from the shipped defaults. */
export const isCustom = (s: Settings) => JSON.stringify(s) !== JSON.stringify(defaultSettings());

// ---- G36 theme preference (stored per browser; theme-init.js reads the same key before first paint) ----
export const THEME_KEY = 'hermes.theme';
export const loadTheme = (): ThemePref => {
  const v = load<unknown>(THEME_KEY, 'system');
  return isThemePref(v) ? v : 'system';
};
export const saveTheme = (t: ThemePref) => (t === 'system' ? remove(THEME_KEY) : save(THEME_KEY, t));
/** Sets/clears <html data-theme>; "system" clears it so the prefers-color-scheme rules apply. */
export function applyTheme(t: ThemePref, root: { setAttribute(k: string, v: string): void; removeAttribute(k: string): void } = document.documentElement) {
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}
