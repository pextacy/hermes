import { TransactionBuilder, type NetworkProvider, type SignatureTemplate, type Utxo } from 'cashscript';
import { identityCommitment, parseIdentityCommitment } from '@hermes/id';

type S = Utxo & { lockingBytecode: string };
export const IDENTITY_NFT_SATS = 1000n;

/**
 * Identity NFT (docs/PLAN.md §2.2): a mutable CashToken at the identity's token address whose
 * commitment = SHA-256(nostr) || seq pins the current binding version. Same semantics as the XO
 * template `hermes-identity` (packages/xo), built here with CashScript for local keys.
 */

/** Step 1: a fresh vout-0 outpoint; its txid becomes the NFT category (known before the binding is signed). */
export async function prepareIdentityGenesis(args: { provider: NetworkProvider; address: string; utxos: S[]; signer: SignatureTemplate }) {
  const plain = args.utxos.filter((u) => !u.token);
  if (!plain.length) throw new Error('No BCH coins to create the identity NFT');
  const tx = await new TransactionBuilder({ provider: args.provider })
    .addInputs(plain, args.signer.unlockP2PKH())
    .addOutput({ to: args.address, amount: 3000n })
    .addBchChangeOutputIfNeeded({ to: args.address, feeRate: 1 })
    .send();
  const outpoint: S = { txid: tx.txid, vout: 0, satoshis: 3000n, lockingBytecode: args.utxos[0].lockingBytecode };
  return { category: tx.txid, outpoint };
}

/** Step 2: mint the mutable identity NFT pinning `seq`. */
export function buildMintIdentityNft(args: { provider: NetworkProvider; outpoint: S; category: string; tokenAddress: string; address: string; signer: SignatureTemplate; nostr: string; seq: number }) {
  if (args.outpoint.vout !== 0) throw new Error('genesis input must spend output 0');
  return new TransactionBuilder({ provider: args.provider })
    .addInput(args.outpoint, args.signer.unlockP2PKH())
    .addOutput({
      to: args.tokenAddress,
      amount: IDENTITY_NFT_SATS,
      token: { category: args.category, amount: 0n, nft: { capability: 'mutable', commitment: identityCommitment(args.nostr, args.seq) } },
    })
    .addBchChangeOutputIfNeeded({ to: args.address, feeRate: 1 });
}

export function findIdentityNft(utxos: S[], category: string) {
  return utxos.find((u) => u.token?.category === category && u.token.nft?.capability === 'mutable');
}

/** Rotate: spend the NFT and recreate it with the next commitment (optionally at a new key's token address). */
export function buildRotateIdentityNft(args: { provider: NetworkProvider; nft: S; funding: S[]; signer: SignatureTemplate; nextTokenAddress: string; changeAddress: string; nostr: string; seq: number }) {
  const current = parseIdentityCommitment(args.nft.token!.nft!.commitment);
  if (current && current.seq >= args.seq) throw new Error(`NFT already pins version ${current.seq}`);
  const b = new TransactionBuilder({ provider: args.provider }).addInput(args.nft, args.signer.unlockP2PKH());
  b.addInputs(args.funding.filter((u) => !u.token && !(u.txid === args.nft.txid && u.vout === args.nft.vout)).filter((u, i, a) => a.findIndex((x) => x.txid === u.txid && x.vout === u.vout) === i), args.signer.unlockP2PKH());
  return b
    .addOutput({
      to: args.nextTokenAddress,
      amount: args.nft.satoshis,
      token: { category: args.nft.token!.category, amount: 0n, nft: { capability: 'mutable', commitment: identityCommitment(args.nostr, args.seq) } },
    })
    .addBchChangeOutputIfNeeded({ to: args.changeAddress, feeRate: 1 });
}
