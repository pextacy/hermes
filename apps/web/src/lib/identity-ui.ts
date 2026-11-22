import type { VerifiedBinding } from '@hermes/id';

/** Pure helpers behind the Identity tab (kept out of the component so they are unit-tested). */

/** What changed between two consecutive versions of an identity. */
export function changeLabel(prev: Pick<VerifiedBinding, 'nostr' | 'bch' | 'payload'> | undefined, b: Pick<VerifiedBinding, 'nostr' | 'bch' | 'payload'>): string {
  if (!prev) return 'original binding';
  if (prev.nostr !== b.nostr && prev.bch !== b.bch) return 'both keys changed';
  if (prev.nostr !== b.nostr) return 'Nostr key rotated';
  if (prev.bch !== b.bch) return 'BCH key rotated';
  if (b.payload?.idCategory && b.payload.idCategory !== prev.payload?.idCategory) return 'identity NFT attached';
  return 're-issued';
}

/** NIP-39 status of a profile (claims from `nip39Claims`) against the current binding. */
export function nip39State(
  claims: { addr: string; proof?: string }[],
  current: Pick<VerifiedBinding, 'addr'> & { event: { id: string } },
): { state: 'current' | 'stale' | 'none'; text: string } {
  const mine = claims.find((c) => c.addr === current.addr);
  if (mine) return { state: 'current', text: `Your profile lists ${current.addr}${mine.proof === current.event.id ? ' with this binding event as proof' : ''}.` };
  if (claims.length) return { state: 'stale', text: `Your profile still lists ${claims.map((c) => c.addr).join(', ')} — an older address. Update it.` };
  return { state: 'none', text: 'Not on your profile yet. Other Nostr clients can show the BCH address once you add it (NIP-39 i-tag).' };
}

/** Normalised verifier API base URL, or undefined for "run the verifier in this page". */
export function verifierEndpoint(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  if (/^https?:\/*$/i.test(raw)) throw new Error(`Verifier URL is not a URL: ${raw}`);
  const t = raw.replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(/^https?:\/\//.test(t) ? t : `http://${t}`);
  } catch {
    throw new Error(`Verifier URL is not a URL: ${t}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Verifier URL must be http(s)');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Demo for "Verify any binding": a copy of a binding whose payout address an attacker swapped
 * (one character changed in the content and the tag). Must fail the Nostr signature and the
 * address-derivation checks.
 */
export function tamperedCopy<E extends { content: string; tags: string[][] }>(event: E): E {
  let addr: string | undefined;
  try {
    addr = (JSON.parse(event.content) as { payload?: { addr?: string } }).payload?.addr;
  } catch {
    /* not a binding */
  }
  if (!addr) return { ...event, content: `${event.content} ` };
  const last = addr.slice(-1);
  const swapped = addr.slice(0, -1) + (last === 'q' ? 'p' : 'q');
  return {
    ...event,
    content: event.content.split(addr).join(swapped),
    tags: event.tags.map((t) => t.map((x) => x.split(addr!).join(swapped))),
  };
}
