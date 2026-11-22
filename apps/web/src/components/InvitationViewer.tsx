import { useState } from 'react';
import { describeInvitation, HERMES_TEMPLATES, listInvitationIssues, type InvitationView, type XoNetworkName } from '@hermes/xo/inspect';
import sampleInvitation from '../../../../packages/xo/examples/hermes-htlc-lock.invitation.json?raw';
import { Card, Status, short } from './ui';

type Result = { view: InvitationView; issues: string[] };

/** Decode and validate an XO invitation someone sent you, before you sign anything. */
export function InvitationViewer() {
  const [text, setText] = useState('');
  const [source, setSource] = useState<string>();
  const [network, setNetwork] = useState<XoNetworkName>('chipnet');
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function decode(raw: string, net = network) {
    setError(undefined);
    setResult(undefined);
    const data = raw.trim();
    if (!data) return;
    setBusy(true);
    try {
      const view = describeInvitation(data);
      let issues: string[];
      try {
        issues = await listInvitationIssues(data, net);
      } catch (e) {
        issues = [`Validation could not run: ${(e as Error).message.slice(0, 200)}`];
      }
      setResult({ view, issues });
    } catch (e) {
      setError(`Not a valid XO invitation: ${(e as Error).message.slice(0, 300)}`);
    } finally {
      setBusy(false);
    }
  }

  function load(data: string, from: string) {
    setText(data);
    setSource(from);
    void decode(data);
  }

  async function onFile(f?: File) {
    if (!f) return;
    if (f.size > 1_000_000) {
      setError('File too large for an invitation (> 1 MB).');
      return;
    }
    load(await f.text(), f.name);
  }

  const view = result?.view;
  const issues = result?.issues ?? [];
  const expired = view?.commits.some((c) => c.expired);
  return (
    <Card title="XO invitation viewer">
      <div className="invitation-viewer">
        <p className="muted small">
          Paste or open an invitation file (from <code>htlc create</code> / <code>join</code>, or any XO wallet). It is decoded and validated locally
          with the XO engine’s <code>listInvitationValidationIssues</code> — invitations are untrusted data; only sign ones for a template you pinned.
          Pinned Hermes templates:{' '}
          {HERMES_TEMPLATES.map((t) => (
            <span key={t.identifier}>
              {t.name} <code className="mono" title={t.identifier}>{short(t.identifier, 8, 4)}</code>{' '}
            </span>
          ))}
        </p>
        <textarea
          className="mono"
          rows={4}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSource(undefined);
          }}
          placeholder='{"invitationIdentifier":…}'
          aria-label="Serialized XO invitation"
        />
        <div className="row wrap">
          <button className="primary" onClick={() => void decode(text)} disabled={!text.trim() || busy}>
            {busy ? 'Checking…' : 'Decode & validate'}
          </button>
          <label className="button">
            Open file…{' '}
            <input type="file" style={{ display: 'none' }} accept=".json,.txt,application/json,text/plain" onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Invitation file" />
          </label>
          <button className="link" onClick={() => load(sampleInvitation, 'sample: HTLC lock joined by a counterparty (chipnet, never funded)')}>
            Load sample
          </button>
          <label className="small muted">
            Network{' '}
            <select
              value={network}
              onChange={(e) => {
                const n = e.target.value as XoNetworkName;
                setNetwork(n);
                if (result) void decode(text, n);
              }}
            >
              <option value="chipnet">chipnet</option>
              <option value="mainnet">mainnet</option>
            </select>
          </label>
        </div>
        {source && <p className="small muted">Loaded {source}</p>}
        {error && <Status kind="err">{error}</Status>}
        {view && (
          <>
            <Status kind={view.pinned && issues.length === 0 ? 'ok' : 'err'}>
              {view.pinned ? `Hermes template: ${view.templateName}` : 'Unknown template — do not sign'} · action <b>{view.action}</b> · invitation{' '}
              <code className="mono">{view.invitationIdentifier}</code> ·{' '}
              {issues.length === 0 ? `no validation issues on ${network}` : `${issues.length} validation issue${issues.length > 1 ? 's' : ''}`}
            </Status>
            {issues.length > 0 && (
              <ul className="checks single small">
                {issues.map((m, i) => (
                  <li key={i} className="bad">
                    {m}
                  </li>
                ))}
              </ul>
            )}
            {expired && <Status kind="warn">One or more commits have expired — the parties must re-commit before this can be signed.</Status>}
            <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Commit</th>
                  <th>Entity / role</th>
                  <th>Variables</th>
                  <th>In/Out</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {view.commits.map((c) => (
                  <tr key={c.commit}>
                    <td className="mono">{short(c.commit, 6, 4)}</td>
                    <td className="mono">
                      {c.entity}
                      {c.role && <div className="small">{c.role}</div>}
                    </td>
                    <td className="small">
                      {c.variables.length === 0 && <span className="muted">—</span>}
                      {c.variables.map((v) => (
                        <div key={v.id}>
                          {v.id}
                          {v.role ? ` (${v.role})` : ''}: <code className="mono" title={v.value}>{short(v.value, 14, 6)}</code>
                        </div>
                      ))}
                    </td>
                    <td>
                      {c.inputs}/{c.outputs}
                    </td>
                    <td className="small" style={c.expired ? { color: 'var(--err)' } : undefined}>{c.expires ? `${c.expired ? 'expired ' : ''}${new Date(c.expires).toLocaleString('en-US')}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
