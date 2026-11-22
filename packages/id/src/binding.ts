import { binToHex, hexToBin } from '@bitauth/libauth';
import { getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';
import { canonicalJson, sha256Hex, verifyEventFresh } from './canonical.js';
import {
  addressesForPublicKey,
  isCompressedPublicKeyHex,
  networkOfAddress,
  verifyBchMessage,
  type BchNetwork,
} from './bch.js';
import {
  BINDING_D_TAG,
  BINDING_DOMAIN,
  BINDING_KIND,
  BINDING_VERSION,
  ROTATION_EVENT_KIND,
} from './constants.js';
import { verifyTxProof, type TxProof } from './txproof.js';
import type { BchSigner, NostrSigner } from './signers.js';

/** Canonical binding payload (docs/PLAN.md §2.1). */
export interface BindingPayload {
  domain: string;
  v: number;
  seq: number;
  nostr: string; // 32-byte x-only pubkey hex
  bch: string; // 33-byte compressed pubkey hex
  addr: string; // P2PKH cashaddr
  tokenAddr: string; // token-aware P2PKH cashaddr
  ts: number; // unix seconds
  prev: string | null; // sha256 of previous canonical payload
  /** Optional CashTokens category of the identity NFT that pins `seq`. */
  idCategory?: string;
}

export type BchProof = { type: 'schnorr-msg'; sig: string } | TxProof;

/** Signatures by the *previous* keys approving a rotation (seq > 0). */
export interface RotationProof {
  /** Old BCH key signs the new payload (when the BCH key is the one kept, or both are kept). */
  prevBchProof?: BchProof;
  /** Old Nostr key signs an ephemeral event whose content is the new payload (when the Nostr key is kept). */
  prevNostrEvent?: Event;
}

export interface BindingContent {
  payload: BindingPayload;
  bchProof: BchProof;
  rotation?: RotationProof;
  /**
   * The predecessor event (which embeds its own predecessor, recursively). Replaceable
   * events overwrite earlier versions on relays, so the rotation chain travels with the
   * current binding and can be verified back to seq 0 without any server.
   */
  history?: Event[];
}

export const TAG_ADDR = 'bch:';
export const TAG_BCHPK = 'bchpk:';
export const TAG_PREV = 'hermesprev:';
/** Lineage tag: hash of the identity's original (seq 0) payload, on every version. */
export const TAG_GENESIS = 'hermesgen:';

/** Genesis payload hash of a binding: its own hash at seq 0, else the root of its embedded chain. */
export function genesisHashOf(content: BindingContent): string {
  let c: BindingContent | undefined = content;
  for (let i = 0; i < 64 && c?.history?.length; i++) c = parseBindingContent(c.history[c.history.length - 1]);
  return payloadHash((c ?? content).payload);
}

export interface VerifiedBinding {
  valid: boolean;
  nostr: string;
  bch: string;
  addr: string;
  tokenAddr: string;
  seq: number;
  ts: number;
  network?: BchNetwork;
  payloadHash: string;
  payload?: BindingPayload;
  reasons: string[];
  event: Event;
}

export const payloadMessage = (payload: BindingPayload) => canonicalJson(payload);
export const payloadHash = (payload: BindingPayload) => sha256Hex(canonicalJson(payload));

export function buildPayload(input: {
  nostr: string;
  bch: string;
  network: BchNetwork;
  seq?: number;
  prev?: BindingPayload | null;
  ts?: number;
  idCategory?: string;
}): BindingPayload {
  const { addr, tokenAddr } = addressesForPublicKey(input.bch, input.network);
  const payload: BindingPayload = {
    domain: BINDING_DOMAIN,
    v: BINDING_VERSION,
    seq: input.prev ? input.prev.seq + 1 : (input.seq ?? 0),
    nostr: input.nostr.toLowerCase(),
    bch: input.bch.toLowerCase(),
    addr,
    tokenAddr,
    ts: input.ts ?? Math.floor(Date.now() / 1000),
    prev: input.prev ? payloadHash(input.prev) : null,
  };
  if (input.idCategory) payload.idCategory = input.idCategory.toLowerCase();
  return payload;
}

export function bindingEventTemplate(content: BindingContent): EventTemplate {
  const { payload } = content;
  // Relays only index single-letter tags, so searchable facts use NIP-39 style `i` tags.
  const tags: string[][] = [
    ['d', BINDING_D_TAG],
    ['i', `${TAG_ADDR}${payload.addr}`],
    ['i', `${TAG_ADDR}${payload.tokenAddr}`],
    ['i', `${TAG_BCHPK}${payload.bch}`],
    ['seq', String(payload.seq)],
    ['alt', 'Hermes ID: binding between this Nostr key and a Bitcoin Cash key'],
  ];
  if (payload.prev) tags.push(['i', `${TAG_PREV}${payload.prev}`]);
  tags.push(['i', `${TAG_GENESIS}${genesisHashOf(content)}`]);
  if (content.rotation?.prevNostrEvent) tags.push(['p', content.rotation.prevNostrEvent.pubkey]);
  return { kind: BINDING_KIND, created_at: payload.ts, tags, content: canonicalJson(content) };
}

/** Create a new binding event: BCH key signs the payload, Nostr key signs the event. */
export async function createBinding(args: {
  bch: BchSigner;
  nostr: NostrSigner;
  network: BchNetwork;
  prev?: BindingPayload | null;
  rotation?: RotationProof;
  idCategory?: string;
  ts?: number;
  history?: Event[];
}): Promise<{ event: Event; content: BindingContent }> {
  const nostrPk = await args.nostr.getPublicKey();
  const payload = buildPayload({
    nostr: nostrPk,
    bch: binToHex(await args.bch.getPublicKey()),
    network: args.network,
    prev: args.prev ?? null,
    idCategory: args.idCategory,
    ts: args.ts,
  });
  const bchProof = await args.bch.prove(payloadMessage(payload));
  const content: BindingContent = {
    payload,
    bchProof,
    ...(args.rotation ? { rotation: args.rotation } : {}),
    ...(args.history?.length ? { history: args.history } : {}),
  };
  const event = await args.nostr.signEvent(bindingEventTemplate(content));
  return { event, content };
}

export function verifyBchProof(proof: BchProof | undefined, publicKeyHex: string, message: string): string[] {
  if (!proof) return ['bch proof missing'];
  if (proof.type === 'schnorr-msg') {
    return verifyBchMessage(publicKeyHex, message, proof.sig) ? [] : ['bch signature invalid'];
  }
  if (proof.type === 'tx-commit') return verifyTxProof(proof, publicKeyHex, message);
  return ['bch proof: unknown type'];
}

export function parseBindingContent(event: Event): BindingContent | undefined {
  try {
    const parsed = JSON.parse(event.content) as BindingContent;
    if (!parsed || typeof parsed !== 'object' || !parsed.payload) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Pure verification of one binding event (no network). Checks both proofs over
 * the same canonical payload, key separation, derived addresses and tags.
 * Rotation proofs against the predecessor are checked by `verifyRotation`.
 */
export function verifyBinding(event: Event): VerifiedBinding {
  const reasons: string[] = [];
  const content = parseBindingContent(event);
  const p = content?.payload;
  const base: VerifiedBinding = {
    valid: false,
    nostr: p?.nostr ?? event.pubkey,
    bch: p?.bch ?? '',
    addr: p?.addr ?? '',
    tokenAddr: p?.tokenAddr ?? '',
    seq: typeof p?.seq === 'number' ? p.seq : -1,
    ts: typeof p?.ts === 'number' ? p.ts : 0,
    payloadHash: '',
    payload: p,
    reasons,
    event,
  };
  if (!content || !p) {
    reasons.push('content is not a Hermes binding');
    return base;
  }
  let message: string;
  try {
    message = payloadMessage(p);
    base.payloadHash = sha256Hex(message);
  } catch {
    reasons.push('payload not canonicalisable');
    return base;
  }
  if (event.kind !== BINDING_KIND) reasons.push(`wrong kind ${event.kind}`);
  if (!event.tags.some((t) => t[0] === 'd' && t[1] === BINDING_D_TAG)) reasons.push('missing d tag');
  if (p.domain !== BINDING_DOMAIN) reasons.push('wrong domain');
  if (p.v !== BINDING_VERSION) reasons.push('unsupported version');
  if (!Number.isInteger(p.seq) || p.seq < 0) reasons.push('bad seq');
  if (!Number.isInteger(p.ts) || p.ts <= 0) reasons.push('bad ts');
  if (p.seq === 0 && p.prev !== null) reasons.push('seq 0 must have prev = null');
  if (p.seq > 0 && !/^[0-9a-f]{64}$/.test(p.prev ?? '')) reasons.push('seq > 0 needs prev hash');
  if (!/^[0-9a-f]{64}$/.test(p.nostr)) reasons.push('bad nostr key');
  if (!isCompressedPublicKeyHex(p.bch)) reasons.push('bad bch key');

  // Nostr proof: event signature by the bound Nostr key, over an event that contains the payload.
  if (!verifyEventFresh(event)) reasons.push('nostr signature invalid');
  if (event.pubkey !== p.nostr) reasons.push('event author is not the bound nostr key');

  // Key separation: never reuse one key for both identities.
  if (p.bch.slice(2) === p.nostr) reasons.push('same key used for BCH and Nostr');

  // Derived addresses.
  const network = networkOfAddress(p.addr);
  if (!network) reasons.push('unknown address network');
  else if (isCompressedPublicKeyHex(p.bch)) {
    base.network = network;
    const derived = addressesForPublicKey(p.bch, network);
    if (derived.addr !== p.addr) reasons.push('addr does not match bch key');
    if (derived.tokenAddr !== p.tokenAddr) reasons.push('tokenAddr does not match bch key');
  }

  // Tags must agree with the payload (they are what others search by).
  const itags = event.tags.filter((t) => t[0] === 'i').map((t) => t[1]);
  if (!itags.includes(`${TAG_BCHPK}${p.bch}`)) reasons.push('bchpk tag mismatch');
  if (!itags.includes(`${TAG_ADDR}${p.addr}`)) reasons.push('bch address tag mismatch');

  // BCH proof over the same canonical payload.
  if (isCompressedPublicKeyHex(p.bch)) reasons.push(...verifyBchProof(content.bchProof, p.bch, message));

  base.valid = reasons.length === 0;
  return base;
}

/**
 * Verify that `next` is a legitimate successor of `prev`: seq increments, prev hash
 * links, and the key that is kept signs again while the old key of the identity
 * being rotated approves the change (docs/PLAN.md §2.4).
 */
export function verifyRotation(prev: VerifiedBinding, next: VerifiedBinding): string[] {
  const reasons: string[] = [];
  if (!prev.valid || !prev.payload) return ['predecessor invalid'];
  if (!next.valid || !next.payload) return ['successor invalid'];
  if (next.seq !== prev.seq + 1) reasons.push('seq does not increment by one');
  if (next.payload.prev !== prev.payloadHash) reasons.push('prev hash does not link');
  if (next.ts < prev.ts) reasons.push('timestamp goes backwards');
  const content = parseBindingContent(next.event);
  const rotation = content?.rotation;
  const message = payloadMessage(next.payload);
  const sameNostr = next.nostr === prev.nostr;
  const sameBch = next.bch === prev.bch;
  if (sameNostr && sameBch) {
    // Re-issue without key change (e.g. new idCategory). Event is by the same Nostr key and
    // the same BCH key signs again: both proofs already verified.
    return reasons;
  }
  if (!sameNostr && !sameBch) {
    reasons.push('both keys changed at once: that is a new identity, not a rotation');
    return reasons;
  }
  if (!sameBch) {
    // BCH key rotated: the old BCH key must approve the new payload.
    reasons.push(...verifyBchProof(rotation?.prevBchProof, prev.bch, message).map((r) => `rotation: old ${r}`));
  }
  if (!sameNostr) {
    // Nostr key rotated: the old Nostr key must sign an ephemeral event containing the new payload.
    const ev = rotation?.prevNostrEvent;
    if (!ev) reasons.push('rotation: old nostr approval missing');
    else {
      if (!verifyEventFresh(ev)) reasons.push('rotation: old nostr signature invalid');
      if (ev.pubkey !== prev.nostr) reasons.push('rotation: approval not by old nostr key');
      if (ev.kind !== ROTATION_EVENT_KIND) reasons.push('rotation: wrong approval kind');
      if (ev.content !== message) reasons.push('rotation: approval does not cover the new payload');
    }
  }
  return reasons;
}

/** Template for the old Nostr key's rotation approval. */
export function rotationApprovalTemplate(next: BindingPayload): EventTemplate {
  return {
    kind: ROTATION_EVENT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['alt', 'Hermes ID rotation approval']],
    content: payloadMessage(next),
  };
}

/**
 * Rotate one key of an identity. The kept key signs as usual; the old key of the
 * rotated identity approves. Exactly one of `newBch` / `newNostr` must be given.
 */
export async function rotateBinding(args: {
  /** The current binding event being superseded. */
  prevEvent: Event;
  currentBch: BchSigner;
  currentNostr: NostrSigner;
  newBch?: BchSigner;
  newNostr?: NostrSigner;
  network: BchNetwork;
  idCategory?: string;
}): Promise<{ event: Event; content: BindingContent }> {
  if (!!args.newBch === !!args.newNostr) throw new Error('rotate exactly one key');
  const prevContent = parseBindingContent(args.prevEvent);
  if (!prevContent) throw new Error('previous event is not a Hermes binding');
  const prev = prevContent.payload;
  // The predecessor travels inside the successor (and embeds its own predecessor), so
  // the whole chain is verifiable from the current event alone. Signatures cover the
  // content, so events are embedded verbatim.
  const history = [args.prevEvent];
  const bch = args.newBch ?? args.currentBch;
  const nostr = args.newNostr ?? args.currentNostr;
  const payload = buildPayload({
    nostr: await nostr.getPublicKey(),
    bch: binToHex(await bch.getPublicKey()),
    network: args.network,
    prev,
    idCategory: args.idCategory ?? prev.idCategory,
  });
  const message = payloadMessage(payload);
  const rotation: RotationProof = {};
  if (args.newBch) rotation.prevBchProof = await args.currentBch.prove(message);
  if (args.newNostr) rotation.prevNostrEvent = await args.currentNostr.signEvent(rotationApprovalTemplate(payload));
  const bchProof = await bch.prove(message);
  const content: BindingContent = { payload, bchProof, rotation, history };
  const event = await nostr.signEvent(bindingEventTemplate(content));
  return { event, content };
}

export const xOnlyFromSecret = (secret: Uint8Array) => getPublicKey(secret);
export { hexToBin };

