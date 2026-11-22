import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import type { BchNetwork } from '@hermes/chain';
import {
  auditTrees,
  chainRootsByEpoch,
  claimCost,
  electrumHeights,
  entitlementHistory,
  leaderboard,
  proofDownload,
  proofPath,
  readPoolStatus,
  type AuditRow,
  type Deployment,
  type TreeFileLike,
} from '@hermes/drops';
import { encodeCashAddress } from '@bitauth/libauth';
import { useHermes } from '../lib/context';
import { Status, short } from './ui';

/** Round 3 Claims features G22–G27 (logic in packages/drops/src/insights.ts). */

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
/** P2PKH / P2SH locking bytecode → cashaddr (mainnet prefix, like the FoldingCash API). */
export function lockingToAddress(lb: string): string {
  if (/^76a914[0-9a-f]{40}88ac$/.test(lb)) return encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: hexBytes(lb.slice(6, 46)) }).address;
  if (/^a914[0-9a-f]{40}87$/.test(lb)) return encodeCashAddress({ prefix: 'bitcoincash', type: 'p2sh', payload: hexBytes(lb.slice(4, 44)) }).address;
  return `script ${short(lb, 8, 4)}`;
}
const shortAddr = (a: string) => (a.startsWith('bitcoincash:') ? `${a.slice(12, 20)}…${a.slice(-6)}` : a);

/** 21235670011663n → "21.24T" (base units, compact). */
export function compact(v: bigint): string {
  const units: [bigint, string][] = [
    [10n ** 12n, 'T'],
    [10n ** 9n, 'B'],
    [10n ** 6n, 'M'],
    [10n ** 3n, 'k'],
  ];
  for (const [d, s] of units) if (v >= d) return `${(Number((v * 100n) / d) / 100).toFixed(2)}${s}`;
  return v.toString();
}

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** G22: download the proof JSON for this address. */
export function ProofDownload({ trees, lockingBytecode }: { trees: TreeFileLike[]; lockingBytecode: string }) {
  const epochs = useMemo(() => trees.filter((t) => t.entries.some((e) => e.lockingBytecode === lockingBytecode)).map((t) => t.epoch).sort((a, b) => b - a), [trees, lockingBytecode]);
  const [epoch, setEpoch] = useState(epochs[0]);
  const [saved, setSaved] = useState<string>();
  if (!epochs.length) return null;
  const d = proofDownload(trees, lockingBytecode, epoch);
  return (
    <div className="row wrap c3-dl" data-testid="proof-download">
      <select value={epoch} onChange={(e) => setEpoch(Number(e.target.value))} aria-label="Proof epoch">
        {epochs.map((e) => (
          <option key={e} value={e}>
            epoch {e}
          </option>
        ))}
      </select>
      <button
        onClick={() => {
          if (!d) return;
          download(d.filename, d.json);
          setSaved(d.filename);
        }}
        disabled={!d}
      >
        Download proof JSON
      </button>
      {saved && <span className="muted small">saved {saved}</span>}
    </div>
  );
}

