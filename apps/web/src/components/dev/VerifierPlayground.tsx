import { useState } from 'react';
import * as nip19 from 'nostr-tools/nip19';
import { LocalBchSigner, LocalNostrSigner, createBinding, respondToChallenge, type Challenge } from '@hermes/id';
import { curlOf, runVerifierRequest, verifierRequest, type VerifierOp, type VerifierRequest, type VerifierResult } from '../../lib/devtools';
import { getLocalBchKey, getLocalNsec } from '../../lib/keys';
import { load, save } from '../../lib/storage';
import { useHermes } from '../../lib/context';
import { Card, Status } from '../ui';
import { CopyButton } from './shared';

const OPS: { op: VerifierOp; label: string; route: string }[] = [
  { op: 'info', label: 'Info', route: 'GET /' },
  { op: 'resolve', label: 'Resolve', route: 'GET /resolve?q=' },
  { op: 'verify', label: 'Verify event', route: 'POST /verify' },
  { op: 'challenge', label: 'Issue challenge', route: 'POST /challenge' },
  { op: 'challenge-verify', label: 'Verify challenge', route: 'POST /challenge/verify' },
];
const URL_KEY = 'hermes.dev.verifierUrl';
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** G29 — call a Hermes verifier (apps/verifier) from the browser and show request + response. */
export function VerifierPlayground() {
  const { idNetwork } = useHermes();
  const [base, setBase] = useState(() => load<string>(URL_KEY, 'http://localhost:8787'));
  const [op, setOp] = useState<VerifierOp>('info');
  const [q, setQ] = useState('');
  const [eventText, setEventText] = useState('');
  const [offline, setOffline] = useState(false);
  const [challenge, setChallenge] = useState<Challenge>();
  const [responseText, setResponseText] = useState('');
  const [lastEvent, setLastEvent] = useState<unknown>();
  const [req, setReq] = useState<VerifierRequest>();
  const [res, setRes] = useState<VerifierResult>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [signedWith, setSignedWith] = useState<string>();

  async function send() {
    setErr(undefined);
    setRes(undefined);
    let r: VerifierRequest;
    try {
      r = verifierRequest(base, op, { q, event: eventText, offline, response: responseText });
    } catch (e) {
      setReq(undefined);
      return setErr((e as Error).message);
    }
    save(URL_KEY, base.trim());
    setReq(r);
    setBusy(true);
    const out = await runVerifierRequest(r);
    setBusy(false);
    setRes(out);
    const b = out.body as Record<string, unknown> | undefined;
    if (out.ok && op === 'resolve' && b?.event) setLastEvent(b.event);
    if (out.ok && op === 'challenge' && b?.nonce) setChallenge(b as unknown as Challenge);
  }

  async function sampleEvent() {
    const { event } = await createBinding({ bch: new LocalBchSigner(), nostr: new LocalNostrSigner(), network: 'chipnet' });
    setEventText(pretty(event));
    setOffline(true);
  }

  async function signChallenge() {
    if (!challenge) return;
    const nsec = getLocalNsec();
    const bchKey = getLocalBchKey(idNetwork);
    const own = Boolean(nsec && bchKey);
    const nostr = new LocalNostrSigner(own ? (nip19.decode(nsec!).data as Uint8Array) : undefined);
    const bch = new LocalBchSigner(own ? bchKey : undefined);
    const response = await respondToChallenge(challenge, bch, nostr);
    setSignedWith(own ? `this browser's Identity keys (${idNetwork})` : 'throwaway keys — no Identity keys in this browser, so expect "not the current binding"');
    setResponseText(pretty(response));
  }

  const route = OPS.find((o) => o.op === op)!;
  return (
    <Card title="Verifier API playground">
      <p className="small muted">
        Talks to a running <code>apps/verifier</code> (<code>pnpm --filter verifier start</code>, port 8787). It answers with CORS <code>*</code>, so any page can call it — but an https page cannot reach an http:// verifier.
      </p>
      <label className="small" htmlFor="dev-verifier-url">
        Verifier URL
      </label>
      <input id="dev-verifier-url" className="mono dev-full" value={base} onChange={(e) => setBase(e.target.value)} spellCheck={false} />
      <div className="seg dev-mt" role="tablist" aria-label="endpoint">
        {OPS.map((o) => (
          <button key={o.op} role="tab" aria-selected={o.op === op} className={o.op === op ? 'on' : ''} onClick={() => setOp(o.op)}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="small mono muted">{route.route}</p>

      {op === 'resolve' && <input className="mono dev-full" aria-label="query" placeholder="npub1… · name@domain · bitcoincash:…" value={q} onChange={(e) => setQ(e.target.value)} />}
      {op === 'verify' && (
        <>
          <div className="row wrap">
            <button className="small" onClick={sampleEvent}>
              Sample event (throwaway keys)
            </button>
            {lastEvent !== undefined && (
              <button className="small" onClick={() => setEventText(pretty(lastEvent))}>
                Use event from last resolve
              </button>
            )}
            <label className="small row">
              <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} /> offline (skip the relay freshness check)
            </label>
          </div>
          <textarea className="mono dev-mt" rows={6} aria-label="binding event JSON" placeholder='{"id":"…","kind":30078,…}' value={eventText} onChange={(e) => setEventText(e.target.value)} />
        </>
      )}
      {op === 'challenge-verify' && (
        <>
          {challenge ? (
            <div className="row wrap">
              <span className="small">
                Challenge <code>{challenge.nonce.slice(0, 12)}…</code> for <code>{challenge.audience}</code>
              </span>
              <button className="small" onClick={signChallenge}>
                Sign response
              </button>
            </div>
          ) : (
            <p className="small muted">Issue a challenge first (the tab before); then sign it here.</p>
          )}
          {signedWith && <p className="small muted">Signed with {signedWith}.</p>}
          <textarea className="mono dev-mt" rows={6} aria-label="challenge response JSON" placeholder='{"challenge":{…},"bch":"…","bchProof":{…},"nostrEvent":{…}}' value={responseText} onChange={(e) => setResponseText(e.target.value)} />
        </>
      )}
      <div className="row dev-mt">
        <button className="primary" disabled={busy} onClick={send}>
          {busy ? 'Sending…' : 'Send request'}
        </button>
      </div>
      {err && <Status kind="err">{err}</Status>}
      {req && (
        <div className="dev-io">
          <div>
            <div className="dev-field-head">
              <span>Request</span>
              <CopyButton text={curlOf(req)} label="Copy as curl" />
            </div>
            <pre className="mono pre">{`${req.method} ${req.url}${req.body ? `\ncontent-type: application/json\n\n${req.body}` : ''}`}</pre>
          </div>
          <div aria-live="polite">
            <div className="dev-field-head">
              <span>Response</span>
              {res && (
                <span className={`pill ${res.ok ? 'pill-ok' : 'pill-warn'}`}>
                  {res.status ?? 'no response'} · {res.ms} ms
                </span>
              )}
            </div>
            {busy && <pre className="mono pre">…</pre>}
            {res?.error && <Status kind="err">{res.error}</Status>}
            {res && (res.body !== undefined || res.text) && <pre className="mono pre">{res.body !== undefined ? pretty(res.body) : res.text}</pre>}
          </div>
        </div>
      )}
    </Card>
  );
}
