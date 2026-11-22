import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Banner } from './components/Banner';
import { WalletButton } from './components/Wallet';
import { NetBadge } from './components/ui';
import { HashParamsProvider, HermesProvider, useHashParams, useHermes } from './lib/context';
import { SIM_DIRECTIONS, isSimDirection, isTypingTarget, shortcutStep } from './lib/shell';
import { ShortcutHelp, SkipLink, ThemeToggle } from './components/ShellExtras';
import { Toaster, toast } from './components/Toast';
import { Pay } from './tabs/Pay';
import { Identity } from './tabs/Identity';
import { SettingsTab } from './tabs/Settings';
import { ErrorBoundary, HealthIndicator } from './components/Health';


// Heavy, less-visited tabs load on demand (viem + EVM HTLC, drops covenant, contract sources).
const Swap = lazy(() => import('./tabs/Swap').then((m) => ({ default: m.Swap })));
const Claims = lazy(() => import('./tabs/Claims').then((m) => ({ default: m.Claims })));
const Developers = lazy(() => import('./tabs/Developers').then((m) => ({ default: m.Developers })));

const TABS = [
  { id: 'pay', label: 'Pay', el: Pay },
  { id: 'identity', label: 'Identity', el: Identity },
  { id: 'swap', label: 'Swap', el: Swap },
  { id: 'claims', label: 'Claims', el: Claims },
  { id: 'developers', label: 'Developers', el: Developers },
  { id: 'settings', label: 'Settings', el: SettingsTab },
] as const;
type TabId = (typeof TABS)[number]['id'];

const toTab = (t: string): TabId => (TABS.find((x) => x.id === t)?.id ?? 'pay') as TabId;

/**
 * G42 `#swap?sim=usdc-to-pusd|pusd-to-usdc`: select that direction in the in-browser simulator and scroll to it.
 * Done from the shell (Swap files are owned elsewhere) by clicking the simulator's own Direction button once
 * the lazy Swap tab has rendered it.
 */
function useSwapSimDeepLink(tab: TabId, sim: string | undefined) {
  useEffect(() => {
    if (tab !== 'swap' || !isSimDirection(sim)) return;
    const label = SIM_DIRECTIONS[sim];
    let tries = 0;
    const id = setInterval(() => {
      const card = [...document.querySelectorAll<HTMLElement>('section.card')].find((c) => /Try it now/.test(c.querySelector('h3')?.textContent ?? ''));
      const btn = card && [...card.querySelectorAll<HTMLButtonElement>('[aria-label="Direction"] button')].find((b) => b.textContent?.trim() === label);
      if (btn || ++tries > 60) clearInterval(id);
      if (btn && card) {
        if (!btn.classList.contains('on')) btn.click();
        card.scrollIntoView({ block: 'start' });
        // Content above may still be loading (quotes, balances): settle the scroll once more.
        setTimeout(() => card.scrollIntoView({ block: 'start' }), 700);
      }
    }, 250);
    return () => clearInterval(id);
  }, [tab, sim]);
}

/** G37: `g p` / `g i` / `g s` / `g c` / `g d` / `g t` jump to a tab, `?` opens the help; ignored while typing. */
function useShortcuts(onHelp: (open: boolean) => void) {
  const pending = useRef<number | null>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || isTypingTarget(e.target as HTMLElement)) return;
      const { pendingG, action } = shortcutStep(pending.current, e, Date.now());
      pending.current = pendingG;
      if (!action) return;
      if ('go' in action) {
        e.preventDefault();
        location.hash = `#${action.go}`;
      } else if ('help' in action) {
        e.preventDefault();
        onHelp(true);
      } else onHelp(false);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onHelp]);
}

function Shell() {
  const route = useHashParams();
  const tab = toTab(route.tab);
  const { payNetwork, setPayNetwork, idNetwork, demoNetwork, theme, setTheme } = useHermes();
  const [help, setHelp] = useState(false);
  useShortcuts(setHelp);
  useSwapSimDeepLink(tab, route.params.sim);
  // Move focus to the page content after a tab change so keyboard and screen-reader users land on it.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) return void (firstRender.current = false);
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [tab]);
  // On phones the nav scrolls sideways: keep the active tab in view (e.g. a #settings deep link).
  useEffect(() => {
    const nav = document.querySelector<HTMLElement>('header.top nav');
    const on = nav?.querySelector<HTMLElement>('a.on');
    if (nav && on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft += on.getBoundingClientRect().left - nav.getBoundingClientRect().left - (nav.clientWidth - on.offsetWidth) / 2;
  }, [tab]);
  const Current = TABS.find((t) => t.id === tab)!.el;
  // The network the current tab acts on; Developers/Settings show the demo network the in-browser demos use.
  const network = tab === 'pay' ? payNetwork : tab === 'identity' ? idNetwork : demoNetwork;
  return (
    <>
      <SkipLink />
      <Banner />
      <header className="top">
        <div className="top-in">
          <a className="brand" href="#pay">
            <img src="hermes.svg" alt="" width={22} height={22} />
            <span>Hermes</span>
          </a>
          <nav aria-label="Sections">
            {TABS.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={t.id === tab ? 'on' : ''} aria-current={t.id === tab ? 'page' : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
          <div className="right">
            <HealthIndicator network={network} />
            <ThemeToggle theme={theme} onChange={setTheme} />
            <WalletButton />
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1}>
        <ErrorBoundary resetKey={tab}>
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Current />
          </Suspense>
        </ErrorBoundary>
      </main>
      <footer>
        <span>Hermes never holds your funds.</span>
        <button className="link small" onClick={() => setHelp(true)}>
          Keyboard shortcuts
        </button>
      </footer>
      <ShortcutHelp open={help} onClose={() => setHelp(false)} />
      <Toaster />
    </>
  );
}

export function App() {
  return (
    <ErrorBoundary scope="while starting Hermes">
      <HermesProvider>
        <HashParamsProvider>
          <Shell />
        </HashParamsProvider>
      </HermesProvider>
    </ErrorBoundary>
  );
}
