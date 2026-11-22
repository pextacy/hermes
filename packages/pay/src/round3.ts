/**
 * Round 3 Pay features (G1–G7): pure logic used by the web Pay tab.
 * No I/O here except building (never broadcasting) transactions with CashScript.
 */
import {
  TransactionBuilder,
  gatherBchUtxos,
  placeholderP2PKHUnlocker,
  type NetworkProvider,
  type Output,
  type SignatureTemplate,
  type SpendableUtxo,
} from 'cashscript';
import { FEE_RATE, PLAIN_DUST_SATS, toPlainAddress, uniqueUtxos } from '@hermes/chain';
import { parseRecipient } from '@hermes/id';
import { parsePayLink, type PayLink } from './links.js';

// ───────────────────────────── G1 payment request watcher ─────────────────────────────

export interface WatchUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  token?: { category: string; amount: bigint } | null;
}
export interface WatchWant {
  /** Satoshis expected (BCH request). 0 / undefined = any amount. */
  sats?: bigint;
  /** Token expected (PUSD / CashToken request). */
  token?: { category: string; amount: bigint };
}
export interface DetectedPayment {
  txid: string;
  received: bigint;
  outpoints: string[];
}

export const outpointKey = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

/** The outpoints already at the address when the watcher started (they never count as the payment). */
export const watchBaseline = (utxos: { txid: string; vout: number }[]) => utxos.map(outpointKey);

/**
 * Finds the first transaction that created NEW outputs at the watched address and, summed per
 * transaction, pays at least the requested amount (BCH sats, or the token amount of the category).
 */
export function detectPayment(baseline: Iterable<string>, utxos: WatchUtxo[], want: WatchWant = {}): DetectedPayment | undefined {
  const seen = new Set(baseline);
  const byTx = new Map<string, { received: bigint; outpoints: string[] }>();
  for (const u of utxos) {
    const k = outpointKey(u);
    if (seen.has(k)) continue;
    const value = want.token ? (u.token?.category === want.token.category ? u.token.amount : 0n) : u.token ? 0n : u.satoshis;
    if (value <= 0n) continue;
    const e = byTx.get(u.txid) ?? { received: 0n, outpoints: [] };
    e.received += value;
    e.outpoints.push(k);
    byTx.set(u.txid, e);
  }
  const need = want.token ? want.token.amount : (want.sats ?? 0n);
  for (const [txid, e] of byTx) if (e.received >= need) return { txid, ...e };
  return undefined;
}

// ───────────────────────────── G2 batch pay ─────────────────────────────

export const MAX_BATCH = 50;
export interface BatchLine {
  line: number;
  to: string;
  amount: string;
}
export interface BatchParse {
  lines: BatchLine[];
  errors: { line: number; message: string }[];
}

/** `npub-or-name, amount` per line (comma, tab, `;` or spaces). Blank lines and `#` comments are skipped. */
export function parseBatch(text: string): BatchParse {
  const lines: BatchLine[] = [];
  const errors: BatchParse['errors'] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const s = raw.trim();
    if (!s || s.startsWith('#')) return;
    const parts = s.split(/[\s,;]+/).filter(Boolean);
    if (parts.length !== 2) return errors.push({ line, message: 'expected “npub-or-name, amount”' });
    const [to, amount] = parts;
    const kind = parseRecipient(to).kind;
    if (kind === 'bch') return errors.push({ line, message: 'raw address — batch pay pays Hermes identities (npub or name@domain)' });
    if (kind !== 'nostr' && kind !== 'nip05') return errors.push({ line, message: `“${to.slice(0, 24)}” is not an npub, hex key or name@domain` });
    if (!/^\d+(\.\d+)?$/.test(amount)) return errors.push({ line, message: `“${amount.slice(0, 24)}” is not a plain decimal amount` });
    const key = to.toLowerCase();
    if (seen.has(key)) return errors.push({ line, message: `duplicate of line ${seen.get(key)} — merge the amounts on one line` });
    seen.set(key, line);
    lines.push({ line, to, amount });
  });
  if (lines.length > MAX_BATCH) errors.push({ line: lines[MAX_BATCH].line, message: `at most ${MAX_BATCH} recipients per transaction` });
  return { lines, errors };
}

export interface BatchOutput {
  to: string;
  sats: bigint;
}

/**
 * One BCH transaction with many payment outputs (+ optional OP_RETURN memo, + change).
 * With `signer` it is signed locally; without, inputs get placeholders for a wallet to sign.
 * The caller decides whether to `build()` it (preview) or `send()` it.
 */
