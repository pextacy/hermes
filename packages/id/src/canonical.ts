import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Canonical JSON: object keys sorted (recursively), no whitespace, UTF-8.
 * `undefined` members are dropped. Non-finite numbers and bigints are rejected
 * so that every party serialises the same payload byte for byte.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): Json {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return value;
    case 'object': {
      if (Array.isArray(value)) return value.map(normalise);
      const out: { [key: string]: Json } = {};
      for (const key of Object.keys(value as object).sort()) {
        const member = (value as Record<string, unknown>)[key];
        if (member === undefined) continue;
        out[key] = normalise(member);
      }
      return out;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export const sha256Hex = (data: string | Uint8Array): string =>
  bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));

export const sha256Bytes = (data: string | Uint8Array): Uint8Array =>
  sha256(typeof data === 'string' ? utf8ToBytes(data) : data);

import { verifyEvent, type Event } from 'nostr-tools/pure';

/**
 * Verify a Nostr event's id and signature from scratch. nostr-tools caches a "verified"
 * flag on the event object (a symbol property that survives object spread), so a mutated
 * copy of a previously verified event would otherwise pass. Always verify a clean copy.
 */
export function verifyEventFresh(ev: Event): boolean {
  if (!ev || typeof ev !== 'object') return false;
  const { id, pubkey, created_at, kind, tags, content, sig } = ev;
  try {
    return verifyEvent({ id, pubkey, created_at, kind, tags: JSON.parse(JSON.stringify(tags)), content, sig } as Event);
  } catch {
    return false;
  }
}
