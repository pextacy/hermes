import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Quote, Rfq, SwapState } from '@hermes/swap';

/** Non-secret swap bookkeeping, persisted so the solver can resume and refund after a restart. */
export interface SolverSwap {
  rfq: Rfq;
  quote: Quote;
  rfqEventId: string;
  takerPubkey: string;
  state: SwapState;
  evmLockId?: string; // EVM HTLC lock id (taker's or ours)
  bchHtlcAddress?: string;
  bchLockTxid?: string;
  usdValue: number;
  createdAt: number;
  lastError?: string;
}

const dir = new URL('../data/', import.meta.url);
const file = (network: string) => new URL(`swaps-${network}.json`, dir);
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

export class SwapStore {
  readonly swaps = new Map<string, SolverSwap>();
  constructor(readonly network: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(file(network))) {
      for (const s of JSON.parse(readFileSync(file(network), 'utf8')) as SolverSwap[]) this.swaps.set(s.quote.quoteId, s);
    }
  }
  put(s: SolverSwap) {
    this.swaps.set(s.quote.quoteId, s);
    this.save();
  }
  save() {
    writeFileSync(file(this.network), json([...this.swaps.values()]));
  }
  /** USD committed in the last hour (for the hourly cap). */
  usdLastHour(now: number) {
    return [...this.swaps.values()].filter((s) => now - s.createdAt < 3600 && s.state.phase !== 'aborted').reduce((n, s) => n + s.usdValue, 0);
  }
}