export function buildBatchPayment(req: {
  provider: NetworkProvider;
  from: string;
  utxos: SpendableUtxo[];
  outputs: BatchOutput[];
  memo?: string;
  signer?: SignatureTemplate;
}): TransactionBuilder {
  if (!req.outputs.length) throw new Error('no recipients');
  if (req.outputs.length > MAX_BATCH) throw new Error(`at most ${MAX_BATCH} recipients`);
  for (const o of req.outputs) if (o.sats < PLAIN_DUST_SATS) throw new Error(`amount to ${o.to.slice(0, 20)}… below dust (${PLAIN_DUST_SATS} sats)`);
  const total = req.outputs.reduce((n, o) => n + o.sats, 0n);
  const unlocker = req.signer ? req.signer.unlockP2PKH() : placeholderP2PKHUnlocker(req.from);
  const plain = uniqueUtxos(req.utxos).filter((u) => !u.token);
  const headroom = 1000n + 40n * BigInt(req.outputs.length);
  const have = plain.reduce((n, u) => n + u.satoshis, 0n);
  if (have < total + headroom) throw new Error(`insufficient BCH balance: need ${total + headroom} sats incl. fee headroom, have ${have}`);
  const { utxos: inputs, totalAmount } = gatherBchUtxos(plain, total + headroom);
  if (totalAmount < total + headroom) throw new Error(`insufficient BCH balance: need ${total + headroom} sats incl. fee headroom, have ${totalAmount}`);
  const b = new TransactionBuilder({ provider: req.provider, maximumFeeSatsPerByte: 5 });
  b.addInputs(inputs, unlocker);
  b.addOutputs(req.outputs.map((o): Output => ({ to: o.to, amount: o.sats })));
  if (req.memo) b.addOpReturnOutput(['HRMS', req.memo.slice(0, 180)]);
  b.addBchChangeOutputIfNeeded({ to: req.from, feeRate: FEE_RATE });
  return b;
}

// ───────────────────────────── G6 fee / size preview ─────────────────────────────

export interface TxPreview {
  inputs: number;
  outputs: number;
  bytes: number;
  fee: bigint;
  /** sats per byte, 2 decimals */
  feeRate: number;
  inputSats: bigint;
  outputSats: bigint;
  changeSats: bigint;
  /** exact: built and measured; estimate: computed from typical P2PKH sizes */
  basis: 'exact' | 'estimate';
  hex?: string;
}

/** Schnorr P2PKH unlocking script: push(65-byte sig) + push(33-byte pubkey). */
export const P2PKH_UNLOCK_BYTES = 100;
const outputAmount = (o: Output) => (typeof o.amount === 'bigint' ? o.amount : BigInt(o.amount as number));
const outputTo = (o: Output) => (typeof o.to === 'string' ? o.to : '');

/** Builds (signs locally, or with placeholders) WITHOUT broadcasting and measures the real transaction. */
export function previewBuilder(b: TransactionBuilder, changeAddress?: string): TxPreview {
  const hex = b.build();
  // Wallet-signed inputs carry an empty placeholder unlocking script until the wallet signs:
  // add a P2PKH Schnorr unlock (65-byte sig + 33-byte key + 2 push opcodes) for each.
  const unsigned = b.inputs.filter((u) => (u.unlocker as { placeholder?: boolean } | undefined)?.placeholder).length;
  const bytes = hex.length / 2 + unsigned * P2PKH_UNLOCK_BYTES;
  const inputSats = b.inputs.reduce((n, u) => n + u.satoshis, 0n);
  const outputSats = b.outputs.reduce((n, o) => n + outputAmount(o), 0n);
  const change = changeAddress ? safePlain(changeAddress) : undefined;
  const changeSats = change ? b.outputs.filter((o) => outputTo(o) && safePlain(outputTo(o)) === change).reduce((n, o) => n + outputAmount(o), 0n) : 0n;
  const fee = inputSats - outputSats;
  return { inputs: b.inputs.length, outputs: b.outputs.length, bytes, fee, feeRate: Math.round((Number(fee) / bytes) * 100) / 100, inputSats, outputSats, changeSats, basis: unsigned ? 'estimate' : 'exact', hex: unsigned ? undefined : hex };
}

