import { generatePrivateKey } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo, type Utxo } from 'cashscript';
import { walletFromPrivateKey, type KeyWallet } from '@hermes/chain';
import { deployDrops, type Deployment } from './deploy.js';
import { dropsContracts } from './contracts.js';
import { MerkleTree } from './merkle.js';
import { buildCancel, buildPromote, buildPublish } from './tx.js';
import { decodePending, decodeShardState, shardOf } from './state.js';
import { claimForWallet } from './claim-for.js';
import { readAccountStatus, readPoolStatus, treeEntries, type AccountStatus, type PoolStatus, type TreeFileLike } from './status.js';

type S = Utxo & { lockingBytecode: string };

/**
 * In-browser Drops pool (Claims tab, before / without a chipnet deployment): the production
 * deploy → publish → promote → claimForWallet code on CashScript's MockNetworkProvider (full
 * BCH 2026 VM, nothing broadcast). Trees are the published tree-N.json files plus one sandbox
 * leaf for `wallet` (100,000 units × epoch, like `tree --include`), so roots differ from the
 * published ones. Block height is simulated: a promotion spends the pending root with
 * nSequence = its age, so promoting early is rejected by the covenant's CSV check itself.
 */
export class DropsSandbox {
  readonly heights = new Map<string, number>(); // txid → simulated height
  height = 1;
  private constructor(
    readonly provider: MockNetworkProvider,
    readonly deployment: Deployment,
    readonly authority: KeyWallet,
    readonly wallet: KeyWallet,
    readonly trees: TreeFileLike[],
    readonly log: (s: string) => void,
  ) {}

  /** Published trees + the sandbox leaf for `wallet` (unchanged when the wallet is already a leaf). */
  static sandboxTrees(trees: TreeFileLike[], lockingBytecode: string, perEpoch = 100_000n): TreeFileLike[] {
    const maxId = Math.max(-1, ...trees.flatMap((t) => t.entries.map((e) => e.accountId)));
    const existing = trees.flatMap((t) => t.entries).find((e) => e.lockingBytecode === lockingBytecode);
    const accountId = existing?.accountId ?? maxId + 1;
    return [...trees]
      .sort((a, b) => a.epoch - b.epoch)
      .map((t) => {
        const entries = treeEntries(t);
        if (!entries.some((e) => e.lockingBytecode === lockingBytecode)) entries.push({ lockingBytecode, cumulative: perEpoch * BigInt(t.epoch), accountId });
        const root = new MerkleTree(entries).root;
        return { ...t, root, leaves: entries.length, entries };
      });
  }

  static async create(opts: { trees: TreeFileLike[]; wallet?: KeyWallet; rootTimelock?: number; log?: (s: string) => void }) {
    if (!opts.trees.length) throw new Error('no published tree to build the sandbox from');
    const log = opts.log ?? (() => undefined);
    const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    const authority = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    const wallet = opts.wallet ?? walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    const trees = DropsSandbox.sandboxTrees(opts.trees, wallet.lockingBytecode);
    const maxId = Math.max(...trees.flatMap((t) => t.entries.map((e) => e.accountId)));
    provider.addUtxo(authority.address, randomUtxo({ satoshis: 5_000_000n }));
    provider.addUtxo(wallet.address, randomUtxo({ satoshis: 200_000n }));
    const deployment = await deployDrops({ provider, network: 'mock', authority, shards: shardOf(maxId) + 1, rootTimelock: opts.rootTimelock ?? 144, log });
    return new DropsSandbox(provider, deployment, authority, wallet, trees, log);
  }

  get contracts() {
    return dropsContracts(this.deployment.config, this.provider);
  }

  mine(blocks: number) {
    this.height += blocks;
  }

  /** Authority: publish the pending root of `epoch` for every shard (`opts.root` overrides it, e.g. a bad root for the veto drill). */
  async publish(epoch: number, opts: { root?: string } = {}) {
    const tree = this.trees.find((t) => t.epoch === epoch);
    if (!tree) throw new Error(`no tree for epoch ${epoch}`);
    const a = this.authority;
    const utxos = [...(await this.provider.getUtxos(a.address)), ...(await this.provider.getUtxos(a.tokenAddress))] as S[];
    const tx = await buildPublish({
      provider: this.provider, contracts: this.contracts, authority: a.signer, authorityAddress: a.address, authorityTokenAddress: a.tokenAddress,
      authorityUtxos: utxos, pendingCategory: this.deployment.config.pendingCategory, epoch, root: opts.root ?? tree.root, shards: this.deployment.shards,
    }).send();
    this.heights.set(tx.txid, this.height);
    this.log(`published epoch ${epoch} root ${(opts.root ?? tree.root).slice(0, 16)}…${opts.root && opts.root !== tree.root ? ' (DOES NOT MATCH the tree)' : ''} at block ${this.height}`);
    return tx.txid;
  }

