/**
 * Full Drops lifecycle through the production code paths, on the BCH 2026 VM (mock network with
 * transaction validation): deployDrops genesis → tree from a distribution with an included demo
 * address (CLI `tree --include`) → authority buildPublish → buildPromote after the timelock →
 * claimForWallet (the web Claims tab path) → epoch 2 → claim again. Only the chain is simulated.
 */
import { describe, expect, it } from 'vitest';
import { MockNetworkProvider, randomUtxo, type Utxo } from 'cashscript';
import { generatePrivateKey } from '@bitauth/libauth';
import { walletFromPrivateKey } from '@hermes/chain';
import {
  AccountRegistry,
  MerkleTree,
  accumulate,
  buildPromote,
  buildPublish,
  claimForWallet,
  decodeReceipt,
  decodeShardState,
  deployDrops,
  dropsContracts,
  includeAddresses,
  padWithSample,
} from '@hermes/drops';

type S = Utxo & { lockingBytecode: string };

describe('Drops end to end (production code paths)', () => {
  it('deploy → publish → promote → claim → next epoch → claim the difference', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    const authority = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    provider.addUtxo(authority.address, randomUtxo({ satoshis: 2_000_000n }));
    const d = await deployDrops({ provider, network: 'mock', authority, shards: 2, rootTimelock: 2, log: () => undefined });
    expect(Object.keys(d.txids)).toEqual(['authorityGenesis', 'shardGenesis', 'rewardGenesis']);
    const c = dropsContracts(d.config, provider);
    expect((await provider.getUtxos(c.shard.tokenAddress)).length).toBe(2);

    // Epoch 1 from a FoldingCash-style distribution + one demo wallet (tree --include).
    const demo = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    provider.addUtxo(demo.address, randomUtxo({ satoshis: 50_000n }));
    const registry = new AccountRegistry();
    const e1 = accumulate(new Map(), [{ amount: 12.5, bitcoinAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }], 8, registry);
    const entries1 = padWithSample(includeAddresses(e1.entries, [demo.address], 100_000n, registry), 300, registry);
    const tree1 = new MerkleTree(entries1);

    const authUtxos = async () => [...(await provider.getUtxos(authority.address)), ...(await provider.getUtxos(authority.tokenAddress))] as S[];
    const publish = async (epoch: number, root: string) =>
      buildPublish({ provider, contracts: c, authority: authority.signer, authorityAddress: authority.address, authorityTokenAddress: authority.tokenAddress, authorityUtxos: await authUtxos(), pendingCategory: d.config.pendingCategory, epoch, root, shards: d.shards }).send();
    const promoteAll = async () => {
      for (const p of (await provider.getUtxos(c.pending.tokenAddress)) as S[]) {
        const shards = (await provider.getUtxos(c.shard.tokenAddress)) as S[];
        const idx = Number.parseInt(p.token!.nft!.commitment.slice(0, 2), 16);
        const shard = shards.find((s) => decodeShardState(s.token!.nft!.commitment).shardIndex === idx)!;
        await buildPromote({ provider, contracts: c, receiptCategory: d.config.receiptCategory, shardUtxo: shard, pendingUtxo: p, rootTimelock: d.config.rootTimelock, funder: { address: authority.address, utxos: ((await provider.getUtxos(authority.address)) as S[]).filter((u) => !u.token), signer: authority.signer } }).send();
      }
    };

    await publish(1, tree1.root);
    expect((await provider.getUtxos(c.pending.tokenAddress)).length).toBe(2);
    await promoteAll();
    expect(((await provider.getUtxos(c.shard.tokenAddress)) as S[]).every((s) => decodeShardState(s.token!.nft!.commitment).root === tree1.root)).toBe(true);

    const r1 = await claimForWallet({ provider, config: d.config, entries: entries1, wallet: demo });
    expect(r1.firstClaim).toBe(true);
    expect(r1.payout).toBe(100_000n);

    // Epoch 2: the demo wallet earned more.
    const entries2 = entries1.map((e) => (e.lockingBytecode === demo.lockingBytecode ? { ...e, cumulative: 250_000n } : e));
    const tree2 = new MerkleTree(entries2);
    await publish(2, tree2.root);
    await promoteAll();
    const r2 = await claimForWallet({ provider, config: d.config, entries: entries2, wallet: demo });
    expect(r2.firstClaim).toBe(false);
    expect(r2.payout).toBe(150_000n);

    const tokens = (await provider.getUtxos(demo.tokenAddress)) as S[];
    const reward = tokens.filter((u) => u.token?.category === d.config.rewardCategory).reduce((n, u) => n + u.token!.amount, 0n);
    expect(reward).toBe(250_000n);
    const receipts = tokens.filter((u) => u.token?.category === d.config.receiptCategory);
    expect(receipts).toHaveLength(1); // the old receipt was burned
    expect(decodeReceipt(receipts[0].token!.nft!.commitment).claimedTotal).toBe(250_000n);
    await expect(claimForWallet({ provider, config: d.config, entries: entries2, wallet: demo })).rejects.toThrow(/nothing to claim/);
  }, 120_000);
});
