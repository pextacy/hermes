/**
 * Round 3 web shell (G36–G42): pure logic shared by App.tsx, the toast provider, the theme toggle and the
 * service worker. No DOM access here, so tests/round3-shell.test.ts can cover it in Node.
 */

// ---------- G42 deep links: `#tab?key=value&k2=v2` ----------

export interface HashRoute {
  tab: string;
  params: Record<string, string>;
}

/** `#claims?addr=bitcoincash:q…` → { tab: 'claims', params: { addr: 'bitcoincash:q…' } }. Unknown/empty → tab ''. */
export function parseHash(hash: string): HashRoute {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = h.indexOf('?');
  const tab = (q < 0 ? h : h.slice(0, q)).trim();
  const params: Record<string, string> = {};
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(h.slice(q + 1))) if (k) params[k] = v;
  }
  return { tab, params };
}

/** Inverse of parseHash; empty/undefined params are dropped, keys are sorted so links are stable. */
export function buildHash(tab: string, params: Record<string, string | undefined | null> = {}): string {
  const q = new URLSearchParams();
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') q.set(k, v);
  }
  const s = q.toString();
  return `#${tab}${s ? `?${s}` : ''}`;
}

/** Swap simulator directions a `#swap?sim=…` link may select. */
export const SIM_DIRECTIONS = { 'usdc-to-pusd': 'USDC → PUSD', 'pusd-to-usdc': 'PUSD → USDC' } as const;
export type SimDirection = keyof typeof SIM_DIRECTIONS;
export const isSimDirection = (v: unknown): v is SimDirection => typeof v === 'string' && Object.hasOwn(SIM_DIRECTIONS, v);

// ---------- G36 theme ----------

export const THEME_PREFS = ['system', 'light', 'dark'] as const;
export type ThemePref = (typeof THEME_PREFS)[number];
export const isThemePref = (v: unknown): v is ThemePref => typeof v === 'string' && (THEME_PREFS as readonly string[]).includes(v);
export const resolveTheme = (pref: ThemePref, systemDark: boolean): 'light' | 'dark' => (pref === 'system' ? (systemDark ? 'dark' : 'light') : pref);
/** Header button order: system → light → dark → system. */
export const nextTheme = (pref: ThemePref): ThemePref => THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length];

// ---------- G37 keyboard shortcuts ----------

/** `g` then one of these keys jumps to the tab. */
export const SHORTCUTS: Record<string, string> = { p: 'pay', i: 'identity', s: 'swap', c: 'claims', d: 'developers', t: 'settings' };
/** How long after `g` the second key still counts. */
export const CHORD_MS = 1500;

export type ShortcutAction = { go: string } | { help: true } | { close: true } | null;
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** Elements where letters are text, not shortcuts. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!el?.tagName) return false;
  const t = el.tagName.toUpperCase();
  if (t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable) return true;
  if (t !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes((el.type ?? 'text').toLowerCase());
}

/**
 * Feed one keydown; returns the new pending-`g` timestamp (null when none) and the action, if any.
 * Modifier chords (Ctrl/Cmd/Alt) never trigger anything, so browser shortcuts keep working.
 */
export function shortcutStep(pendingG: number | null, e: KeyLike, now: number): { pendingG: number | null; action: ShortcutAction } {
  if (e.ctrlKey || e.metaKey || e.altKey) return { pendingG: null, action: null };
  if (e.key === 'Escape') return { pendingG: null, action: { close: true } };
  if (e.key === '?') return { pendingG: null, action: { help: true } };
  const k = e.key.toLowerCase();
  if (pendingG !== null && now - pendingG <= CHORD_MS && SHORTCUTS[k]) return { pendingG: null, action: { go: SHORTCUTS[k] } };
  if (k === 'g') return { pendingG: now, action: null };
  return { pendingG: null, action: null };
}

// ---------- G39 toasts ----------

export type ToastKind = 'ok' | 'info' | 'warn' | 'err';
export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  /** ms before it disappears; 0 = stays until dismissed */
  ttl: number;
}
export const MAX_TOASTS = 4;
/** Newest last; identical text+kind replaces the old one; at most MAX_TOASTS (oldest dropped). */
export function pushToast(list: readonly Toast[], t: Toast, max = MAX_TOASTS): Toast[] {
  const rest = list.filter((x) => !(x.text === t.text && x.kind === t.kind));
  return [...rest, t].slice(-max);
}
export const dropToast = (list: readonly Toast[], id: number): Toast[] => list.filter((x) => x.id !== id);
/** Errors stay longer; warnings a bit longer than the rest. */
export const defaultTtl = (kind: ToastKind) => (kind === 'err' ? 8000 : kind === 'warn' ? 6000 : 3500);

// ---------- G40 mainnet safety ----------

/** Only a switch *onto* mainnet (from anything else) needs an explicit confirmation. */
export const needsMainnetConfirm = (from: string, to: string) => to === 'mainnet' && from !== 'mainnet';
export const MAINNET_CONFIRM =
  'Switch Pay to Bitcoin Cash MAINNET?\n\nPayments will move real BCH and real tokens. Each payment still asks for its own confirmation. Use chipnet to try Hermes with test coins.';

// G38 service-worker routing lives in ../sw/strategy.ts (kept out of the app graph so sw.js bundles standalone).