/** Typical sizes: P2PKH input 141 B (Schnorr), P2PKH output 34 B, token prefix adds ~42 B, OP_RETURN 9 + data. */
export function estimateP2pkhSize(args: { inputs: number; outputs: number; tokenOutputs?: number; opReturnBytes?: number }): number {
  const varint = (n: number) => (n < 0xfd ? 1 : 3);
  const op = args.opReturnBytes ? 9 + 2 + args.opReturnBytes : 0;
  const outs = args.outputs + (args.opReturnBytes ? 1 : 0);
  return 4 + varint(args.inputs) + 141 * args.inputs + varint(outs) + 34 * args.outputs + 42 * (args.tokenOutputs ?? 0) + op + 4;
}

// ───────────────────────────── G3 address-poisoning guard ─────────────────────────────

/** Plain cashaddr, or the trimmed lowercase input when it doesn't decode (never throws). */
export const safePlain = (addr: string) => {
  try {
    return toPlainAddress(addr.trim());
  } catch {
    return addr.trim().toLowerCase();
  }
};
const payloadOf = (addr: string) => safePlain(addr).split(':').pop() ?? addr;

/**
 * Address poisoning: an attacker grinds an address whose first and last characters match one you
 * have paid before, hoping you copy it from history. Same edges, different address → look-alike.
 */
export function looksAlike(a: string, b: string, edge = 4): boolean {
  const x = payloadOf(a);
  const y = payloadOf(b);
  if (x === y) return false;
  // the first payload char is the version/type (`q`/`z`), so compare from the 2nd char
  return x.slice(1, 1 + edge) === y.slice(1, 1 + edge) && x.slice(-edge) === y.slice(-edge);
}

export interface KnownAddress {
  addr: string;
  label: string;
}
export type AddressGuard =
  | { kind: 'owner'; nostr: string; version: number; lookalikes: KnownAddress[] }
  | { kind: 'moved'; nostr: string; version: number; currentAddr: string; lookalikes: KnownAddress[] }
  | { kind: 'unknown'; lookalikes: KnownAddress[] };

/**
 * Verdict for a pasted raw cashaddr. `current` is the identity a relay reverse lookup
 * (`#i` = `bch:<addr>`) resolved to, if any — its CURRENT verified binding.
 */
export function addressGuard(addr: string, current: { nostr: string; addr: string; tokenAddr: string; seq: number } | undefined, known: KnownAddress[] = []): AddressGuard {
  const plain = safePlain(addr);
  const lookalikes = known.filter((k, i, a) => a.findIndex((x) => x.addr === k.addr) === i && looksAlike(plain, k.addr));
  if (!current) return { kind: 'unknown', lookalikes };
  const mine = safePlain(current.addr) === plain || safePlain(current.tokenAddr) === plain;
  return mine
    ? { kind: 'owner', nostr: current.nostr, version: current.seq, lookalikes }
    : { kind: 'moved', nostr: current.nostr, version: current.seq, currentAddr: current.addr, lookalikes };
}

// ───────────────────────────── G4 contacts ─────────────────────────────

export interface Contact {
  /** The npub you saved (stable key, even if the identity later rotates its Nostr key). */
  npub: string;
  nostr: string;
  name?: string;
  addr: string;
  tokenAddr: string;
  version: number;
  bindingId: string;
  network?: string;
  savedAt: number;
}
export interface CardLike {
  npub: string;
  nostr: string;
  addr: string;
  tokenAddr: string;
  version: number;
  network?: string;
  profile?: { name?: string; displayName?: string };
}

export function contactFromCard(card: CardLike, bindingId: string, now = Date.now()): Contact {
  return {
    npub: card.npub,
    nostr: card.nostr,
    name: card.profile?.displayName || card.profile?.name || undefined,
    addr: card.addr,
    tokenAddr: card.tokenAddr,
    version: card.version,
    bindingId,
    network: card.network,
    savedAt: now,
  };
}

const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? v : undefined);
export function normalizeContacts(raw: unknown): Contact[] {
  if (!Array.isArray(raw)) return [];
  const out: Contact[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const npub = str(r.npub), nostr = str(r.nostr, 64), addr = str(r.addr), tokenAddr = str(r.tokenAddr), bindingId = str(r.bindingId, 64);
    if (!npub || !nostr || !addr || !tokenAddr || !bindingId || typeof r.version !== 'number') continue;
    out.push({ npub, nostr, addr, tokenAddr, bindingId, version: r.version, name: str(r.name, 64), network: str(r.network, 16), savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0 });
  }
  return out;
}

