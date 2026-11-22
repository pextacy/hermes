import { useState } from 'react';
import { checkPreimage, hashlockOf, newSecret } from '../../lib/devtools';
import { Card, Status } from '../ui';
import { Field } from './shared';

/** G33 — generate a swap secret, compute its SHA-256 hashlock, check a preimage against a hashlock. */
export function HashlockTool() {
  const [secret, setSecret] = useState('');
  const [pre, setPre] = useState('');
  const [lock, setLock] = useState('');
  let hash: string | undefined;
  let err: string | undefined;
  try {
    if (secret.trim()) hash = hashlockOf(secret);
  } catch (e) {
    err = (e as Error).message;
  }
  const check = pre.trim() && lock.trim() ? checkPreimage(pre, lock) : undefined;
  return (
    <Card title="Hashlock tool">
      <p className="small muted">Both HTLCs check <code>sha256(secret) == hashlock</code> over the 32 secret <i>bytes</i>. Runs locally; nothing is sent anywhere.</p>
      <div className="row wrap">
        <button onClick={() => setSecret(newSecret())}>Generate secret</button>
        <input className="mono dev-grow" aria-label="secret (hex)" placeholder="or paste a secret (hex)" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </div>
      {err && <Status kind="err">{err}</Status>}
      {hash && (
        <>
          <Field label="Hashlock = SHA-256(secret)" value={hash} />
          <button
            className="link"
            onClick={() => {
              setPre(secret.trim());
              setLock(hash!);
            }}
          >
            check this pair below
          </button>
        </>
      )}
      <h4 className="dev-sub">Check a preimage</h4>
      <div className="dev-grid2">
        <input className="mono" aria-label="preimage (hex)" placeholder="preimage (hex, from a claim tx)" value={pre} onChange={(e) => setPre(e.target.value)} />
        <input className="mono" aria-label="hashlock (hex)" placeholder="hashlock (32-byte hex)" value={lock} onChange={(e) => setLock(e.target.value)} />
      </div>
      {check && (
        <div aria-live="polite">
          {check.ok ? <Status kind="ok">Match ✓ — this preimage opens the hashlock.</Status> : <Status kind={check.computed ? 'warn' : 'err'}>No match: {check.reason}</Status>}
          {check.computed && !check.ok && <Field label="SHA-256(preimage)" value={check.computed} />}
        </div>
      )}
    </Card>
  );
}
