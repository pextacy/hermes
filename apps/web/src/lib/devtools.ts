/**
 * Developers-tab tools (Round 3, G29–G35). Pure logic only — the React components in
 * components/dev/ are thin views over these functions, and tests/round3-dev.test.ts covers them.
 */
import { binToHex, hexToBin } from '@bitauth/libauth';
import { getEventHash, serializeEvent, type Event, type EventTemplate } from 'nostr-tools/pure';
import {
  AUTH_DOMAIN,
  AUTH_EVENT_KIND,
  BCH_MESSAGE_PREFIX,
  BINDING_D_TAG,
  BINDING_DOMAIN,
  BINDING_KIND,
  BINDING_VERSION,
  ROTATION_EVENT_KIND,
  TAG_ADDR,
  TAG_BCHPK,
  TAG_GENESIS,
  TAG_PREV,
  bchMessageHash,
  bindingEventTemplate,
  canonicalJson,
  nip39ProfileTemplate,
  type VerifiedBinding,
  lockingBytecodeForAddress,
  payloadHash,
  payloadMessage,
  rotationApprovalTemplate,
  sha256Hex,
  type BindingContent,
  type BindingPayload,
} from '@hermes/id';
import { NOTICE_KIND, QUOTE_KIND, RFQ_KIND, SWAP_TAG, noticeTemplate, quoteTemplate, rfqTemplate, type Quote, type Rfq } from '@hermes/swap';
import { PAYMENT_NOTE_TAG, paymentNoteEvent } from '@hermes/pay';
import { encodeLE, leafHash } from '@hermes/drops';

// ───────────────────────────── G33 hashlock ─────────────────────────────

const HEX = /^[0-9a-f]*$/;
/** Normalise user hex: trims, drops 0x, lower-cases; throws on odd length / non-hex. */
export function cleanHex(input: string, bytes?: number): string {
  const h = input.trim().replace(/^0x/i, '').toLowerCase();
  if (!HEX.test(h)) throw new Error('not hex');
  if (h.length % 2) throw new Error('odd number of hex digits');
  if (bytes !== undefined && h.length !== bytes * 2) throw new Error(`expected ${bytes} bytes, got ${h.length / 2}`);
  return h;
}

export function newSecret(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return binToHex(b);
}

/** SHA-256 of the secret *bytes* (not its hex text) — what both HTLCs check (OP_SHA256 / sha256()). */
export function hashlockOf(secretHex: string): string {
  return sha256Hex(hexToBin(cleanHex(secretHex)));
}

export type PreimageCheck = { ok: true; computed: string } | { ok: false; computed?: string; reason: string };
export function checkPreimage(preimageHex: string, hashlockHex: string): PreimageCheck {
  let pre: string, lock: string;
  try {
    pre = cleanHex(preimageHex);
  } catch (e) {
    return { ok: false, reason: `preimage: ${(e as Error).message}` };
  }
  try {
    lock = cleanHex(hashlockHex, 32);
  } catch (e) {
    return { ok: false, reason: `hashlock: ${(e as Error).message}` };
  }
  const computed = hashlockOf(pre);
  if (computed === lock) return pre.length === 64 ? { ok: true, computed } : { ok: false, computed, reason: 'matches, but Hermes HTLCs require a 32-byte secret' };
  return { ok: false, computed, reason: 'SHA-256(preimage) does not equal the hashlock' };
}

// ───────────────────────────── G32 canonical payload explorer ─────────────────────────────

export interface SignedMessage {
  key: string;
  scheme: string;
  message: string;
  digest: string;
  note: string;
}
export interface PayloadExploration {
  /** What was pasted: a bare payload, binding content ({payload, bchProof}) or a whole Nostr event. */
  input: 'payload' | 'content' | 'event';
  payload: BindingPayload;
  canonical: string;
  payloadHash: string;
  signed: SignedMessage[];
  warnings: string[];
}

const PAYLOAD_KEYS = ['domain', 'v', 'seq', 'nostr', 'bch', 'addr', 'tokenAddr', 'ts', 'prev'] as const;

