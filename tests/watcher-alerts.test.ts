import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { verifyEventFresh } from '@hermes/id';
import { publishAlert } from '../apps/watcher/src/alerts';

/** Minimal NIP-01 relay: stores EVENTs and answers OK. */
let wss: WebSocketServer;
const received: any[] = [];
let url: string;
beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (sock) => {
    sock.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg[0] === 'EVENT') {
        received.push(msg[1]);
        sock.send(JSON.stringify(['OK', msg[1].id, true, '']));
      }
    });
  });
  await new Promise((r) => wss.on('listening', r));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
});
afterAll(() => wss.close());

describe('watcher Nostr alerts', () => {
  it('publishes a signed #hermesdrops note to the relays', async () => {
    const r = await publishAlert('shard 0 epoch 3: pending root mismatch', { relays: [url], network: 'chipnet' });
    expect(r.accepted).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe(1);
    expect(received[0].tags).toContainEqual(['t', 'hermesdrops']);
    expect(received[0].content).toContain('pending root mismatch');
    expect(verifyEventFresh(received[0])).toBe(true);
  });
});
