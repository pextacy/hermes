/**
 * End-to-end Hermes Drops demo on CashScript's MockNetworkProvider (full BCH 2026 VM
 * evaluation, no network, no keys at risk). Shows: tree of N leaves, timelocked root
 * promotion, first claim, a second "first claim" rejected, a later claim with the receipt
 * paying only the difference, early promotion rejected, and measured transaction sizes.
 */
import { binToHex, encodeCashAddress, generatePrivateKey, hash160, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, type Utxo } from 'cashscript';
import { dropsContracts, lockingBytecodeOf, type DropsConfig } from './contracts.js';
import { MerkleTree, type Entitlement } from './merkle.js';
import { emptyShard, encodePending, encodeReceipt, encodeShardState } from './state.js';
import { buildClaim, buildPromote, type ClaimContext } from './tx.js';

type S = Utxo & { lockingBytecode: string };
const rnd = () => binToHex(generatePrivateKey());

function wallet(prefix: 'bchtest' | 'bitcoincash' = 'bchtest') {
  const signer = new SignatureTemplate(generatePrivateKey());
  const pkh = hash160(signer.publicKey);
  return {
    signer,
    address: encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload: pkh }).address,
    lockingBytecode: binToHex(Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac])),
    pkh: binToHex(pkh),
  };
}

export async function runDemo(opts: { leaves?: number; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const N = opts.leaves ?? 400;
  const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
  const authority = wallet();
  const cfg: DropsConfig = {
    receiptCategory: rnd(),
    pendingCategory: rnd(),
    rewardCategory: rnd(),
    authorityPkh: authority.pkh,
    rootTimelock: 144,
  };
  const c = dropsContracts(cfg, provider);
  log(`shard ${c.shard.address}\nvault ${c.vault.address}\npending ${c.pending.address}`);

  // Users and epoch-1 entitlements (cumulative earned, base units).
  const users = Array.from({ length: N }, () => wallet());
  const epoch1: Entitlement[] = users.map((u, i) => ({ lockingBytecode: u.lockingBytecode, cumulative: BigInt(1000 + i * 7), accountId: i }));
  const tree1 = new MerkleTree(epoch1);
  log(`epoch 1: ${N} leaves, depth ${tree1.depth}, root ${tree1.root}`);

  // Genesis state on the mock chain: one shard (accounts 0..703), a funded vault, a pending root.
  const add = (address: string, u: Utxo) => provider.addUtxo(address, u);
  add(c.shard.tokenAddress, randomUtxo({ satoshis: 2000n, token: { category: cfg.receiptCategory, amount: 0n, nft: { capability: 'minting', commitment: encodeShardState(emptyShard(0)) } } }));
  add(c.vault.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: cfg.rewardCategory, amount: 10_000_000_000n } }));
  add(c.pending.tokenAddress, randomUtxo({ satoshis: 800n, token: { category: cfg.pendingCategory, amount: 0n, nft: { capability: 'none', commitment: encodePending(0, 1, tree1.root) } } }));
  const funder = wallet();
  for (let i = 0; i < 4; i++) add(funder.address, randomUtxo({ satoshis: 100_000n }));

  const utxos = async (addr: string) => (await provider.getUtxos(addr)) as S[];
  const results: Record<string, string> = {};

  // 1. Early promotion (sequence below the timelock) must fail.
  {
    const b = buildPromote({
      provider, contracts: c, receiptCategory: cfg.receiptCategory,
      shardUtxo: (await utxos(c.shard.tokenAddress))[0], pendingUtxo: (await utxos(c.pending.tokenAddress))[0],
      rootTimelock: 10, funder: { address: funder.address, utxos: await utxos(funder.address), signer: funder.signer },
    });
    try { b.debug(); results.earlyPromote = 'ACCEPTED (bug)'; } catch { results.earlyPromote = 'rejected ✔'; }
  }
  // 2. Promotion after the timelock.
  {
    const b = buildPromote({
      provider, contracts: c, receiptCategory: cfg.receiptCategory,
      shardUtxo: (await utxos(c.shard.tokenAddress))[0], pendingUtxo: (await utxos(c.pending.tokenAddress))[0],
      rootTimelock: cfg.rootTimelock, funder: { address: funder.address, utxos: await utxos(funder.address), signer: funder.signer },
    });
    const tx = await b.send();
    results.promote = `ok ✔ (${tx.hex.length / 2} bytes)`;
  }

  const ctx = async (): Promise<ClaimContext> => ({
    provider, contracts: c, rewardCategory: cfg.rewardCategory, receiptCategory: cfg.receiptCategory,
    shardUtxos: await utxos(c.shard.tokenAddress), vaultUtxos: await utxos(c.vault.tokenAddress),
  });
  const alice = users[7];
  const aliceIdx = 7;
  add(alice.address, randomUtxo({ satoshis: 50_000n }));
  add(alice.address, randomUtxo({ satoshis: 50_000n }));
  const aliceUtxos = async () => [...(await utxos(alice.address)), ...(await utxos(alice.tokenAddress))];

  // 3. First claim.
  {
    const { builder, payout } = buildClaim({ ctx: await ctx(), tree: tree1, entry: epoch1[aliceIdx], claimerAddress: alice.address, claimerTokenAddress: alice.tokenAddress, claimerUtxos: await aliceUtxos(), signer: alice.signer });
    const tx = await builder.send();
    results.firstClaim = `ok ✔ payout ${payout} (${tx.hex.length / 2} bytes, depth ${tree1.depth})`;
    results.claimBytes = String(tx.hex.length / 2);
  }
  // 4. A second "first claim" (hiding the receipt) must fail: the bitmap bit is set.
  {
    const bitSet = await ctx();
    const fakeFirst = buildClaimForcingFirst(bitSet, tree1, epoch1[aliceIdx], alice, await utxos(alice.address));
    try { fakeFirst.debug(); results.doubleFirstClaim = 'ACCEPTED (bug)'; } catch { results.doubleFirstClaim = 'rejected ✔'; }
  }
  // 5. Claim again in the same epoch with the receipt → nothing to claim.
  try {
    buildClaim({ ctx: await ctx(), tree: tree1, entry: epoch1[aliceIdx], claimerAddress: alice.address, claimerTokenAddress: alice.tokenAddress, claimerUtxos: await aliceUtxos(), signer: alice.signer });
    results.sameEpochAgain = 'built (bug)';
  } catch (e) { results.sameEpochAgain = `refused ✔ (${(e as Error).message})`; }

  // 6. Epoch 2: cumulative grows; publish + promote; claim pays only the difference.
  const epoch2 = epoch1.map((e) => ({ ...e, cumulative: e.cumulative + 500n }));
  const tree2 = new MerkleTree(epoch2);
  add(c.pending.tokenAddress, randomUtxo({ satoshis: 800n, token: { category: cfg.pendingCategory, amount: 0n, nft: { capability: 'none', commitment: encodePending(0, 2, tree2.root) } } }));
  await buildPromote({
    provider, contracts: c, receiptCategory: cfg.receiptCategory,
    shardUtxo: (await utxos(c.shard.tokenAddress))[0], pendingUtxo: (await utxos(c.pending.tokenAddress))[0],
    rootTimelock: cfg.rootTimelock, funder: { address: funder.address, utxos: await utxos(funder.address), signer: funder.signer },
  }).send();
  {
    const { builder, payout } = buildClaim({ ctx: await ctx(), tree: tree2, entry: epoch2[aliceIdx], claimerAddress: alice.address, claimerTokenAddress: alice.tokenAddress, claimerUtxos: await aliceUtxos(), signer: alice.signer });
    await builder.send();
    results.secondEpochClaim = `ok ✔ payout ${payout} (= cumulative ${epoch2[aliceIdx].cumulative} − claimed ${epoch1[aliceIdx].cumulative})`;
  }
  // 7. Old root no longer accepted.
  try {
    buildClaim({ ctx: await ctx(), tree: tree1, entry: epoch1[3], claimerAddress: users[3].address, claimerTokenAddress: users[3].tokenAddress, claimerUtxos: [], signer: users[3].signer });
    results.staleRoot = 'built (bug)';
  } catch (e) { results.staleRoot = `refused ✔ (${(e as Error).message})`; }
  // 8. A tiny claim (no minimum amount) by another user in epoch 2.
  {
    const bob = users[0];
    add(bob.address, randomUtxo({ satoshis: 20_000n }));
    const { builder, payout } = buildClaim({ ctx: await ctx(), tree: tree2, entry: epoch2[0], claimerAddress: bob.address, claimerTokenAddress: bob.tokenAddress, claimerUtxos: await utxos(bob.address), signer: bob.signer });
    await builder.send();
    results.anotherUser = `ok ✔ payout ${payout}`;
  }
  const vaultLeft = (await utxos(c.vault.tokenAddress))[0].token?.amount;
  results.vaultRemaining = String(vaultLeft);
  for (const [k, v] of Object.entries(results)) log(`${k.padEnd(18)} ${v}`);
  return results;
}

