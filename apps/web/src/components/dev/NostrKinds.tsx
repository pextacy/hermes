import { useMemo, useState } from 'react';
import { nostrKinds } from '../../lib/devtools';
import { Card } from '../ui';

/** G34 — every Nostr kind and tag Hermes uses, generated from the package constants/templates. */
export function NostrKinds() {
  const rows = useMemo(() => nostrKinds(), []);
  const [open, setOpen] = useState<number>();
  return (
    <Card title="Nostr event kinds & tags">
      <p className="small muted">Generated at runtime from the constants and template functions in packages/id, packages/swap and packages/pay — change a constant and this table follows.</p>
      <div className="table-scroll">
        <table className="table dev-kinds">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Purpose</th>
              <th>Tags</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.kind}>
                <td className="mono">
                  <b>{r.kind}</b>
                </td>
                <td>
                  <b>{r.name}</b>
                  <div className="small muted">
                    {r.module} · {r.storage}
                  </div>
                  <div className="small muted mono">{r.source}</div>
                </td>
                <td>
                  <ul className="dev-tags">
                    {r.tags.map((t) => (
                      <li key={t.tag}>
                        <code>{t.tag}</code> <span className="small muted">{t.meaning}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td>
                  <button className="link" aria-expanded={open === r.kind} onClick={() => setOpen(open === r.kind ? undefined : r.kind)}>
                    {open === r.kind ? 'hide' : 'show'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open !== undefined && (
        <pre className="mono pre" aria-label={`example kind ${open}`}>
          {JSON.stringify(rows.find((r) => r.kind === open)!.example, null, 2)}
        </pre>
      )}
    </Card>
  );
}
