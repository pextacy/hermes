import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';

/** Publish a watcher alert as a public Nostr note (kind 1, #hermesdrops) to the given relays. */
export async function publishAlert(message: string, opts: { relays: string[]; secretKey?: Uint8Array; network: string }) {
  const sk = opts.secretKey ?? generateSecretKey();
  const ev: Event = finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [['t', 'hermesdrops']], content: `Hermes Drops watcher (${opts.network}): ${message}` },
    sk,
  );
  const pool = new SimplePool();
  const results = await Promise.allSettled(pool.publish(opts.relays, ev));
  pool.close(opts.relays);
  return { event: ev, pubkey: getPublicKey(sk), accepted: results.filter((r) => r.status === 'fulfilled').length };
}
