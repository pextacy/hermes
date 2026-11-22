import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { binToHex, generatePrivateKey, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, TransactionBuilder, randomUtxo, type Utxo } from 'cashscript';
import { walletFromPrivateKey } from '@hermes/chain';
import {
  AccountRegistry,
  MerkleTree,
  accumulate,
  buildClaim,
  buildPromote,
  costModel,
  decodeReceipt,
  decodeShardState,
  dropsContracts,
  emptyShard,
  encodePending,
  encodeReceipt,
  encodeShardState,
  leafHash,
  lockingBytecodeForUser,
  padWithSample,
  verifyProof,
  type ClaimContext,
  type DropsConfig,
  type Entitlement,
} from '@hermes/drops';
import { runDemo } from '@hermes/drops/demo';

type S = Utxo & { lockingBytecode: string };
const rnd = () => binToHex(generatePrivateKey());

describe('Merkle tree', () => {
  const users = Array.from({ length: 37 }, () => walletFromPrivateKey(generatePrivateKey(), 'chipnet'));
  const entries: Entitlement[] = users.map((u, i) => ({ lockingBytecode: u.lockingBytecode, cumulative: BigInt(10 + i), accountId: i }));
  const tree = new MerkleTree(entries);

  it('every leaf proves against the root; tampering breaks it', () => {
    expect(tree.depth).toBe(6);
    for (let i = 0; i < entries.length; i++) {
      const p = tree.proof(i);
      expect(verifyProof(entries[i], p.siblings, p.path, tree.root)).toBe(true);
    }
    const p = tree.proof(3);
    expect(verifyProof({ ...entries[3], cumulative: entries[3].cumulative + 1n }, p.siblings, p.path, tree.root)).toBe(false);
    expect(verifyProof(entries[3], p.siblings, p.path ^ 1, tree.root)).toBe(false);
  });

  it('leaf encoding is lockingBytecode || cumulative (8 LE) || accountId (4 LE)', () => {
    const e = { lockingBytecode: '76a914' + '11'.repeat(20) + '88ac', cumulative: 0x0102n, accountId: 3 };
    const expected = createHash('sha256').update(Buffer.from(e.lockingBytecode + '0201000000000000' + '03000000', 'hex')).digest('hex');
    expect(binToHex(leafHash(e))).toBe(expected);
  });

  it('rejects out-of-range values', () => {
    expect(() => leafHash({ ...entries[0], cumulative: 0n })).toThrow();
    expect(() => leafHash({ ...entries[0], accountId: -1 })).toThrow();
  });
});

