import { binToHex } from '@bitauth/libauth';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure';
import { createWalletClient, http, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ElectrumNetworkProvider, Utxo } from 'cashscript';
import { HERMES, NETWORKS, type BchNetwork, type KeyWallet } from '@hermes/chain';
import {
  QUOTE_EXPIRY_SECONDS,
  apply,
  buildClaim,
  buildLock,
  buildRefund,
  convert,
  defaultTimeouts,
  erc20Abi,
  evmChain,
  evmClaim,
  evmConfig,
  evmLock,
  evmRefund,
  findBchPreimage,
  findEvmLocks,
  findEvmPreimage,
  htlcContract,
  initialState,
  nextAction,
  noticeFilter,
  parseNotice,
  parseRfq,
  publicClientFor,
  quoteTemplate,
  readLock,
  rfqFilter,
  tokenDecimals,
  validateTimeouts,
  type EvmKey,
  type Quote,
  type Rfq,
} from '@hermes/swap';
import { SwapStore, type SolverSwap } from './store.js';

type S = Utxo & { lockingBytecode: string };

export interface SolverOptions {
  bchNetwork: BchNetwork;
  evm: EvmKey;
  provider: ElectrumNetworkProvider;
  bch: KeyWallet;
  evmPrivateKey: Hex;
  nostrSecret: Uint8Array;
  /** BCH stablecoins this solver makes markets in (PUSD, MoriaUSD, …). */
  bchTokens: { category: string; decimals: number; symbol: string }[];
  evmHtlc: Address;
  usdc: Address;
  /** RPC URL override for the EVM chain (default: config/networks.json). */
  evmRpc?: string;
  spreadPpm: number;
  relays?: string[];
  /** How often to advance swaps (ms). Default 15 s. */
  tickMs?: number;
  /** Bookkeeping file name (apps/solver/data/swaps-<name>.json). */
  storeName?: string;
  log?: (s: string) => void;
}

const now = () => Math.floor(Date.now() / 1000);

export class Solver {
  readonly store: SwapStore;
  readonly pool = new SimplePool();
  readonly relays: string[];
  readonly nostrPubkey: string;
  readonly client: PublicClient;
  readonly wallet: WalletClient;
  readonly evmAddress: Address;
  usdcDecimals = 6;
  private log: (s: string) => void;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(readonly o: SolverOptions) {
    this.store = new SwapStore(o.storeName ?? `${o.bchNetwork}-${o.evm}`);
    this.relays = o.relays ?? NETWORKS.nostr.relays;
    this.nostrPubkey = getPublicKey(o.nostrSecret);
    const cfg = { ...evmConfig(o.evm), ...(o.evmRpc ? { rpc: o.evmRpc } : {}) };
    this.client = publicClientFor(cfg);
    const account = privateKeyToAccount(o.evmPrivateKey);
    this.evmAddress = account.address;
    this.wallet = createWalletClient({ account, chain: evmChain(cfg), transport: http(cfg.rpc) });
    this.log = o.log ?? ((s) => console.log(`${new Date().toISOString()} ${s}`));
  }

  private get capped() {
    return this.o.bchNetwork === 'mainnet' || !HERMES.swap.testnetUnlimited;
  }

