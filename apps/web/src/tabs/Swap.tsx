import { useEffect, useMemo, useRef, useState } from 'react';
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/pure';
import { binToHex } from '@bitauth/libauth';
import type { Address, Hex, WalletClient } from 'viem';
import type { Utxo } from 'cashscript';
import {
  ACTION_MARGIN_SECONDS,
  apply,
  applyAll,
  buildClaim,
  buildLock,
  buildRefund,
  evmClaim,
  evmConfig,
  evmLock,
  evmRefund,
  findBchPreimage,
  findEvmLocks,
  generateSecret,
  htlcContract,
  initialState,
  nextAction,
  noticeTemplate,
  observeTakerSwap,
  parseQuote,
  publicClientFor,
  quoteFilter,
  rankQuoteEntries,
  SAFETY_MARGIN_SECONDS,
  swapHistoryCsv,
  readLock,
  rfqTemplate,
  solverStats,
  takerFacts,
  takerTimeline,
  countdown,
  tokenDecimals,
  type Direction,
  type Quote,
  type Rfq,
  type SwapState,
} from '@hermes/swap';
import { formatUnits, getTokenMeta, parseUnits, stablecoins, tokenConfig } from '@hermes/chain';
import * as nip19 from 'nostr-tools/nip19';
import { useHermes } from '../lib/context';
import { ensureLocalNostr, localWallet } from '../lib/keys';
import { connectEvm } from '../lib/evm';
import { loadArray, reviveBigints, save } from '../lib/storage';
import { Card, NetBadge, Status, TxLink, short } from '../components/ui';
import { SwapSimulator } from '../components/SwapSimulator';
import { FeeBreakdown, TimeoutLadder, downloadText } from '../components/SwapViz';

type S = Utxo & { lockingBytecode: string };
const EVM_KEY = 'baseSepolia' as const;

interface TakerSwap {
  rfq: Rfq;
  quote: Quote;
  solverPubkey: string;
  secret: string;
  state: SwapState;
  evmLockId?: string;
  bchLockTxid?: string;
  claimTx?: string;
  refundTx?: string;
  /** EVM tx hashes (lock / claim / refund) for explorer links. */
  evmTxs?: { label: string; hash: string }[];
  /** BCH stablecoin symbol at the time of the swap (the selector may change later). */
  bchSymbol?: string;
  log: string[];
}

const now = () => Math.floor(Date.now() / 1000);

