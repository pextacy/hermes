import { countdown, feeBreakdown, timeoutLadder } from '@hermes/swap';

/** Shared Swap visuals (Round 3): timeout ladder (G21), fee breakdown (G19), file download (G18/G20). */

const W = 360;
const X0 = 14;
const X1 = W - 14;
const AXIS = 44;

const rel = (t: number, now: number) => (t >= now ? `in ${countdown(t - now)}` : `${countdown(now - t)} ago`);
const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Timeout ladder: where "now" sits relative to the solver's deadline T₂, the safety margin after it,
 * and the taker's deadline T₁. Claim before T₂; refund only after T₁; the margin is the solver's
 * time to use a secret revealed at the last moment.
 */
export function TimeoutLadder({
  now,
  tFirst,
  tSecond,
  margin,
  start,
  extra,
  caption,
}: {
  now: number;
  tFirst: number;
  tSecond: number;
  margin: number;
  start?: number;
  /** An extra marker, e.g. the timeout a malicious solver actually used. */
  extra?: { t: number; label: string };
  caption?: string;
}) {
  const l = timeoutLadder({ now, tFirst, tSecond, margin, start: Math.min(start ?? now, extra?.t ?? now) });
  const x = (p: number) => X0 + Math.max(0, Math.min(1, p)) * (X1 - X0);
  const px = (t: number) => x((t - l.start) / (l.end - l.start));
  const xs = { now: x(l.now), t2: x(l.t2), t1: x(l.t1), m: x(l.marginEnd) };
  const label = `Timeout ladder: now; T₂ (solver's lock expires) ${rel(tSecond, now)}; safety margin ${countdown(margin)}; T₁ (taker's lock refundable) ${rel(tFirst, now)}.${l.orderingOk ? '' : ' Ordering violated: T₁ is less than T₂ plus the margin.'}`;
  return (
    <figure className="ladder">
      <svg viewBox={`0 0 ${W} 92`} role="img" aria-label={label}>
        {/* phases */}
        <rect className="ladder-claim" x={X0} y={AXIS - 5} width={Math.max(0, xs.t2 - X0)} height={10} rx={3} />
        <rect className="ladder-wait" x={xs.t2} y={AXIS - 5} width={Math.max(0, xs.t1 - xs.t2)} height={10} />
        <rect className="ladder-refund" x={xs.t1} y={AXIS - 5} width={Math.max(0, X1 - xs.t1)} height={10} rx={3} />
        {/* safety margin band */}
        <rect className={l.orderingOk ? 'ladder-margin' : 'ladder-margin bad'} x={xs.t2} y={AXIS - 11} width={Math.max(1, xs.m - xs.t2)} height={22} rx={3} />
        <text className="ladder-small" x={(xs.t2 + xs.m) / 2} y={AXIS + 24} textAnchor="middle">
          margin {countdown(margin)}
          {l.orderingOk ? '' : ' ✗'}
        </text>
        {/* T₂ and T₁ */}
        <line className="ladder-tick" x1={xs.t2} x2={xs.t2} y1={AXIS - 16} y2={AXIS + 11} />
        <text className="ladder-label" x={xs.t2} y={AXIS - 28} textAnchor="middle">
          T₂ {hhmm(tSecond)}
        </text>
        <text className="ladder-small" x={xs.t2} y={AXIS - 18} textAnchor="middle">
          solver’s lock expires
        </text>
        <line className="ladder-tick" x1={xs.t1} x2={xs.t1} y1={AXIS - 16} y2={AXIS + 11} />
        <text className="ladder-label" x={Math.min(xs.t1, X1 - 30)} y={AXIS - 28} textAnchor="middle">
          T₁ {hhmm(tFirst)}
        </text>
        <text className="ladder-small" x={Math.min(xs.t1, X1 - 36)} y={AXIS - 18} textAnchor="middle">
          taker can refund
        </text>
        {extra && (
          <g className="ladder-extra">
            <line x1={px(extra.t)} x2={px(extra.t)} y1={AXIS - 11} y2={AXIS + 34} />
            <text x={Math.max(X0 + 30, px(extra.t))} y={AXIS + 44} textAnchor="middle">
              {extra.label}
            </text>
          </g>
        )}
        {/* now */}
        <g className="ladder-now">
          <line x1={xs.now} x2={xs.now} y1={AXIS - 13} y2={AXIS + 13} />
          <path d={`M ${xs.now - 5} ${AXIS + 20} L ${xs.now + 5} ${AXIS + 20} L ${xs.now} ${AXIS + 13} Z`} />
          <text x={Math.max(X0 + 8, Math.min(xs.now, X1 - 8))} y={AXIS + 32} textAnchor={xs.now > X1 - 40 ? 'end' : xs.now < X0 + 20 ? 'start' : 'middle'}>
            now
          </text>
        </g>
      </svg>
      <figcaption className="muted small">
        {caption ??
          (l.phase === 'before-t2'
            ? `Claim window open: T₂ ${rel(tSecond, now)}, T₁ ${rel(tFirst, now)}.`
            : l.phase === 'between'
              ? `Past T₂: no more claims by the taker; T₁ ${rel(tFirst, now)}.`
              : `Past T₁: the taker's lock is refundable.`)}{' '}
        <span className="ladder-key">
          <i className="k-claim" /> claim <i className="k-wait" /> wait <i className="k-refund" /> refund
        </span>
      </figcaption>
    </figure>
  );
}

const units = (v: bigint, dec: number) => {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(dec + 1, '0');
  const out = dec ? `${s.slice(0, -dec)}.${s.slice(-dec)}` : s;
  return `${neg ? '−' : ''}${out.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')}`;
};

/** Gross (1:1), the solver's spread, what the taker nets, and the effective rate. */
export function FeeBreakdown({ amountIn, amountOut, decimalsIn, decimalsOut, symIn, symOut, compact }: { amountIn: bigint; amountOut: bigint; decimalsIn: number; decimalsOut: number; symIn: string; symOut: string; compact?: boolean }) {
  const f = feeBreakdown({ amountIn, amountOut, decimalsIn, decimalsOut });
  const rate = f.effectiveRate.toFixed(Math.min(6, Math.max(4, decimalsOut)));
  if (compact)
    return (
      <span className="fee-compact small">
        gross {units(f.gross, decimalsOut)} · cost −{units(f.spread, decimalsOut)} ({f.spreadPct.toFixed(2)}%, spread + rounding down to {decimalsOut} decimals) · net {units(f.net, decimalsOut)} {symOut} · 1 {symIn} = {rate} {symOut}
      </span>
    );
  return (
    <dl className="fee" aria-label="Quote fee breakdown">
      <div>
        <dt>Gross at 1:1</dt>
        <dd className="mono">
          {units(f.gross, decimalsOut)} {symOut}
        </dd>
      </div>
      <div>
        <dt>Solver spread</dt>
        <dd className="mono">
          −{units(f.spread, decimalsOut)} {symOut} <span className="muted">({f.spreadPct.toFixed(2)}%)</span>
        </dd>
      </div>
      <div>
        <dt>Net you receive</dt>
        <dd className="mono">
          <b>
            {units(f.net, decimalsOut)} {symOut}
          </b>
        </dd>
      </div>
      <div>
        <dt>Effective rate</dt>
        <dd className="mono">
          1 {symIn} = {rate} {symOut}
        </dd>
      </div>
    </dl>
  );
}

/** Save text as a file in the browser (nothing is uploaded). */
export function downloadText(name: string, text: string, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