  async start() {
    this.usdcDecimals = await tokenDecimals(this.client, this.o.usdc);
    this.log(`solver ${this.nostrPubkey.slice(0, 12)}… evm ${this.evmAddress} bch ${this.o.bch.tokenAddress}; USDC decimals ${this.usdcDecimals}`);
    this.pool.subscribeMany(this.relays, rfqFilter(), { onevent: (ev) => void this.onRfq(ev).catch((e) => this.log(`rfq error: ${e.message}`)) });
    this.pool.subscribeMany(this.relays, noticeFilter(this.nostrPubkey), { onevent: (ev) => void this.onNotice(ev) });
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 15_000);
    await this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.pool.close(this.relays);
  }

  private token(category: string) {
    return this.o.bchTokens.find((t) => t.category === category);
  }

  async inventory(category: string) {
    const tokens = (await this.o.provider.getUtxos(this.o.bch.tokenAddress)) as S[];
    const bchToken = tokens.filter((u) => u.token?.category === category && !u.token.nft).reduce((n, u) => n + u.token!.amount, 0n);
    const usdc = await this.client.readContract({ address: this.o.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [this.evmAddress] });
    return { bchToken, usdc };
  }

  quoteFor(rfq: Rfq): { quote?: Quote; usd: number; reason?: string } {
    const amountIn = BigInt(rfq.amountIn);
    const ratePpm = BigInt(1_000_000 - this.o.spreadPpm);
    const tok = this.token(rfq.bchToken);
    if (!tok) return { usd: 0, reason: 'unsupported BCH token' };
    const [decIn, decOut] = rfq.direction === 'usdc-to-pusd' ? [this.usdcDecimals, tok.decimals] : [tok.decimals, this.usdcDecimals];
    const amountOut = convert(amountIn, decIn, decOut, ratePpm);
    const gross = convert(amountIn, decIn, decOut, 1_000_000n);
    const usd = Number(amountIn) / 10 ** decIn;
    if (amountOut <= 0n) return { usd, reason: 'amount too small' };
    if (rfq.evmChainId !== evmConfig(this.o.evm).chainId) return { usd, reason: 'other chain' };
    if (rfq.evmToken.toLowerCase() !== this.o.usdc.toLowerCase()) return { usd, reason: 'other EVM token' };
    if (this.capped && usd > HERMES.swap.solverCapUsdPerSwap) return { usd, reason: 'over per-swap cap' };
    if (this.capped && this.store.usdLastHour(now()) + usd > HERMES.swap.solverCapUsdPerHour) return { usd, reason: 'over hourly cap' };
    const { tFirst, tSecond } = defaultTimeouts();
    const quote: Quote = {
      v: 1,
      rfqId: rfq.id,
      quoteId: binToHex(globalThis.crypto.getRandomValues(new Uint8Array(16))),
      direction: rfq.direction,
      amountIn: rfq.amountIn,
      amountOut: amountOut.toString(),
      ratePpm: ratePpm.toString(),
      feeOut: (gross - amountOut).toString(),
      tFirst,
      tSecond,
      solverEvm: this.evmAddress,
      solverBch: this.o.bch.tokenAddress,
      solverBchPkh: this.o.bch.pkh,
      evmHtlc: this.o.evmHtlc,
      evmChainId: rfq.evmChainId,
      expiry: now() + QUOTE_EXPIRY_SECONDS,
    };
    const errs = validateTimeouts(quote.tFirst, quote.tSecond);
    if (errs.length) return { usd, reason: errs.join('; ') };
    return { quote, usd };
  }

  async onRfq(ev: Event) {
    const { rfq, errors } = parseRfq(ev);
    if (!rfq) return;
    if (errors.length) return;
    if ([...this.store.swaps.values()].some((s) => s.rfq.id === rfq.id)) return;
    const { quote, usd, reason } = this.quoteFor(rfq);
    if (!quote) return this.log(`rfq ${rfq.id.slice(0, 8)} skipped: ${reason}`);
    const inv = await this.inventory(rfq.bchToken);
    const out = BigInt(quote.amountOut);
    if (rfq.direction === 'usdc-to-pusd' ? inv.bchToken < out : inv.usdc < out) return this.log(`rfq ${rfq.id.slice(0, 8)} skipped: inventory`);
    const signed = finalizeEvent(quoteTemplate(quote, ev), this.o.nostrSecret);
    await Promise.allSettled(this.pool.publish(this.relays, signed));
    this.store.put({
      rfq,
      quote,
      rfqEventId: ev.id,
      takerPubkey: ev.pubkey,
      state: initialState({ direction: rfq.direction, hashlock: '', tFirst: quote.tFirst, tSecond: quote.tSecond, quoteExpiry: quote.expiry }),
      usdValue: usd,
      createdAt: now(),
    });
    this.log(`quoted ${rfq.direction} ${rfq.amountIn} → ${quote.amountOut} (${quote.quoteId.slice(0, 8)})`);
  }

  async onNotice(ev: Event) {
    const n = parseNotice(ev);
    if (!n) return;
    const s = this.store.swaps.get(n.quoteId);
    if (!s || s.takerPubkey !== ev.pubkey || s.state.phase !== 'quoted') return;
    s.state = { ...s.state, hashlock: n.hashlock.toLowerCase() };
    if (n.chain === 'evm') s.evmLockId = n.ref;
    this.store.put(s);
    this.log(`notice for ${n.quoteId.slice(0, 8)}: ${n.chain} lock ${n.ref.slice(0, 18)}…`);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const s of this.store.swaps.values()) {
        try {
          await this.advance(s);
        } catch (e) {
          s.lastError = (e as Error).message.slice(0, 300);
          this.log(`swap ${s.quote.quoteId.slice(0, 8)}: ${s.lastError}`);
        }
      }
      this.store.save();
    } finally {
      this.busy = false;
    }
  }

  /** HTLC on BCH for this swap. usdc-to-pusd: solver locks for the taker; pusd-to-usdc: taker locks for the solver. */
  private bchHtlc(s: SolverSwap) {
    const solverIsInitiator = s.rfq.direction === 'usdc-to-pusd';
    return htlcContract(
      {
        recipientPkh: solverIsInitiator ? s.rfq.takerBchPkh : this.o.bch.pkh,
        refundPkh: solverIsInitiator ? this.o.bch.pkh : s.rfq.takerBchPkh,
        hashlock: s.state.hashlock,
        timeout: solverIsInitiator ? s.quote.tSecond : s.quote.tFirst,
      },
      this.o.provider,
    );
  }

  private async observeFirstLock(s: SolverSwap): Promise<string | undefined> {
    if (s.rfq.direction === 'usdc-to-pusd') {
      const locks = await findEvmLocks(this.client, this.o.evmHtlc, { recipient: this.evmAddress });
      for (const l of locks) {
        if (s.evmLockId && l.id !== s.evmLockId) continue;
        // One EVM lock pays for exactly one swap: never counter-lock again for a lock another swap already
        // owns (otherwise stale quotes from the same taker, same amount, would each get a BCH lock with the
        // same hashlock — and one secret would claim all of them).
        if ([...this.store.swaps.values()].some((o) => o !== s && o.evmLockId?.toLowerCase() === l.id.toLowerCase())) continue;
        if (l.sender.toLowerCase() !== s.rfq.takerEvm.toLowerCase() || l.token.toLowerCase() !== this.o.usdc.toLowerCase()) continue;
        // The taker locks with exactly this quote's T_first; a lock made for another quote has another timeout.
        if (l.amount < BigInt(s.quote.amountIn) || Math.abs(Number(l.timeout) - s.quote.tFirst) > 120) continue;
        const onchain = await readLock(this.client, this.o.evmHtlc, l.id);
        if (onchain.state !== 'locked') continue;
        const confirmations = evmConfig(this.o.evm).confirmations;
        const block = await this.client.getBlockNumber();
        const lockBlock = l.blockNumber;
        if (block - lockBlock + 1n < BigInt(confirmations)) return undefined;
        s.evmLockId = l.id;
        s.state = { ...s.state, hashlock: l.hashlock.slice(2).toLowerCase() };
        return l.id;
      }
      return undefined;
    }
    if (!s.state.hashlock) return undefined; // taker must tell us the hashlock (notice)
    const c = this.bchHtlc(s);
    const utxos = (await this.o.provider.getUtxos(c.tokenAddress)) as S[];
    const lock = utxos.find((u) => u.token?.category === s.rfq.bchToken && u.token.amount >= BigInt(s.quote.amountIn) && !u.token.nft);
    if (!lock) return undefined;
    s.bchHtlcAddress = c.tokenAddress;
    return `${lock.txid}:${lock.vout}`;
  }

  async advance(s: SolverSwap): Promise<void> {
    const t = now();
    const phase = s.state.phase;
    if (phase === 'quoted') {
      const ref = await this.observeFirstLock(s);
      if (ref) {
        s.state = apply(s.state, { type: 'first-locked', ref, at: Math.min(t, s.state.quoteExpiry) });
        this.log(`${s.quote.quoteId.slice(0, 8)} first leg locked (${ref.slice(0, 18)}…)`);
      } else if (t > s.state.quoteExpiry + 600) {
        s.state = apply(s.state, { type: 'quote-expired', at: t });
      }
      return;
    }
    const action = nextAction(s.state, 'solver', t);
    if (action.do === 'lock') {
      if (s.rfq.direction === 'usdc-to-pusd') {
        const c = this.bchHtlc(s);
        const utxos = [...(await this.o.provider.getUtxos(this.o.bch.address)), ...(await this.o.provider.getUtxos(this.o.bch.tokenAddress))] as S[];
        const tx = await buildLock({ provider: this.o.provider, contract: c, from: this.o.bch.address, utxos, token: { category: s.rfq.bchToken, amount: BigInt(s.quote.amountOut) }, signer: this.o.bch.signer }).send();
        s.bchHtlcAddress = c.tokenAddress;
        s.bchLockTxid = tx.txid;
        s.state = apply(s.state, { type: 'second-locked', ref: tx.txid, at: t });
        this.log(`${s.quote.quoteId.slice(0, 8)} ${this.token(s.rfq.bchToken)?.symbol} locked on BCH ${tx.txid}`);
      } else {
        const { id } = await evmLock({ wallet: this.wallet, client: this.client, htlc: this.o.evmHtlc, token: this.o.usdc, amount: BigInt(s.quote.amountOut), recipient: s.rfq.takerEvm as Address, hashlock: `0x${s.state.hashlock}`, timeout: BigInt(s.quote.tSecond) });
        s.evmLockId = id;
        s.state = apply(s.state, { type: 'second-locked', ref: id, at: t });
        this.log(`${s.quote.quoteId.slice(0, 8)} USDC locked on EVM ${id}`);
      }
      return;
    }
    if (phase === 'second-locked') {
      // Did the taker claim the second leg (revealing the secret)?
      let secret: string | undefined;
      if (s.rfq.direction === 'usdc-to-pusd') secret = (await findBchPreimage(this.o.provider, s.bchHtlcAddress!, s.state.hashlock))?.secret;
      else secret = (await findEvmPreimage(this.client, this.o.evmHtlc, s.evmLockId as Hex))?.slice(2);
      if (secret) {
        s.state = apply(s.state, { type: 'second-claimed', secret, at: Math.min(t, s.state.tSecond - 1) });
        this.log(`${s.quote.quoteId.slice(0, 8)} secret revealed`);
        return this.advance(s);
      }
    }
    if (action.do === 'claim') {
      if (s.rfq.direction === 'usdc-to-pusd') {
        await evmClaim({ wallet: this.wallet, client: this.client, htlc: this.o.evmHtlc, id: s.evmLockId as Hex, preimage: `0x${s.state.secret}` });
      } else {
        const c = this.bchHtlc(s);
        const [utxo] = (await this.o.provider.getUtxos(c.tokenAddress)) as S[];
        await buildClaim({ provider: this.o.provider, contract: c, utxo, recipient: this.o.bch.signer, recipientTokenAddr: this.o.bch.tokenAddress, preimage: s.state.secret! }).send();
      }
      s.state = apply(s.state, { type: 'first-claimed', at: t });
      this.log(`${s.quote.quoteId.slice(0, 8)} completed ✔`);
      return;
    }
    if (action.do === 'refund' && t >= action.notBefore) {
      if (s.rfq.direction === 'usdc-to-pusd') {
        const c = this.bchHtlc(s);
        const [utxo] = (await this.o.provider.getUtxos(c.tokenAddress)) as S[];
        if (utxo) await buildRefund({ provider: this.o.provider, contract: c, utxo, timeout: s.quote.tSecond, refunder: this.o.bch.signer, refundTokenAddr: this.o.bch.tokenAddress }).send();
        else {
          // Empty HTLC: either we already refunded (restart) or the taker claimed in the meantime.
          // Never mark it refunded if the secret is on-chain — we still have to claim the USDC leg.
          const found = await findBchPreimage(this.o.provider, s.bchHtlcAddress!, s.state.hashlock);
          if (found?.secret) {
            s.state = apply(s.state, { type: 'second-claimed', secret: found.secret, at: Math.min(t, s.state.tSecond - 1) });
            this.log(`${s.quote.quoteId.slice(0, 8)} secret revealed (late)`);
            return this.advance(s);
          }
        }
      } else {
        await evmRefund({ wallet: this.wallet, client: this.client, htlc: this.o.evmHtlc, id: s.evmLockId as Hex });
      }
      s.state = apply(s.state, { type: 'second-refunded', at: t });
      this.log(`${s.quote.quoteId.slice(0, 8)} second leg refunded`);
    }
  }
}
