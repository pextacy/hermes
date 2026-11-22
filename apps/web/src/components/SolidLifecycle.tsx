import { useState } from 'react';
import { explorerTxUrl, type BchNetwork } from '@hermes/chain';
import type { DeploymentRecord, HtlcPath, LifecycleStep } from '@hermes/solid/lifecycle-core';
import { Card, Copy, NetBadge, Status, short } from './ui';

/** Deployment records written by `pnpm --filter @hermes/solid lifecycle -- --network <net>` (live runs only). */
const records = import.meta.glob('../../../../packages/solid/deployments/*.json', { eager: true, import: 'default' }) as Record<string, DeploymentRecord>;

type Run = 'claim' | 'refund' | 'ledger';
const LIVE_NETWORKS = ['chipnet', 'mainnet'] as const;

function StepList({ steps, network }: { steps: LifecycleStep[]; network?: BchNetwork }) {
  return (
    <ol className="lifecycle">
      {steps.map((s, i) => (
        <li key={i} className={s.ok ? 'ok' : 'bad'} data-step={`${s.path}:${s.step}`}>
          <b>
            {s.path} · {s.step}
          </b>{' '}
          {s.note}
          {s.txid && (
            <>
              {' '}
              {network ? (
                <a className="mono" href={explorerTxUrl(network, s.txid)} target="_blank" rel="noreferrer" title={s.txid}>
                  tx {short(s.txid)}
                </a>
              ) : (
                <code className="mono" title={s.txid}>
                  tx {short(s.txid)}
                </code>
              )}{' '}
              <Copy text={s.txid} />
            </>
          )}
          {s.bytes !== undefined && <span className="muted"> · {s.bytes} B</span>}
          {s.address && (
            <>
              {' '}
              <code className="mono" title={s.address}>
                {short(s.address, 14, 6)}
              </code>{' '}
              <Copy text={s.address} />
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * SolidCash contracts run live in the browser on the BCH 2026 VM (SolidCash mock network): the HTLC
 * (lock → claim, lock → refund) and the stateful HermesSwapLedger; plus the recorded live runs.
 */
export function SolidLifecycle() {
  const [steps, setSteps] = useState<LifecycleStep[]>([]);
  const [running, setRunning] = useState<Run>();
  const [error, setError] = useState<string>();

  async function run(which: Run) {
    setRunning(which);
    setSteps([]);
    setError(undefined);
    try {
      const [core, { MockNetworkProvider }] = await Promise.all([import('@hermes/solid/lifecycle-core'), import('@solidcash/solidcash/network/mock')]);
      const onStep = (s: LifecycleStep) => setSteps((x) => [...x, s]);
      const key = crypto.getRandomValues(new Uint8Array(32));
      if (which === 'ledger') {
        await core.runLedgerDemo({ provider: new MockNetworkProvider(), mock: true, operatorKey: key, onStep });
      } else {
        await core.runSolidLifecycle({
          provider: new MockNetworkProvider(),
          mock: true,
          prefix: 'bchtest',
          locker: core.party(key, 'bchtest'),
          lockSats: 10_000n,
          now: Math.floor(Date.now() / 1000),
          paths: [which as HtlcPath],
          onStep,
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(undefined);
    }
  }

  const byNetwork = new Map(Object.values(records).map((r) => [r.network, r]));
  const allOk = steps.length > 0 && steps.every((s) => s.ok);
  return (
    <Card title="SolidCash contracts, run in your browser" aside={<NetBadge network="mock" />}>
      <p className="muted small">
        Contracts written in SolidCash (Solidity dialect) and compiled to BCH Script. Each run signs real transactions and evaluates them in the BCH 2026
        VM on SolidCash’s mock network — nothing is broadcast. Negative steps (wrong secret, early refund, replay) must be <i>rejected</i> by the
        contract.
      </p>
      <div className="row wrap">
        <button className="primary" onClick={() => void run('claim')} disabled={!!running}>
          {running === 'claim' ? 'Running…' : 'Run lock → claim'}
        </button>
        <button className="primary" onClick={() => void run('refund')} disabled={!!running}>
          {running === 'refund' ? 'Running…' : 'Run lock → refund'}
        </button>
        <button onClick={() => void run('ledger')} disabled={!!running}>
          {running === 'ledger' ? 'Running…' : 'Run swap ledger (state · events · modifiers)'}
        </button>
      </div>
      {error && <Status kind="err">{error}</Status>}
      {steps.length > 0 && <StepList steps={steps} />}
      {!running && steps.length > 0 && (
        <Status kind={allOk ? 'ok' : 'err'}>
          {allOk ? `All ${steps.length} steps behaved as the contract requires.` : 'A step did not behave as expected — see the red line.'}
        </Status>
      )}

      <h4>Live deployment record</h4>
      {LIVE_NETWORKS.map((net) => {
        const r = byNetwork.get(net);
        if (!r)
          return (
            <p key={net} className="small muted" data-record={`${net}:empty`}>
              <NetBadge network={net} /> No {net} run recorded yet. The owner runs{' '}
              <code className="mono">pnpm --filter @hermes/solid lifecycle -- --network {net}
                {net === 'mainnet' ? ' --i-have-owner-approval' : ''}</code>{' '}
              (key typed at runtime); it writes <code className="mono">packages/solid/deployments/{net}.json</code>, shown here.
            </p>
          );
        return (
          <div key={net} className="small" data-record={net}>
            <p>
              <NetBadge network={net} /> {(r.contracts ?? [r.contract]).join(' + ')} · recorded {new Date(r.at).toLocaleString('en-US')}
              {r.lockSats && <> · {r.lockSats} sats locked per path</>} · {r.steps.filter((s) => s.txid).length} transactions
            </p>
            <StepList steps={r.steps} network={net} />
          </div>
        );
      })}
    </Card>
  );
}
