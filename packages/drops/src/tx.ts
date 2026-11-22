import { hexToBin } from '@bitauth/libauth';
import {
  SignatureTemplate,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  type NetworkProvider,
  type Unlocker,
  type Utxo,
} from 'cashscript';
import type { DropsContracts } from './contracts.js';

const uniq = <T extends { txid: string; vout: number }>(u: T[]) => u.filter((x, i) => u.findIndex((y) => y.txid === x.txid && y.vout === x.vout) === i);
import type { Entitlement, MerkleTree } from './merkle.js';
import {
  decodePending,
  decodeReceipt,
  decodeShardState,
  encodeReceipt,
  encodeShardState,
  encodePending,
  hasClaimed,
  shardOf,
  withClaimBit,
} from './state.js';

type SpendableUtxo = Utxo & { lockingBytecode: string };

export const TOKEN_DUST = 1000n;
export const SHARD_SATS = 2000n; // ≥ dust for a 125-byte commitment output
export const FEE_RATE = 1;

export interface ClaimContext {
  provider: NetworkProvider;
  contracts: DropsContracts;
  rewardCategory: string; // display hex
  receiptCategory: string;
  shardUtxos: SpendableUtxo[];
  vaultUtxos: SpendableUtxo[];
}

/** Find the shard UTXO for an account and decode its state. */
export function findShard(ctx: ClaimContext, accountId: number) {
  const shardIndex = shardOf(accountId);
  for (const u of ctx.shardUtxos) {
    if (!u.token?.nft) continue;
    const state = decodeShardState(u.token.nft.commitment);
    if (state.shardIndex === shardIndex) return { utxo: u, state };
  }
  throw new Error(`shard ${shardIndex} not found`);
}

export function findReceipt(utxos: SpendableUtxo[], receiptCategory: string, accountId: number) {
  for (const u of utxos) {
    if (u.token?.category !== receiptCategory || !u.token.nft || u.token.nft.capability !== 'none') continue;
    try {
      const r = decodeReceipt(u.token.nft.commitment);
      if (r.accountId === accountId) return { utxo: u, ...r };
    } catch {
      /* not a receipt */
    }
  }
  return undefined;
}

/**
 * Build a claim for `entry`: payout = cumulative − claimedTotal (from the receipt, or 0 on the
 * first claim). The claimer pays dust and fee from their own BCH inputs; their inputs are
 * signed locally (`signer`) or left as placeholders for WizardConnect.
 */
export function buildClaim(args: {
  ctx: ClaimContext;
  tree: MerkleTree;
  entry: Entitlement;
  claimerAddress: string; // P2PKH (plain) — matches entry.lockingBytecode
  claimerTokenAddress: string;
  claimerUtxos: SpendableUtxo[];
  signer?: SignatureTemplate;
}): { builder: TransactionBuilder; payout: bigint; firstClaim: boolean } {
  const { ctx, tree, entry } = args;
  args = { ...args, claimerUtxos: uniq(args.claimerUtxos) };
  const index = tree.indexOfAccount(entry.accountId);
  if (index < 0) throw new Error('account not in tree');
  const { siblings, path } = tree.proof(index);
  const { utxo: shardUtxo, state } = findShard(ctx, entry.accountId);
  if (state.root !== tree.root) throw new Error(`tree root is not the active root of the shard (shard ${state.shardIndex} is at epoch ${state.epoch}; a newer root may still be pending its timelock)`);

  const first = !hasClaimed(state, entry.accountId);
  const receipt = first ? undefined : findReceipt(args.claimerUtxos, ctx.receiptCategory, entry.accountId);
  if (!first && !receipt) throw new Error('already claimed once: receipt NFT required but not found in wallet');
  const claimed = receipt?.claimedTotal ?? 0n;
  const payout = entry.cumulative - claimed;
  if (payout <= 0n) throw new Error(`already claimed: nothing to claim until a new epoch is promoted (receipt shows ${claimed} of ${entry.cumulative})`);

  const vaultUtxo = ctx.vaultUtxos.find((u) => u.token?.category === ctx.rewardCategory && (u.token.amount ?? 0n) > payout);
  if (!vaultUtxo) throw new Error('no vault UTXO with enough reward tokens');

  const unlocker: Unlocker = args.signer ? args.signer.unlockP2PKH() : placeholderP2PKHUnlocker(args.claimerAddress);
  const funding = args.claimerUtxos.filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis));
  if (!funding.length || funding[0].satoshis < 3n * TOKEN_DUST + 2000n) throw new Error('claimer needs a BCH UTXO for dust and fee');

  const newState = first ? withClaimBit(state, entry.accountId) : state;
  const receiptIndex = 3n;
  const b = new TransactionBuilder({ provider: ctx.provider, allowImplicitFungibleTokenBurn: false })
    .addInput(
      shardUtxo,
      ctx.contracts.shard.unlock.claim(
        hexToBin(entry.lockingBytecode),
        entry.cumulative,
        BigInt(entry.accountId),
        hexToBin(siblings),
        BigInt(path),
        receiptIndex,
      ),
    )
    .addInput(vaultUtxo, ctx.contracts.vault.unlock.release())
    .addInput(funding[0], unlocker);
  if (receipt) b.addInput(receipt.utxo, unlocker);

  b.addOutput({
    to: ctx.contracts.shard.tokenAddress,
    amount: shardUtxo.satoshis,
    token: { category: ctx.receiptCategory, amount: 0n, nft: { capability: 'minting', commitment: encodeShardState(newState) } },
  })
    .addOutput({
      to: ctx.contracts.vault.tokenAddress,
      amount: vaultUtxo.satoshis,
      token: { category: ctx.rewardCategory, amount: vaultUtxo.token!.amount - payout },
    })
    .addOutput({
      to: args.claimerTokenAddress,
      amount: TOKEN_DUST,
      token: { category: ctx.receiptCategory, amount: 0n, nft: { capability: 'none', commitment: encodeReceipt(entry.accountId, entry.cumulative) } },
    })
    .addOutput({ to: args.claimerTokenAddress, amount: TOKEN_DUST, token: { category: ctx.rewardCategory, amount: payout } })
    .addBchChangeOutputIfNeeded({ to: args.claimerAddress, feeRate: FEE_RATE });
  return { builder: b, payout, firstClaim: first };
}

