import { useEffect, useMemo, useState } from 'react';
import {
  BINDING_D_TAG,
  BINDING_KIND,
  badgeEmbed,
  badgeSvg,
  bindingDiff,
  humanDuration,
  makeProofBundle,
  npubOf,
  relayAudit,
  rotationTimeline,
  svgDataUri,
  type BadgeInput,
  type Discovery,
  type RelayAudit,
  type ResolvedIdentity,
} from '@hermes/id';
import { Card, Copy, Status, short } from './ui';
import { Qr } from './Qr';

/** Save a text file from the browser. */
export function downloadText(name: string, text: string, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const when = (ts: number) => new Date(ts * 1000).toLocaleString();
const LANE = ['#1f7a4d', '#2f5fb3', '#9a6400', '#8a3ea8', '#b42318', '#0f7c86'];

/**
 * Round 3 identity tools for the user's own binding: G8 badge, G9 relay audit, G10 timeline,
 * G12 proof bundle download, G13 npub QR + event JSON, G14 diff between versions.
 */
export function IdentityTools({ identity, discovery, onRepublished }: { identity: ResolvedIdentity; discovery: Discovery; onRepublished?: () => void }) {
  const [audit, setAudit] = useState<RelayAudit>();
  const [auditBusy, setAuditBusy] = useState<string>();
  const [auditMsg, setAuditMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string }>();
  const cur = identity.current;
  const npub = npubOf(cur.nostr);

  async function runAudit() {
    setAuditBusy(`Asking ${discovery.relays.length} relays one by one…`);
    try {
      const authors = [...new Set(identity.chain.map((b) => b.nostr))];
      const perRelay = await Promise.all(
        discovery.relays.map(async (relay) => {
          try {
            const r = await discovery.query({ kinds: [BINDING_KIND], '#d': [BINDING_D_TAG], authors }, [relay]);
            return { relay, answered: r.answered > 0, events: r.events };
          } catch {
            return { relay, answered: false, events: [] };
          }
        }),
      );
      setAudit(relayAudit(cur, identity.genesisHash, perRelay));
    } finally {
      setAuditBusy(undefined);
    }
  }

  async function republish() {
    if (!audit?.needRepublish.length) return;
    setAuditMsg(undefined);
    setAuditBusy(`Republishing v${cur.seq} to ${audit.needRepublish.length} relay(s)…`);
    try {
      const r = await discovery.publish(cur.event, audit.needRepublish);
      const ok = r.filter((x) => x.ok).length;
      setAuditMsg({ kind: ok === r.length ? 'ok' : 'err', text: `Republished the latest event (v${cur.seq}) to ${ok}/${r.length} stale relay(s).` });
      await new Promise((res) => setTimeout(res, 600));
      await runAudit();
      onRepublished?.();
    } catch (e) {
      setAuditMsg({ kind: 'err', text: (e as Error).message });
      setAuditBusy(undefined);
    }
  }

  useEffect(() => {
    setAudit(undefined);
    setAuditMsg(undefined);
    void runAudit();
  }, [cur.event.id]);

  const badge: BadgeInput = { nostr: cur.nostr, addr: cur.addr, seq: cur.seq, network: cur.network, ts: cur.ts };
  const svg = badgeSvg(badge);
  const embed = badgeEmbed(badge, location.origin + location.pathname.replace(/\/[^/]*$/, ''));

  function downloadBundle() {
    const bundle = makeProofBundle(cur.event, { relays: audit?.rows.map((r) => ({ relay: r.relay, status: r.status, seq: r.seq })) });
    downloadText(`hermes-proof-${npub.slice(0, 16)}-v${cur.seq}.json`, JSON.stringify(bundle, null, 2));
  }

  return (
    <>
      <Card title="Share and export" aside={<span className="pill pill-ok">v{cur.seq}</span>}>
        <div className="r3-share">
          <div className="r3-qr">
            <Qr value={npub} size={160} />
            <small className="muted">Scan: your npub</small>
          </div>
          <div className="grow stack-sm">
            <div>
              <div className="small muted">“Verified on Hermes” badge (G8)</div>
              <img className="r3-badge" alt="Verified on Hermes badge" src={svgDataUri(svg)} />
            </div>
            <div className="row wrap">
              <button onClick={() => downloadText(`hermes-badge-v${cur.seq}.svg`, svg, 'image/svg+xml')}>Download badge SVG</button>
              <button onClick={() => downloadText(`hermes-binding-v${cur.seq}.json`, JSON.stringify(cur.event, null, 2))}>Download binding event JSON</button>
              <button className="primary" onClick={downloadBundle}>
                Download proof bundle
              </button>
            </div>
            <label className="small muted">
              Embed snippet (HTML, links to your Hermes pay page) <Copy text={embed} />
            </label>
            <textarea className="mono r3-embed" rows={3} readOnly value={embed} onFocus={(e) => e.currentTarget.select()} />
            <p className="muted small">
              npub <code className="mono">{short(npub, 16, 8)}</code> <Copy text={npub} />. The proof bundle holds the current event with every earlier version embedded — anyone can check it offline
              (“Verify any binding” → upload). The badge is a picture; the bundle and the relays are the proof.
            </p>
          </div>
        </div>
      </Card>

      <Card
        title="Relay consistency audit"
        aside={audit && <span className={`pill ${audit.consistent ? 'pill-ok' : 'pill-warn'}`}>{audit.consistent ? 'all current' : `${audit.needRepublish.length} stale`}</span>}
      >
        <p className="muted small">Each relay is asked on its own which version of your identity it holds. A stale relay would still send payers to an old version.</p>
        {audit && (
          <table className="r3-audit">
            <thead>
              <tr>
                <th>Relay</th>
                <th>Holds</th>
                <th>Event</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {audit.rows.map((r) => (
                <tr key={r.relay} className={`r3-${r.status}`}>
                  <td className="mono">{r.relay.replace(/^wss?:\/\//, '')}</td>
                  <td>{r.seq !== undefined ? `v${r.seq}` : '—'}</td>
                  <td className="mono">{r.eventId ? short(r.eventId, 8, 4) : '—'}</td>
                  <td>
                    <span className={`pill ${r.status === 'current' ? 'pill-ok' : 'pill-warn'}`}>
                      {r.status === 'current' ? 'current ✔' : r.status === 'stale' ? `stale (latest v${audit.latestSeq})` : r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row wrap">
          <button onClick={() => void runAudit()} disabled={!!auditBusy}>
            Re-check relays
          </button>
          <button className="primary" onClick={() => void republish()} disabled={!!auditBusy || !audit?.needRepublish.length}>
            Republish v{cur.seq} to stale relays{audit?.needRepublish.length ? ` (${audit.needRepublish.length})` : ''}
          </button>
        </div>
        {auditBusy && <Status kind="info">{auditBusy}</Status>}
        {auditMsg && <Status kind={auditMsg.kind}>{auditMsg.text}</Status>}
      </Card>

      <Card title="Rotation timeline">
        <RotationTimeline identity={identity} />
        {identity.chain.length > 1 && <BindingDiffView identity={identity} />}
      </Card>
    </>
  );
}

/** G10 — two lanes (Nostr key, BCH key), one column per version; a colour per distinct key, ⟳ where a key changed. */
export function RotationTimeline({ identity }: { identity: ResolvedIdentity }) {
  const items = rotationTimeline(identity.chain);
  const col = 210;
  const w = Math.max(360, items.length * col + 40);
  const yN = 44;
  const yB = 96;
  const x = (i: number) => 40 + i * col + col / 2 - 40;
  return (
    <div className="r3-timeline">
      <svg width={w} height={186} viewBox={`0 0 ${w} 186`} role="img" aria-label={`Rotation timeline, ${items.length} version(s)`}>
        <text x={4} y={yN - 14} className="r3-lane">
          Nostr key
        </text>
        <text x={4} y={yB - 14} className="r3-lane">
          BCH key
        </text>
        {items.map((it, i) => {
          const next = items[i + 1];
          return (
            <g key={it.seq}>
              {next && (
                <>
                  <line x1={x(i)} y1={yN} x2={x(i + 1)} y2={yN} stroke={LANE[it.nostrKey % LANE.length]} strokeWidth={4} strokeDasharray={next.nostrChanged ? '4 5' : undefined} />
                  <line x1={x(i)} y1={yB} x2={x(i + 1)} y2={yB} stroke={LANE[it.bchKey % LANE.length]} strokeWidth={4} strokeDasharray={next.bchChanged ? '4 5' : undefined} />
                  <text x={(x(i) + x(i + 1)) / 2} y={(yN + yB) / 2 + 4} textAnchor="middle" className="r3-dt">
                    +{humanDuration(next.sincePrev ?? 0)}
                  </text>
                </>
              )}
              <circle cx={x(i)} cy={yN} r={it.nostrChanged ? 10 : 7} fill={LANE[it.nostrKey % LANE.length]} stroke={it.nostrChanged ? 'var(--text)' : 'none'} strokeWidth={2} />
              <circle cx={x(i)} cy={yB} r={it.bchChanged ? 10 : 7} fill={LANE[it.bchKey % LANE.length]} stroke={it.bchChanged ? 'var(--text)' : 'none'} strokeWidth={2} />
              {it.nostrChanged && (
                <text x={x(i) + 14} y={yN + 4} className="r3-mark">
                  ⟳
                </text>
              )}
              {it.bchChanged && (
                <text x={x(i) + 14} y={yB + 4} className="r3-mark">
                  ⟳
                </text>
              )}
              <text x={x(i)} y={130} textAnchor="middle" className="r3-v">
                v{it.seq}
                {it.seq === identity.current.seq ? ' (current)' : ''}
              </text>
              <text x={x(i)} y={148} textAnchor="middle" className="r3-l">
                {it.label}
              </text>
              <text x={x(i)} y={164} textAnchor="middle" className="r3-d">
                {new Date(it.ts * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
              </text>
              <text x={x(i)} y={180} textAnchor="middle" className="r3-d mono">
                {short(npubOf(it.nostr), 8, 4)} · {short(it.addr.replace(/^(bitcoincash|bchtest):/, ''), 4, 4)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** G14 — compare two versions field by field. */
export function BindingDiffView({ identity }: { identity: ResolvedIdentity }) {
  const chain = identity.chain;
  const [a, setA] = useState(chain.length - 2);
  const [b, setB] = useState(chain.length - 1);
  useEffect(() => {
    setA(Math.max(0, chain.length - 2));
    setB(chain.length - 1);
  }, [chain.length]);
  const ia = Math.min(a, chain.length - 1);
  const ib = Math.min(b, chain.length - 1);
  const rows = useMemo(() => bindingDiff(chain[ia], chain[ib]), [chain, ia, ib]);
  const changed = rows.filter((r) => r.changed).length;
  return (
    <details className="r3-diff" open>
      <summary>
        Compare two versions ({changed} field{changed === 1 ? '' : 's'} differ)
      </summary>
      <div className="row wrap">
        <label className="small">
          From{' '}
          <select value={ia} onChange={(e) => setA(Number(e.target.value))} aria-label="diff from">
            {chain.map((v, i) => (
              <option key={v.payloadHash} value={i}>
                v{v.seq} · {when(v.ts)}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          to{' '}
          <select value={ib} onChange={(e) => setB(Number(e.target.value))} aria-label="diff to">
            {chain.map((v, i) => (
              <option key={v.payloadHash} value={i}>
                v{v.seq} · {when(v.ts)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <table className="r3-difftable">
        <thead>
          <tr>
            <th>Field</th>
            <th>v{chain[ia].seq}</th>
            <th>v{chain[ib].seq}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.field} className={r.changed ? 'r3-changed' : ''}>
              <td>
                {r.changed ? '≠ ' : ''}
                {r.field}
              </td>
              <td className="mono">{r.a}</td>
              <td className="mono">{r.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