/** Adversarial helper: build a claim that pretends to be a first claim (no receipt input). */
function buildClaimForcingFirst(ctx: ClaimContext, tree: MerkleTree, entry: Entitlement, who: ReturnType<typeof wallet>, funding: S[]) {
  const shardUtxo = ctx.shardUtxos[0];
  const vaultUtxo = ctx.vaultUtxos[0];
  const { siblings, path } = tree.proof(tree.indexOfAccount(entry.accountId));
  // Same outputs a first claim would produce, without presenting the receipt.
  return new TransactionBuilder({ provider: ctx.provider })
    .addInput(shardUtxo, ctx.contracts.shard.unlock.claim(hexToBin(entry.lockingBytecode), entry.cumulative, BigInt(entry.accountId), hexToBin(siblings), BigInt(path), 3n))
    .addInput(vaultUtxo, ctx.contracts.vault.unlock.release())
    .addInput(funding[0], who.signer.unlockP2PKH())
    .addOutput({ to: ctx.contracts.shard.tokenAddress, amount: shardUtxo.satoshis, token: shardUtxo.token })
    .addOutput({ to: ctx.contracts.vault.tokenAddress, amount: vaultUtxo.satoshis, token: { category: ctx.rewardCategory, amount: vaultUtxo.token!.amount - entry.cumulative } })
    .addOutput({ to: who.tokenAddress, amount: 1000n, token: { category: ctx.receiptCategory, amount: 0n, nft: { capability: 'none', commitment: encodeReceipt(entry.accountId, entry.cumulative) } } })
    .addOutput({ to: who.tokenAddress, amount: 1000n, token: { category: ctx.rewardCategory, amount: entry.cumulative } });
}

export { lockingBytecodeOf };

if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === `file://${process.argv[1]}`) {
  await runDemo({ leaves: Number(process.argv[2] ?? 400) });
  process.exit(0);
}
