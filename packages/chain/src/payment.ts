import {
  TransactionBuilder,
  gatherBchUtxos,
  gatherFungibleTokenUtxos,
  placeholderP2PKHUnlocker,
  SignatureTemplate,
  type NetworkProvider,
  type Output,
  type Unlocker,
  type SpendableUtxo,
  type WcTransactionObject,
} from 'cashscript';

export const DUST_SATS = 800n; // token-carrying outputs need ≥ 798 sats; plain P2PKH dust is 546
export const PLAIN_DUST_SATS = 546n;
export const FEE_RATE = 1.0; // sats per byte

export type PaymentAsset = { kind: 'bch'; satoshis: bigint } | { kind: 'token'; category: string; amount: bigint };

export interface PaymentRequest {
  provider: NetworkProvider;
  /** Sender's P2PKH address (cashaddr); change returns here. */
  from: string;
  /** Sender's token-aware address (for token change). */
  fromTokenAddr?: string;
  utxos: SpendableUtxo[];
  /** Destination: plain addr for BCH, token-aware addr for tokens. */
  to: string;
  asset: PaymentAsset;
  /** Optional payment reference, written as OP_RETURN. */
  memo?: string;
  /** Local signer; when absent the inputs get placeholders for a wallet (WizardConnect) to sign. */
  signer?: SignatureTemplate;
}

const plainUtxos = (utxos: SpendableUtxo[]) => utxos.filter((u) => !u.token);

/**
 * Build a payment with CashScript's TransactionBuilder: coin selection, optional memo,
 * BCH change (and token change for token payments). Returns the builder so callers can
 * either `send()` (local key) or `generateWcTransactionObject()` (wallet signs).
 */
export function buildPayment(req: PaymentRequest): TransactionBuilder {
  req = { ...req, utxos: uniqueUtxos(req.utxos) };
  const unlocker: Unlocker = req.signer ? req.signer.unlockP2PKH() : placeholderP2PKHUnlocker(req.from);
  const builder = new TransactionBuilder({ provider: req.provider, maximumFeeSatsPerByte: 5 });
  const outputs: Output[] = [];
  let bchNeeded = 0n;
  if (req.asset.kind === 'bch') {
    if (req.asset.satoshis < PLAIN_DUST_SATS) throw new Error(`amount below dust (${PLAIN_DUST_SATS} sats)`);
    outputs.push({ to: req.to, amount: req.asset.satoshis });
    bchNeeded += req.asset.satoshis;
  } else {
    const { utxos: tokenIn, totalAmount } = gatherFungibleTokenUtxos(req.utxos, req.asset.category, req.asset.amount);
    if (totalAmount < req.asset.amount) throw new Error('insufficient token balance');
    builder.addInputs(tokenIn, unlocker);
    outputs.push({ to: req.to, amount: DUST_SATS, token: { category: req.asset.category, amount: req.asset.amount } });
    const tokenSats = tokenIn.reduce((s, u) => s + u.satoshis, 0n);
    bchNeeded += DUST_SATS - tokenSats + (totalAmount > req.asset.amount ? DUST_SATS : 0n);
  }
  // Fee headroom: generous for a few inputs/outputs at 1 sat/byte.
  const feeHeadroom = 2000n;
  const { utxos: bchIn, totalAmount } = gatherBchUtxos(plainUtxos(req.utxos), bchNeeded > 0n ? bchNeeded + feeHeadroom : feeHeadroom);
  if (totalAmount < bchNeeded) throw new Error('insufficient BCH balance');
  builder.addInputs(bchIn, unlocker);
  builder.addOutputs(outputs);
  if (req.memo) builder.addOpReturnOutput(['HRMS', req.memo.slice(0, 180)]);
  if (req.asset.kind === 'token') {
    builder.addTokenChangeOutputIfNeeded({ category: req.asset.category, to: req.fromTokenAddr ?? req.from });
  }
  builder.addBchChangeOutputIfNeeded({ to: req.from, feeRate: FEE_RATE });
  return builder;
}

export function paymentForWallet(req: Omit<PaymentRequest, 'signer'>, userPrompt?: string): WcTransactionObject {
  return buildPayment(req).generateWcTransactionObject({ broadcast: false, userPrompt });
}

export async function sendLocal(req: PaymentRequest & { signer: SignatureTemplate }) {
  return buildPayment(req).send();
}

/**
 * A P2PKH wallet's plain and token-aware cashaddrs share one locking bytecode, so asking an
 * Electrum server for both returns every coin twice. Builders de-duplicate by outpoint.
 */
export function uniqueUtxos<T extends { txid: string; vout: number }>(utxos: T[]): T[] {
  const seen = new Set<string>();
  return utxos.filter((u) => {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
