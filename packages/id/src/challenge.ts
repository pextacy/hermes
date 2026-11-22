import { binToHex } from '@bitauth/libauth';
import type { Event } from 'nostr-tools/pure';
import { canonicalJson, verifyEventFresh } from './canonical.js';
import { AUTH_DOMAIN, AUTH_EVENT_KIND, CHALLENGE_FRESHNESS_SECONDS } from './constants.js';
import { verifyBchProof, type BchProof, type VerifiedBinding } from './binding.js';
import type { BchSigner, NostrSigner } from './signers.js';

export interface Challenge {
  domain: string; // "hermes-auth"
  nonce: string; // 16+ random bytes hex
  ts: number; // unix seconds, issued by verifier
  audience: string; // who is asking, e.g. origin "https://hermes.example"
}

export interface ChallengeResponse {
  challenge: Challenge;
  bch: string;
  bchProof: BchProof;
  nostrEvent: Event; // kind 27235, content = canonical challenge, by the bound Nostr key
}

const randomHex = (bytes: number) => {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return binToHex(b);
};

export function createChallenge(audience: string, now = Math.floor(Date.now() / 1000)): Challenge {
  return { domain: AUTH_DOMAIN, nonce: randomHex(16), ts: now, audience };
}

export async function respondToChallenge(challenge: Challenge, bch: BchSigner, nostr: NostrSigner): Promise<ChallengeResponse> {
  const message = canonicalJson(challenge);
  const bchProof = await bch.prove(message);
  const nostrEvent = await nostr.signEvent({
    kind: AUTH_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['challenge', challenge.nonce], ['audience', challenge.audience]],
    content: message,
  });
  return { challenge, bch: binToHex(await bch.getPublicKey()), bchProof, nostrEvent };
}

export interface NonceStore {
  /** Returns true the first time a nonce is consumed, false afterwards. */
  consume(nonce: string): boolean;
  /** Whether the verifier issued this nonce. */
  issued(nonce: string): boolean;
  issue(nonce: string, ts?: number): void;
  /** Optional: the `ts` the verifier put in the challenge, so a client cannot refresh an old nonce. */
  issuedAt?(nonce: string): number | undefined;
}

/**
 * In-memory nonce store. With `maxAgeSeconds`, entries older than that are pruned on each
 * issue (a pruned nonce is "unknown" — it had expired anyway), so a long-running verifier
 * does not grow without bound.
 */
export class MemoryNonceStore implements NonceStore {
  private readonly issuedMap = new Map<string, number | undefined>();
  private readonly used = new Set<string>();
  constructor(readonly maxAgeSeconds?: number) {}
  issue(nonce: string, ts?: number) {
    if (this.maxAgeSeconds !== undefined) {
      const cutoff = Math.floor(Date.now() / 1000) - this.maxAgeSeconds;
      for (const [n, t] of this.issuedMap) {
        if (t !== undefined && t < cutoff) {
          this.issuedMap.delete(n);
          this.used.delete(n);
        }
      }
    }
    this.issuedMap.set(nonce, ts);
  }
  issued(nonce: string) {
    return this.issuedMap.has(nonce);
  }
  issuedAt(nonce: string) {
    return this.issuedMap.get(nonce);
  }
  get size() {
    return this.issuedMap.size;
  }
  consume(nonce: string) {
    if (this.used.has(nonce)) return false;
    this.used.add(nonce);
    return true;
  }
}

/**
 * Verifier side of challenge-response login. A response is accepted iff both keys
 * signed the exact challenge, the challenge is fresh, the nonce was issued here and
 * is used once, the audience matches, and the keys are the *current* binding.
 */
export class ChallengeVerifier {
  constructor(
    readonly audience: string,
    readonly nonces: NonceStore = new MemoryNonceStore(),
    readonly freshnessSeconds = CHALLENGE_FRESHNESS_SECONDS,
  ) {}

  issue(now?: number): Challenge {
    const challenge = createChallenge(this.audience, now);
    this.nonces.issue(challenge.nonce, challenge.ts);
    return challenge;
  }

  verify(response: ChallengeResponse, currentBinding: VerifiedBinding | undefined, now = Math.floor(Date.now() / 1000)) {
    const reasons: string[] = [];
    const c = response.challenge;
    if (c.domain !== AUTH_DOMAIN) reasons.push('wrong domain');
    if (c.audience !== this.audience) reasons.push('wrong audience');
    if (!this.nonces.issued(c.nonce)) reasons.push('unknown nonce');
    else {
      const at = this.nonces.issuedAt?.(c.nonce);
      if (at !== undefined && at !== c.ts) reasons.push('challenge timestamp altered');
    }
    if (Math.abs(now - c.ts) > this.freshnessSeconds) reasons.push('challenge expired');
    const message = canonicalJson(c);
    const ev = response.nostrEvent;
    if (!verifyEventFresh(ev)) reasons.push('nostr signature invalid');
    if (ev.kind !== AUTH_EVENT_KIND) reasons.push('wrong nostr event kind');
    if (ev.content !== message) reasons.push('nostr event does not sign this challenge');
    reasons.push(...verifyBchProof(response.bchProof, response.bch, message));
    if (!currentBinding || !currentBinding.valid) reasons.push('no current binding for this identity');
    else {
      if (currentBinding.nostr !== ev.pubkey) reasons.push('nostr key is not the current binding');
      if (currentBinding.bch !== response.bch) reasons.push('bch key is not the current binding');
    }
    // Consume last so a malformed attempt cannot burn someone else's nonce… but a
    // correctly signed replay is always rejected.
    if (reasons.length === 0 && !this.nonces.consume(c.nonce)) reasons.push('nonce already used');
    return { ok: reasons.length === 0, reasons, nostr: ev.pubkey, bch: response.bch };
  }
}