/** G23: cumulative entitlement per epoch (line) and per-epoch earnings (bars), inline SVG. */
export function HistoryChart({ trees, lockingBytecode }: { trees: TreeFileLike[]; lockingBytecode: string }) {
  const h = useMemo(() => entitlementHistory(trees, lockingBytecode), [trees, lockingBytecode]);
  if (!h.some((p) => p.member)) return null;
  const W = 520;
  const H = 200;
  const pad = { l: 56, r: 12, t: 26, b: 34 };
  const max = h.reduce((m, p) => (p.cumulative > m ? p.cumulative : m), 1n);
  const y = (v: bigint) => pad.t + (H - pad.t - pad.b) * (1 - Number((v * 10000n) / max) / 10000);
  const slot = (W - pad.l - pad.r) / h.length;
  const x = (i: number) => pad.l + slot * (i + 0.5);
  const bw = Math.min(46, slot * 0.5);
  const line = h.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(' ');
  const ticks = [0n, max / 2n, max];
  const label = (p: (typeof h)[number]) => (p.window ? new Date(p.window[0]).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : '');
  return (
    <figure className="c3-chart" data-testid="history-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Entitlement history per epoch">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="c3-grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="c3-axis">
              {compact(t)}
            </text>
          </g>
        ))}
        {h.map((p, i) => (
          <g key={p.epoch}>
            <rect x={x(i) - bw / 2} y={y(p.earned)} width={bw} height={Math.max(0, H - pad.b - y(p.earned))} className="c3-bar" rx={3}>
              <title>{`epoch ${p.epoch}: earned ${p.earned.toLocaleString('en-US')} this epoch`}</title>
            </rect>
            <text x={x(i)} y={H - pad.b + 16} textAnchor="middle" className="c3-axis">
              epoch {p.epoch}
            </text>
            <text x={x(i)} y={H - pad.b + 29} textAnchor="middle" className="c3-axis c3-faint">
              {label(p)}
            </text>
          </g>
        ))}
        <path d={line} className="c3-line" fill="none" />
        {h.map((p, i) => (
          <g key={`d${p.epoch}`}>
            <circle cx={x(i)} cy={y(p.cumulative)} r={4.5} className={p.member ? 'c3-dot' : 'c3-dot c3-dot-off'}>
              <title>{`epoch ${p.epoch}: cumulative ${p.cumulative.toLocaleString('en-US')}${p.member ? '' : ' (not a member)'}`}</title>
            </circle>
            <text x={x(i)} y={y(p.cumulative) - 9} textAnchor="middle" className="c3-val">
              {compact(p.cumulative)}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="small muted">
        <span className="c3-key c3-key-line" /> cumulative entitlement (what the covenant pays up to) · <span className="c3-key c3-key-bar" /> earned in that epoch ·
        base units
      </figcaption>
    </figure>
  );
}

/** G26: leaf → sibling at each level → root, exactly as DropsShard recomputes it. */
export function ProofPathView({ tree, lockingBytecode }: { tree: TreeFileLike; lockingBytecode: string }) {
  const p = useMemo(() => proofPath(tree, lockingBytecode), [tree, lockingBytecode]);
  if (!p) return null;
  return (
    <details className="c3-path" data-testid="proof-path">
      <summary>
        Proof path, epoch {tree.epoch}: leaf #{p.leafIndex} → {p.steps.length} sibling hashes → root {p.ok ? '✔' : '✘'}
      </summary>
      <ol className="c3-steps">
        <li className="c3-leaf">
          <span className="c3-tag">leaf</span>
          <code className="mono">{short(p.leaf, 12, 8)}</code>
          <span className="muted small">SHA256(lockingBytecode ‖ cumulative u64 LE ‖ accountId u32 LE)</span>
        </li>
        {p.steps.map((s) => (
          <li key={s.level}>
            <span className="c3-tag">level {s.level}</span>
            <div className="c3-pair">
              <code className={`mono ${s.isRight ? 'c3-sib' : 'c3-me'}`}>{short(s.isRight ? s.sibling : s.node, 8, 4)}</code>
              <span className="muted">‖</span>
              <code className={`mono ${s.isRight ? 'c3-me' : 'c3-sib'}`}>{short(s.isRight ? s.node : s.sibling, 8, 4)}</code>
            </div>
            <span className="small muted">
              path bit {s.isRight ? '1 (we are the right child)' : '0 (we are the left child)'}
              {s.siblingIsPadding ? ' · sibling is zero padding' : ''} → <code className="mono">{short(s.parent, 8, 4)}</code>
            </span>
          </li>
        ))}
        <li className={p.ok ? 'c3-root ok' : 'c3-root bad'}>
          <span className="c3-tag">root</span>
          <code className="mono">{short(p.root, 12, 8)}</code>
          <span className="small">{p.ok ? `= tree-${tree.epoch}.json root ✔` : `≠ published root ${short(tree.root, 8, 4)} ✘`}</span>
        </li>
      </ol>
      <p className="small muted">
        <span className="c3-me c3-swatch">our hash</span> <span className="c3-sib c3-swatch">sibling from the proof</span> · each line is SHA256(left ‖ right).
      </p>
    </details>
  );
}

/** G24: top cumulative earners of the latest tree. */
export function Leaderboard({ tree, n = 10 }: { tree: TreeFileLike; n?: number }) {
  const lb = useMemo(() => leaderboard(tree, n), [tree, n]);
  const top = lb.rows[0]?.cumulative ?? 1n;
  return (
    <div className="stack-sm" data-testid="leaderboard">
      <p className="small muted">
        Epoch {tree.epoch}, {lb.members} leaves, {compact(lb.total)} base units in total. Addresses are shortened.
      </p>
      <table className="table small c3-lb">
        <thead>
          <tr>
            <th>#</th>
            <th>Address</th>
            <th>Cumulative</th>
            <th className="c3-hide-sm">Share</th>
          </tr>
        </thead>
        <tbody>
          {lb.rows.map((r) => (
            <tr key={r.accountId}>
              <td>{r.rank}</td>
              <td>
                <code className="mono" title={lockingToAddress(r.lockingBytecode)}>
                  {shortAddr(lockingToAddress(r.lockingBytecode))}
                </code>{' '}
                <span className="muted">#{r.accountId}</span>
              </td>
              <td>
                <div className="c3-lbbar">
                  <span style={{ width: `${Math.max(2, Number((r.cumulative * 100n) / top))}%` }} />
                </div>
                {compact(r.cumulative)}
              </td>
              <td className="c3-hide-sm">{(r.shareBps / 100).toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** G25: recompute each tree's root in this browser; compare with the file and (when deployed) chipnet. */
export function RootAudit({ trees, deployment, network = 'chipnet' }: { trees: TreeFileLike[]; deployment?: Deployment; network?: BchNetwork }) {
  const { provider } = useHermes();
  const [rows, setRows] = useState<AuditRow[]>();
  const [ms, setMs] = useState<number>();
  const [chain, setChain] = useState<{ state: 'none' | 'loading' | 'ok' | 'err'; msg?: string }>({ state: deployment ? 'loading' : 'none' });

  async function run() {
    setRows(undefined);
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    const local = auditTrees(trees);
    setMs(performance.now() - t0);
    setRows(local);
    if (!deployment) return;
    setChain({ state: 'loading' });
    try {
      const p = provider(network);
      const pool = await readPoolStatus({ provider: p, config: deployment.config, trees, heights: electrumHeights(p) });
      setRows(auditTrees(trees, chainRootsByEpoch(pool)));
      setChain({ state: 'ok' });
    } catch (e) {
      setChain({ state: 'err', msg: (e as Error).message });
    }
  }
  useEffect(() => void run(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const allOk = rows?.every((r) => r.fileOk && r.shapeOk && r.chainOk !== false);
  return (
    <div className="stack-sm" data-testid="root-audit">
      <p className="small muted">
        Every leaf is rehashed and the tree rebuilt here with the same code the covenant mirrors, then the root is compared with the one written in{' '}
        <code>tree-N.json</code>
        {deployment ? ` and with the active / pending roots read from the ${network} pool.` : '. The chain column fills in once the pool is deployed on chipnet.'}
      </p>
      {rows && (
        <table className="table small c3-audit">
          <thead>
            <tr>
              <th>Epoch</th>
              <th>Recomputed root</th>
              <th>File</th>
              <th>Chain</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.epoch}>
                <td>
                  {r.epoch}
                  <div className="muted">
                    {r.leaves} leaves · d{r.depth}
                  </div>
                </td>
                <td>
                  <code className="mono">{short(r.recomputedRoot, 10, 6)}</code>
                </td>
                <td className={r.fileOk && r.shapeOk ? 'c3-ok' : 'c3-bad'}>{r.fileOk ? (r.shapeOk ? 'match ✔' : 'root ✔, size ✘') : `✘ file says ${short(r.storedRoot, 6, 4)}`}</td>
                <td className={r.chainOk === undefined ? 'muted' : r.chainOk ? 'c3-ok' : 'c3-bad'}>
                  {chain.state === 'none' ? 'not deployed' : chain.state === 'loading' ? 'reading…' : r.chainOk === undefined ? 'not on chain' : r.chainOk ? 'match ✔' : `✘ ${r.chainRoots.map((x) => short(x, 6, 4)).join(', ')}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && (
        <Status kind={allOk ? 'ok' : 'err'}>
          {allOk ? `All ${rows.length} published roots reproduce from their entries` : 'Mismatch: a published root does not reproduce'}
          {ms !== undefined ? ` (${rows.reduce((n, r) => n + r.leaves, 0)} leaves hashed in ${ms.toFixed(0)} ms)` : ''}.
        </Status>
      )}
      {chain.state === 'err' && <Status kind="warn">Could not read {network}: {chain.msg}</Status>}
      <div>
        <button onClick={() => void run()}>Re-run audit</button>
      </div>
    </div>
  );
}

/** G27: claims × tx size × fee rate, from the drops cost model's measured claim size. */
export function ClaimCostEstimator({ depth }: { depth: number }) {
  const [claims, setClaims] = useState(12);
  const [feeRate, setFeeRate] = useState(1);
  const [d, setD] = useState(depth);
  const [dust, setDust] = useState(1000);
  const c = claimCost({ claims, feeRate, depth: d, tokenDust: dust, firstClaims: 1 });
  const num = (set: (n: number) => void, min = 0) => (e: ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    set(Number.isFinite(n) ? Math.max(min, n) : min);
  };
  return (
    <div className="stack-sm" data-testid="cost-estimator">
      <div className="c3-form">
        <label>
          Claims
          <input type="number" min={0} max={10000} value={claims} onChange={num(setClaims)} />
        </label>
        <label>
          Fee rate (sat/B)
          <input type="number" min={0} step={0.1} value={feeRate} onChange={num(setFeeRate)} />
        </label>
        <label>
          Proof depth
          <input type="number" min={0} max={20} value={d} onChange={num((n) => setD(Math.min(20, Math.round(n))))} />
        </label>
        <label>
          Token dust (sats)
          <input type="number" min={0} step={100} value={dust} onChange={num(setDust)} />
        </label>
      </div>
      <div className="c3-cost">
        <div>
          <span className="muted small">per claim tx</span>
          <b>{c.bytesPerClaim.toLocaleString('en-US')} B</b>
          <span className="small">{c.feePerClaim.toLocaleString('en-US')} sats fee</span>
        </div>
        <div>
          <span className="muted small">first claim</span>
          <b>{c.firstClaimSats.toLocaleString('en-US')} sats</b>
          <span className="small">fee + receipt & payout dust</span>
        </div>
        <div>
          <span className="muted small">later claims</span>
          <b>{c.laterClaimSats.toLocaleString('en-US')} sats</b>
          <span className="small">old receipt dust recovered</span>
        </div>
        <div className="c3-total">
          <span className="muted small">
            {claims.toLocaleString('en-US')} claim{claims === 1 ? '' : 's'} total
          </span>
          <b data-testid="cost-total">{c.totalSats.toLocaleString('en-US')} sats</b>
          <span className="small">
            {c.totalBytes.toLocaleString('en-US')} B · {c.feeSats.toLocaleString('en-US')} fee + {c.dustSats.toLocaleString('en-US')} dust
          </span>
        </div>
      </div>
      <p className="small muted">
        Size from <code>DEFAULT_SIZES.claimBytes</code> in packages/drops/src/cost.ts (1,782 B measured at depth 9, rounded to 1,800) plus 32 B per extra
        proof level. The dust stays in the claimer’s own outputs. The claimer pays all of it, and only when they decide to claim.
      </p>
    </div>
  );
}
