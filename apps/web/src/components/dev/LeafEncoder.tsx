import { useState } from 'react';
import { encodeDropsLeaf } from '../../lib/devtools';
import { Card, Status } from '../ui';
import { Field } from './shared';

const SAMPLE = 'bchtest:qr52jg08h7272jeln68e9aec3wjhyvjm6vpg3lj4s8';

/** G35 — address + cumulative (+ account id) → Drops Merkle leaf bytes and hash (packages/drops/src/merkle.ts). */
export function LeafEncoder() {
  const [addr, setAddr] = useState('');
  const [cum, setCum] = useState('1000');
  const [id, setId] = useState('0');
  let out: ReturnType<typeof encodeDropsLeaf> | undefined;
  let err: string | undefined;
  if (addr.trim()) {
    try {
      out = encodeDropsLeaf(addr, cum, id);
    } catch (e) {
      err = (e as Error).message;
    }
  }
  return (
    <Card title="Drops leaf encoder">
      <p className="small muted">
        <code>leaf = SHA256(lockingBytecode ‖ cumulative (8 bytes LE) ‖ accountId (4 bytes LE))</code> — byte for byte what DropsShard.cash checks.
      </p>
      <input className="mono dev-full" aria-label="address" placeholder="cashaddr (bitcoincash:… / bchtest:…)" value={addr} onChange={(e) => setAddr(e.target.value)} />
      <div className="row wrap dev-mt">
        <label className="small">
          cumulative (base units) <input className="mono amount" aria-label="cumulative" value={cum} onChange={(e) => setCum(e.target.value)} />
        </label>
        <label className="small">
          account id <input className="mono amount" aria-label="account id" value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        {!addr && (
          <button className="link" onClick={() => setAddr(SAMPLE)}>
            use a sample address
          </button>
        )}
      </div>
      {err && <Status kind="err">{err}</Status>}
      {out && (
        <>
          <div className="dev-bytes mono" aria-label="leaf bytes by part">
            <span className="b-lb" title="locking bytecode">{out.lockingBytecode}</span>
            <span className="b-cum" title="cumulative, 8 bytes little-endian">{out.cumulativeLE}</span>
            <span className="b-id" title="account id, 4 bytes little-endian">{out.accountIdLE}</span>
          </div>
          <p className="small muted">
            <span className="b-lb">locking bytecode ({out.lockingBytecode.length / 2} B)</span> · <span className="b-cum">cumulative LE (8 B)</span> · <span className="b-id">account id LE (4 B)</span>
          </p>
          <Field label={`Leaf bytes (${out.leafBytes.length / 2} bytes)`} value={out.leafBytes} />
          <Field label="Leaf hash" value={out.leafHash} />
        </>
      )}
    </Card>
  );
}
