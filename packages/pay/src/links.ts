import { encrypt as nip04Encrypt } from 'nostr-tools/nip04';
import { queryProfile } from 'nostr-tools/nip05';
import { PAYMENT_NOTE_TAG } from './extras.js';
import type { EventTemplate } from 'nostr-tools/pure';

/**
 * Shareable pay link: <origin>/#pay?to=<npub|name>&amount=<decimal>&asset=BCH|PUSD|<token category>&memo=<text>
 * `asset` is BCH, PUSD, or the 64-hex category id of any other fungible CashToken.
 */
export interface PayLink {
  to: string;
  amount?: string;
  asset?: 'BCH' | 'PUSD' | (string & {});
  memo?: string;
}

/** BCH / PUSD / a lowercase 64-hex CashToken category; anything else is dropped. */
export function parsePayAsset(v: string | null | undefined): PayLink['asset'] | undefined {
  if (v === 'BCH' || v === 'PUSD') return v;
  if (v && /^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase();
  return undefined;
}

export function payLinkUrl(origin: string, l: PayLink): string {
  const q = new URLSearchParams({ to: l.to });
  if (l.amount) q.set('amount', l.amount);
  if (l.asset) q.set('asset', l.asset);
  if (l.memo) q.set('memo', l.memo);
  return `${origin.replace(/\/$/, '')}/#pay?${q.toString()}`;
}

/** Parse the query part of a #pay?… hash. Values are untrusted user input: validated, never executed. */
export function parsePayLink(hash: string): PayLink | undefined {
  const i = hash.indexOf('?');
  if (i < 0) return undefined;
  const q = new URLSearchParams(hash.slice(i + 1));
  const to = q.get('to')?.trim();
  if (!to || to.length > 200) return undefined;
  const amount = q.get('amount') ?? undefined;
  const asset = parsePayAsset(q.get('asset'));
  return {
    to,
    amount: amount && /^\d+(\.\d+)?$/.test(amount) ? amount : undefined,
    asset,
    memo: q.get('memo')?.replace(/[^\x20-\x7e]/g, '').slice(0, 64) || undefined,
  };
}

/** NIP-05: does `name@domain` point at this pubkey right now? (`checkNip05` also says why not.) */
export async function verifyNip05(name: string | undefined, pubkey: string): Promise<boolean> {
  if (!name) return false;
  try {
    const p = await queryProfile(name);
    return p?.pubkey === pubkey;
  } catch {
    return false;
  }
}

/** Plaintext of a payment note (what `parsePaymentNote` reads back on the recipient's side). */
export function paymentNoteText(args: { amount: string; asset: string; txid: string; memo?: string }): string {
  return `Hermes Pay: sent you ${args.amount} ${args.asset}${args.memo ? ` (ref: ${args.memo})` : ''}. Transaction ${args.txid}`;
}

/** Unencrypted parts of a payment note event; `content` is filled with the NIP-04 ciphertext. */
export function paymentNoteEvent(recipientPubkey: string, content: string): EventTemplate {
  return {
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', recipientPubkey],
      ['t', PAYMENT_NOTE_TAG],
    ],
    content,
  };
}

/**
 * Encrypted payment note to the recipient (NIP-04 direct message, the most widely supported
 * DM format). Contains only what the payer chose to share: amount, asset, txid, reference.
 */
export async function paymentNoteTemplate(args: {
  senderSecret: Uint8Array;
  recipientPubkey: string;
  amount: string;
  asset: string;
  txid: string;
  memo?: string;
}): Promise<EventTemplate> {
  return paymentNoteEvent(args.recipientPubkey, await nip04Encrypt(args.senderSecret, args.recipientPubkey, paymentNoteText(args)));
}