export function explorePayload(text: string): PayloadExploration {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected a JSON object');
  let input: PayloadExploration['input'] = 'payload';
  let event: Event | undefined;
  let content: Partial<BindingContent> | undefined;
  let obj = raw as Record<string, unknown>;
  if (typeof obj.content === 'string' && typeof obj.kind === 'number') {
    input = 'event';
    event = obj as unknown as Event;
    try {
      obj = JSON.parse(event.content);
    } catch {
      throw new Error('Event content is not JSON (not a Hermes binding event)');
    }
  }
  if (obj.payload && typeof obj.payload === 'object') {
    if (input === 'payload') input = 'content';
    content = obj as Partial<BindingContent>;
    obj = obj.payload as Record<string, unknown>;
  }
  const payload = obj as unknown as BindingPayload;
  const warnings: string[] = [];
  const missing = PAYLOAD_KEYS.filter((k) => !(k in obj));
  if (missing.length) warnings.push(`missing payload field(s): ${missing.join(', ')}`);
  const extra = Object.keys(obj).filter((k) => !(PAYLOAD_KEYS as readonly string[]).includes(k) && k !== 'idCategory');
  if (extra.length) warnings.push(`unknown field(s) are signed too: ${extra.join(', ')}`);
  if (payload.domain !== undefined && payload.domain !== BINDING_DOMAIN) warnings.push(`domain is "${String(payload.domain)}", Hermes expects "${BINDING_DOMAIN}"`);
  if (payload.v !== undefined && payload.v !== BINDING_VERSION) warnings.push(`v is ${String(payload.v)}, Hermes expects ${BINDING_VERSION}`);
  const canonical = payloadMessage(payload);
  const hash = payloadHash(payload);

  const signed: SignedMessage[] = [
    {
      key: 'BCH key (payload.bch)',
      scheme: 'BCH Schnorr over SHA-256(prefix ‖ canonical payload)',
      message: BCH_MESSAGE_PREFIX + canonical,
      digest: binToHex(bchMessageHash(canonical)),
      note: 'bchProof.sig in the binding content; a WizardConnect wallet may instead commit the payload hash in an OP_RETURN (tx-commit proof).',
    },
  ];
  // The Nostr key signs the event id: SHA-256 of the NIP-01 serialisation of the binding event.
  try {
    const template: EventTemplate =
      event ??
      bindingEventTemplate({
        payload,
        bchProof: (content?.bchProof as BindingContent['bchProof']) ?? { type: 'schnorr-msg', sig: '<bch signature>' },
        ...(content?.rotation ? { rotation: content.rotation } : {}),
        ...(content?.history ? { history: content.history } : {}),
      });
    const unsigned = { ...template, pubkey: event?.pubkey ?? String(payload.nostr ?? '') };
    const id = getEventHash(unsigned);
    let nostrNote = 'Event id = SHA-256 of this serialisation; the Nostr key BIP-340-signs the id.';
    if (event) nostrNote += id === event.id ? ' Matches the pasted event id ✓' : ' Does NOT match the pasted event id ✗';
    else if (!content?.bchProof) nostrNote += ' The content embeds bchProof, so the exact id is known only once the BCH key has signed (placeholder shown).';
    signed.push({ key: 'Nostr key (payload.nostr)', scheme: 'BIP-340 Schnorr over the NIP-01 event id', message: serializeEvent(unsigned), digest: id, note: nostrNote });
  } catch (e) {
    warnings.push(`Nostr event cannot be built (${(e as Error).message}) — nostr must be a 64-hex key and ts a number`);
  }
  if (typeof payload.seq === 'number' && payload.seq > 0) {
    const approval = rotationApprovalTemplate(payload);
    signed.push({
      key: 'Previous keys (rotation)',
      scheme: `old BCH key: same BCH message as above; old Nostr key: kind ${ROTATION_EVENT_KIND} event`,
      message: approval.content,
      digest: payloadHash(payload),
      note: `Rotation approval content = canonical payload of the new version; its prev field must equal the previous payload hash.`,
    });
  }
  return { input, payload, canonical, payloadHash: hash, signed, warnings };
}

// ───────────────────────────── G35 drops leaf encoder ─────────────────────────────

