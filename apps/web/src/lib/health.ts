import { MIN_RELAYS } from './settings';

/** One relay or Electrum server being probed. */
export type Probe<T> = { target: string; state: 'checking' | 'ok' | 'down'; value?: T };
export interface Connectivity {
  relays: Probe<true>[];
  electrum: Probe<number>[];
  checkedAt?: number;
  recheck: () => void;
}

/**
 * Header dot colour from the probe results: ok when enough relays for discovery and at least one Electrum
 * server answer; err when no relay or no Electrum server answers; warn in between; checking before any result.
 */
export function overall(c: Pick<Connectivity, 'relays' | 'electrum'>, minRelays = MIN_RELAYS): 'ok' | 'warn' | 'err' | 'checking' {
  const all = [...c.relays, ...c.electrum];
  if (!all.length || all.every((p) => p.state === 'checking')) return 'checking';
  const relaysUp = c.relays.filter((p) => p.state === 'ok').length;
  const electrumUp = c.electrum.some((p) => p.state === 'ok');
  const pending = all.some((p) => p.state === 'checking');
  if (!pending && (!electrumUp || (c.relays.length > 0 && relaysUp === 0))) return 'err';
  return relaysUp >= Math.min(minRelays, c.relays.length) && electrumUp ? 'ok' : 'warn';
}

/** Electrum servers more than `lag` blocks behind the best tip seen (stale or forked server). */
export const behind = (electrum: Probe<number>[], lag = 2) => {
  const tip = Math.max(0, ...electrum.map((p) => p.value ?? 0));
  return new Set(electrum.filter((p) => p.state === 'ok' && (p.value ?? 0) < tip - lag).map((p) => p.target));
};
