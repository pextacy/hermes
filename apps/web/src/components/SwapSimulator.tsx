import { useRef, useState } from 'react';
import { convert, type Direction } from '@hermes/swap';
import type { SimBalances, SimPlan, SimResult, SimScenario, SimStep } from '@hermes/swap/simulator';
import { Card, Status, short } from './ui';
import { FeeBreakdown, TimeoutLadder, downloadText } from './SwapViz';

const SCENARIOS: { id: SimScenario; label: string; blurb: string }[] = [
  { id: 'happy', label: 'Atomic swap', blurb: 'Both sides honest: the secret crosses chains and both legs settle.' },
  { id: 'refund', label: 'Solver disappears → refund', blurb: 'The solver never counter-locks; the taker refunds after T₁.' },
];
const ATTACKS: { id: SimScenario; label: string; blurb: string }[] = [
  { id: 'bad-hashlock', label: 'Wrong hashlock', blurb: 'The solver locks under a hashlock the taker’s secret cannot open.' },
  { id: 'short-timeout', label: 'Too-short timeout', blurb: 'The solver’s lock expires 10 minutes after it is made — no safe time to claim.' },
  { id: 'short-amount', label: 'Short amount', blurb: 'The solver locks 10% less than it quoted.' },
];
const DEC = { usdc: 6, pusd: 2 };

function parseUnitsLoose(s: string, dec: number): bigint | undefined {
  const m = s.trim().match(/^(\d{1,12})(?:\.(\d*))?$/);
  if (!m || (m[2] ?? '').length > dec) return undefined;
  return BigInt(m[1]!) * 10n ** BigInt(dec) + BigInt((m[2] ?? '').padEnd(dec, '0') || '0');
}

/**
 * "Try it now": a full USDC ⇄ PUSD atomic swap in the browser — the real HermesHTLC bytecode on an
 * in-browser EVM and the real BCH covenant on the BCH 2026 VM. No wallet, no testnet, nothing broadcast.
 * Custom amount and spread (G15), malicious-solver scenarios (G16), step-through (G17), transcript
 * download (G18), fee breakdown (G19) and the timeout ladder (G21).
 */