export interface LeafEncoding {
  lockingBytecode: string;
  cumulativeLE: string;
  accountIdLE: string;
  leafBytes: string;
  leafHash: string;
}
export function encodeDropsLeaf(address: string, cumulative: string, accountId: string | number): LeafEncoding {
  let lb: string;
  try {
    lb = binToHex(lockingBytecodeForAddress(address.trim()));
  } catch (e) {
    throw new Error(`address: ${(e as Error).message}`);
  }
  if (!/^\d+$/.test(String(cumulative).trim())) throw new Error('cumulative must be a whole number of base units');
  const cum = BigInt(String(cumulative).trim());
  const id = Number(String(accountId).trim());
  if (!Number.isInteger(id)) throw new Error('accountId must be an integer');
  const hash = binToHex(leafHash({ lockingBytecode: lb, cumulative: cum, accountId: id })); // range checks live here
  const cumLE = binToHex(encodeLE(cum, 8));
  const idLE = binToHex(encodeLE(BigInt(id), 4));
  return { lockingBytecode: lb, cumulativeLE: cumLE, accountIdLE: idLE, leafBytes: lb + cumLE + idLE, leafHash: hash };
}

// ───────────────────────────── G34 Nostr kinds reference ─────────────────────────────

export interface KindRow {
  kind: number;
  name: string;
  module: string;
  storage: string;
  source: string;
  tags: { tag: string; meaning: string }[];
  example: EventTemplate;
}

const X = (c: string) => c.repeat(64);
const SAMPLE_PAYLOAD: BindingPayload = {
  domain: BINDING_DOMAIN,
  v: BINDING_VERSION,
  seq: 1,
  nostr: X('a'),
  bch: '02' + X('b'),
  addr: 'bchtest:qq…',
  tokenAddr: 'bchtest:zq…',
  ts: 1763800000,
  prev: X('c'),
};

const SAMPLE_RFQ: Rfq = {
  v: 1,
  id: X('1').slice(0, 32),
  direction: 'usdc-to-pusd',
  amountIn: '5000000',
  evmChainId: 84532,
  evmToken: '0x…usdc',
  bchToken: X('2'),
  takerEvm: '0x…taker',
  takerBch: 'bchtest:zq…',
  takerBchPkh: X('3').slice(0, 40),
  expiry: 1763800120,
};
const SAMPLE_QUOTE: Quote = {
  v: 1,
  rfqId: SAMPLE_RFQ.id,
  quoteId: X('4').slice(0, 32),
  direction: 'usdc-to-pusd',
  amountIn: '5000000',
  amountOut: '497',
  ratePpm: '1000000',
  feeOut: '3',
  tFirst: 1763886400,
  tSecond: 1763843200,
  solverEvm: '0x…solver',
  solverBch: 'bchtest:zq…',
  solverBchPkh: X('5').slice(0, 40),
  evmHtlc: '0x…htlc',
  evmChainId: 84532,
  expiry: 1763800060,
};
/** Fixed timestamp so examples are stable. */
const at = (t: EventTemplate): EventTemplate => ({ ...t, created_at: 1763800000 });

