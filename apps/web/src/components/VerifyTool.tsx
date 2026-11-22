import { useRef, useState } from 'react';
import type { Event } from 'nostr-tools/pure';
import {
  PROOF_BUNDLE_FORMAT,
  addressOwners,
  bindingVerdict,
  makeProofBundle,
  npubOf,
  parseRecipient,
  parseVerifyInput,
  verifyChain,
  verifyProofBundle,
  type AddressOwner,
  type BindingVerdict,
  type BundleVerdict,
  type IdentityWarning,
} from '@hermes/id';
import { downloadText } from './IdentityTools';
import { useHermes } from '../lib/context';
import { Card, Status, short } from './ui';
import { tamperedCopy } from '../lib/identity-ui';

interface Result {
  verdict: BindingVerdict;
  source: string;
  warnings: IdentityWarning[];
  rotations?: number;
  /** G11: reverse lookup — every identity that ever named the pasted address */
  owners?: { address: string; list: AddressOwner[] };
  event?: Event;
}

/**
 * F5 — verify any binding: an npub / name / address (fetched from relays) or a pasted raw event.
 * Signature and chain checks run in the browser; relays are only asked whether a newer version exists.
 */
export function VerifyTool({ mine }: { mine?: Event } = {}) {
  const { discovery } = useHermes();
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [bundle, setBundle] = useState<BundleVerdict & { file: string }>();
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    const text = await file.text();
    setBundle(undefined);
    setResult(undefined);
    setError(undefined);
    let j: unknown;
    try {
      j = JSON.parse(text);
    } catch {
      j = undefined;
    }
    if ((j as { format?: string })?.format === PROOF_BUNDLE_FORMAT) {
      setBundle({ ...verifyProofBundle(j), file: file.name });
      return;
    }
    setInput(text.trim());
    void run(text);
  }

  async function run(text = input) {
    setResult(undefined);
    setError(undefined);
    setBundle(undefined);
    const parsed = parseVerifyInput(text);
    if (parsed.kind === 'invalid') return setError(parsed.reason);
    try {
      if (parsed.kind === 'event') {
        const offline = bindingVerdict(parsed.event);
        setResult({ verdict: offline, source: 'pasted event — checked in your browser', warnings: [] });
        if (!offline.ok || !offline.summary) return;
        // Signatures are fine; is it still the identity's current version?
        setBusy('Signatures valid — asking relays whether a newer version exists…');
        const chain = verifyChain(parsed.event).chain;
        const r = await discovery.resolve(offline.summary.nostr);
        const sameLineage = r.identity && r.identity.genesisHash === chain[0].payloadHash;
        const verdict = bindingVerdict(parsed.event, { currentSeq: sameLineage ? r.identity!.current.seq : undefined });
        setResult({
          verdict,
          source: sameLineage
            ? `pasted event · relays (${r.answered}) hold v${r.identity!.current.seq}`
            : `pasted event · relays (${r.answered}) know no newer version${r.answered === 0 ? ' (no relay answered — freshness unknown)' : ''}`,
          warnings: sameLineage ? r.identity!.warnings : [],
          rotations: chain.length - 1,
          event: parsed.event,
        });
      } else if (parseRecipient(parsed.query).kind === 'bch') {
        // G11 reverse lookup: which Hermes identities claim this address, now or in the past?
        const address = parsed.query.trim();
        setBusy(`Reverse lookup of ${short(address, 18, 6)} on ${discovery.relays.length} relays…`);
        const found = await discovery.byAddress(address);
        if (found.answered === 0) throw new Error('No relay answered');
        const list = addressOwners(await discovery.followSuccessors(found.events), address);
        if (!list.length) {
          setResult({
            verdict: { ok: false, status: 'invalid', headline: 'No Hermes identity claims this address', reasons: ['Nobody has bound this address to a Nostr identity on these relays. Check who you are paying out of band.'], steps: [], versions: 0 },
            source: `reverse lookup on ${found.answered}/${discovery.relays.length} relays`,
            warnings: [],
            owners: { address, list },
          });
          return;
        }
        const top = list[0].identity;
        setResult({
          verdict: bindingVerdict(top.current.event, { currentSeq: top.current.seq }),
          source: `reverse lookup on ${found.answered}/${discovery.relays.length} relays · current binding of the owner`,
          warnings: top.warnings,
          rotations: top.chain.length - 1,
          owners: { address, list },
          event: top.current.event,
        });
      } else {
        setBusy(`Looking up ${short(parsed.query, 16, 8)} on ${discovery.relays.length} relays…`);
        const r = await discovery.resolve(parsed.query);
        if (!r.identity) throw new Error(r.error ?? 'not found');
        const ev = r.identity.current.event;
        setResult({
          verdict: bindingVerdict(ev, { currentSeq: r.identity.current.seq }),
          source: `current binding from ${r.answered}/${discovery.relays.length} relays`,
          warnings: r.identity.warnings,
          rotations: r.identity.chain.length - 1,
          event: ev,
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const v = result?.verdict;
  const kind = !v ? 'info' : v.status === 'valid' ? 'ok' : v.status === 'stale' ? 'warn' : 'err';
  const fill = (t: string) => {
    setInput(t);
    void run(t);
  };

  return (
    <Card title="Verify any binding">
      <p className="muted small">
        Paste an npub, hex key, name@domain or cashaddr — or a raw binding event (JSON). Both signatures, the derived addresses and the whole rotation chain are checked in your
        browser; relays are only asked whether a newer version exists.
      </p>
      <textarea className="mono" rows={3} value={input} onChange={(e) => setInput(e.target.value)} placeholder="npub1… or {&quot;kind&quot;:30078,…}" />
      <div className="row wrap">
        <button className="primary" onClick={() => void run()} disabled={!input.trim() || !!busy}>
          {busy ? 'Checking…' : 'Verify'}
        </button>
        {mine && (
          <>
            <button className="link" onClick={() => fill(JSON.stringify(mine))} disabled={!!busy}>
              try my binding event
            </button>
            <button className="link" onClick={() => fill(JSON.stringify(tamperedCopy(mine)))} disabled={!!busy}>
              try a tampered copy
            </button>
          </>
        )}
        <button className="link" onClick={() => fileRef.current?.click()} disabled={!!busy}>
          upload a proof bundle / event file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="proof bundle file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
        {(input || result || error || bundle) && (
          <button
            className="link"
            onClick={() => {
              setInput('');
              setResult(undefined);
              setError(undefined);
              setBundle(undefined);
            }}
          >
            clear
          </button>
        )}
      </div>
      {busy && <Status kind="info">{busy}</Status>}
      {error && <Status kind="err">Could not verify: {error}</Status>}
      {bundle && <BundleResult b={bundle} />}
      {result?.owners && <OwnersList address={result.owners.address} list={result.owners.list} />}
      {v && (
        <>
          <Status kind={kind}>
            <b>{v.headline}</b>
            {v.reasons.length > 0 && (
              <ul className="log">
                {v.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </Status>
          {v.summary && (
            <div className="small">
              <div className="kv">
                <span>Nostr</span>
                <code className="mono">{/^[0-9a-f]{64}$/.test(v.summary.nostr) ? short(npubOf(v.summary.nostr), 16, 8) : short(v.summary.nostr)}</code>
              </div>
              <div className="kv">
                <span>BCH address</span>
                <code className="mono">{v.summary.addr || '—'}</code>
              </div>
              <div className="kv">
                <span>Version</span>
                <span>
                  v{v.summary.seq}
                  {result?.rotations !== undefined ? ` · ${result.rotations} rotation(s)` : ''} · {v.summary.network ?? 'unknown network'}
                  {v.summary.ts > 0 ? ` · signed ${new Date(v.summary.ts * 1000).toLocaleString()}` : ''}
                  {v.summary.idCategory ? ` · identity NFT ${short(v.summary.idCategory, 8, 4)}` : ''}
                </span>
              </div>
              <div className="kv">
                <span>Source</span>
                <span>{result?.source}</span>
              </div>
              {result?.event && v.ok && (
                <div className="kv">
                  <span>Portable proof</span>
                  <button
                    className="link"
                    onClick={() => downloadText(`hermes-proof-v${v.summary!.seq}.json`, JSON.stringify(makeProofBundle(result.event!), null, 2))}
                  >
                    download proof bundle
                  </button>
                </div>
              )}
            </div>
          )}
          {result!.warnings.map((w) => (
            <Status key={w.message} kind="warn">
              {w.message}
            </Status>
          ))}
          {v.steps.length > 0 && (
            <details open={v.status !== 'valid'}>
              <summary>
                All checks ({v.steps.filter((s) => s.ok).length}/{v.steps.length} passed)
              </summary>
              <ul className="checks single">
                {v.steps.map((s, i) => (
                  <li key={`${i}-${s.label}`} className={s.ok ? 'ok' : 'bad'}>
                    {s.label}
                    {s.detail && <small className="mono"> — {s.detail}</small>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Card>
  );
}

/** G11 — who owns the address, and is it still their current one? */
function OwnersList({ address, list }: { address: string; list: AddressOwner[] }) {
  if (!list.length) return null;
  return (
    <div className="r3-owners">
      <div className="small muted">Reverse lookup · {short(address, 18, 6)}</div>
      {list.map((o) => {
        const cur = o.identity.current;
        return (
          <Status key={o.genesisHash} kind={o.isCurrent ? 'ok' : 'warn'}>
            {o.isCurrent ? (
              <>
                <b>Owned by {short(npubOf(cur.nostr), 16, 8)}</b> — the address is in their current binding v{cur.seq}
                {o.seqs.length > 1 || o.seqs[0] !== cur.seq ? ` (named in v${o.seqs.join(', v')})` : ''}. Safe to pay.
              </>
            ) : (
              <>
                <b>Old address of {short(npubOf(cur.nostr), 16, 8)}</b> — named in v{o.seqs.join(', v')}, but their current binding v{cur.seq} pays to{' '}
                <code className="mono">{short(cur.addr, 18, 6)}</code>. Do not pay the old address; pay the identity instead.
              </>
            )}
          </Status>
        );
      })}
      {list.length > 1 && <Status kind="warn">More than one identity lineage names this address — confirm the recipient out of band.</Status>}
    </div>
  );
}

/** G12 — offline verdict of an uploaded proof bundle. */
function BundleResult({ b }: { b: BundleVerdict & { file: string } }) {
  const cur = b.chain[b.chain.length - 1];
  return (
    <Status kind={b.ok ? 'ok' : 'err'}>
      <b>
        {b.ok
          ? `Proof bundle valid — v${cur.seq}, ${b.chain.length} version(s) verified offline back to v0`
          : 'Proof bundle invalid'}
      </b>{' '}
      <span className="small">({b.file})</span>
      {b.reasons.length > 0 && (
        <ul className="log">
          {b.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {cur && (
        <ol className="log small">
          {b.chain.map((c) => (
            <li key={c.payloadHash} className={c.valid ? 'ok' : 'err'}>
              v{c.seq} · {new Date(c.ts * 1000).toLocaleString()} · {short(npubOf(c.nostr), 12, 6)} · <code className="mono">{short(c.addr, 18, 6)}</code> {c.valid ? '✔' : '✘'}
            </li>
          ))}
        </ol>
      )}
      {b.ok && b.bundle && (
        <div className="small">
          Bundle made {new Date(b.bundle.createdAt * 1000).toLocaleString()} — signatures prove the binding existed then; only relays can tell whether a newer version exists since.
        </div>
      )}
    </Status>
  );
}
