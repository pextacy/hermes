import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  CHALLENGE_FRESHNESS_SECONDS,
  ChallengeVerifier,
  Discovery,
  MemoryNonceStore,
  bindingReport,
  bindingVerdict,
  identityNftStatus,
  looksLikeEvent,
  networkOfAddress,
  npubOf,
  verifyChain,
  type BchNetwork,
  type ChallengeResponse,
  type NftStatus,
  type ResolvedIdentity,
  type TokenUtxoLike,
} from '@hermes/id';

/** UTXO lookup for the identity NFT pin (Electrum in production, the BCH VM in tests). */
export type NftUtxoLookup = (tokenAddr: string, network: BchNetwork) => Promise<TokenUtxoLike[]>;

/**
 * Hermes ID verification API — the "identity verification API for wallets" from the PRD.
 * Stateless except for challenge nonces; every answer is recomputed from relay data, so a
 * wallet can also run the same library locally instead of trusting this server.
 *
 *   GET  /resolve?q=<npub|name@domain|cashaddr>   current verified binding + warnings (+ identity NFT pin)
 *   POST /verify[?offline=1] {event}               report for a raw binding event: `ok` = signatures and
 *                                                   rotation chain valid; `status` = valid | stale | invalid
 *                                                   (stale = relays hold a newer version; skipped offline)
 *   POST /challenge                                 challenge for challenge-response login
 *   POST /challenge/verify  {response}              verdict (keys must be the *current* binding)
 */
export function createVerifierServer(opts: { audience: string; discovery?: Discovery; maxBody?: number; nftUtxos?: NftUtxoLookup }) {
  const discovery = opts.discovery ?? new Discovery();
  // Nonces older than twice the freshness window are pruned (they are expired anyway).
  const verifier = new ChallengeVerifier(opts.audience, new MemoryNonceStore(CHALLENGE_FRESHNESS_SECONDS * 2));
  const maxBody = opts.maxBody ?? 256_000;
  const hits = new Map<string, number[]>();

  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  };
  const body = (req: IncomingMessage) =>
    new Promise<unknown>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) reject(new Error('body too large'));
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
    });
  const limited = (ip: string) => {
    const t = Date.now();
    const list = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
    list.push(t);
    hits.set(ip, list);
    return list.length > 60;
  };
  /** Identity NFT status over every token address in the chain; undefined when no lookup / no NFT. */
  const nftOf = async (i: ResolvedIdentity): Promise<NftStatus | undefined> => {
    const cat = i.current.payload?.idCategory;
    const network = networkOfAddress(i.current.addr);
    if (!opts.nftUtxos || !cat || !network) return undefined;
    const addrs = [...new Set(i.chain.map((b) => b.tokenAddr))];
    try {
      const lists = await Promise.all(addrs.map(async (a) => (await opts.nftUtxos!(a, network)).map((u) => ({ ...u, address: a }))));
      return identityNftStatus(i.chain, lists.flat());
    } catch {
      return { state: 'missing', category: cat, current: i.current.seq, message: 'identity NFT lookup failed (Electrum unreachable)', needsSync: false };
    }
  };
  const summary = (i: ResolvedIdentity, nft?: NftStatus) => ({
    npub: npubOf(i.current.nostr),
    nostr: i.current.nostr,
    bch: i.current.bch,
    addr: i.current.addr,
    tokenAddr: i.current.tokenAddr,
    version: i.current.seq,
    firstSeen: i.firstSeen,
    rotations: i.chain.length - 1,
    payable: i.payable,
    warnings: i.warnings,
    ...(nft ? { nft } : {}),
    event: i.current.event,
  });

  return createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204, null);
      if (limited(req.socket.remoteAddress ?? '?')) return send(res, 429, { error: 'rate limited' });
      const url = new URL(req.url ?? '/', 'http://local');
      if (req.method === 'GET' && url.pathname === '/resolve') {
        const q = url.searchParams.get('q');
        if (!q) return send(res, 400, { error: 'q required' });
        let r = await discovery.resolve(q);
        if (!r.identity) return send(res, 404, { error: r.error, relaysAnswered: r.answered });
        const nft = await nftOf(r.identity);
        // The NFT pins an older version than relays show: payers must follow the pin.
        if (nft?.state === 'behind' && nft.pinned !== undefined) {
          const pinned = await discovery.resolve(q, { pinnedSeq: () => nft.pinned });
          if (pinned.identity) r = pinned;
        }
        return send(res, 200, { ...summary(r.identity!, nft), relaysAnswered: r.answered });
      }
      if (req.method === 'POST' && url.pathname === '/verify') {
        const b = (await body(req)) as { event?: unknown };
        if (!b.event) return send(res, 400, { error: 'event required' });
        if (!looksLikeEvent(b.event)) return send(res, 400, { error: 'event is not a Nostr event (id, pubkey, sig, kind, created_at, tags, content)' });
        const event = b.event;
        const report = bindingReport(event);
        let current: { seq?: number; eventId?: string; error?: string } | undefined;
        if (report.ok && url.searchParams.get('offline') !== '1') {
          // Is this the identity's current version? Resolve its own lineage on relays.
          const verdict = verifyChain(event);
          const me = verdict.chain[verdict.chain.length - 1];
          try {
            const r = await discovery.resolve(me.nostr);
            if (r.identity && r.identity.genesisHash === verdict.chain[0].payloadHash) current = { seq: r.identity.current.seq, eventId: r.identity.current.event.id };
            else current = { error: r.error ?? 'identity not found on relays' };
          } catch (e) {
            current = { error: (e as Error).message };
          }
        }
        const v = bindingVerdict(event, { currentSeq: current?.seq });
        return send(res, 200, { ...report, status: v.status, headline: v.headline, reasons: v.reasons, summary: v.summary, ...(current ? { current } : {}) });
      }
      if (req.method === 'POST' && url.pathname === '/challenge') return send(res, 200, verifier.issue());
      if (req.method === 'POST' && url.pathname === '/challenge/verify') {
        const b = (await body(req)) as { response?: ChallengeResponse };
        const response = b.response;
        if (!response?.nostrEvent?.pubkey) return send(res, 400, { error: 'response required' });
        if (!response.challenge || typeof response.challenge !== 'object' || typeof response.bch !== 'string') return send(res, 400, { error: 'response must have challenge, bch, bchProof, nostrEvent' });
        const r = await discovery.resolve(response.nostrEvent.pubkey);
        return send(res, 200, verifier.verify(response, r.identity?.current));
      }
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, { service: 'hermes-id verifier', endpoints: ['/resolve', '/verify', '/challenge', '/challenge/verify'] });
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  });
}