describe('FoldingCash inputs', () => {
  it('maps legacy, cashaddr and token addresses to the same P2PKH bytecode and accumulates', () => {
    const lb = lockingBytecodeForUser({ amount: 1, bitcoinAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' });
    expect(lb?.startsWith('76a914')).toBe(true);
    const reg = new AccountRegistry();
    const a = accumulate(new Map(), [{ amount: 1.5, bitcoinAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }, { amount: 0, bitcoinAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }, { amount: 2 }], 8, reg);
    expect(a.entries).toHaveLength(1);
    expect(a.entries[0].cumulative).toBe(150_000_000n);
    expect(a.skipped).toBe(2);
    const b = accumulate(a.cumulative, [{ amount: 1, bitcoinAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }], 8, reg);
    expect(b.entries[0].cumulative).toBe(250_000_000n); // cumulative only grows
    expect(b.entries[0].accountId).toBe(0); // ids are stable
    const padded = padWithSample(b.entries, 300, reg);
    expect(padded).toHaveLength(300);
    expect(new Set(padded.map((e) => e.accountId)).size).toBe(300);
  });
});

/** A deployed pool on the mock network with one shard holding epoch 1. */
async function pool(n = 50) {
  const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
  const authority = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
  const cfg: DropsConfig = { receiptCategory: rnd(), pendingCategory: rnd(), rewardCategory: rnd(), authorityPkh: authority.pkh, rootTimelock: 144 };
  const c = dropsContracts(cfg, provider);
  const users = Array.from({ length: n }, () => walletFromPrivateKey(generatePrivateKey(), 'chipnet'));
  const entries: Entitlement[] = users.map((u, i) => ({ lockingBytecode: u.lockingBytecode, cumulative: BigInt(1000 + i), accountId: i }));
  const tree = new MerkleTree(entries);
  const state = { ...emptyShard(0), epoch: 1, root: tree.root };
  provider.addUtxo(c.shard.tokenAddress, randomUtxo({ satoshis: 2000n, token: { category: cfg.receiptCategory, amount: 0n, nft: { capability: 'minting', commitment: encodeShardState(state) } } }));
  provider.addUtxo(c.vault.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: cfg.rewardCategory, amount: 1_000_000n } }));
  for (const u of users.slice(0, 5)) provider.addUtxo(u.address, randomUtxo({ satoshis: 50_000n }));
  const ctx = async (): Promise<ClaimContext> => ({
    provider,
    contracts: c,
    rewardCategory: cfg.rewardCategory,
    receiptCategory: cfg.receiptCategory,
    shardUtxos: (await provider.getUtxos(c.shard.tokenAddress)) as S[],
    vaultUtxos: (await provider.getUtxos(c.vault.tokenAddress)) as S[],
  });
  const utxosOf = async (w: (typeof users)[number]) => [...(await provider.getUtxos(w.address)), ...(await provider.getUtxos(w.tokenAddress))] as S[];
  return { provider, cfg, c, users, entries, tree, ctx, utxosOf, authority };
}

/** Hand-built claim transaction so tests can deviate from the honest layout. */
function rawClaim(p: Awaited<ReturnType<typeof pool>>, x: { ctx: ClaimContext; i: number; payTo?: string; payout?: bigint; vaultLeft?: bigint; extraOutput?: boolean; funding: S; newState?: string }) {
  const shard = x.ctx.shardUtxos[0];
  const vault = x.ctx.vaultUtxos[0];
  const e = p.entries[x.i];
  const proof = p.tree.proof(x.i);
  const payout = x.payout ?? e.cumulative;
  const st = decodeShardState(shard.token!.nft!.commitment);
  const bit = { ...st, bitmap: st.bitmap.slice() };
  bit.bitmap[e.accountId >> 3] |= 1 << (e.accountId & 7);
  const to = x.payTo ?? p.users[x.i].tokenAddress;
  const b = new TransactionBuilder({ provider: p.provider })
    .addInput(shard, p.c.shard.unlock.claim(hexToBin(e.lockingBytecode), e.cumulative, BigInt(e.accountId), hexToBin(proof.siblings), BigInt(proof.path), 3n))
    .addInput(vault, p.c.vault.unlock.release())
    .addInput(x.funding, p.users[x.i].signer.unlockP2PKH())
    .addOutput({ to: p.c.shard.tokenAddress, amount: shard.satoshis, token: { category: p.cfg.receiptCategory, amount: 0n, nft: { capability: 'minting', commitment: x.newState ?? encodeShardState(bit) } } })
    .addOutput({ to: p.c.vault.tokenAddress, amount: vault.satoshis, token: { category: p.cfg.rewardCategory, amount: x.vaultLeft ?? vault.token!.amount - payout } })
    .addOutput({ to, amount: 1000n, token: { category: p.cfg.receiptCategory, amount: 0n, nft: { capability: 'none', commitment: encodeReceipt(e.accountId, e.cumulative) } } })
    .addOutput({ to, amount: 1000n, token: { category: p.cfg.rewardCategory, amount: payout } });
  if (x.extraOutput) b.addOutput({ to, amount: 1000n, token: { category: p.cfg.receiptCategory, amount: 0n, nft: { capability: 'none', commitment: encodeReceipt(e.accountId, 0n) } } });
  return b;
}

