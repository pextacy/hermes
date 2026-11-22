import type { ReactNode } from 'react';

/** Page content blocks shared by the tabs: feature list, stat row, step list, on-chain links. */

export function Section({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </header>
      {children}
    </section>
  );
}

export function FeatureGrid({ items }: { items: { title: string; text: ReactNode }[] }) {
  return (
    <ul className="features">
      {items.map((f) => (
        <li key={f.title}>
          <b>{f.title}</b>
          <p>{f.text}</p>
        </li>
      ))}
    </ul>
  );
}

export function Stats({ items }: { items: { value: ReactNode; label: string }[] }) {
  return (
    <dl className="stats">
      {items.map((s) => (
        <div key={s.label}>
          <dd>{s.value}</dd>
          <dt>{s.label}</dt>
        </div>
      ))}
    </dl>
  );
}

export function Steps({ items }: { items: { title: string; text: ReactNode; tag?: string }[] }) {
  return (
    <ol className="steps-v">
      {items.map((s, i) => (
        <li key={s.title}>
          <span className="steps-n">{i + 1}</span>
          <div>
            <b>
              {s.title}
              {s.tag && <span className="steps-tag">{s.tag}</span>}
            </b>
            <p>{s.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function OnChain({ items }: { items: { label: string; network: string; value: string; href: string }[] }) {
  return (
    <ul className="onchain">
      {items.map((x) => (
        <li key={x.label + x.value}>
          <span className="onchain-label">{x.label}</span>
          <span className="onchain-net">{x.network}</span>
          <a className="mono" href={x.href} target="_blank" rel="noreferrer">
            {x.value.length > 24 ? `${x.value.slice(0, 14)}…${x.value.slice(-8)}` : x.value}
          </a>
        </li>
      ))}
    </ul>
  );
}
