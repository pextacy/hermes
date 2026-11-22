import { tokenConfig, type BchNetwork } from './config.js';

export interface TokenMeta {
  category: string;
  symbol: string;
  name?: string;
  decimals: number;
  source: 'bcmr' | 'config';
}

const BCMR_INDEXERS = ['https://bcmr.paytaca.com/api/tokens/'];
const metaCache = new Map<string, TokenMeta>();

/**
 * Token metadata. Decimals are read from BCMR metadata (Paytaca indexer); the config value
 * is only a fallback when no indexer answers — amounts are always integer base units.
 * BCMR answers are data, not instructions: only `symbol`, `name`, `decimals` are read.
 */
export async function getTokenMeta(category: string, fallback?: { symbol: string; decimals: number }): Promise<TokenMeta> {
  const cached = metaCache.get(category);
  if (cached) return cached;
  for (const base of BCMR_INDEXERS) {
    try {
      const res = await fetch(`${base}${category}/`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const j = (await res.json()) as { name?: unknown; token?: { symbol?: unknown; decimals?: unknown } };
      // Only a real number (or an all-digit string) counts: Number(null) / Number('') would be 0,
      // silently assuming 0 decimals for a token that has none declared.
      const raw = j.token?.decimals;
      const decimals = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) continue;
      const meta: TokenMeta = {
        category,
        symbol: typeof j.token?.symbol === 'string' ? j.token.symbol.slice(0, 16) : (fallback?.symbol ?? 'TOKEN'),
        name: typeof j.name === 'string' ? j.name.slice(0, 64) : undefined,
        decimals,
        source: 'bcmr',
      };
      metaCache.set(category, meta);
      return meta;
    } catch {
      /* try next */
    }
  }
  if (!fallback) throw new Error(`No metadata for token ${category}`);
  const meta: TokenMeta = { category, symbol: fallback.symbol, decimals: fallback.decimals, source: 'config' };
  metaCache.set(category, meta);
  return meta;
}

export async function getConfiguredToken(network: BchNetwork, symbol: 'PUSD' | 'FLDCH'): Promise<TokenMeta | undefined> {
  const cfg = tokenConfig(network, symbol);
  if (!cfg.category) return undefined;
  return getTokenMeta(cfg.category, { symbol: cfg.symbol, decimals: cfg.decimalsFallback });
}

/** Parse a decimal string ("1.25") into integer base units. Rejects excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount "${value}"`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`too many decimals (max ${decimals})`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export const SATS_PER_BCH = 100_000_000n;
export const parseBch = (v: string) => parseUnits(v, 8);
export const formatBch = (v: bigint) => formatUnits(v, 8);