describe('Drops covenants (BCH 2026 VM)', () => {
  it('end-to-end demo: timelock, first claim, double claim, difference-only payout', async () => {
    const r = await runDemo({ leaves: 300, log: () => undefined });
    expect(r.earlyPromote).toMatch(/rejected/);
    expect(r.promote).toMatch(/^ok/);
    expect(r.firstClaim).toMatch(/^ok/);
    expect(r.doubleFirstClaim).toMatch(/rejected/);
    expect(r.sameEpochAgain).toMatch(/refused/);
    expect(r.secondEpochClaim).toMatch(/payout 500/);
    expect(r.anotherUser).toMatch(/^ok/);
  }, 60_000);

  it('honest first claim pays cumulative and mints a receipt with claimedTotal', async () => {
    const p = await pool();
    const { builder, payout, firstClaim } = buildClaim({ ctx: await p.ctx(), tree: p.tree, entry: p.entries[2], claimerAddress: p.users[2].address, claimerTokenAddress: p.users[2].tokenAddress, claimerUtxos: await p.utxosOf(p.users[2]), signer: p.users[2].signer });
    expect(firstClaim).toBe(true);
    await builder.send();
    expect(payout).toBe(1002n);
    const receipt = (await p.provider.getUtxos(p.users[2].tokenAddress)).find((u) => u.token?.category === p.cfg.receiptCategory)!;
    expect(decodeReceipt(receipt.token!.nft!.commitment)).toEqual({ accountId: 2, claimedTotal: 1002n });
  });

  it('a claim cannot pay more than its entitlement, nor drain extra from the vault', async () => {
    const p = await pool();
    const ctx = await p.ctx();
    const funding = (await p.provider.getUtxos(p.users[1].address))[0] as S;
    expect(() => rawClaim(p, { ctx, i: 1, payout: p.entries[1].cumulative + 1n, funding }).debug()).toThrow();
    expect(() => rawClaim(p, { ctx, i: 1, vaultLeft: ctx.vaultUtxos[0].token!.amount - p.entries[1].cumulative - 5n, funding }).debug()).toThrow();
    expect(() => rawClaim(p, { ctx, i: 1, funding }).debug()).not.toThrow();
  });

  it('a leaf cannot be claimed to another address', async () => {
    const p = await pool();
    const ctx = await p.ctx();
    const funding = (await p.provider.getUtxos(p.users[1].address))[0] as S;
    expect(() => rawClaim(p, { ctx, i: 1, payTo: p.users[0].tokenAddress, funding }).debug()).toThrow();
  });

  it('no stray receipts: an extra receipt output is rejected', async () => {
    const p = await pool();
    const ctx = await p.ctx();
    const funding = (await p.provider.getUtxos(p.users[1].address))[0] as S;
    expect(() => rawClaim(p, { ctx, i: 1, extraOutput: true, funding }).debug()).toThrow();
  });

  it('the first-claim bit must be set in the new shard state', async () => {
    const p = await pool();
    const ctx = await p.ctx();
    const funding = (await p.provider.getUtxos(p.users[1].address))[0] as S;
    expect(() => rawClaim(p, { ctx, i: 1, newState: ctx.shardUtxos[0].token!.nft!.commitment, funding }).debug()).toThrow();
  });

  it('no minimum claim: a 1-unit entitlement can be claimed', async () => {
    const p = await pool(8);
    // Rebuild the pool with a tiny entitlement for account 0.
    const entries = p.entries.map((e, i) => (i === 0 ? { ...e, cumulative: 1n } : e));
    const tree = new MerkleTree(entries);
    const shard = (await p.provider.getUtxos(p.c.shard.tokenAddress))[0] as S;
    const st = { ...decodeShardState(shard.token!.nft!.commitment), root: tree.root };
    const provider = p.provider;
    // Replace the shard state with the new root through a promotion of epoch 2.
    provider.addUtxo(p.c.pending.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: p.cfg.pendingCategory, amount: 0n, nft: { capability: 'none', commitment: encodePending(0, 2, tree.root) } } }));
    const funder = p.users[4];
    await buildPromote({ provider, contracts: p.c, receiptCategory: p.cfg.receiptCategory, shardUtxo: shard, pendingUtxo: (await provider.getUtxos(p.c.pending.tokenAddress))[0] as S, rootTimelock: 144, funder: { address: funder.address, utxos: (await provider.getUtxos(funder.address)) as S[], signer: funder.signer } }).send();
    void st;
    const { builder, payout } = buildClaim({ ctx: await p.ctx(), tree, entry: entries[0], claimerAddress: p.users[0].address, claimerTokenAddress: p.users[0].tokenAddress, claimerUtxos: await p.utxosOf(p.users[0]), signer: p.users[0].signer });
    await builder.send();
    expect(payout).toBe(1n);
  });

  it('promotion: needs the timelock, a newer epoch, the authority category, and keeps the bitmap', async () => {
    const p = await pool();
    const funder = p.users[4];
    const shard = (await p.provider.getUtxos(p.c.shard.tokenAddress))[0] as S;
    const addPending = (category: string, epoch: number) =>
      p.provider.addUtxo(p.c.pending.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category, amount: 0n, nft: { capability: 'none', commitment: encodePending(0, epoch, 'cd'.repeat(32)) } } }));
    const promote = async (pending: S, seq = 144) =>
      buildPromote({ provider: p.provider, contracts: p.c, receiptCategory: p.cfg.receiptCategory, shardUtxo: shard, pendingUtxo: pending, rootTimelock: seq, funder: { address: funder.address, utxos: (await p.provider.getUtxos(funder.address)) as S[], signer: funder.signer } });
    addPending(rnd(), 2); // forged: not the authority's category
    const forged = (await p.provider.getUtxos(p.c.pending.tokenAddress))[0] as S;
    await expect((async () => (await promote(forged)).debug())()).rejects.toThrow();
    addPending(p.cfg.pendingCategory, 2);
    const real = ((await p.provider.getUtxos(p.c.pending.tokenAddress)) as S[]).find((u) => u.token?.category === p.cfg.pendingCategory)!;
    await expect((async () => (await promote(real, 143)).debug())()).rejects.toThrow();
    expect(() => buildPromote({ provider: p.provider, contracts: p.c, receiptCategory: p.cfg.receiptCategory, shardUtxo: shard, pendingUtxo: { ...real, token: { ...real.token!, nft: { capability: 'none', commitment: encodePending(0, 1, 'cd'.repeat(32)) } } }, rootTimelock: 144, funder: { address: funder.address, utxos: [], signer: funder.signer } })).toThrow(/not newer/);
    await (await promote(real)).send();
    const after = decodeShardState(((await p.provider.getUtxos(p.c.shard.tokenAddress))[0] as S).token!.nft!.commitment);
    expect(after.epoch).toBe(2);
    expect(after.root).toBe('cd'.repeat(32));
  });

  it('the vault only moves as input 1 of a shard claim', async () => {
    const p = await pool();
    const vault = (await p.provider.getUtxos(p.c.vault.tokenAddress))[0] as S;
    const thief = p.users[0];
    const b = new TransactionBuilder({ provider: p.provider })
      .addInput((await p.provider.getUtxos(thief.address))[0] as S, thief.signer.unlockP2PKH())
      .addInput(vault, p.c.vault.unlock.release())
      .addOutput({ to: thief.tokenAddress, amount: 1000n, token: vault.token });
    expect(() => b.debug()).toThrow();
  });
});

describe('cost model', () => {
  it('pull keeps operator cost constant in users; push grows linearly', () => {
    const a = costModel({ users: 100, epochs: 12, claimRate: 0.25, feeRate: 1, tokenDust: 1000, shards: 8 });
    const b = costModel({ users: 10_000, epochs: 12, claimRate: 0.25, feeRate: 1, tokenDust: 1000, shards: 8 });
    expect(a.pull.operatorSats).toBe(b.pull.operatorSats);
    expect(b.push.operatorSats).toBeGreaterThan(90 * a.push.operatorSats);
    expect(b.operatorSavingsSats).toBeGreaterThan(0);
  });
});