/** Every event kind Hermes signs, generated from the package constants and template functions. */
export function nostrKinds(): KindRow[] {
  const binding = bindingEventTemplate({
    payload: SAMPLE_PAYLOAD,
    bchProof: { type: 'schnorr-msg', sig: '<bch sig>' },
    rotation: { prevNostrEvent: { pubkey: X('d') } as Event },
  });
  binding.content = '{"bchProof":{…},"history":[…],"payload":{…},"rotation":{…}}';
  const rotation = at(rotationApprovalTemplate(SAMPLE_PAYLOAD));
  rotation.content = '<canonical JSON of the new payload>';
  return [
    {
      kind: BINDING_KIND,
      name: 'Identity binding',
      module: 'hermes-id',
      storage: 'parameterised replaceable (NIP-78), published to ≥3 relays',
      source: 'packages/id/src/binding.ts bindingEventTemplate',
      tags: [
        { tag: `d=${BINDING_D_TAG}`, meaning: 'one binding per Nostr key (replaceable slot)' },
        { tag: `i=${TAG_ADDR}<cashaddr>`, meaning: 'reverse lookup by BCH address (plain and token-aware)' },
        { tag: `i=${TAG_BCHPK}<pubkey>`, meaning: 'lookup by BCH public key' },
        { tag: `i=${TAG_PREV}<hash>`, meaning: 'previous payload hash (rotations only)' },
        { tag: `i=${TAG_GENESIS}<hash>`, meaning: 'lineage: seq-0 payload hash, on every version' },
        { tag: 'seq=<n>', meaning: 'binding version' },
        { tag: 'p=<old nostr>', meaning: 'old Nostr key when the Nostr key was rotated' },
        { tag: 'alt', meaning: 'NIP-31 human description' },
      ],
      example: binding,
    },
    {
      kind: ROTATION_EVENT_KIND,
      name: 'Rotation approval',
      module: 'hermes-id',
      storage: 'never published — embedded in the rotated binding content',
      source: 'packages/id/src/binding.ts rotationApprovalTemplate',
      tags: [{ tag: 'alt', meaning: 'NIP-31 description' }],
      example: rotation,
    },
    {
      kind: AUTH_EVENT_KIND,
      name: 'Challenge response (login)',
      module: 'hermes-id',
      storage: 'never published — POSTed to the verifier',
      source: 'packages/id/src/challenge.ts respondToChallenge',
      tags: [
        { tag: 'challenge=<nonce>', meaning: 'verifier-issued nonce (single use)' },
        { tag: 'audience=<origin>', meaning: 'who asked; stops replay to another site' },
      ],
      example: {
        kind: AUTH_EVENT_KIND,
        created_at: 1763800000,
        tags: [['challenge', '<nonce>'], ['audience', 'https://wallet.example']],
        content: canonicalJson({ audience: 'https://wallet.example', domain: AUTH_DOMAIN, nonce: '<nonce>', ts: 1763800000 }),
      },
    },
    {
      kind: RFQ_KIND,
      name: 'Swap request for quote',
      module: 'hermes-swap',
      storage: 'ephemeral (relays forward, do not store)',
      source: 'packages/swap/src/quotes.ts rfqTemplate',
      tags: [
        { tag: `t=${SWAP_TAG}`, meaning: 'solvers subscribe to this topic' },
        { tag: 'expiration=<unix>', meaning: 'NIP-40 expiry' },
      ],
      example: at(rfqTemplate(SAMPLE_RFQ)),
    },
    {
      kind: QUOTE_KIND,
      name: 'Solver quote',
      module: 'hermes-swap',
      storage: 'ephemeral',
      source: 'packages/swap/src/quotes.ts quoteTemplate',
      tags: [
        { tag: `t=${SWAP_TAG}`, meaning: 'topic' },
        { tag: 'e=<rfq id>', meaning: 'the RFQ it answers' },
        { tag: 'p=<taker>', meaning: 'the taker who asked' },
        { tag: 'expiration=<unix>', meaning: 'NIP-40 expiry' },
      ],
      example: at(quoteTemplate(SAMPLE_QUOTE, { id: X('e'), pubkey: X('f') } as Event)),
    },
    {
      kind: NOTICE_KIND,
      name: 'Lock notice',
      module: 'hermes-swap',
      storage: 'ephemeral',
      source: 'packages/swap/src/quotes.ts noticeTemplate',
      tags: [
        { tag: `t=${SWAP_TAG}`, meaning: 'topic' },
        { tag: 'p=<solver>', meaning: 'solver that quoted' },
      ],
      example: at(noticeTemplate({ v: 1, quoteId: X('1').slice(0, 32), hashlock: X('9'), chain: 'evm', ref: '0x' + X('7') }, X('f'))),
    },
    {
      kind: 4,
      name: 'Payment note (NIP-04 DM)',
      module: 'hermes-pay',
      storage: 'regular, optional',
      source: 'packages/pay/src/links.ts paymentNoteEvent',
      tags: [
        { tag: 'p=<recipient>', meaning: 'recipient' },
        { tag: `t=${PAYMENT_NOTE_TAG}`, meaning: 'marks Hermes payment notes' },
      ],
      example: at(paymentNoteEvent(X('a'), '<NIP-04 ciphertext>?iv=<iv>')),
    },
    {
      kind: 0,
      name: 'Profile cross-reference (NIP-39)',
      module: 'hermes-id',
      storage: 'replaceable profile, informational only',
      source: 'packages/id/src/nip39.ts nip39ProfileTemplate',
      tags: [{ tag: 'i=<cashaddr>,<binding id>', meaning: 'NIP-39 claim; Hermes verifies the binding, never this tag' }],
      example: at(nip39ProfileTemplate(undefined, { addr: 'bitcoincash:qq…', event: { id: X('e') } } as VerifiedBinding)),
    },
  ];
}

// ───────────────────────────── G29 verifier playground ─────────────────────────────

export type VerifierOp = 'info' | 'resolve' | 'verify' | 'challenge' | 'challenge-verify';
export interface VerifierRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: string;
}

