import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { electrumProvider, type BchNetwork } from '@hermes/chain';
import { useHermes } from '../lib/context';
import { behind, overall, type Connectivity, type Probe } from '../lib/health';

/** A lazy tab chunk that 404s after a redeploy: only a full reload fixes it. */
const isChunkError = (e: Error) => /dynamically imported module|Importing a module script failed|Failed to fetch|ChunkLoadError/i.test(e.message);

/** F32: keeps one broken tab (or the whole shell) from blanking the app, with retry and reload. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string; scope?: string }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: undefined });
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkError(error);
    return (
      <div className="card error-card" role="alert">
        <h3>Something went wrong {this.props.scope ?? 'on this tab'}</h3>
        <p className="small">
          {chunk
            ? 'Part of the app failed to load — usually a new version was just deployed or the connection dropped. Reloading fixes it.'
            : 'Your keys and settings are stored in this browser and are not affected. Try again, or reload the page.'}
        </p>
        <p className="muted small mono">{error.message}</p>
        <div className="row wrap">
          {!chunk && (
            <button className="primary" onClick={() => this.setState({ error: undefined })}>
              Try again
            </button>
          )}
          <button className={chunk ? 'primary' : ''} onClick={() => location.reload()}>
            Reload page
          </button>
          <a className="button ghost" href="#pay" onClick={() => this.setState({ error: undefined })}>
            Go to Pay
          </a>
        </div>
      </div>
    );
  }
}

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export function probeRelay(url: string, timeoutMs = 6000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let ws: WebSocket | undefined;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(url);
    } catch {
      return finish(false);
    }
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
  });
}

/** Tip height from one Electrum server, or null when it does not answer in time. */
export async function probeElectrum(network: BchNetwork, server: string, timeoutMs = 8000): Promise<number | null> {
  const p = electrumProvider(network, server);
  try {
    return await withTimeout(p.getBlockHeight(), timeoutMs);
  } catch {
    return null;
  } finally {
    void p.disconnect?.().catch(() => undefined);
  }
}

/** Probes each relay and each Electrum server of `network`; results stream in as they arrive. */
export function useConnectivity(network: BchNetwork, relayList: string[], electrumList: string[], everyMs = 60_000): Connectivity {
  const [relays, setRelays] = useState<Probe<true>[]>([]);
  const [electrum, setElectrum] = useState<Probe<number>[]>([]);
  const [checkedAt, setCheckedAt] = useState<number>();
  const [tick, setTick] = useState(0);
  const key = `${network}|${relayList.join(',')}|${electrumList.join(',')}`;
  const run = useRef(0);
  const lastKey = useRef('');
  useEffect(() => {
    const id = ++run.current;
    const live = () => run.current === id;
    // New targets start as "checking"; a periodic recheck keeps the last result on screen until it is replaced.
    if (lastKey.current !== key) {
      lastKey.current = key;
      setRelays(relayList.map((target) => ({ target, state: 'checking' })));
      setElectrum(electrumList.map((target) => ({ target, state: 'checking' })));
    }
    const jobs = [
      ...relayList.map((r, i) =>
        probeRelay(r).then((ok) => live() && setRelays((xs) => xs.map((x, j) => (j === i ? { target: r, state: ok ? 'ok' : 'down', value: ok ? true : undefined } : x)))),
      ),
      ...electrumList.map((h, i) =>
        probeElectrum(network, h).then((height) =>
          live() && setElectrum((xs) => xs.map((x, j) => (j === i ? { target: h, state: height ? 'ok' : 'down', value: height ?? undefined } : x))),
        ),
      ),
    ];
    void Promise.all(jobs).then(() => live() && setCheckedAt(Date.now()));
    const t = everyMs ? setInterval(() => setTick((n) => n + 1), everyMs) : undefined;
    return () => {
      run.current++;
      if (t) clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, everyMs]);
  return { relays, electrum, checkedAt, recheck: useCallback(() => setTick((n) => n + 1), []) };
}

export function ProbeList({ c, network }: { c: Connectivity; network: BchNetwork }) {
  const late = behind(c.electrum);
  return (
    <div className="probes">
      {c.relays.length > 0 && <h4>Nostr relays</h4>}
      <ul>
        {c.relays.map((p) => (
          <li key={p.target}>
            <span className={`dot ${p.state === 'ok' ? 'ok' : p.state === 'down' ? 'bad' : ''}`} />
            <span className="mono">{p.target.replace(/^wss:\/\//, '')}</span>
            <span className="muted">{p.state === 'checking' ? 'checking…' : p.state === 'ok' ? 'connected' : 'unreachable'}</span>
          </li>
        ))}
      </ul>
      <h4>Electrum · {network}</h4>
      <ul>
        {c.electrum.map((p) => (
          <li key={p.target}>
            <span className={`dot ${p.state === 'ok' ? (late.has(p.target) ? 'warn' : 'ok') : p.state === 'down' ? 'bad' : ''}`} />
            <span className="mono">{p.target}</span>
            <span className="muted">
              {p.state === 'checking' ? 'checking…' : p.state === 'ok' ? `#${p.value}${late.has(p.target) ? ' (behind)' : ''}` : 'unreachable'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** F32: live connectivity for the network in view — per-relay and per-Electrum-server, from the user's Settings. */
export function HealthIndicator({ network }: { network: BchNetwork }) {
  const { settings } = useHermes();
  const c = useConnectivity(network, settings.relays, settings.electrum[network]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const state = overall(c);
  const up = c.relays.filter((p) => p.state === 'ok').length;
  const tip = Math.max(0, ...c.electrum.map((p) => p.value ?? 0));
  const eDone = c.electrum.every((p) => p.state !== 'checking');
  return (
    <div className="health" ref={box}>
      <button
        className="health-btn"
        aria-expanded={open}
        aria-label={`Connection status: ${state}`}
        title="Relay and Electrum status"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`dot ${state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : state === 'err' ? 'bad' : ''}`} />
        <span className="health-text">
          {up}/{c.relays.length} relays · {tip ? `#${tip}` : eDone ? 'no Electrum' : '…'}
        </span>
      </button>
      {open && (
        <div className="health-pop" role="dialog" aria-label="Connection status">
          <ProbeList c={c} network={network} />
          <div className="row wrap small">
            <button className="small" onClick={c.recheck}>
              Recheck
            </button>
            <a className="button ghost small" href="#settings" onClick={() => setOpen(false)}>
              Change servers
            </a>
            {c.checkedAt && <span className="muted">checked {new Date(c.checkedAt).toLocaleTimeString()}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
