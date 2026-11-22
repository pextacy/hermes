import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useWizardConnect } from '@wizardconnect/react';
import { Discovery } from '@hermes/id';
import { getProvider, HERMES, type BchNetwork } from '@hermes/chain';
import { Nip07Signer } from '@hermes/id';
import type { NostrMode } from './keys';
import { loadChoice, save } from './storage';
import { applyTheme, loadSettings, loadTheme, saveTheme, type Settings } from './settings';
import { MAINNET_CONFIRM, buildHash, needsMainnetConfirm, parseHash, type HashRoute, type ThemePref } from './shell';

type WC = ReturnType<typeof useWizardConnect>;

interface Ctx {
  payNetwork: BchNetwork;
  /**
   * G40: switch the network Pay sends on. Moving onto mainnet asks for confirmation (window.confirm);
   * returns false when the user declined. Persisted in this browser (hermes.payNetwork).
   */
  setPayNetwork: (n: BchNetwork) => boolean;
  demoNetwork: BchNetwork;
  discovery: Discovery;
  provider: (n: BchNetwork) => ReturnType<typeof getProvider>;
  wc: WC;
  nostrMode: NostrMode;
  setNostrMode: (m: NostrMode) => void;
  idNetwork: BchNetwork;
  setIdNetwork: (n: BchNetwork) => void;
  settings: Settings;
  /** G36: light / dark / system, persisted (hermes.theme). */
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
}

const C = createContext<Ctx | null>(null);
const NETS = ['mainnet', 'chipnet'] as const;

/** Injected for tests / embedding; defaults to the browser's confirm dialog. */
export let confirmMainnet: (message: string) => boolean = (m) => (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(m) : false);
export const setConfirmMainnet = (f: (message: string) => boolean) => void (confirmMainnet = f);

export function HermesProvider({ children }: { children: ReactNode }) {
  const wc = useWizardConnect({ dappName: 'Hermes', dappIcon: new URL('hermes-logo.png', location.href).href });
  const [nostrMode, setMode] = useState<NostrMode>(loadChoice<NostrMode>('hermes.nostrMode', ['nip07', 'local'], Nip07Signer.available() ? 'nip07' : 'local'));
  const [idNetwork, setNet] = useState<BchNetwork>(loadChoice<BchNetwork>('hermes.idNetwork', NETS, HERMES.web.payNetwork as BchNetwork));
  const [payNetwork, setPayNet] = useState<BchNetwork>(loadChoice<BchNetwork>('hermes.payNetwork', NETS, HERMES.web.payNetwork as BchNetwork));
  const [theme, setThemeState] = useState<ThemePref>(loadTheme);
  const settings = useMemo(() => loadSettings(), []);
  const discovery = useMemo(() => new Discovery({ relays: settings.relays }), [settings]);
  useEffect(() => applyTheme(theme), [theme]);
  const value: Ctx = {
    payNetwork,
    setPayNetwork: (n) => {
      if (n === payNetwork) return true;
      if (needsMainnetConfirm(payNetwork, n) && !confirmMainnet(MAINNET_CONFIRM)) return false;
      setPayNet(n);
      save('hermes.payNetwork', n);
      return true;
    },
    demoNetwork: HERMES.web.demoNetwork as BchNetwork,
    discovery,
    provider: (n) => getProvider(n),
    wc,
    nostrMode,
    setNostrMode: (m) => {
      setMode(m);
      save('hermes.nostrMode', m);
    },
    idNetwork,
    setIdNetwork: (n) => {
      setNet(n);
      save('hermes.idNetwork', n);
    },
    settings,
    theme,
    setTheme: (t) => {
      setThemeState(t);
      saveTheme(t);
    },
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useHermes() {
  const c = useContext(C);
  if (!c) throw new Error('HermesProvider missing');
  return c;
}

/*
 * G42 — deep links that restore state.
 *
 * The URL hash is `#<tab>?<key>=<value>&…` (URLSearchParams encoding). App.tsx picks the tab; any tab can read
 * and write its own params with `useHashParams()`:
 *
 *   const { params, setParams } = useHashParams();
 *   const [addr, setAddr] = useState(params.addr ?? '');           // restore on open
 *   useEffect(() => setParams({ addr: addr || undefined }), [addr]); // keep the link shareable (replaceState)
 *
 * Param names (keep this list in sync with the tabs that read them):
 *   #swap?sim=usdc-to-pusd | pusd-to-usdc   simulator direction — applied by App.tsx (selects + scrolls to the
 *                                           "Try it now" simulator; Swap files are untouched)
 *   #claims?addr=<bitcoincash:… address>    the address whose claim status to show — read by Claims.tsx
 *   #developers?tool=<tool id>              which Developers tool to open/scroll to — read by Developers.tsx
 *
 * Unknown params are kept and ignored. setParams(patch) merges; a value of undefined/'' removes that key.
 */
export interface HashParams extends HashRoute {
  /** Merge into the current tab's params. Default replaces the history entry (no back-button spam). */
  setParams: (patch: Record<string, string | undefined>, opts?: { push?: boolean }) => void;
}

const H = createContext<HashParams | null>(null);

function writeHash(next: string, push: boolean) {
  if (push) location.hash = next;
  else history.replaceState(history.state, '', next);
}

export function HashParamsProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<HashRoute>(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const setParams = useCallback<HashParams['setParams']>((patch, opts) => {
    const cur = parseHash(location.hash);
    const next = buildHash(cur.tab || 'pay', { ...cur.params, ...patch });
    if (next === buildHash(cur.tab || 'pay', cur.params) && cur.tab) return;
    writeHash(next, !!opts?.push);
    setRoute(parseHash(next));
  }, []);
  const value = useMemo(() => ({ ...route, setParams }), [route, setParams]);
  return <H.Provider value={value}>{children}</H.Provider>;
}

/** G42: the current `#tab?params`; works (read-only snapshot + hash writes) even outside the provider. */
export function useHashParams(): HashParams {
  const h = useContext(H);
  if (h) return h;
  const r = parseHash(typeof location === 'undefined' ? '' : location.hash);
  return {
    ...r,
    setParams: (patch, opts) => writeHash(buildHash(r.tab || 'pay', { ...r.params, ...patch }), !!opts?.push),
  };
}
