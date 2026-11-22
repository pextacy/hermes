import { TransactionBuilder, type NetworkProvider, type Utxo } from 'cashscript';
import type { KeyWallet } from '@hermes/chain';
import { dropsContracts, type DropsConfig } from './contracts.js';
import { emptyShard, encodeShardState } from './state.js';
import { SHARD_SATS, TOKEN_DUST } from './tx.js';

type S = Utxo & { lockingBytecode: string };

export interface Deployment {
  network: string;
  createdAt: string;
  config: DropsConfig;
  shards: number;
  addresses: { shard: string; vault: string; pending: string; authority: string };
  txids: Record<string, string>;
}

/** Send to self so that output 0 is a fresh outpoint (CashTokens genesis needs input 0 at vout 0). */
async function prepareGenesisOutpoint(provider: NetworkProvider, w: KeyWallet, sats: bigint, reserved: S[] = []): Promise<S> {
  const skip = new Set(reserved.map((r) => `${r.txid}:${r.vout}`));
  const utxos = ((await provider.getUtxos(w.address)) as S[]).filter((u) => !u.token && !skip.has(`${u.txid}:${u.vout}`));
  if (!utxos.length) throw new Error(`No BCH at ${w.address}; fund it first (chipnet faucet).`);
  const b = new TransactionBuilder({ provider }).addInputs(utxos, w.signer.unlockP2PKH()).addOutput({ to: w.address, amount: sats });
  b.addBchChangeOutputIfNeeded({ to: w.address, feeRate: 1 });
  const tx = await b.send();
  return { txid: tx.txid, vout: 0, satoshis: sats, lockingBytecode: w.lockingBytecode };
}


/**
 * Deploy a Drops pool:
 *  1. authority genesis: minting NFT of the pending category P, kept by the authority key;
 *  2. receipt genesis: K shard UTXOs, each a minting NFT of category R with an empty state;
 *  3. reward: `rewardCategory` given (mainnet FLDCH), or a test FT minted to the vaults (chipnet/mock).
 * Categories are known before the contracts exist (= txid of the genesis outpoint), which is
 * why R and P can be constructor parameters of the covenants.
 */
export async function deployDrops(args: {
  provider: NetworkProvider;
  network: string;
  authority: KeyWallet;
  shards: number;
  rootTimelock: number;
  rewardCategory?: string;
  testRewardSupply?: bigint;
  log?: (s: string) => void;
}): Promise<Deployment> {
  const log = args.log ?? console.log;
  const { provider, authority: w } = args;
  const txids: Record<string, string> = {};
  // Refuse before any transaction is sent (the genesis prep below already broadcasts).
  if (!args.rewardCategory && args.network === 'mainnet') throw new Error('refusing to mint a test reward token on mainnet');

  const pOut = await prepareGenesisOutpoint(provider, w, 20_000n);
  const pendingCategory = pOut.txid;
  const rOut = await prepareGenesisOutpoint(provider, w, BigInt(args.shards) * (SHARD_SATS + 500n) + 5_000n, [pOut]);
  const receiptCategory = rOut.txid;
  let rewardOut: S | undefined;
  if (!args.rewardCategory) rewardOut = await prepareGenesisOutpoint(provider, w, BigInt(args.shards) * (TOKEN_DUST + 500n) + 5_000n, [pOut, rOut]);
  const rewardCategory = args.rewardCategory ?? rewardOut!.txid;

  const config: DropsConfig = { receiptCategory, pendingCategory, rewardCategory, authorityPkh: w.pkh, rootTimelock: args.rootTimelock };
  const c = dropsContracts(config, provider);

  // 1. Authority minting NFT.
  {
    const b = new TransactionBuilder({ provider })
      .addInput(pOut, w.signer.unlockP2PKH())
      .addOutput({ to: w.tokenAddress, amount: TOKEN_DUST, token: { category: pendingCategory, amount: 0n, nft: { capability: 'minting', commitment: '' } } });
    b.addBchChangeOutputIfNeeded({ to: w.address, feeRate: 1 });
    txids.authorityGenesis = (await b.send()).txid;
    log(`authority genesis ${txids.authorityGenesis}`);
  }
  // 2. Shards.
  {
    const b = new TransactionBuilder({ provider }).addInput(rOut, w.signer.unlockP2PKH());
    for (let s = 0; s < args.shards; s++) {
      b.addOutput({
        to: c.shard.tokenAddress,
        amount: SHARD_SATS,
        token: { category: receiptCategory, amount: 0n, nft: { capability: 'minting', commitment: encodeShardState(emptyShard(s)) } },
      });
    }
    b.addBchChangeOutputIfNeeded({ to: w.address, feeRate: 1 });
    txids.shardGenesis = (await b.send()).txid;
    log(`shard genesis ${txids.shardGenesis} (${args.shards} shards)`);
  }
  // 3. Test reward token minted straight into the vaults (never on mainnet).
  if (rewardOut) {
    const supply = args.testRewardSupply ?? 1_000_000_000n;
    const per = supply / BigInt(args.shards);
    const b = new TransactionBuilder({ provider }).addInput(rewardOut, w.signer.unlockP2PKH());
    for (let s = 0; s < args.shards; s++) b.addOutput({ to: c.vault.tokenAddress, amount: TOKEN_DUST, token: { category: rewardCategory, amount: per } });
    b.addBchChangeOutputIfNeeded({ to: w.address, feeRate: 1 });
    txids.rewardGenesis = (await b.send()).txid;
    log(`test reward genesis ${txids.rewardGenesis} (${supply} units into ${args.shards} vault UTXOs)`);
  }
  return {
    network: args.network,
    createdAt: new Date().toISOString(),
    config,
    shards: args.shards,
    addresses: { shard: c.shard.tokenAddress, vault: c.vault.tokenAddress, pending: c.pending.tokenAddress, authority: w.tokenAddress },
    txids,
  };
}
