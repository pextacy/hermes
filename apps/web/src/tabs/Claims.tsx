import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DropsSandbox,
  claimForWallet,
  costModel,
  electrumHeights,
  proofFor,
  readAccountStatus,
  readPoolStatus,
  tamperRoot,
  treeEntries,
  type AccountStatus,
  type Deployment,
  type PoolStatus,
  type TreeFileLike,
} from '@hermes/drops';
import { cashAddressToLockingBytecode, binToHex, decodeCashAddress, encodeCashAddress } from '@bitauth/libauth';
import { HERMES, type BchNetwork } from '@hermes/chain';
import planMd from '../../../../docs/PLAN.md?raw';
import { useHashParams, useHermes } from '../lib/context';
import { localWallet } from '../lib/keys';
import { Card, Copy, NetBadge, Status, TxLink, short, More } from '../components/ui';
import { ClaimCostEstimator, HistoryChart, Leaderboard, ProofDownload, ProofPathView, RootAudit } from '../components/ClaimsInsights';
import { FeatureGrid, Section, Stats } from '../components/Sections';
import { HeroArt } from '../components/HeroArt';

const files = import.meta.glob('../../../../packages/drops/deployments/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
type TreeFile = TreeFileLike & { window: [string, string]; leaves: number; depth: number; realMembers: number };
const trees = Object.entries(files)
  .filter(([k]) => /tree-\d+\.json$/.test(k))
  .map(([, v]) => v as TreeFile)
  .sort((a, b) => a.epoch - b.epoch);
const latest = trees[trees.length - 1];
// The live pool: chipnet when deployed there, else testnet4 (same contracts, same bchtest: addresses).
const liveEntry = (['chipnet', 'testnet4'] as const)
  .map((n) => [n, Object.entries(files).find(([k]) => k.endsWith(`/${n}.json`))?.[1] as Deployment | undefined] as const)
  .find(([, d]) => d);
const chipnet = liveEntry?.[1];
const LIVE_NET: BchNetwork = liveEntry?.[0] ?? 'chipnet';
const TIMELOCK = HERMES.drops.rootTimelockBlocks;
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
const month = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** cashaddr → locking bytecode + the token-aware address where receipts live. */
function parseAddress(addr: string): { lockingBytecode: string; tokenAddress: string } | string {
  const lb = cashAddressToLockingBytecode(addr.trim());
  if (typeof lb === 'string') return 'Not a valid cashaddr (bitcoincash:… / bchtest:…).';
  const d = decodeCashAddress(addr.trim());
  let tokenAddress = addr.trim();
  if (typeof d !== 'string' && (d.type === 'p2pkh' || d.type === 'p2sh')) {
    tokenAddress = encodeCashAddress({ prefix: d.prefix as 'bchtest', type: d.type === 'p2pkh' ? 'p2pkhWithTokens' : 'p2shWithTokens', payload: d.payload }).address;
  }
  return { lockingBytecode: binToHex(lb.bytecode), tokenAddress };
}

const accountKind = (s: AccountStatus['state']) => (s === 'claimable' ? 'ok' : s === 'already-claimed' ? 'info' : s === 'not-in-tree' ? 'warn' : s === 'receipt-missing' ? 'err' : 'warn');

/** Pool state: active epoch/root per shard, pending roots with their timelock, vault balance. */
/** "#0–#7" for consecutive shard indices, "#0, #3" otherwise. */
const shardLabel = (ix: number[]) =>
  ix.length > 1 && ix.every((v, i) => i === 0 || v === ix[i - 1] + 1) ? `#${ix[0]}–#${ix[ix.length - 1]}` : ix.map((i) => `#${i}`).join(', ');
/** Group identical rows so eight shards in the same state read as one line. */
function groupBy<T>(xs: T[], key: (x: T) => string): { first: T; ix: T[] }[] {
  const m = new Map<string, { first: T; ix: T[] }>();
  for (const x of xs) {
    const k = key(x);
    const g = m.get(k);
    if (g) g.ix.push(x);
    else m.set(k, { first: x, ix: [x] });
  }
  return [...m.values()];
}

function PoolView({ pool, treeList }: { pool: PoolStatus; treeList: TreeFileLike[] }) {
  const shardRows = groupBy(pool.shards, (s) => `${s.epoch}|${s.root}|${s.treeEpoch}|${s.claimedAccounts}`);
  const pendingRows = groupBy(pool.pending, (p) => `${p.epoch}|${p.root}|${p.matchesTree}|${p.confirmations}|${p.remaining}`);
  return (
    <div className="small stack-sm" data-testid="pool-status">
      <table className="table">
        <thead>
          <tr>
            <th>Shard</th>
            <th>Active epoch</th>
            <th>Root</th>
            <th>Accounts claimed</th>
          </tr>
        </thead>
        <tbody>
          {shardRows.map(({ first: s, ix }) => (
            <tr key={s.shardIndex}>
              <td>{shardLabel(ix.map((x) => x.shardIndex))}</td>
              <td>{s.epoch === 0 ? 'none yet' : s.epoch}</td>
              <td>
                {s.epoch === 0 ? (
                  '—'
                ) : (
                  <>
                    <code className="mono">{short(s.root, 10, 6)}</code> {s.treeEpoch ? `= tree-${s.treeEpoch} ✔` : 'unknown root ✘'}
                  </>
                )}
              </td>
              <td>{s.claimedAccounts}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pool.pending.length === 0 ? (
        <p className="muted">No pending root waiting for its timelock.</p>
      ) : (
        <ul>
          {pendingRows.map(({ first: p, ix }) => (
            <li key={`${p.shardIndex}-${p.epoch}-${p.root}`}>
              Pending epoch {p.epoch} ({ix.length > 1 ? 'shards' : 'shard'} {shardLabel(ix.map((x) => x.shardIndex))}) <code className="mono">{short(p.root, 10, 6)}</code>{' '}
              {p.matchesTree === undefined ? 'no tree file to audit against' : p.matchesTree ? `matches tree-${p.epoch}.json ✔` : `DOES NOT match tree-${p.epoch}.json ✘ (authority should cancel)`}
              {' · '}
              {p.confirmations === undefined
                ? 'age unknown'
                : p.remaining
                  ? `timelock ${p.confirmations}/${pool.rootTimelock} blocks, promotable in ${p.remaining}`
                  : `timelock ${pool.rootTimelock}/${pool.rootTimelock} blocks: promotable now (anyone)`}
            </li>
          ))}
        </ul>
      )}
      <div className="kv">
        <span>Vault</span>
        <span>
          {pool.vault.units.toLocaleString('en-US')} reward units in {pool.vault.utxos} UTXO(s){pool.tip !== undefined ? ` · tip ${pool.tip}` : ''} · {treeList.length} published tree(s)
        </span>
      </div>
    </div>
  );
}

/** What one account can claim, its receipt NFT and the reason when it cannot. */
function AccountView({ account }: { account: AccountStatus }) {
  return (
    <div className="small stack-sm" data-testid="account-status">
      {account.accountId !== undefined && (
        <div className="kv">
          <span>Account</span>
          <span>
            #{account.accountId} (shard #{account.shardIndex}) · active epoch {account.activeEpoch || 'none'} · entitled {account.cumulative?.toString() ?? '—'} (latest tree-{account.latestEpoch}:{' '}
            {account.latestCumulative?.toString()})
          </span>
        </div>
      )}
      {account.accountId !== undefined && (
        <div className="kv">
          <span>Receipt NFT</span>
          <span>
            {account.receipt ? (
              <>
                claimed total <b>{account.receipt.claimedTotal.toString()}</b> · <code className="mono">{short(account.receipt.txid, 8, 4)}:{account.receipt.vout}</code>
              </>
            ) : account.firstClaimDone ? (
              'first claim done, receipt not in this wallet'
            ) : (
              'none yet (minted on the first claim)'
            )}
          </span>
        </div>
      )}
      <Status kind={accountKind(account.state)}>{account.message}</Status>
    </div>
  );
}

/** F25: live chipnet claim with this browser's chipnet key (when a deployment record exists). */
function ChipnetClaim({ deployment }: { deployment: Deployment }) {
  const { provider } = useHermes();
  const me = useMemo(() => localWallet(LIVE_NET), []);
  const [pool, setPool] = useState<PoolStatus>();
  const [account, setAccount] = useState<AccountStatus>();
  const [bch, setBch] = useState<bigint>();
  const [err, setErr] = useState<string>();
  const [result, setResult] = useState<{ kind: 'ok' | 'info' | 'err'; text: string; txid?: string }>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setErr(undefined);
    try {
      const p = provider(LIVE_NET);
      const pl = await readPoolStatus({ provider: p, config: deployment.config, trees, heights: electrumHeights(p) });
      setPool(pl);
      setAccount(await readAccountStatus({ provider: p, config: deployment.config, trees, pool: pl, wallet: me }));
      setBch((await p.getUtxos(me.address)).filter((u) => !u.token).reduce((n, u) => n + u.satoshis, 0n));
    } catch (e) {
      setErr(`Could not read the pool from ${LIVE_NET} Electrum: ${(e as Error).message}`);
    }
  }, [provider, deployment, me]);
  useEffect(() => void refresh(), [refresh]);

  async function claim() {
    setBusy(true);
    setResult(undefined); // a failed retry must not render as success next to the old txid
    try {
      if (account?.state === 'already-claimed') throw new Error(account.message);
      if (!account?.activeTree) throw new Error(account?.message ?? 'Pool status not loaded yet');
      const r = await claimForWallet({ provider: provider(LIVE_NET), config: deployment.config, entries: treeEntries(account.activeTree), wallet: me });
      setResult({ kind: 'ok', text: `Claimed ${r.payout} units (${r.firstClaim ? 'first claim: receipt NFT minted' : 'receipt NFT updated'}).`, txid: r.txid });
      await refresh();
    } catch (e) {
      const m = (e as Error).message;
      setResult({ kind: /already claimed/i.test(m) ? 'info' : 'err', text: m });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-sm">
      <div className="small">
        <div className="kv">
          <span>Shard</span>
          <code className="mono">{short(deployment.addresses.shard, 20, 8)}</code>
        </div>
        <div className="kv">
          <span>Vault</span>
          <code className="mono">{short(deployment.addresses.vault, 20, 8)}</code>
        </div>
        <div className="kv">
          <span>Pending roots</span>
          <code className="mono">{short(deployment.addresses.pending, 20, 8)}</code>
        </div>
        <div className="kv">
          <span>Receipt category</span>
          <code className="mono">{short(deployment.config.receiptCategory, 16, 8)}</code>
        </div>
      </div>
      {err && <Status kind="err">{err}</Status>}
      {pool && <PoolView pool={pool} treeList={trees} />}
      <div className="small">
        <div className="kv">
          <span>Your {LIVE_NET} key</span>
          <code className="mono">{short(me.address, 18, 6)}</code> <Copy text={me.address} />
          {bch !== undefined && <span className="muted">{bch.toLocaleString('en-US')} sats</span>}
        </div>
      </div>
      {account && <AccountView account={account} />}
      {account?.state === 'not-in-tree' && (
        <p className="muted small">
          Demo addresses are added by the operator with <code>tree --include {short(me.address, 12, 4)}</code> (the watcher re-applies the same list).
        </p>
      )}
      {bch !== undefined && bch < 5000n && account?.state === 'claimable' && (
        <Status kind="warn">Fund this address with a little {LIVE_NET} BCH first (≥ 5,000 sats for dust and fee): the claimer pays, not the operator.</Status>
      )}
      <div className="row wrap">
        <button className="primary" onClick={() => void claim()} disabled={busy || !account || account.state === 'not-in-tree'}>
          {busy ? 'Claiming…' : 'Claim my rewards'}
        </button>
        <button onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
      </div>
      {result && result.text !== account?.message && <Status kind={result.kind}>{result.text}</Status>}
      {result?.txid && <TxLink network={LIVE_NET} txid={result.txid} />}
    </div>
  );
}

/** F25 fallback / judge path: the whole lifecycle with the production code on the BCH 2026 VM in this tab. */
function Sandbox() {
  const sb = useRef<DropsSandbox | undefined>(undefined);
  const [state, setState] = useState<{ pool: PoolStatus; account: AccountStatus }>();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ kind: 'ok' | 'info' | 'err' | 'warn'; text: ReactNode }>();
  const [published, setPublished] = useState(0);
  const push = (s: string) => setLog((l) => [...l, s]);

  async function step(fn: (s: DropsSandbox) => Promise<{ kind: 'ok' | 'info' | 'err' | 'warn'; text: ReactNode } | void>) {
    setBusy(true);
    try {
      const r = sb.current ? await fn(sb.current) : undefined;
      if (r) setLast(r);
      if (sb.current) setState(await sb.current.status());
    } catch (e) {
      const m = (e as Error).message;
      setLast({ kind: /already claimed/i.test(m) ? 'info' : 'err', text: m });
      push(`× ${m}`);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setLog([]);
    setLast(undefined);
    setPublished(0);
    try {
      sb.current = await DropsSandbox.create({ trees, rootTimelock: TIMELOCK, log: push });
      setState(await sb.current.status());
      setLast({ kind: 'info', text: 'Pool deployed in the VM. Next: the authority publishes epoch 1.' });
    } catch (e) {
      setLast({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const next = trees.find((t) => t.epoch > published);
  const pendingNow = (state?.pool.pending.length ?? 0) > 0;
  const badPending = state?.pool.pending.some((p) => p.matchesTree === false) ?? false;
  const hint = !state
    ? undefined
    : badPending
      ? `the pending root does NOT match tree-${state.pool.pending[0].epoch}: the authority cancels it before the ${TIMELOCK}-block timelock ends.`
      : pendingNow
      ? state.pool.pending[0].remaining
        ? `Epoch ${state.pool.pending[0].epoch} is pending: try “Promote” now (the covenant rejects it), then mine ${TIMELOCK} blocks.`
        : 'Timelock passed: anyone can promote.'
      : state.account.state === 'claimable'
        ? 'Claim your rewards.'
        : state.account.state === 'already-claimed'
          ? next
            ? `Claim again to see the refusal, or publish epoch ${next.epoch}.`
            : 'All epochs claimed. Claim again to see the refusal.'
          : next
            ? `Publish epoch ${next.epoch}.`
            : undefined;

  return (
    <div className="stack-sm">
      <p className="muted small">
        The same transactions as the live pool, run on the BCH 2026 VM in this tab with simulated blocks. Nothing is broadcast. The trees add one
        throwaway sandbox wallet, so their roots differ from the published ones.
      </p>
      <div className="row wrap">
        <button className={state ? '' : 'primary'} onClick={() => void start()} disabled={busy || !trees.length}>
          {state ? 'Reset sandbox' : 'Start sandbox'}
        </button>
        {state && (
          <>
            <button
              onClick={() =>
                void step(async (s) => {
                  await s.publish(next!.epoch);
                  setPublished(next!.epoch);
                  return { kind: 'info', text: `Epoch ${next!.epoch} root published as pending; claimable only after ${TIMELOCK} blocks.` };
                })
              }
              disabled={busy || !next || pendingNow}
            >
              {next ? `Publish epoch ${next.epoch} (authority)` : 'All epochs published'}
            </button>
            <button onClick={() => void step(async (s) => (s.mine(1), { kind: 'info', text: `Mined 1 block (tip ${s.height - 1}).` }))} disabled={busy}>
              Mine 1 block
            </button>
            <button onClick={() => void step(async (s) => (s.mine(TIMELOCK), { kind: 'info', text: `Mined ${TIMELOCK} blocks (tip ${s.height - 1}).` }))} disabled={busy}>
              Mine {TIMELOCK} blocks
            </button>
            <button
              onClick={() =>
                void step(async (s) => {
                  const r = await s.promote();
                  if (r.promoted.length) return { kind: 'ok', text: `Promoted epoch ${r.promoted[0].epoch} into ${r.promoted.length} shard(s).` };
                  if (r.rejected.length) return { kind: 'warn', text: `Rejected by the covenant: pending root is ${r.rejected[0].age}/${TIMELOCK} blocks old (CSV).` };
                  return { kind: 'info', text: 'Nothing pending to promote.' };
                })
              }
              disabled={busy}
            >
              Promote (anyone)
            </button>
            <button
              className="primary"
              onClick={() =>
                void step(async (s) => {
                  const r = await s.claim();
                  return { kind: 'ok', text: `Claimed ${r.payout} units — ${r.firstClaim ? 'first claim: receipt NFT minted, bitmap bit set' : 'old receipt burned, new one minted'}.` };
                })
              }
              disabled={busy}
            >
              Claim
            </button>
          </>
        )}
      </div>
      {state && (
        <div className="c3-veto" data-testid="veto-drill">
          <div className="small">
            <b>Authority veto drill (G28).</b> Publish a wrong root on purpose, watch the audit flag it, then cancel it with the authority key before the
            timelock ends (<code>DropsPending.cancel</code>, the CLI’s <code>cancel --epoch N</code>).
          </div>
          <div className="row wrap">
            <button
              onClick={() =>
                void step(async (s) => {
                  const t = s.trees.find((x) => x.epoch === next!.epoch)!;
                  await s.publish(t.epoch, { root: tamperRoot(t.root) });
                  return { kind: 'warn', text: `Published a BAD root for epoch ${t.epoch} (one bit flipped): it does not match the tree. Cancel it before ${TIMELOCK} blocks pass.` };
                })
              }
              disabled={busy || !next || pendingNow}
            >
              {next ? `Publish a bad root for epoch ${next.epoch}` : 'No epoch left to publish'}
            </button>
            <button
              className={badPending ? 'primary' : ''}
              onClick={() =>
                void step(async (s) => {
                  const p = (await s.status()).pool.pending[0];
                  if (!p) return { kind: 'info', text: 'Nothing pending to cancel.' };
                  const txids = await s.cancel(p.epoch);
                  return {
                    kind: 'ok',
                    text: `Vetoed: ${txids.length} pending root(s) for epoch ${p.epoch} burned by the authority at ${p.confirmations ?? 0}/${TIMELOCK} blocks, before the timelock. Nothing can be promoted; publish the correct root again.`,
                  };
                })
              }
              disabled={busy || !pendingNow}
            >
              Cancel pending root (authority veto)
            </button>
          </div>
        </div>
      )}
      {state && (
        <div className="kv small">
          <span>Block</span>
          <span>
            {state.pool.tip} (simulated){hint ? ` · next: ${hint}` : ''}
          </span>
        </div>
      )}
      {last && last.text !== state?.account.message && (
        <div data-testid="sandbox-last">
          <Status kind={last.kind}>{last.text}</Status>
        </div>
      )}
      {state && <AccountView account={state.account} />}
      {state && <PoolView pool={state.pool} treeList={trees} />}
      {log.length > 0 && (
        <details>
          <summary>Sandbox log ({log.length})</summary>
          <pre className="mono pre">{log.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

/** Address → entitlement per epoch → Merkle proof (same JSON as the CLI) → on-chain receipt when deployed. */
function Lookup() {
  const { provider } = useHermes();
  const { params, setParams } = useHashParams(); // G42: #claims?addr=… restores and shares a lookup
  const [lookup, setLookup] = useState(params.addr ?? '');
  const [res, setRes] = useState<{ lb?: string; error?: string; rows?: { epoch: number; cumulative?: string; accountId?: number }[]; proof?: ReturnType<typeof proofFor>; account?: AccountStatus; chainErr?: string }>();

  useEffect(() => {
    if (params.addr) void find(params.addr);
  }, []);

  async function find(addr = lookup) {
    setRes(undefined);
    setParams({ addr: addr.trim() || undefined });
    if (!latest) return setRes({ error: 'No published tree in this build.' });
    const a = parseAddress(addr);
    if (typeof a === 'string') return setRes({ error: a });
    const rows = trees.map((t) => {
      const e = t.entries.find((x) => x.lockingBytecode === a.lockingBytecode);
      return { epoch: t.epoch, cumulative: e ? String(e.cumulative) : undefined, accountId: e?.accountId };
    });
    if (!rows.some((r) => r.cumulative)) return setRes({ error: `Not in any published tree (epochs ${trees.map((t) => t.epoch).join(', ')}).`, rows });
    const newest = [...trees].reverse().find((t) => t.entries.some((x) => x.lockingBytecode === a.lockingBytecode))!;
    const proof = proofFor(newest, a.lockingBytecode);
    const lb = a.lockingBytecode;
    setRes({ lb, rows, proof });
    if (chipnet) {
      try {
        const p = provider(LIVE_NET);
        const pool = await readPoolStatus({ provider: p, config: chipnet.config, trees, heights: electrumHeights(p) });
        const account = await readAccountStatus({ provider: p, config: chipnet.config, trees, pool, wallet: a });
        setRes({ lb, rows, proof, account });
      } catch (e) {
        setRes({ lb, rows, proof, chainErr: (e as Error).message });
      }
    }
  }

  // A real member from the published tree, so a judge can try the lookup without an address of their own.
  const sample = useMemo(() => {
    const e = latest?.entries.find((x) => x.lockingBytecode.startsWith('76a914') && !x.lockingBytecode.startsWith('76a914a9'));
    if (!e) return undefined;
    const pkh = Uint8Array.from(e.lockingBytecode.slice(6, 46).match(/../g)!.map((h) => parseInt(h, 16)));
    return encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload: pkh }).address;
  }, []);

  return (
    <div className="stack-sm">
      <div className="row">
        <input className="grow" placeholder="Check an address (bitcoincash:… / bchtest:…)" value={lookup} onChange={(e) => setLookup(e.target.value)} />
        <button onClick={() => void find()} disabled={!lookup}>
          Check
        </button>
      </div>
      <div className="row wrap small">
        {sample && (
          <button
            className="link"
            onClick={() => {
              setLookup(sample);
              void find(sample);
            }}
          >
            try a FoldingCash member
          </button>
        )}
        {chipnet && (
          <button
            className="link"
            onClick={() => {
              const a = localWallet(LIVE_NET).address;
              setLookup(a);
              void find(a);
            }}
          >
            use my {LIVE_NET} key
          </button>
        )}
      </div>
      {res?.error && <Status kind="warn">{res.error}</Status>}
      {res?.rows && res.rows.some((r) => r.cumulative) && (
        <table className="table small" data-testid="lookup-rows">
          <thead>
            <tr>
              <th>Epoch</th>
              <th>Window</th>
              <th>Cumulative earned (base units)</th>
              <th>Account</th>
            </tr>
          </thead>
          <tbody>
            {res.rows.map((r) => {
              const t = trees.find((x) => x.epoch === r.epoch)!;
              return (
                <tr key={r.epoch}>
                  <td>{r.epoch}</td>
                  <td>{t.window ? `${month(t.window[0])}` : '—'}</td>
                  <td>{r.cumulative ?? 'not a member'}</td>
                  <td>{r.accountId !== undefined ? `#${r.accountId}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {res?.proof && (
        <>
          <Status kind={res.proof.verifies ? 'ok' : 'err'}>
            Epoch {res.proof.epoch} proof: depth {res.proof.depth}, path {res.proof.path} · {res.proof.verifies ? 'verifies against the published root ✔' : 'does NOT verify ✘'}
          </Status>
          <details>
            <summary>
              Proof JSON (same as <code>tsx src/cli.ts proof --address …</code>)
            </summary>
            <pre className="mono pre">{json(res.proof)}</pre>
            <Copy text={json(res.proof)} />
          </details>
          {res.lb && (
            <>
              <ProofDownload trees={trees} lockingBytecode={res.lb} />
              <HistoryChart trees={trees} lockingBytecode={res.lb} />
              <ProofPathView tree={trees.find((t) => t.epoch === res.proof!.epoch)!} lockingBytecode={res.lb} />
            </>
          )}
        </>
      )}
      {res?.account && <AccountView account={res.account} />}
      {res?.chainErr && <Status kind="err">Could not read the {LIVE_NET} pool: {res.chainErr}</Status>}
      {res?.proof && !chipnet && <p className="muted small">On-chain receipt and claimable amount appear here once the pool is deployed on chipnet.</p>}
    </div>
  );
}

/** Minimal Markdown for the PLAN §5.1 excerpt: paragraphs, bullets, one table, `code`, **bold**, *em*. */
function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/).map((p, i) =>
    p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith('*') && p.length > 2 ? <em key={i}>{p.slice(1, -1)}</em> : p,
  );
}
function MiniMarkdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/);
  return (
    <div className="small guide">
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines[0].startsWith('|')) {
          const rows = lines.filter((l) => !/^\|\s*-/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
          return (
            <table className="table" key={i}>
              <thead>
                <tr>{rows[0].map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
              </thead>
              <tbody>
                {rows.slice(1).map((r, k) => (
                  <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          );
        }
        // Paragraph lines, then "- " bullets; indented lines continue the previous bullet.
        const para: string[] = [];
        const items: string[] = [];
        for (const l of lines) {
          if (l.startsWith('- ')) items.push(l.slice(2));
          else if (items.length) items[items.length - 1] += ` ${l.trim()}`;
          else para.push(l.trim());
        }
        return (
          <div key={i}>
            {para.length > 0 && <p>{inline(para.join(' '))}</p>}
            {items.length > 0 && <ul>{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ul>}
          </div>
        );
      })}
    </div>
  );
}
const guideText = (() => {
  const a = planMd.indexOf('### 5.1');
  const b = planMd.indexOf('\n## 6', a);
  return a < 0 ? '' : planMd.slice(planMd.indexOf('\n', a) + 1, b < 0 ? undefined : b);
})();

export function Claims() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const guideRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (location.hash.includes('guide')) guideRef.current?.scrollIntoView();
  }, []);

  async function runDemo() {
    setRunning(true);
    setLog([]);
    try {
      const { runDemo } = await import('@hermes/drops/demo');
      await runDemo({ leaves: HERMES.drops.demoLeaves, log: (s) => setLog((l) => [...l, s]) });
    } catch (e) {
      setLog((l) => [...l, `error: ${(e as Error).message}`]);
    } finally {
      setRunning(false);
    }
  }

  const rows = useMemo(
    () =>
      [62, 400, 3000, 10000].map((users) => ({
        users,
        ...costModel({ users, epochs: 12, claimRate: 0.25, feeRate: 1, tokenDust: 1000, shards: HERMES.drops.shards }),
      })),
    [],
  );
  const max = Math.max(...rows.map((r) => r.push.operatorSats));

  return (
    <div className="stack">
      <div className="hero small">
        <HeroArt kind="claims" />
        <h2>Hermes Drops</h2>
        <p>
          FoldingCash rewards as one Merkle root per epoch. Members claim whenever they like; a receipt NFT tracks what each account has taken,
          and every new root waits {TIMELOCK} blocks on-chain before it pays, so anyone can audit it first.
        </p>
      </div>

      {latest && (
        <Stats
          items={[
            { value: trees.length, label: 'Epochs published' },
            { value: latest.realMembers, label: 'FoldingCash members' },
            { value: latest.leaves, label: 'Leaves per tree' },
            { value: `${TIMELOCK} blocks`, label: 'Audit window' },
          ]}
        />
      )}

      <Card title="Find your rewards">
        {latest && (
          <p className="small muted">
            Search the published trees. Latest: epoch {latest.epoch} ({month(latest.window[0])}), root{' '}
            <code className="mono">{short(latest.root, 12, 6)}</code>.
          </p>
        )}
        <Lookup />
      </Card>

      <Card title={`Claim on ${LIVE_NET}`} aside={<NetBadge network={LIVE_NET} />}>
        {chipnet ? (
          <ChipnetClaim deployment={chipnet} />
        ) : (
          <div className="stack-sm" data-testid="not-deployed">
            <Status kind="warn">
              Not deployed on chipnet yet: this build has no <code>packages/drops/deployments/chipnet.json</code>. The trees are published, the
              covenants are compiled, and the claim button appears here as soon as the operator deploys (needs chipnet BCH).
            </Status>
            <p className="small muted">
              Operator steps: <code>tsx src/cli.ts deploy --network chipnet --timelock 2</code> → <code>publish --epoch 1</code> → wait 2 blocks →{' '}
              <code>promote</code>. Until then, run the exact same claim below in the browser VM.
            </p>
          </div>
        )}
      </Card>

      <Card title={chipnet ? 'Sandbox: the same flow in your browser' : 'Claim in your browser (sandbox)'} aside={<NetBadge network="mock" />}>
        <Sandbox />
      </Card>

      <Section title="Why pull, not push">
        <FeatureGrid
          items={[
            { title: 'One root per epoch', text: 'The operator posts 32 bytes, not one payment per member.' },
            { title: 'Claim any time', text: 'A receipt NFT records what you have taken; the next claim pays only the difference.' },
            { title: 'Audit window', text: `Each new root waits ${TIMELOCK} blocks before it pays, and the authority can veto a bad one.` },
            { title: 'Recomputable', text: 'Anyone can rebuild every root from the public FoldingCash data.' },
          ]}
        />
      </Section>

      <More>
      {latest && (
        <Card title={`Top earners · epoch ${latest.epoch}`}>
          <Leaderboard tree={latest} />
        </Card>
      )}

      <Card title="Root audit">
        <RootAudit trees={trees} deployment={chipnet} network={LIVE_NET} />
      </Card>

      <Card title="Scripted covenant demo" aside={<NetBadge network="mock" />}>
        <p className="muted small">
          Builds a {HERMES.drops.demoLeaves}-leaf tree and runs real transactions through the full BCH 2026 virtual machine (CashScript mock
          network): timelocked promotion, first claim, double-claim attempt, a later claim that pays only the difference.
        </p>
        <button onClick={() => void runDemo()} disabled={running}>
          {running ? 'Running…' : 'Run demo'}
        </button>
        {log.length > 0 && <pre className="mono pre">{log.join('\n')}</pre>}
      </Card>

      <Card title="Push vs pull: operator cost">
        <p className="muted small">
          Model in packages/drops/src/cost.ts with sizes measured from the demo transactions (claim ≈ 1,782 bytes at depth 9, promotion ≈ 1,271
          bytes), 1 sat/byte, 1,000-sat token dust, 25% of users claiming per epoch. 62 is FoldingCash’s actual member count for October 2026.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Users</th>
              <th>Push (operator)</th>
              <th>Pull (operator)</th>
              <th>Pull (all claimers)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.users}>
                <td>{r.users.toLocaleString('en-US')}</td>
                <td>{r.push.operatorSats.toLocaleString('en-US')} sats</td>
                <td>{r.pull.operatorSats.toLocaleString('en-US')} sats</td>
                <td>{r.pull.userSatsTotal.toLocaleString('en-US')} sats</td>
                <td className="bars">
                  <span className="bar push" style={{ width: `${(r.push.operatorSats / max) * 100}%` }} />
                  <span className="bar pull" style={{ width: `${Math.max((r.pull.operatorSats / max) * 100, 0.5)}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">
          Operator cost becomes constant in the number of users ({rows[0].breakEvenUsers}+ users and pull is cheaper for the operator). Each
          claimer pays ≈ {rows[0].pull.userSatsPerClaim.toLocaleString('en-US')} sats only when they choose to claim, and small balances never wait for a
          threshold.
        </p>
      </Card>

      <Card title="Claim cost estimator">
        <ClaimCostEstimator depth={latest?.depth ?? 9} />
      </Card>

      <div ref={guideRef} id="drops-guide">
        <Card title="Developer guide" open={location.hash.includes('guide')}>
          <p className="small muted">
            From <code>docs/PLAN.md</code> §5.1 (rendered from the same file). CLI: <code>pnpm --filter @hermes/drops exec tsx src/cli.ts</code>{' '}
            <code>tree | deploy | publish | cancel | promote | status | proof | cost | demo</code>; watcher:{' '}
            <code>pnpm --filter watcher once -- --network chipnet [--source fah] [--alerts nostr]</code>.
          </p>
          {guideText ? <MiniMarkdown text={guideText} /> : <Status kind="warn">PLAN.md §5.1 not found in this build.</Status>}
        </Card>
      </div>
      </More>
    </div>
  );
}
