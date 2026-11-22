import { useMemo, useState } from 'react';
import { LocalBchSigner, LocalNostrSigner, createBinding } from '@hermes/id';
import { explorePayload } from '../../lib/devtools';
import { Card, Status } from '../ui';
import { Field } from './shared';

/** G32 — binding payload → canonical JSON, payload hash and the exact message each key signs. */
export function PayloadExplorer() {
  const [text, setText] = useState('');
  const result = useMemo(() => {
    if (!text.trim()) return undefined;
    try {
      return { ok: explorePayload(text) } as const;
    } catch (e) {
      return { err: (e as Error).message } as const;
    }
  }, [text]);

  async function sample(full: boolean) {
    const { event, content } = await createBinding({ bch: new LocalBchSigner(), nostr: new LocalNostrSigner(), network: 'chipnet' });
    // Pretty-printed with keys out of order on purpose: canonical JSON sorts them back.
    const p = content.payload;
    const shuffled = { ts: p.ts, seq: p.seq, nostr: p.nostr, domain: p.domain, v: p.v, bch: p.bch, addr: p.addr, tokenAddr: p.tokenAddr, prev: p.prev };
    setText(JSON.stringify(full ? event : shuffled, null, 2));
  }

  const r = result && 'ok' in result ? result.ok : undefined;
  return (
    <Card title="Canonical payload explorer">
      <p className="small muted">Paste a binding payload, binding content (<code>{'{payload, bchProof}'}</code>) or a whole binding event. Keys are sorted, whitespace removed, UTF-8 — every party gets the same bytes.</p>
      <div className="row wrap">
        <button className="small" onClick={() => sample(false)}>
          Sample payload
        </button>
        <button className="small" onClick={() => sample(true)}>
          Sample signed event (throwaway keys)
        </button>
      </div>
      <textarea className="mono dev-mt" rows={8} aria-label="binding payload JSON" aria-invalid={result && 'err' in result ? true : undefined} placeholder='{"domain":"hermes-id","v":1,"seq":0,…}' value={text} onChange={(e) => setText(e.target.value)} />
      {result && 'err' in result && <Status kind="err">{result.err}</Status>}
      {r && (
        <div aria-live="polite">
          <p className="small">
            Read as: <span className="pill">{r.input}</span> · seq {String(r.payload.seq)}
          </p>
          {r.warnings.map((w) => (
            <Status key={w} kind="warn">
              {w}
            </Status>
          ))}
          <Field label="Canonical JSON (payloadMessage)" value={r.canonical} />
          <Field label="Payload hash = SHA-256(canonical) — next version's prev, lineage tag" value={r.payloadHash} />
          {r.signed.map((s) => (
            <details key={s.key} className="dev-signed" open>
              <summary>
                <b>{s.key}</b> <span className="small muted">— {s.scheme}</span>
              </summary>
              <Field label="Message" value={s.message} />
              <Field label="Digest signed" value={s.digest} />
              <p className={`small ${s.note.includes('✗') ? 'dev-bad' : 'muted'}`}>{s.note}</p>
            </details>
          ))}
        </div>
      )}
    </Card>
  );
}
