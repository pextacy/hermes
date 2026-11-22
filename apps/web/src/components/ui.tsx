import { createContext, useContext, type ReactNode } from 'react';
import { explorerTxUrl, type BchNetwork } from '@hermes/chain';
import { toast } from './Toast';

/** Cards inside <More> render as closed, one-line rows; a card's own children never inherit it. */
const FoldCtx = createContext(false);

export function Card({ title, children, aside, fold, open }: { title?: ReactNode; children: ReactNode; aside?: ReactNode; fold?: boolean; open?: boolean }) {
  const folded = (useContext(FoldCtx) || fold) && !!title;
  if (folded)
    return (
      <details className="card fold" open={open}>
        <summary className="card-head">
          <h3>{title}</h3>
        </summary>
        <FoldCtx.Provider value={false}>
          <div className="fold-body">
            {aside && <div className="fold-aside">{aside}</div>}
            {children}
          </div>
        </FoldCtx.Provider>
      </details>
    );
  return (
    <section className="card">
      {(title || aside) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {aside}
        </header>
      )}
      <FoldCtx.Provider value={false}>{children}</FoldCtx.Provider>
    </section>
  );
}

/** Secondary tools of a tab: a quiet label, then each card as a closed row. */
export function More({ children, label = 'More' }: { children: ReactNode; label?: string }) {
  return (
    <div className="more">
      <h2 className="more-label">{label}</h2>
      <div className="more-list">
        <FoldCtx.Provider value={true}>{children}</FoldCtx.Provider>
      </div>
    </div>
  );
}

export function NetBadge({ network }: { network: BchNetwork | string }) {
  const n = String(network);
  const title = n === 'mainnet' ? 'Bitcoin Cash mainnet: real funds' : n === 'chipnet' ? 'Bitcoin Cash chipnet: test coins, no value' : n === 'testnet4' ? 'Bitcoin Cash testnet4: test coins, no value' : n;
  return (
    <span className={`net net-${n}`} title={title}>
      {n.toUpperCase()}
    </span>
  );
}

export function TxLink({ network, txid, label }: { network: BchNetwork; txid: string; label?: string }) {
  return (
    <a className="mono" href={explorerTxUrl(network, txid)} target="_blank" rel="noreferrer">
      {label ?? `${txid.slice(0, 10)}…${txid.slice(-6)}`}
    </a>
  );
}

/** G41: a live region, so screen readers announce results and errors as they appear. */
export function Status({ kind, children }: { kind: 'ok' | 'warn' | 'err' | 'info'; children: ReactNode }) {
  return (
    <div className={`status status-${kind}`} role="status" aria-live="polite">
      {children}
    </div>
  );
}

export const short = (s: string, a = 10, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

export function Copy({ text }: { text: string }) {
  return (
    <button
      className="link"
      title="Copy"
      aria-label="Copy to clipboard"
      onClick={() => {
        const p = navigator.clipboard?.writeText(text);
        if (!p) return void toast('Clipboard is not available in this browser', 'warn');
        p.then(
          () => toast('Copied to clipboard', 'ok'),
          () => toast('Could not copy — select the text and copy it manually', 'warn'),
        );
      }}
    >
      copy
    </button>
  );
}