export function SwapSimulator() {
  const [direction, setDirection] = useState<Direction>('usdc-to-pusd');
  const [scenario, setScenario] = useState<SimScenario>('happy');
  const [amountStr, setAmountStr] = useState('5');
  const [spreadStr, setSpreadStr] = useState('0.50');
  const [stepMode, setStepMode] = useState(false);
  const [steps, setSteps] = useState<SimStep[]>([]);
  const [bal, setBal] = useState<SimBalances>();
  const [plan, setPlan] = useState<SimPlan>();
  const [result, setResult] = useState<SimResult>();
  const [running, setRunning] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const [fmt, setFmt] = useState<{ usdc: (v: bigint) => string; pusd: (v: bigint) => string }>();
  const gate = useRef<(() => void) | undefined>(undefined);
  const pausing = useRef(false);

  const usdcIn = direction === 'usdc-to-pusd';
  const decIn = usdcIn ? DEC.usdc : DEC.pusd;
  const decOut = usdcIn ? DEC.pusd : DEC.usdc;
  const symIn = usdcIn ? 'USDC' : 'tPUSD';
  const symOut = usdcIn ? 'tPUSD' : 'USDC';
  const amount = parseUnitsLoose(amountStr, decIn);
  const spreadNum = Number(spreadStr);
  const spreadPpm = /^\d{1,2}(\.\d{1,4})?$/.test(spreadStr.trim()) && spreadNum <= 10 ? Math.round(spreadNum * 1e4) : undefined;
  const previewOut = amount !== undefined && spreadPpm !== undefined ? convert(amount, decIn, decOut, BigInt(1_000_000 - spreadPpm)) : undefined;
  const inputError =
    amount === undefined || amount <= 0n
      ? `Enter an amount in ${symIn} (up to ${decIn} decimals).`
      : spreadPpm === undefined
        ? 'Spread must be a percentage between 0 and 10 (e.g. 0.5).'
        : previewOut !== undefined && previewOut < (scenario === 'short-amount' ? 2n : 1n)
          ? `Too small: ${amountStr} ${symIn} is less than one unit of ${symOut} after the spread.`
          : undefined;
  const malicious = ATTACKS.some((a) => a.id === scenario);

  function next() {
    setWaiting(false);
    const g = gate.current;
    gate.current = undefined;
    g?.();
  }
  function runToEnd() {
    pausing.current = false;
    next();
  }

  async function run() {
    if (inputError || amount === undefined || spreadPpm === undefined) return;
    setRunning(true);
    setError(undefined);
    setSteps([]);
    setResult(undefined);
    setBal(undefined);
    setPlan(undefined);
    pausing.current = stepMode;
    try {
      const sim = await import('@hermes/swap/simulator'); // loads the EVM only when asked
      setFmt(() => sim.formatSim);
      const r = await sim.runSwapSimulation({
        direction,
        scenario,
        amount,
        spreadPpm,
        onPlan: (p) => setPlan(p),
        onStep: (s, b) => {
          setSteps((xs) => [...xs, s]);
          setBal(b);
          if (!pausing.current) return;
          setWaiting(true);
          return new Promise<void>((res) => (gate.current = res));
        },
      });
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      setWaiting(false);
      gate.current = undefined;
    }
  }

  async function download() {
    if (!result) return;
    const sim = await import('@hermes/swap/simulator');
    const t = sim.simTranscript(result);
    downloadText(`hermes-swap-sim-${result.direction}-${result.scenario}-${result.hashlock.slice(0, 8)}.json`, JSON.stringify(t, null, 2));
  }

  const attacks = steps.filter((s) => s.expect === 'rejected');
  const current = steps.at(-1);
  const nowSim = current?.at ?? plan?.t0;
  const solverBadTimeout = plan && plan.scenario === 'short-timeout' ? steps.find((s) => s.checks)?.at : undefined;
  return (
    <Card title="Try it now — a full atomic swap in your browser" aside={<span className="net net-mock">NO WALLET · NO TESTNET</span>}>
      <p className="muted small">
        Both chains run the <b>real contracts</b>: the compiled HermesHTLC + USDC bytecode on an in-browser EVM, and the HermesHtlc covenant on
        the BCH 2026 VM, built with the same code as the live swap. The secret really travels from one chain to the other, and the contracts
        themselves must reject every attack along the way. Nothing is broadcast.
      </p>
      <div className="row wrap">
        <div className="seg" role="group" aria-label="Direction">
          <button className={direction === 'usdc-to-pusd' ? 'on' : ''} onClick={() => setDirection('usdc-to-pusd')} disabled={running}>
            USDC → PUSD
          </button>
          <button className={direction === 'pusd-to-usdc' ? 'on' : ''} onClick={() => setDirection('pusd-to-usdc')} disabled={running}>
            PUSD → USDC
          </button>
        </div>
        <label className="sim-field">
          <span className="muted small">Amount</span>
          <input className="amount" aria-label={`Amount in ${symIn}`} value={amountStr} onChange={(e) => setAmountStr(e.target.value)} inputMode="decimal" disabled={running} />
          <span className="small">{symIn}</span>
        </label>
        <label className="sim-field">
          <span className="muted small">Spread</span>
          <input className="amount sim-spread" aria-label="Solver spread in percent" value={spreadStr} onChange={(e) => setSpreadStr(e.target.value)} inputMode="decimal" disabled={running} />
          <span className="small">%</span>
        </label>
      </div>
      <div className="row wrap">
        <div className="seg" role="group" aria-label="Scenario">
          {SCENARIOS.map((s) => (
            <button key={s.id} className={scenario === s.id ? 'on' : ''} onClick={() => setScenario(s.id)} disabled={running}>
              {s.label}
            </button>
          ))}
          <button className={malicious ? 'on' : ''} onClick={() => !malicious && setScenario('bad-hashlock')} disabled={running}>
            Malicious solver
          </button>
        </div>
      </div>
      {malicious && (
        <div className="row wrap">
          <span className="muted small">The solver cheats with:</span>
          <div className="seg" role="group" aria-label="Malicious solver attack">
            {ATTACKS.map((a) => (
              <button key={a.id} className={scenario === a.id ? 'on' : ''} onClick={() => setScenario(a.id)} disabled={running}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="muted small" style={{ margin: 0 }}>
        {[...SCENARIOS, ...ATTACKS].find((s) => s.id === scenario)?.blurb}
        {malicious && ' The taker must catch it before claiming — claiming would reveal the secret.'}
      </p>
      {!inputError && amount !== undefined && previewOut !== undefined && !plan && (
        <FeeBreakdown amountIn={amount} amountOut={previewOut} decimalsIn={decIn} decimalsOut={decOut} symIn={symIn} symOut={symOut} />
      )}
      <div className="row wrap">
        <label className="row small sim-check">
          <input type="checkbox" checked={stepMode} onChange={(e) => setStepMode(e.target.checked)} disabled={running} /> Step through (pause after each step)
        </label>
        <button className="primary" onClick={() => void run()} disabled={running || !!inputError}>
          {running ? 'Running…' : steps.length ? 'Run again' : 'Run the swap'}
        </button>
        {result && (
          <button onClick={() => void download()} title="JSON with every step, BCH tx hex and EVM calldata/logs">
            Download transcript (JSON)
          </button>
        )}
      </div>
      {inputError && <Status kind="warn">{inputError}</Status>}
      {error && <Status kind="err">Simulator failed: {error}</Status>}
      {result && (
        <Status kind={result.passed ? 'ok' : 'err'}>
          {result.passed ? '✔' : '✘'} {steps.filter((s) => s.ok).length}/{steps.length} checks passed — {attacks.length} attack(s) rejected
          {malicious ? ' (including the taker’s own refusal to claim)' : ' by the contracts themselves'}, value conserved across both chains.
          {result.scenario === 'happy' ? ' Neither side could get paid without paying.' : ' The taker got everything back; nothing was lost.'}
        </Status>
      )}
      {waiting && current && (
        <div className="sim-explain" aria-live="polite">
          <div className="muted small">
            Step {current.n} · {current.chain} · {current.actor}
          </div>
          <b>{current.title}</b>
          <p>{current.explain}</p>
          <div className="row wrap">
            <button className="primary" onClick={next}>
              Next step ▸
            </button>
            <button onClick={runToEnd}>Run to end</button>
          </div>
        </div>
      )}
      {plan && (
        <div className="sim-terms">
          <FeeBreakdown amountIn={plan.amountIn} amountOut={plan.amountOut} decimalsIn={plan.decimalsIn} decimalsOut={plan.decimalsOut} symIn={plan.symbolIn} symOut={plan.symbolOut} />
          {nowSim !== undefined && (
            <TimeoutLadder
              now={nowSim}
              start={plan.t0}
              tFirst={plan.tFirst}
              tSecond={plan.tSecond}
              margin={plan.marginSeconds}
              extra={solverBadTimeout ? { t: solverBadTimeout + 600, label: 'solver’s actual timeout' } : undefined}
            />
          )}
        </div>
      )}
      {bal && fmt && (
        <div className="sim-bal" role="table" aria-label="Balances">
          <div role="row" className="sim-bal-head">
            <span />
            <span>USDC (EVM)</span>
            <span>tPUSD (BCH)</span>
          </div>
          {(['taker', 'solver', 'escrow'] as const).map((who) => (
            <div role="row" key={who}>
              <span className="muted">{who === 'escrow' ? 'held by HTLCs' : who}</span>
              <span className="mono">{fmt.usdc(bal[who].usdc)}</span>
              <span className="mono">{fmt.pusd(bal[who].pusd)}</span>
            </div>
          ))}
        </div>
      )}
      {steps.length > 0 && (
        <ol className="sim-steps">
          {steps.map((s) => (
            <li key={s.n} className={s.ok ? (s.expect === 'rejected' ? 'blocked' : 'done') : 'fail'}>
              <div className="row wrap sim-step-head">
                <span className={`net ${s.chain === 'EVM' ? 'net-evm' : s.chain === 'BCH' ? 'net-chipnet' : 'net-docs'}`}>{s.chain}</span>
                <span className="muted small">{s.actor}</span>
                <b>{s.title}</b>
                <span className={`pill ${s.ok ? 'pill-ok' : 'pill-warn'}`}>{s.expect === 'rejected' ? (s.ok ? 'blocked ✓' : 'NOT blocked ✗') : s.ok ? 'ok' : 'failed'}</span>
              </div>
              <div className="small">{s.detail}</div>
              {s.checks && (
                <ul className="sim-checks">
                  {s.checks.map((c) => (
                    <li key={c.name} className={c.ok ? 'ok' : 'bad'}>
                      {c.ok ? '✓' : '✗'} <b>{c.name}</b> — {c.detail}
                    </li>
                  ))}
                </ul>
              )}
              {(s.ref || s.cost) && (
                <div className="muted small mono">
                  {s.ref && short(s.ref, 14, 8)} {s.cost && `· ${s.cost}`}
                </div>
              )}
              {s.explain && !(waiting && s === current) && (
                <details className="sim-why">
                  <summary className="small">Why this step</summary>
                  <p className="small">{s.explain}</p>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