  /**
   * Authority veto (CLI `cancel`): burn every pending root of `epoch` through DropsPending.cancel
   * (authority signature checked by the covenant on the BCH 2026 VM). Returns the cancel txids.
   */
  async cancel(epoch: number) {
    const c = this.contracts;
    const cfg = this.deployment.config;
    const a = this.authority;
    const txids: string[] = [];
    for (const p of (await this.provider.getUtxos(c.pending.tokenAddress)) as S[]) {
      if (p.token?.category !== cfg.pendingCategory || !p.token.nft) continue;
      const pend = decodePending(p.token.nft.commitment);
      if (pend.epoch !== epoch) continue;
      const funding = ((await this.provider.getUtxos(a.address)) as S[]).filter((u) => !u.token);
      const b = buildCancel({ provider: this.provider, contracts: c, authority: a.signer, authorityAddress: a.address, pendingUtxo: p, funding });
      b.debug();
      const tx = await b.send();
      txids.push(tx.txid);
      this.log(`cancelled pending root epoch ${epoch} shard ${pend.shardIndex} at block ${this.height}: ${tx.txid.slice(0, 16)}…`);
    }
    if (!txids.length) this.log(`no pending root for epoch ${epoch} to cancel`);
    return txids;
  }

  /** Anyone: promote every pending root; each is spent with nSequence = its simulated age. */
  async promote() {
    const c = this.contracts;
    const cfg = this.deployment.config;
    const promoted: { shardIndex: number; epoch: number; txid: string }[] = [];
    const rejected: { shardIndex: number; epoch: number; age: number; reason: string }[] = [];
    for (const p of (await this.provider.getUtxos(c.pending.tokenAddress)) as S[]) {
      if (p.token?.category !== cfg.pendingCategory || !p.token.nft) continue;
      const pend = decodePending(p.token.nft.commitment);
      const shard = ((await this.provider.getUtxos(c.shard.tokenAddress)) as S[]).find((s) => s.token?.nft && decodeShardState(s.token.nft.commitment).shardIndex === pend.shardIndex);
      if (!shard) continue;
      const age = this.height - (this.heights.get(p.txid) ?? this.height);
      try {
        const b = buildPromote({
          provider: this.provider, contracts: c, receiptCategory: cfg.receiptCategory, shardUtxo: shard, pendingUtxo: p, rootTimelock: age,
          funder: { address: this.authority.address, utxos: ((await this.provider.getUtxos(this.authority.address)) as S[]).filter((u) => !u.token), signer: this.authority.signer },
        });
        b.debug(); // full VM evaluation: the covenant's CSV check rejects age < ROOT_TIMELOCK
        const tx = await b.send();
        promoted.push({ shardIndex: pend.shardIndex, epoch: pend.epoch, txid: tx.txid });
      } catch (e) {
        rejected.push({ shardIndex: pend.shardIndex, epoch: pend.epoch, age, reason: (e as Error).message.split('\n')[0].slice(0, 160) });
      }
    }
    for (const r of promoted) this.log(`promoted shard ${r.shardIndex} → epoch ${r.epoch}`);
    for (const r of rejected) this.log(`shard ${r.shardIndex} epoch ${r.epoch}: rejected at age ${r.age}/${cfg.rootTimelock} blocks`);
    return { promoted, rejected };
  }

  async status(): Promise<{ pool: PoolStatus; account: AccountStatus }> {
    const pool = await readPoolStatus({
      provider: this.provider, config: this.deployment.config, trees: this.trees, tip: this.height - 1,
      heights: async () => {
        const m = new Map<string, number>();
        for (const u of await this.provider.getUtxos(this.contracts.pending.tokenAddress)) m.set(`${u.txid}:${u.vout}`, this.heights.get(u.txid) ?? this.height);
        return m;
      },
    });
    const account = await readAccountStatus({ provider: this.provider, config: this.deployment.config, trees: this.trees, pool, wallet: this.wallet });
    return { pool, account };
  }

  /** Claim with the sandbox wallet through `claimForWallet` (the chipnet code path). */
  async claim() {
    const { account } = await this.status();
    if (account.state !== 'claimable' || !account.activeTree) throw new Error(account.message);
    const r = await claimForWallet({ provider: this.provider, config: this.deployment.config, entries: treeEntries(account.activeTree), wallet: this.wallet });
    this.log(`claimed ${r.payout} units (${r.firstClaim ? 'first claim: receipt minted' : 'receipt updated'})`);
    return r;
  }
}