export function Swap() {
  const { demoNetwork, provider, settings } = useHermes();
  const evm = evmConfig(EVM_KEY);
  const coins = stablecoins(demoNetwork);
  const [coinKey, setCoinKey] = useState<string>(coins[0]?.key ?? 'PUSD');
  const pusdCfg = coins.find((c) => c.key === coinKey) ?? tokenConfig(demoNetwork, 'PUSD');
  const [clock, setClock] = useState(now());
  useEffect(() => {
    const t = setInterval(() => setClock(now()), 1000);
    return () => clearInterval(t);
  }, []);
  const client = useMemo(() => publicClientFor(evm), []);
  const [direction, setDirection] = useState<Direction>('usdc-to-pusd');
  const [amount, setAmount] = useState('5');
  const [evmWallet, setEvmWallet] = useState<{ wallet: WalletClient; address: Address }>();
  const [quotes, setQuotes] = useState<{ quote: Quote; event: Event }[]>([]);
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;
  const [rfqState, setRfqState] = useState<{ rfq: Rfq; event: Event }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [swaps, setSwaps] = useState<TakerSwap[]>(() => reviveBigints(loadArray<TakerSwap>('hermes.swaps')));
  // Decimals come from token metadata (ERC-20 decimals() / BCMR), never assumed; undefined until read.
  const [usdcDecimals, setUsdcDecimals] = useState<number>();
  const [pusdDecimals, setPusdDecimals] = useState<number>();
  const pool = useRef(new SimplePool());
  const quoteSub = useRef<{ close: () => void; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const WAITING = 'Waiting for solver quotes…';
  const stopQuotes = () => {
    if (!quoteSub.current) return;
    clearTimeout(quoteSub.current.timer);
    quoteSub.current.close();
    quoteSub.current = undefined;
  };
  useEffect(
    () => () => {
      stopQuotes();
      pool.current.close(settings.relays);
    },
    [],
  );
  // A quote answers one RFQ: changing direction, amount or coin makes any shown quote stale — drop it so a
  // quote for the other direction can never be accepted by mistake.
  useEffect(() => {
    stopQuotes();
    setQuotes([]);
    setRfqState(undefined);
    setBusy((b) => (b === WAITING ? undefined : b));
  }, [direction, amount, coinKey]);
  const bch = localWallet(demoNetwork);
  const ready = !!evm.htlc && !!evm.usdc && !!pusdCfg.category;

  useEffect(() => {
    if (evm.usdc) void tokenDecimals(client, evm.usdc as Address).then(setUsdcDecimals).catch(() => undefined);
  }, []);

  useEffect(() => {
    let live = true;
    setPusdDecimals(undefined);
    if (pusdCfg.category)
      void getTokenMeta(pusdCfg.category, { symbol: pusdCfg.symbol, decimals: pusdCfg.decimalsFallback })
        .then((m) => live && setPusdDecimals(m.decimals))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pusdCfg.category]);

  const persist = (next: TakerSwap[]) => {
    setSwaps(next);
    save('hermes.swaps', next);
  };
  const update = (id: string, f: (s: TakerSwap) => TakerSwap) => persist(swapsRef.current.map((s) => (s.quote.quoteId === id ? f(s) : s)));
  const swapsRef = useRef(swaps);
  swapsRef.current = swaps;

  async function requestQuotes() {
    setError(undefined);
    stopQuotes(); // quotes for an earlier RFQ must not land in this one's list
    setQuotes([]);
    try {
      if (!ready) throw new Error('Swap contracts are not configured yet (EVM HTLC, USDC, tPUSD category in config/networks.json).');
      if (usdcDecimals === undefined || pusdDecimals === undefined) throw new Error('Token decimals not loaded yet (EVM RPC / token metadata unreachable) — try again in a moment.');
      const w = evmWallet ?? (await connectEvm(evm));
      setEvmWallet(w);
      const decIn = direction === 'usdc-to-pusd' ? usdcDecimals : pusdDecimals;
      const rfq: Rfq = {
        v: 1,
        id: binToHex(crypto.getRandomValues(new Uint8Array(16))),
        direction,
        amountIn: parseUnits(amount, decIn).toString(),
        evmChainId: evm.chainId,
        evmToken: evm.usdc!,
        bchToken: pusdCfg.category!,
        takerEvm: w.address,
        takerBch: bch.tokenAddress,
        takerBchPkh: bch.pkh,
        expiry: now() + 120,
      };
      const ev = await ensureLocalNostr().signEvent(rfqTemplate(rfq));
      setRfqState({ rfq, event: ev });
      setBusy(WAITING);
      // Subscribe BEFORE publishing the RFQ: quotes are ephemeral events (kind 25911) that relays do not
      // store, so a solver answering faster than our subscription is established would be missed.
      const sub = pool.current.subscribeMany(settings.relays, quoteFilter(ev.id), {
        onevent: (qe) => {
          const { quote, errors } = parseQuote(qe, rfq);
          if (quote) setQuotes((qs) => (qs.some((x) => x.quote.quoteId === quote.quoteId) ? qs : [...qs, { quote, event: qe }]));
          else console.warn('quote rejected', errors);
        },
      });
      quoteSub.current = {
        close: () => sub.close(),
        timer: setTimeout(() => {
          stopQuotes();
          // Only clear our own message: an accept() in progress owns `busy` by then.
          setBusy((b) => {
            if (b === WAITING && quotesRef.current.length === 0)
              setError(`No solver answered within 25 s on ${settings.relays.length} relay(s). Is a solver running (pnpm --filter solver dev) and listening on the same relays as Settings?`);
            return b === WAITING ? undefined : b;
          });
        }, 25_000),
      };
      await Promise.allSettled(pool.current.publish(settings.relays, ev));
    } catch (e) {
      setError((e as Error).message);
      setBusy(undefined);
    }
  }

  function bchHtlc(s: TakerSwap) {
    const takerLocksBch = s.rfq.direction === 'pusd-to-usdc';
    return htlcContract(
      {
        recipientPkh: takerLocksBch ? s.quote.solverBchPkh : s.rfq.takerBchPkh,
        refundPkh: takerLocksBch ? s.rfq.takerBchPkh : s.quote.solverBchPkh,
        hashlock: s.state.hashlock,
        timeout: takerLocksBch ? s.quote.tFirst : s.quote.tSecond,
      },
      provider(demoNetwork),
    );
  }

  async function accept(q: { quote: Quote; event: Event }) {
    if (!rfqState) return;
    setError(undefined);
    stopQuotes();
    setBusy('Locking the first leg…');
    try {
      const { secret, hashlock } = generateSecret();
      let s: TakerSwap = {
        rfq: rfqState.rfq,
        quote: q.quote,
        solverPubkey: q.event.pubkey,
        secret,
        bchSymbol: pusdCfg.symbol,
        state: initialState({ direction: q.quote.direction, hashlock, tFirst: q.quote.tFirst, tSecond: q.quote.tSecond, quoteExpiry: q.quote.expiry }),
        log: [`accepted quote ${q.quote.quoteId.slice(0, 8)}: ${q.quote.amountIn} → ${q.quote.amountOut}`],
      };
      let ref: string;
      if (q.quote.direction === 'usdc-to-pusd') {
        const w = evmWallet ?? (await connectEvm(evm));
        const { id, txHash } = await evmLock({ wallet: w.wallet, client, htlc: evm.htlc as Address, token: evm.usdc as Address, amount: BigInt(q.quote.amountIn), recipient: q.quote.solverEvm as Address, hashlock: `0x${hashlock}`, timeout: BigInt(q.quote.tFirst) });
        s.evmLockId = id;
        ref = id;
        s.evmTxs = [{ label: 'USDC lock', hash: txHash }];
        s.log.push(`USDC locked on ${evm.name}: ${txHash}`);
      } else {
        const c = bchHtlc(s);
        const p = provider(demoNetwork);
        const utxos = [...(await p.getUtxos(bch.address)), ...(await p.getUtxos(bch.tokenAddress))] as S[];
        const tx = await buildLock({ provider: p, contract: c, from: bch.address, utxos, token: { category: s.rfq.bchToken, amount: BigInt(q.quote.amountIn) }, signer: bch.signer }).send();
        s.bchLockTxid = tx.txid;
        ref = `${tx.txid}:0`;
        s.log.push(`${pusdCfg.symbol} locked on BCH ${demoNetwork}: ${tx.txid}`);
      }
      s.state = apply(s.state, { type: 'first-locked', ref, at: now() });
      const notice = await ensureLocalNostr().signEvent(noticeTemplate({ v: 1, quoteId: q.quote.quoteId, hashlock, chain: q.quote.direction === 'usdc-to-pusd' ? 'evm' : 'bch', ref }, q.event.pubkey));
      await Promise.allSettled(pool.current.publish(settings.relays, notice));
      persist([s, ...swapsRef.current]);
      setQuotes([]);
      setRfqState(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  // Watch active swaps: detect the solver's lock, claim, offer refunds.
  useEffect(() => {
    const t = setInterval(() => void tick(), 10_000);
    void tick();
    return () => clearInterval(t);
  }, []);

  async function tick() {
    for (const s of swapsRef.current) {
      try {
        if (s.state.phase === 'second-locked' || s.state.phase === 'second-claimed') {
          // Reload-safe: read both legs and apply only facts that are certain (our claim found on-chain,
          // the solver claimed our lock → completed, the solver refunded after T_second).
          const p = provider(demoNetwork);
          const o = await observeTakerSwap(
            { direction: s.rfq.direction, hashlock: s.state.hashlock, secret: s.secret, evmLockId: s.evmLockId, bchHtlcAddress: bchHtlc(s).tokenAddress },
            {
              evmLockState: async (id) => (await readLock(client, evm.htlc as Address, id as Hex)).state,
              bchLocked: async (a) => ((await p.getUtxos(a)) as S[]).some((x) => x.token?.category === s.rfq.bchToken && !x.token.nft),
              bchPreimage: async (a, h) => (await findBchPreimage(p, a, h))?.secret,
            },
          );
          const facts = takerFacts(s.state, o, now());
          if (facts.length)
            update(s.quote.quoteId, (x) => {
              const next = applyAll(x.state, facts);
              const notes = facts.map((f) =>
                f.type === 'first-claimed' ? 'solver claimed your lock with the revealed secret — swap complete ✔' : f.type === 'second-refunded' ? 'solver refunded its lock after T_second — refund yours after T_first' : `observed on-chain: ${f.type}`,
              );
              return next === x.state ? x : { ...x, state: next, log: [...x.log, ...notes] };
            });
          continue;
        }
        if (s.state.phase === 'first-locked') {
          if (s.rfq.direction === 'usdc-to-pusd') {
            const c = bchHtlc(s);
            const u = ((await provider(demoNetwork).getUtxos(c.tokenAddress)) as S[]).find((x) => x.token?.category === s.rfq.bchToken && x.token.amount >= BigInt(s.quote.amountOut));
            if (u) update(s.quote.quoteId, (x) => ({ ...x, state: apply(x.state, { type: 'second-locked', ref: u.txid, at: now() }), log: [...x.log, `solver locked tPUSD: ${u.txid}`] }));
          } else {
            const locks = await findEvmLocks(client, evm.htlc as Address, { recipient: s.rfq.takerEvm as Address });
            const l = locks.find((x) => x.hashlock.slice(2).toLowerCase() === s.state.hashlock && x.amount >= BigInt(s.quote.amountOut) && Number(x.timeout) >= s.quote.tSecond - 120);
            if (l) update(s.quote.quoteId, (x) => ({ ...x, evmLockId: l.id, state: apply(x.state, { type: 'second-locked', ref: l.id, at: now() }), log: [...x.log, `solver locked USDC: ${l.id.slice(0, 18)}…`] }));
          }
        }
      } catch (e) {
        console.warn(e);
      }
    }
  }

  async function claim(s: TakerSwap) {
    setBusy('Claiming…');
    setError(undefined);
    try {
      let tx: string;
      if (s.rfq.direction === 'usdc-to-pusd') {
        const c = bchHtlc(s);
        const p = provider(demoNetwork);
        const utxo = ((await p.getUtxos(c.tokenAddress)) as S[]).find((x) => x.token?.category === s.rfq.bchToken && !x.token.nft && x.token.amount >= BigInt(s.quote.amountOut));
        if (!utxo) throw new Error('The solver’s BCH lock was not found at the HTLC address (spent already, or not confirmed yet).');
        tx = (await buildClaim({ provider: p, contract: c, utxo, recipient: bch.signer, recipientTokenAddr: bch.tokenAddress, preimage: s.secret }).send()).txid;
      } else {
        const w = evmWallet ?? (await connectEvm(evm));
        tx = await evmClaim({ wallet: w.wallet, client, htlc: evm.htlc as Address, id: s.evmLockId as Hex, preimage: `0x${s.secret}` });
      }
      const evmTx = s.rfq.direction === 'pusd-to-usdc' ? [{ label: 'USDC claim', hash: tx }] : [];
      update(s.quote.quoteId, (x) => ({ ...x, claimTx: tx, evmTxs: [...(x.evmTxs ?? []), ...evmTx], state: apply(x.state, { type: 'second-claimed', secret: x.secret, at: now() }), log: [...x.log, `claimed (secret revealed): ${tx}`] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  async function refund(s: TakerSwap) {
    setBusy('Refunding…');
    setError(undefined);
    try {
      let tx: string;
      if (s.rfq.direction === 'usdc-to-pusd') {
        const w = evmWallet ?? (await connectEvm(evm));
        tx = await evmRefund({ wallet: w.wallet, client, htlc: evm.htlc as Address, id: s.evmLockId as Hex });
      } else {
        const c = bchHtlc(s);
        const p = provider(demoNetwork);
        const utxo = ((await p.getUtxos(c.tokenAddress)) as S[]).find((x) => x.token?.category === s.rfq.bchToken && !x.token.nft);
        if (!utxo) throw new Error('Your BCH lock was not found at the HTLC address (already claimed or refunded?).');
        tx = (await buildRefund({ provider: p, contract: c, utxo, timeout: s.quote.tFirst, refunder: bch.signer, refundTokenAddr: bch.tokenAddress }).send()).txid;
      }
      const evmTx = s.rfq.direction === 'usdc-to-pusd' ? [{ label: 'USDC refund', hash: tx }] : [];
      update(s.quote.quoteId, (x) => ({ ...x, refundTx: tx, evmTxs: [...(x.evmTxs ?? []), ...evmTx], state: apply(x.state, { type: 'first-refunded', at: now() }), log: [...x.log, `refunded: ${tx}`] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const decOut = (d: Direction) => (d === 'usdc-to-pusd' ? pusdDecimals : usdcDecimals);
  const fmtOut = (v: string, d: Direction) => {
    const dec = decOut(d);
    return dec === undefined ? `${v} base units` : formatUnits(BigInt(v), dec);
  };
  const symOut = (d: Direction, sym = pusdCfg.symbol) => (d === 'usdc-to-pusd' ? sym : 'USDC');
  const symIn = (d: Direction, sym = pusdCfg.symbol) => (d === 'usdc-to-pusd' ? 'USDC' : sym);
  const solverRecord = (pubkey: string) => {
    const st = solverStats(swaps, pubkey);
    return st.total === 0 ? 'new solver to you' : `${st.completed} completed${st.refunded ? `, ${st.refunded} refunded` : ''} of ${st.total} swap(s) with you`;
  };
  const ranked = rankQuoteEntries(quotes);
  const evmTxUrl = (h: string) => `${evm.explorerTx}${h}`;
  const finished = swaps.filter((s) => nextAction(s.state, 'taker', clock).do === 'nothing');
  const decs = (d: Direction) => (d === 'usdc-to-pusd' ? [usdcDecimals, pusdDecimals] : [pusdDecimals, usdcDecimals]);
  const exportCsv = () =>
    downloadText(`hermes-swaps-${new Date().toISOString().slice(0, 10)}.csv`, swapHistoryCsv(swaps, { usdcDecimals, pusdDecimals, bchSymbol: pusdCfg.symbol }), 'text/csv');

  return (
    <div className="stack">
      <div className="hero small">
        <h2>Hermes Swap</h2>
        <p>
          USDC on {evm.name} for PUSD on Bitcoin Cash. One secret unlocks a time-locked contract on each chain: both sides settle, or both
          refund. No bridge, no custodian.
        </p>
        <p className="row wrap small">
          <NetBadge network={demoNetwork} /> <span className="net net-evm">{evm.name.toUpperCase()}</span>
          <span className="muted">Testnets only. Demo amounts.</span>
        </p>
      </div>

      <SwapSimulator />

      {!ready && (
        <Status kind="info">
          Live swaps on this deployment need {[!evm.htlc && 'the EVM HTLC address', !evm.usdc && 'the USDC address', !pusdCfg.category && `a tPUSD category on ${demoNetwork}`].filter(Boolean).join(', ')} and a running solver.
          The simulator above runs the same flow end to end.
        </Status>
      )}

      <Card title="New swap">
        <div className="row wrap">
          <div className="seg">
            <button className={direction === 'usdc-to-pusd' ? 'on' : ''} onClick={() => setDirection('usdc-to-pusd')}>
              USDC → PUSD
            </button>
            <button className={direction === 'pusd-to-usdc' ? 'on' : ''} onClick={() => setDirection('pusd-to-usdc')}>
              PUSD → USDC
            </button>
          </div>
          <input className="amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <span>{symIn(direction)}</span>
          {coins.length > 1 && (
            <select value={coinKey} onChange={(e) => setCoinKey(e.target.value)} aria-label="BCH stablecoin">
              {coins.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.symbol}
                </option>
              ))}
            </select>
          )}
          <button className="primary" onClick={() => void requestQuotes()} disabled={!!busy && busy !== WAITING}>
            Get quotes
          </button>
        </div>
        <p className="muted small">
          BCH side uses this browser’s {demoNetwork} key {short(bch.tokenAddress, 18, 6)}. EVM side uses your injected wallet
          {evmWallet ? ` (${short(evmWallet.address, 8, 4)})` : ''}.
        </p>
        {busy && <Status kind="info">{busy}</Status>}
        {error && <Status kind="err">{error}</Status>}
        {ranked.map((q, i) => {
          const left = q.quote.expiry - clock;
          return (
            <div key={q.quote.quoteId} className="quote">
              <div>
                <b>
                  {fmtOut(q.quote.amountOut, q.quote.direction)} {symOut(q.quote.direction)}
                </b>{' '}
                {i === 0 && <span className="pill pill-ok">best</span>}{' '}
                <span className="muted small">
                  fee {((1_000_000 - Number(q.quote.ratePpm)) / 1e4).toFixed(2)}% · your lock refundable after {countdown(q.quote.tFirst - clock)} · solver’s lock{' '}
                  {countdown(q.quote.tSecond - clock)}
                </span>
                {(() => {
                  const [di, dout] = decs(q.quote.direction);
                  return di !== undefined && dout !== undefined ? (
                    <div className="muted">
                      <FeeBreakdown compact amountIn={BigInt(q.quote.amountIn)} amountOut={BigInt(q.quote.amountOut)} decimalsIn={di} decimalsOut={dout} symIn={symIn(q.quote.direction)} symOut={symOut(q.quote.direction)} />
                    </div>
                  ) : null;
                })()}
                <div className="muted small">
                  solver <code className="mono">{short(nip19.npubEncode(q.event.pubkey), 12, 6)}</code> · {solverRecord(q.event.pubkey)} ·{' '}
                  <span className={left > 0 && left <= 15 ? 'warn' : ''}>{left > 0 ? `quote valid ${countdown(left)}` : 'quote expired'}</span>
                </div>
              </div>
              <button className="primary small" onClick={() => void accept(q)} disabled={(!!busy && busy !== WAITING) || left <= 0}>
                Accept & lock
              </button>
            </div>
          );
        })}
      </Card>

      {swaps.length > 0 && (
        <div className="row wrap">
          <h3 style={{ margin: 0 }}>Your swaps ({swaps.length})</h3>
          {finished.length > 0 && (
            <button
              className="small"
              onClick={() => confirm(`Remove ${finished.length} finished swap(s) from this browser? Active swaps are kept.`) && persist(swaps.filter((s) => !finished.includes(s)))}
            >
              Clear finished
            </button>
          )}
          <button className="small" onClick={exportCsv} title="Download your swap history as CSV (stays on this device)">
            Export CSV
          </button>
        </div>
      )}
      {swaps.map((s) => {
        const action = nextAction(s.state, 'taker', clock);
        const sym = s.bchSymbol ?? pusdCfg.symbol;
        return (
          <Card
            key={s.quote.quoteId}
            title={`${fmtOut(s.quote.amountIn, s.rfq.direction === 'usdc-to-pusd' ? 'pusd-to-usdc' : 'usdc-to-pusd')} ${symIn(s.rfq.direction, sym)} → ${fmtOut(s.quote.amountOut, s.rfq.direction)} ${symOut(s.rfq.direction, sym)}`}
            aside={<span className="pill">{s.state.phase}</span>}
          >
            <Steps phase={s.state.phase} />
            {(() => {
              const [di, dout] = decs(s.rfq.direction);
              return di !== undefined && dout !== undefined ? (
                <div className="muted">
                  <FeeBreakdown compact amountIn={BigInt(s.quote.amountIn)} amountOut={BigInt(s.quote.amountOut)} decimalsIn={di} decimalsOut={dout} symIn={symIn(s.rfq.direction, sym)} symOut={symOut(s.rfq.direction, sym)} />
                </div>
              ) : null;
            })()}
            {action.do !== 'nothing' && <TimeoutLadder now={clock} start={Math.min(clock, s.state.tSecond - 3600)} tFirst={s.state.tFirst} tSecond={s.state.tSecond} margin={SAFETY_MARGIN_SECONDS} />}
            {takerTimeline(s.state, clock).length > 0 && <p className="muted small">{takerTimeline(s.state, clock).join(' · ')}</p>}
            <ol className="log">
              {s.log.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ol>
            <div className="row wrap">
              {action.do === 'claim' && (
                <button className="primary" onClick={() => void claim(s)} disabled={!!busy}>
                  Claim {symOut(s.rfq.direction, sym)} (claim window closes in {countdown(s.state.tSecond - ACTION_MARGIN_SECONDS - clock)})
                </button>
              )}
              {action.do === 'refund' && (
                <button onClick={() => void refund(s)} disabled={!!busy || clock < action.notBefore}>
                  {clock < action.notBefore ? `Refund ${symIn(s.rfq.direction, sym)} in ${countdown(action.notBefore - clock)}` : `Refund ${symIn(s.rfq.direction, sym)}`}
                </button>
              )}
              {action.do === 'wait' && <span className="muted small">{action.reason}</span>}
              {s.state.phase === 'completed' && <span className="pill pill-ok">complete — both legs settled</span>}
            </div>
            <div className="row wrap small">
              {s.bchLockTxid && <TxLink network={demoNetwork} txid={s.bchLockTxid} label="BCH lock" />}
              {s.claimTx && s.rfq.direction === 'usdc-to-pusd' && <TxLink network={demoNetwork} txid={s.claimTx} label="BCH claim" />}
              {s.refundTx && s.rfq.direction === 'pusd-to-usdc' && <TxLink network={demoNetwork} txid={s.refundTx} label="BCH refund" />}
              {(s.evmTxs ?? []).map((t) => (
                <a key={t.hash} className="mono" href={evmTxUrl(t.hash)} target="_blank" rel="noreferrer">
                  {t.label}
                </a>
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Steps({ phase }: { phase: SwapState['phase'] }) {
  const order = ['quoted', 'first-locked', 'second-locked', 'second-claimed', 'completed'];
  const labels = ['Quote', 'You lock', 'Solver locks', 'You claim (secret revealed)', 'Solver claims'];
  const at = order.indexOf(phase === 'completed' ? 'completed' : phase);
  const refunded = phase.includes('refund');
  return (
    <div className="steps">
      {labels.map((l, i) => (
        <span key={l} className={refunded ? 'step' : i <= at ? 'step done' : 'step'}>
          {l}
        </span>
      ))}
      {refunded && <span className="step warn">Refunded</span>}
    </div>
  );
}
