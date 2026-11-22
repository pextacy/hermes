import { binToHex, decodeTransaction, hash160, hexToBin, sha256 } from '@bitauth/libauth';
import {
  Contract,
  SignatureTemplate,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  type NetworkProvider,
  type SpendableUtxo,
  type Artifact,
} from 'cashscript';
import { toTokenAddress, uniqueUtxos } from '@hermes/chain';
import artifact from '../artifacts/HermesHtlc.json' with { type: 'json' };

export const htlcArtifact = artifact as unknown as Artifact;

export interface BchHtlcParams {
  recipientPkh: string; // hex 20 bytes
  refundPkh: string; // hex 20 bytes
  hashlock: string; // hex 32 bytes
  timeout: number; // unix seconds
}

export function pkhOfPublicKey(publicKey: Uint8Array | string): string {
  return binToHex(hash160(typeof publicKey === 'string' ? hexToBin(publicKey) : publicKey));
}

export function htlcContract(params: BchHtlcParams, provider: NetworkProvider) {
  return new Contract(
    htlcArtifact,
    [hexToBin(params.recipientPkh), hexToBin(params.refundPkh), hexToBin(params.hashlock), BigInt(params.timeout)],
    { provider, contractType: 'p2sh32' },
  );
}

/** Fee kept by the contract spend (≤ 3000 sats permitted by the covenant). */
export const HTLC_SPEND_FEE = 1500n;
export const HTLC_DUST = 1000n;

/**
 * Lock: an ordinary payment to the HTLC's token-aware address (BCH or a CashToken).
 * Locker's inputs are signed locally or left as placeholders for a WizardConnect wallet.
 */
export function buildLock(args: {
  provider: NetworkProvider;
  contract: Contract;
  from: string;
  utxos: SpendableUtxo[];
  satoshis?: bigint;
  token?: { category: string; amount: bigint };
  signer?: SignatureTemplate;
}): TransactionBuilder {
  args = { ...args, utxos: uniqueUtxos(args.utxos) };
  const unlocker = args.signer ? args.signer.unlockP2PKH() : placeholderP2PKHUnlocker(args.from);
  const b = new TransactionBuilder({ provider: args.provider });
  // The contract value must cover the claim/refund fee and the paid-out output's dust.
  const lockSats = args.token ? HTLC_DUST + HTLC_SPEND_FEE : (args.satoshis ?? 0n) + HTLC_SPEND_FEE;
  let tokenSats = 0n;
  if (args.token) {
    let have = 0n;
    for (const u of args.utxos.filter((u) => u.token?.category === args.token!.category && !u.token.nft)) {
      if (have >= args.token.amount) break;
      b.addInput(u, unlocker);
      have += u.token!.amount;
      tokenSats += u.satoshis;
    }
    if (have < args.token.amount) throw new Error('insufficient token balance for the lock');
  }
  let bch = tokenSats;
  for (const u of args.utxos.filter((u) => !u.token)) {
    if (bch >= lockSats + 3000n) break;
    b.addInput(u, unlocker);
    bch += u.satoshis;
  }
  if (bch < lockSats + 1000n) throw new Error('insufficient BCH for the lock');
  b.addOutput({ to: args.contract.tokenAddress, amount: lockSats, ...(args.token ? { token: { ...args.token } } : {}) });
  if (args.token) b.addTokenChangeOutputIfNeeded({ category: args.token.category, to: toTokenAddress(args.from) });
  b.addBchChangeOutputIfNeeded({ to: args.from, feeRate: 1 });
  return b;
}

function payout(utxo: SpendableUtxo, to: string) {
  return { to, amount: utxo.satoshis - HTLC_SPEND_FEE, ...(utxo.token ? { token: utxo.token } : {}) };
}

/** Claim with the preimage. Output index equals the HTLC input index (covenant rule). */
export function buildClaim(args: {
  provider: NetworkProvider;
  contract: Contract;
  utxo: SpendableUtxo;
  recipient: SignatureTemplate;
  recipientTokenAddr: string;
  preimage: string;
}): TransactionBuilder {
  const pk = args.recipient.publicKey;
  return new TransactionBuilder({ provider: args.provider })
    .addInput(args.utxo, args.contract.unlock.claim(pk, args.recipient, hexToBin(args.preimage)))
    .addOutput(payout(args.utxo, args.recipientTokenAddr));
}

/** Refund after the timeout: locktime is set to the HTLC timeout (CLTV). */
export function buildRefund(args: {
  provider: NetworkProvider;
  contract: Contract;
  utxo: SpendableUtxo;
  timeout: number;
  refunder: SignatureTemplate;
  refundTokenAddr: string;
}): TransactionBuilder {
  return new TransactionBuilder({ provider: args.provider })
    .setLocktime(args.timeout)
    .addInput(args.utxo, args.contract.unlock.refund(args.refunder.publicKey, args.refunder), { sequence: 0xfffffffe })
    .addOutput(payout(args.utxo, args.refundTokenAddr));
}

/** Read data pushes from an unlocking bytecode (enough for P2SH unlocking scripts). */
export function readPushes(bytecode: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i < bytecode.length) {
    const op = bytecode[i++];
    let len = -1;
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === 0x4c) len = bytecode[i++];
    else if (op === 0x4d) {
      len = bytecode[i] | (bytecode[i + 1] << 8);
      i += 2;
    } else if (op === 0x4e) {
      len = bytecode[i] | (bytecode[i + 1] << 8) | (bytecode[i + 2] << 16) | (bytecode[i + 3] << 24);
      i += 4;
    }
    if (len >= 0) {
      out.push(bytecode.slice(i, i + len));
      i += len;
    }
  }
  return out;
}

/** Extract the swap secret from a BCH claim transaction: the 32-byte push whose SHA-256 is the hashlock. */
export function extractPreimageFromBchTx(txHex: string, hashlock: string): string | undefined {
  const tx = decodeTransaction(hexToBin(txHex));
  if (typeof tx === 'string') return undefined;
  for (const input of tx.inputs) {
    for (const push of readPushes(input.unlockingBytecode)) {
      if (push.length === 32 && binToHex(sha256.hash(push)) === hashlock) return binToHex(push);
    }
  }
  return undefined;
}

/**
 * Watch an HTLC address for the claim: scan its history and return the secret once a
 * transaction spending it reveals the preimage. Uses Electrum `blockchain.address.get_history`.
 */
export async function findBchPreimage(
  provider: { performRequest(name: string, ...p: (string | number | boolean)[]): Promise<unknown>; getRawTransaction(txid: string): Promise<string> },
  htlcAddress: string,
  hashlock: string,
): Promise<{ secret: string; txid: string } | undefined> {
  const history = (await provider.performRequest('blockchain.address.get_history', htlcAddress)) as { tx_hash: string }[];
  if (!Array.isArray(history)) return undefined;
  for (const h of history) {
    const hex = await provider.getRawTransaction(h.tx_hash);
    const secret = extractPreimageFromBchTx(hex, hashlock);
    if (secret) return { secret, txid: h.tx_hash };
  }
  return undefined;
}
