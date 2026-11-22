import type { DistroUser } from './sources.js';

/**
 * Folding@home daily user summary (https://apps.foldingathome.org/daily_user_summary.txt.bz2):
 *   line 1: date · line 2: header "name\tnewcredit\tsum(total)\tteam" · then one row per user.
 * FoldingCash participants put a BCH address in their F@H user name; a distribution for a window
 * is the credit gained between two snapshots, shared proportionally. These rules mirror the
 * public FoldingCash API and are an alternative, fully independent input for the watcher.
 */
export interface FahRow {
  name: string;
  credit: bigint;
  workUnits: bigint;
  team: number;
}

export function parseFahSummary(text: string): FahRow[] {
  const rows: FahRow[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue;
    const [name, credit, wus, team] = line.split('\t');
    if (!name || !/^\d+$/.test(credit ?? '') || !/^\d+$/.test(wus ?? '')) continue;
    rows.push({ name, credit: BigInt(credit), workUnits: BigInt(wus), team: Number(team ?? 0) });
  }
  return rows;
}

const CASHADDR = /(?:bitcoincash:)?(q[02-9ac-hj-np-z]{41}|z[02-9ac-hj-np-z]{41})/i;
// Not \b: user names often join the address with '_' (a word character).
const LEGACY = /(?:^|[^1-9A-HJ-NP-Za-km-z])(1[1-9A-HJ-NP-Za-km-z]{25,34})(?![1-9A-HJ-NP-Za-km-z])/;

/** Extract the payout address a user embedded in their F@H name (cashaddr preferred, legacy accepted). */
export function addressFromFahName(name: string): Pick<DistroUser, 'bitcoinCashAddress' | 'bitcoinAddress'> | undefined {
  const c = name.match(CASHADDR);
  if (c) return { bitcoinCashAddress: `bitcoincash:${c[1].toLowerCase()}` };
  const l = name.match(LEGACY);
  if (l) return { bitcoinAddress: l[1] };
  return undefined;
}

/** Distribution of `amount` tokens over the credit gained between two snapshots (optionally one team). */
export function distroFromFahSnapshots(start: FahRow[], end: FahRow[], amount: number, team?: number): DistroUser[] {
  const before = new Map(start.map((r) => [`${r.name}\t${r.team}`, r]));
  const gains: { addr: NonNullable<ReturnType<typeof addressFromFahName>>; credit: bigint; wus: bigint }[] = [];
  for (const r of end) {
    if (team !== undefined && r.team !== team) continue;
    const addr = addressFromFahName(r.name);
    if (!addr) continue;
    const b = before.get(`${r.name}\t${r.team}`);
    const credit = r.credit - (b?.credit ?? 0n);
    if (credit <= 0n) continue;
    gains.push({ addr, credit, wus: r.workUnits - (b?.workUnits ?? 0n) });
  }
  const total = gains.reduce((n, g) => n + g.credit, 0n);
  if (total === 0n) return [];
  return gains.map((g) => ({ ...g.addr, amount: (Number(g.credit) / Number(total)) * amount, pointsGained: Number(g.credit), workUnitsGained: Number(g.wus) }));
}

/** Fetch and decompress a summary file (bz2). */
export async function fetchFahSummary(url = 'https://apps.foldingathome.org/daily_user_summary.txt.bz2'): Promise<FahRow[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`F@H ${res.status}`);
  const { default: Bunzip } = await import('seek-bzip');
  const text = (Bunzip as { decode(b: Buffer): Uint8Array }).decode(Buffer.from(await res.arrayBuffer()));
  return parseFahSummary(new TextDecoder().decode(text));
}