export function verifierRequest(base: string, op: VerifierOp, arg: { q?: string; event?: string; offline?: boolean; response?: string } = {}): VerifierRequest {
  let u: URL;
  try {
    u = new URL(base.trim());
  } catch {
    throw new Error('verifier URL is not a valid URL');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('verifier URL must be http(s)');
  const root = u.toString().replace(/\/+$/, '');
  const json = (s: string | undefined, what: string) => {
    try {
      return JSON.parse(s ?? '');
    } catch {
      throw new Error(`${what} is not valid JSON`);
    }
  };
  switch (op) {
    case 'info':
      return { method: 'GET', url: `${root}/` };
    case 'resolve':
      if (!arg.q?.trim()) throw new Error('enter an npub, name@domain or cashaddr');
      return { method: 'GET', url: `${root}/resolve?q=${encodeURIComponent(arg.q.trim())}` };
    case 'verify':
      return { method: 'POST', url: `${root}/verify${arg.offline ? '?offline=1' : ''}`, body: JSON.stringify({ event: json(arg.event, 'event') }, null, 2) };
    case 'challenge':
      return { method: 'POST', url: `${root}/challenge`, body: '{}' };
    case 'challenge-verify':
      return { method: 'POST', url: `${root}/challenge/verify`, body: JSON.stringify({ response: json(arg.response, 'response') }, null, 2) };
  }
}

export interface VerifierResult {
  ok: boolean;
  status?: number;
  ms: number;
  body?: unknown;
  text?: string;
  error?: string;
}

/** Run a request; never throws. Network/CORS failures come back as a readable `error`. */
export async function runVerifierRequest(req: VerifierRequest, fetcher: typeof fetch = fetch, timeoutMs = 15_000): Promise<VerifierResult> {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetcher(req.url, {
      method: req.method,
      headers: req.body ? { 'content-type': 'application/json' } : undefined,
      body: req.body,
      signal: ctl.signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, status: res.status, ms: Date.now() - t0, text, error: 'response is not JSON — is this a Hermes verifier?' };
    }
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body };
  } catch (e) {
    const err = e as Error;
    const error =
      err.name === 'AbortError'
        ? `no answer within ${Math.round(timeoutMs / 1000)} s`
        : `could not reach the verifier (${err.message}). It is down, the URL is wrong, or the browser blocked it (CORS / mixed content: an https page cannot call an http verifier). Run one locally: pnpm --filter verifier start`;
    return { ok: false, ms: Date.now() - t0, error };
  } finally {
    clearTimeout(timer);
  }
}

/** curl equivalent of a request, for copy-paste. */
export function curlOf(req: VerifierRequest): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return req.method === 'GET' ? `curl ${q(req.url)}` : `curl -X POST ${q(req.url)} -H 'content-type: application/json' -d ${q(req.body ?? '{}')}`;
}

// ───────────────────────────── G31 test report ─────────────────────────────

export interface SuiteCount {
  file: string;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  ms: number;
}
export interface TestReport {
  generatedAt: string;
  runner: string;
  totals: { suites: number; tests: number; passed: number; failed: number; skipped: number };
  suites: SuiteCount[];
}

interface VitestJson {
  testResults?: {
    name: string;
    startTime?: number;
    endTime?: number;
    assertionResults?: { status: string }[];
  }[];
}

/** Summarise a vitest `--reporter=json` file into per-suite counts (paths made repo-relative). */
export function summarizeVitest(json: VitestJson, root: string, generatedAt = new Date().toISOString()): TestReport {
  const prefix = root.endsWith('/') ? root : root + '/';
  const suites = (json.testResults ?? [])
    .map((r) => {
      const a = r.assertionResults ?? [];
      const n = (s: string[]) => a.filter((x) => s.includes(x.status)).length;
      return {
        file: r.name.startsWith(prefix) ? r.name.slice(prefix.length) : r.name,
        tests: a.length,
        passed: n(['passed']),
        failed: n(['failed']),
        skipped: n(['skipped', 'pending', 'todo', 'disabled']),
        ms: Math.max(0, Math.round((r.endTime ?? 0) - (r.startTime ?? 0))),
      };
    })
    .sort((x, y) => x.file.localeCompare(y.file));
  const sum = (k: 'tests' | 'passed' | 'failed' | 'skipped') => suites.reduce((s, x) => s + x[k], 0);
  return {
    generatedAt,
    runner: 'vitest',
    totals: { suites: suites.length, tests: sum('tests'), passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped') },
    suites,
  };
}
