import type { NetworkProvider, SignatureTemplate, Utxo } from 'cashscript';
import { dropsContracts, type DropsConfig } from './contracts.js';
import { MerkleTree, type Entitlement } from './merkle.js';
import { buildClaim } from './tx.js';

type S = Utxo & { lockingBytecode: string };

/**
 * Claim for one wallet against a deployed pool and a published tree — the exact path the web
 * Claims tab and any integrating wallet use: find the wallet's leaf, gather shard/vault/wallet
 * UTXOs, build, sign, broadcast.
 */
export async function claimForWallet(args: {
  provider: NetworkProvider;
  config: DropsConfig;
  entries: Entitlement[];
  wallet: { address: string; tokenAddress: string; lockingBytecode: string; signer: SignatureTemplate };
}) {
  const entry = args.entries.find((e) => e.lockingBytecode === args.wallet.lockingBytecode);
  if (!entry) throw new Error('This address is not in the published tree');
  const c = dropsContracts(args.config, args.provider);
  const ctx = {
    provider: args.provider,
    contracts: c,
    rewardCategory: args.config.rewardCategory,
    receiptCategory: args.config.receiptCategory,
    shardUtxos: (await args.provider.getUtxos(c.shard.tokenAddress)) as S[],
    vaultUtxos: (await args.provider.getUtxos(c.vault.tokenAddress)) as S[],
  };
  const claimerUtxos = [...(await args.provider.getUtxos(args.wallet.address)), ...(await args.provider.getUtxos(args.wallet.tokenAddress))] as S[];
  const { builder, payout, firstClaim } = buildClaim({
    ctx,
    tree: new MerkleTree(args.entries),
    entry,
    claimerAddress: args.wallet.address,
    claimerTokenAddress: args.wallet.tokenAddress,
    claimerUtxos,
    signer: args.wallet.signer,
  });
  const tx = await builder.send();
  return { txid: tx.txid, payout, firstClaim, entry };
}
