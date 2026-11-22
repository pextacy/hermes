import type { Event, EventTemplate } from 'nostr-tools/pure';
import type { VerifiedBinding } from './binding.js';

/**
 * NIP-39 style cross-reference in the Nostr profile (kind 0): ["i", "<cashaddr>", <binding event id>] — a cashaddr
 * (bitcoincash:q…) is already in NIP-39 platform:identity form.
 * Purely informational for other clients — Hermes verifies the binding event itself, never this tag.
 * Existing profile content and unrelated tags are preserved.
 */
export const NIP39_PLATFORMS = ['bitcoincash', 'bchtest'];
/** A cashaddr already has the NIP-39 `platform:identity` shape (bitcoincash:q…). */
const isOurs = (v: string) => NIP39_PLATFORMS.some((p) => v.startsWith(`${p}:`));

export function nip39ProfileTemplate(current: Event | undefined, binding: VerifiedBinding): EventTemplate {
  const keep = (current?.tags ?? []).filter((t) => !(t[0] === 'i' && typeof t[1] === 'string' && isOurs(t[1])));
  return {
    kind: 0,
    created_at: Math.max(Math.floor(Date.now() / 1000), (current?.created_at ?? 0) + 1),
    tags: [...keep, ['i', binding.addr, binding.event.id]],
    content: current?.content ?? '{}',
  };
}

export function nip39Claims(profile: Event | undefined): { addr: string; proof?: string }[] {
  return (profile?.tags ?? [])
    .filter((t) => t[0] === 'i' && typeof t[1] === 'string' && isOurs(t[1]))
    .map((t) => ({ addr: t[1], proof: t[2] }));
}
