/** localStorage helpers that never throw (private windows, blocked storage). */
export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x)));
  } catch {
    /* ignore */
  }
}
export function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
export const reviveBigints = <T,>(v: T): T =>
  JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === 'string' && /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));

/** A stored enum value; anything else (corrupted or stale storage) falls back. */
export function loadChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = load<unknown>(key, fallback);
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** A stored list; a non-array (corrupted storage) yields `[]` instead of crashing the tab. */
export function loadArray<T>(key: string): T[] {
  const v = load<unknown>(key, []);
  return Array.isArray(v) ? (v as T[]) : [];
}
