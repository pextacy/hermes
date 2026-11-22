/**
 * Dev relay core (see scripts/dev-relay.ts).
 * pnpm dev:relay — minimal in-memory Nostr relay (NIP-01: EVENT, REQ, CLOSE; replaceable kinds)
 * for local demos and browser tests, so nothing is published to public relays.
 *   pnpm dev:relay -- --ports 7001,7002,7003
 * Then in the web app: Settings → relays ws://localhost:7001 ws://localhost:7002 ws://localhost:7003.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyEvent, type Event, type Filter } from 'nostr-tools';

export function startDevRelay(ports: number[]) {
const events = new Map<string, Event>();
const servers: WebSocketServer[] = [];

const matches = (e: Event, f: Filter) =>
  (!f.ids || f.ids.includes(e.id)) &&
  (!f.kinds || f.kinds.includes(e.kind)) &&
  (!f.authors || f.authors.includes(e.pubkey)) &&
  (!f.since || e.created_at >= f.since) &&
  (!f.until || e.created_at <= f.until) &&
  Object.entries(f).every(([k, v]) => !k.startsWith('#') || e.tags.some((t) => t[0] === k.slice(1) && (v as string[]).includes(t[1])));

function store(e: Event) {
  const replaceable = e.kind === 0 || e.kind === 3 || (e.kind >= 10000 && e.kind < 20000);
  const param = e.kind >= 30000 && e.kind < 40000;
  if (e.kind >= 20000 && e.kind < 30000) return; // ephemeral: forward only
  for (const [id, o] of events) {
    const d = (x: Event) => x.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    if (o.pubkey === e.pubkey && o.kind === e.kind && (replaceable || (param && d(o) === d(e)))) {
      if (o.created_at > e.created_at) return;
      events.delete(id);
    }
  }
  events.set(e.id, e);
}

const subs = new Set<{ ws: WebSocket; id: string; filters: Filter[] }>();
for (const port of ports) {
  const wss = new WebSocketServer({ port });
  servers.push(wss);
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg[0] === 'EVENT') {
        const e = msg[1] as Event;
        const ok = verifyEvent(e);
        ws.send(JSON.stringify(['OK', e.id, ok, ok ? '' : 'invalid: bad signature']));
        if (!ok) return;
        store(e);
        for (const s of subs) if (s.filters.some((f) => matches(e, f))) s.ws.send(JSON.stringify(['EVENT', s.id, e]));
      } else if (msg[0] === 'REQ') {
        const [, id, ...filters] = msg as [string, string, ...Filter[]];
        for (const e of [...events.values()].sort((a, b) => b.created_at - a.created_at)) if (filters.some((f) => matches(e, f))) ws.send(JSON.stringify(['EVENT', id, e]));
        ws.send(JSON.stringify(['EOSE', id]));
        subs.add({ ws, id, filters });
      } else if (msg[0] === 'CLOSE') {
        for (const s of subs) if (s.ws === ws && s.id === msg[1]) subs.delete(s);
      }
    });
    ws.on('close', () => {
      for (const s of subs) if (s.ws === ws) subs.delete(s);
    });
  });
}
return { urls: servers.map((_, i) => `ws://127.0.0.1:${ports[i]}`), close: () => servers.forEach((s) => s.close()), events };
}