export function upsertContact(list: Contact[], c: Contact): Contact[] {
  return [c, ...list.filter((x) => x.npub !== c.npub)];
}
export const removeContact = (list: Contact[], npub: string) => list.filter((x) => x.npub !== npub);
/** The contact this resolved card belongs to (by saved npub, or by current Nostr key). */
export const findContact = (list: Contact[], card: { npub: string; nostr: string }, typed?: string) =>
  list.find((x) => x.npub === typed || x.npub === card.npub || x.nostr === card.nostr);

export interface ContactDrift {
  from: number;
  to: number;
  addrChanged: boolean;
  nostrChanged: boolean;
  message: string;
}

/** Re-verification on use: has the binding moved on since the contact was saved? */
export function contactDrift(saved: Contact, card: CardLike): ContactDrift | undefined {
  const addrChanged = saved.addr !== card.addr;
  const nostrChanged = saved.nostr !== card.nostr;
  if (saved.version === card.version && !addrChanged && !nostrChanged) return undefined;
  const what = [addrChanged && 'BCH address', nostrChanged && 'Nostr key'].filter(Boolean).join(' and ');
  return {
    from: saved.version,
    to: card.version,
    addrChanged,
    nostrChanged,
    message: `Binding changed since you saved this contact: version ${saved.version} → ${card.version}${what ? ` (${what} changed)` : ''}. The new version verified; confirm with them before paying.`,
  };
}

// ───────────────────────────── G5 receipt ─────────────────────────────

export interface ReceiptLine {
  to: string;
  name?: string;
  address: string;
  amount: string;
  bindingEventId: string;
  bindingVersion: number;
}
export interface PaymentReceipt {
  type: 'hermes.receipt';
  v: 1;
  network: string;
  txid: string;
  explorer?: string;
  at: string;
  asset: string;
  memo?: string;
  recipients: ReceiptLine[];
  fee?: string;
  bytes?: number;
  from?: string;
}

export function buildReceipt(a: Omit<PaymentReceipt, 'type' | 'v' | 'at' | 'fee'> & { at?: number; fee?: bigint }): PaymentReceipt {
  if (!/^[0-9a-f]{64}$/.test(a.txid)) throw new Error('receipt needs a 64-hex txid');
  if (!a.recipients.length) throw new Error('receipt needs at least one recipient');
  const r: PaymentReceipt = {
    type: 'hermes.receipt',
    v: 1,
    network: a.network,
    txid: a.txid,
    explorer: a.explorer,
    at: new Date(a.at ?? Date.now()).toISOString(),
    asset: a.asset,
    memo: a.memo || undefined,
    recipients: a.recipients.map((x) => ({ ...x })),
    fee: a.fee === undefined ? undefined : a.fee.toString(),
    bytes: a.bytes,
    from: a.from,
  };
  return JSON.parse(JSON.stringify(r)) as PaymentReceipt; // drops undefined fields
}
export const receiptJson = (r: PaymentReceipt) => JSON.stringify(r, null, 2);
export const receiptFilename = (r: PaymentReceipt) => `hermes-receipt-${r.txid.slice(0, 12)}.json`;

// ───────────────────────────── G7 QR scan ─────────────────────────────

export type Scanned =
  | { kind: 'paylink'; link: PayLink }
  | { kind: 'recipient'; value: string; amount?: string }
  | { kind: 'invalid'; reason: string };

/** Whatever a QR code held → what the Pay tab should do with it. Untrusted input: parsed, never executed. */
export function parseScanned(raw: string): Scanned {
  const s = raw.trim();
  if (!s || s.length > 2000) return { kind: 'invalid', reason: 'empty or oversized QR content' };
  const hash = s.indexOf('#pay?');
  if (hash >= 0 && /^https?:\/\//i.test(s)) {
    const link = parsePayLink(s.slice(hash));
    return link ? { kind: 'paylink', link } : { kind: 'invalid', reason: 'pay link without a recipient' };
  }
  const bip21 = /^(bitcoincash|bchtest):([a-z0-9]+)(\?.*)?$/i.exec(s);
  if (bip21) {
    const amount = bip21[3] ? new URLSearchParams(bip21[3].slice(1)).get('amount') ?? undefined : undefined;
    return { kind: 'recipient', value: `${bip21[1].toLowerCase()}:${bip21[2].toLowerCase()}`, amount: amount && /^\d+(\.\d+)?$/.test(amount) ? amount : undefined };
  }
  const v = s.replace(/^nostr:/i, '');
  const kind = parseRecipient(v).kind;
  if (kind === 'invalid') return { kind: 'invalid', reason: 'not an npub, name@domain, pay link or BCH address' };
  return { kind: 'recipient', value: v };
}
