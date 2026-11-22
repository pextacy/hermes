import { binToHex, cashAddressToLockingBytecode, decodeBase58Address, encodeLockingBytecodeP2pkh, encodeLockingBytecodeP2sh20 } from '@bitauth/libauth';
import type { Entitlement } from './merkle.js';

/**
 * Entitlement sources. FoldingCash computes its distribution from the public Folding@home
 * stats; Hermes Drops treats that distribution as *trusted input* and only makes payout
 * trust-minimised (anyone can recompute and audit a pending root during the timelock).
 */
export interface DistroUser {
  amount: number; // whole tokens (FoldingCash API returns decimals)
  bitcoinAddress?: string | null;
  bitcoinCashAddress?: string | null;
  cashTokensAddress?: string | null;
  pointsGained?: number;
  workUnitsGained?: number;
}

export const FOLDINGCASH_API = 'https://api.folding.cash';

const fmt = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}-${d.getUTCFullYear()}`;

/** FoldingCash distribution for a window (GET /v1/GetDistro). Response is data: only known fields are read. */
export async function fetchFoldingCashDistro(start: Date, end: Date, amount: number): Promise<DistroUser[]> {
  const url = `${FOLDINGCASH_API}/v1/GetDistro?startDate=${fmt(start)}&endDate=${fmt(end)}&amount=${amount}&includeFoldingUserTypes=15`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`FoldingCash API ${res.status}`);
  const j = (await res.json()) as { success?: boolean; distro?: unknown[] };
  if (!j.success || !Array.isArray(j.distro)) throw new Error('FoldingCash API returned no distribution');
  return j.distro.map((d) => {
    const o = d as Record<string, unknown>;
    const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
    return {
      amount: typeof o.amount === 'number' && Number.isFinite(o.amount) ? o.amount : 0,
      bitcoinAddress: s('bitcoinAddress'),
      bitcoinCashAddress: s('bitcoinCashAddress'),
      cashTokensAddress: s('cashTokensAddress'),
      pointsGained: typeof o.pointsGained === 'number' ? o.pointsGained : undefined,
      workUnitsGained: typeof o.workUnitsGained === 'number' ? o.workUnitsGained : undefined,
    };
  });
}

/** Locking bytecode for a distro user (cashTokens > bitcoinCash > legacy base58, same hash160). */
export function lockingBytecodeForUser(u: DistroUser): string | undefined {
  for (const a of [u.cashTokensAddress, u.bitcoinCashAddress]) {
    if (!a) continue;
    const withPrefix = a.includes(':') ? a : `bitcoincash:${a}`;
    const r = cashAddressToLockingBytecode(withPrefix);
    if (typeof r !== 'string') return binToHex(r.bytecode);
  }
  if (u.bitcoinAddress) {
    const d = decodeBase58Address(u.bitcoinAddress);
    if (typeof d !== 'string') {
      if (d.version === 0) return binToHex(encodeLockingBytecodeP2pkh(d.payload));
      if (d.version === 5) return binToHex(encodeLockingBytecodeP2sh20(d.payload));
    }
  }
  return undefined;
}

/**
 * Append-only account registry: an address gets the next id the first time it appears and
 * keeps it forever (ids decide shard and bitmap bit, so they must never move).
 */
export class AccountRegistry {
  private readonly ids = new Map<string, number>();
  constructor(initial: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(initial)) this.ids.set(k, v);
  }
  idFor(lockingBytecode: string): number {
    let id = this.ids.get(lockingBytecode);
    if (id === undefined) {
      id = this.ids.size;
      this.ids.set(lockingBytecode, id);
    }
    return id;
  }
  toJSON(): Record<string, number> {
    return Object.fromEntries(this.ids);
  }
  get size() {
    return this.ids.size;
  }
}

/**
 * Exact number → base units (truncating extra digits). Goes through the number's shortest decimal
 * string so 0.29 at 8 decimals is 29000000, not the 28999999 that `Math.floor(0.29 * 1e8)` yields.
 */
export function decimalToUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(amount));
  if (!m) return 0n;
  const digits = m[1] + (m[2] ?? '');
  const point = m[1].length + Number(m[3] ?? 0) + decimals; // position of the decimal point after scaling
  if (point <= 0) return 0n;
  const int = point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point);
  return BigInt(int);
}

/**
 * Fold epoch distributions into cumulative entitlements (base units). `previous` holds the
 * cumulative totals already committed in earlier roots; cumulative values only grow.
 */
export function accumulate(
  previous: Map<string, bigint>,
  distro: DistroUser[],
  decimals: number,
  registry: AccountRegistry,
): { entries: Entitlement[]; cumulative: Map<string, bigint>; skipped: number } {
  const cumulative = new Map(previous);
  let skipped = 0;
  for (const u of distro) {
    const lb = lockingBytecodeForUser(u);
    const units = decimalToUnits(u.amount, decimals);
    if (!lb || units <= 0n) {
      skipped++;
      continue;
    }
    cumulative.set(lb, (cumulative.get(lb) ?? 0n) + units);
  }
  const entries = [...cumulative.entries()]
    .map(([lockingBytecode, c]) => ({ lockingBytecode, cumulative: c, accountId: registry.idFor(lockingBytecode) }))
    .sort((a, b) => a.accountId - b.accountId);
  return { entries, cumulative, skipped };
}

/**
 * Deterministic sample for the chipnet demo when fewer real members exist than the
 * 300–500 leaves the bounty asks for: real FoldingCash members first, then synthetic
 * leaves with documented, reproducible amounts (seeded hash of the index).
 */
export function padWithSample(entries: Entitlement[], target: number, registry: AccountRegistry, prefixByte = 0xa9): Entitlement[] {
  const out = [...entries];
  let i = 0;
  while (out.length < target) {
    const pkh = new Uint8Array(20);
    let x = (i + 1) * 2654435761;
    for (let k = 0; k < 20; k++) {
      x = (x ^ (x >>> 13)) * 1274126177;
      pkh[k] = (x >>> 24) & 0xff;
    }
    pkh[0] = prefixByte;
    const lockingBytecode = binToHex(encodeLockingBytecodeP2pkh(pkh));
    out.push({ lockingBytecode, cumulative: BigInt(100 + ((i * 7919) % 50_000)), accountId: registry.idFor(lockingBytecode) });
    i++;
  }
  return out;
}

/**
 * Add demo addresses (e.g. the team's chipnet test wallets) to a tree with a fixed cumulative
 * amount, so a live demo can claim. Documented alongside the sample padding; never on mainnet.
 */
export function includeAddresses(entries: Entitlement[], addresses: string[], cumulative: bigint, registry: AccountRegistry): Entitlement[] {
  const out = [...entries];
  for (const a of addresses) {
    const r = cashAddressToLockingBytecode(a.trim());
    if (typeof r === 'string') throw new Error(`bad address ${a}: ${r}`);
    const lockingBytecode = binToHex(r.bytecode);
    if (out.some((e) => e.lockingBytecode === lockingBytecode)) continue;
    out.push({ lockingBytecode, cumulative, accountId: registry.idFor(lockingBytecode) });
  }
  return out;
}