/** Root authority: publish a pending root for every shard (one NFT each) at the pending covenant. */
export function buildPublish(args: {
  provider: NetworkProvider;
  contracts: DropsContracts;
  authority: SignatureTemplate;
  authorityAddress: string;
  authorityTokenAddress: string;
  authorityUtxos: SpendableUtxo[];
  pendingCategory: string;
  epoch: number;
  root: string;
  shards: number;
}): TransactionBuilder {
  args = { ...args, authorityUtxos: uniq(args.authorityUtxos) };
  const minting = args.authorityUtxos.find((u) => u.token?.category === args.pendingCategory && u.token.nft?.capability === 'minting');
  if (!minting) throw new Error('authority minting NFT not found');
  const funding = args.authorityUtxos.filter((u) => !u.token);
  const b = new TransactionBuilder({ provider: args.provider }).addInput(minting, args.authority.unlockP2PKH());
  b.addInputs(funding, args.authority.unlockP2PKH());
  b.addOutput({ to: args.authorityTokenAddress, amount: minting.satoshis, token: minting.token! });
  for (let s = 0; s < args.shards; s++) {
    b.addOutput({
      to: args.contracts.pending.tokenAddress,
      amount: TOKEN_DUST,
      token: { category: args.pendingCategory, amount: 0n, nft: { capability: 'none', commitment: encodePending(s, args.epoch, args.root) } },
    });
  }
  return b.addBchChangeOutputIfNeeded({ to: args.authorityAddress, feeRate: FEE_RATE });
}

/** Anyone: promote a matured pending root into its shard. `sequence` must be ≥ ROOT_TIMELOCK. */
export function buildPromote(args: {
  provider: NetworkProvider;
  contracts: DropsContracts;
  receiptCategory: string;
  shardUtxo: SpendableUtxo;
  pendingUtxo: SpendableUtxo;
  rootTimelock: number;
  funder: { address: string; utxos: SpendableUtxo[]; signer?: SignatureTemplate };
}): TransactionBuilder {
  const state = decodeShardState(args.shardUtxo.token!.nft!.commitment);
  const pending = decodePending(args.pendingUtxo.token!.nft!.commitment);
  if (pending.shardIndex !== state.shardIndex) throw new Error('pending root is for another shard');
  if (pending.epoch <= state.epoch) throw new Error('pending epoch is not newer');
  const unlocker = args.funder.signer ? args.funder.signer.unlockP2PKH() : placeholderP2PKHUnlocker(args.funder.address);
  args = { ...args, funder: { ...args.funder, utxos: uniq(args.funder.utxos) } };
  const fund = args.funder.utxos.filter((u) => !u.token).sort((a, b) => Number(b.satoshis - a.satoshis))[0];
  if (!fund) throw new Error('funder needs a BCH UTXO');
  return new TransactionBuilder({ provider: args.provider })
    .addInput(args.shardUtxo, args.contracts.shard.unlock.promote())
    .addInput(args.pendingUtxo, args.contracts.pending.unlock.promote(), { sequence: args.rootTimelock })
    .addInput(fund, unlocker)
    .addOutput({
      to: args.contracts.shard.tokenAddress,
      amount: args.shardUtxo.satoshis,
      token: {
        category: args.receiptCategory,
        amount: 0n,
        nft: { capability: 'minting', commitment: encodePending(pending.shardIndex, pending.epoch, pending.root) + encodeShardState(state).slice(74) },
      },
    })
    .addBchChangeOutputIfNeeded({ to: args.funder.address, feeRate: FEE_RATE });
}

/** Authority veto: burn a pending root before it is promoted. */
export function buildCancel(args: {
  provider: NetworkProvider;
  contracts: DropsContracts;
  authority: SignatureTemplate;
  authorityAddress: string;
  pendingUtxo: SpendableUtxo;
  funding: SpendableUtxo[];
}) {
  const b = new TransactionBuilder({ provider: args.provider, allowImplicitFungibleTokenBurn: true }).addInput(
    args.pendingUtxo,
    args.contracts.pending.unlock.cancel(args.authority.publicKey, args.authority),
  );
  b.addInputs(args.funding, args.authority.unlockP2PKH());
  return b.addBchChangeOutputIfNeeded({ to: args.authorityAddress, feeRate: FEE_RATE });
}
