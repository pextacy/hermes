/**
 * Round 3 Claims features G22–G28 (packages/drops/src/insights.ts + DropsSandbox.cancel), on the
 * published tree files and CashScript's MockNetworkProvider (full BCH 2026 VM). Nothing broadcast.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DropsSandbox,
  MerkleTree,
  auditTrees,
  chainRootsByEpoch,
  claimBytesAtDepth,
  claimCost,
  costModel,
  entitlementHistory,
  leaderboard,
  proofDownload,
  proofFor,
  proofPath,
  tamperRoot,
  treeEntries,
  verifyProof,
  type TreeFileLike,
} from '@hermes/drops';

const DEP = new URL('../packages/drops/deployments/', import.meta.url);
const trees = (): TreeFileLike[] => [1, 2].map((e) => JSON.parse(readFileSync(new URL(`tree-${e}.json`, DEP), 'utf8')));
const [t1, t2] = trees();
const member = t2.entries[3].lockingBytecode;
const onlyIn2 = t2.entries.find((e) => !t1.entries.some((x) => x.lockingBytecode === e.lockingBytecode));

describe('G22 proof download', () => {
  it('produces a parseable JSON file equal to proofFor() for the newest tree containing the address', () => {
    const d = proofDownload(trees(), member)!;
    expect(d.filename).toMatch(/^hermes-drops-proof-epoch2-account\d+\.json$/);
    const parsed = JSON.parse(d.json);
    const ref = proofFor(t2, member)!;
    expect(parsed.root).toBe(t2.root);
    expect(parsed.publishedRoot).toBe(t2.root);
    expect(parsed.proof).toBe(ref.proof);
    expect(parsed.path).toBe(ref.path);
    expect(parsed.verifies).toBe(true);
    expect(parsed.leaf.cumulative).toBe(String(ref.leaf.cumulative));
    expect(verifyProof({ ...parsed.leaf, cumulative: BigInt(parsed.leaf.cumulative) }, parsed.proof, parsed.path, parsed.root)).toBe(true);
  });
  it('selects a specific epoch and returns undefined for non-members', () => {
    const lb = t1.entries[0].lockingBytecode;
    expect(JSON.parse(proofDownload(trees(), lb, 1)!.json).epoch).toBe(1);
    expect(proofDownload(trees(), '76a914' + '00'.repeat(20) + '88ac')).toBeUndefined();
  });
});

describe('G23 entitlement history', () => {
  it('one point per epoch, cumulative from the trees, earned = delta', () => {
    const h = entitlementHistory(trees(), member);
    expect(h.map((p) => p.epoch)).toEqual([1, 2]);
    const c1 = t1.entries.find((e) => e.lockingBytecode === member);
    const c2 = BigInt(t2.entries[3].cumulative);
    expect(h[1].cumulative).toBe(c2);
    expect(h[0].cumulative).toBe(c1 ? BigInt(c1.cumulative) : 0n);
    expect(h[1].earned).toBe(c2 - h[0].cumulative);
    expect(h[0].earned).toBe(h[0].cumulative);
  });
  it('an address absent from an epoch carries 0 / unchanged and member=false', () => {
    if (!onlyIn2) return;
    const h = entitlementHistory(trees(), onlyIn2.lockingBytecode);
    expect(h[0]).toMatchObject({ member: false, cumulative: 0n, earned: 0n });
    expect(h[1].member).toBe(true);
  });
});

describe('G24 leaderboard', () => {
  it('top n sorted by cumulative descending with shares', () => {
    const lb = leaderboard(t2, 10);
    expect(lb.rows).toHaveLength(10);
    expect(lb.members).toBe(t2.entries.length);
    const all = treeEntries(t2).map((e) => e.cumulative).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
    expect(lb.rows.map((r) => r.cumulative)).toEqual(all.slice(0, 10));
    expect(lb.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(lb.total).toBe(all.reduce((s, x) => s + x, 0n));
    expect(lb.rows[0].shareBps).toBeGreaterThan(0);
    expect(lb.rows[0].shareBps).toBeLessThanOrEqual(10000);
  });
  it('breaks ties by accountId', () => {
    const t: TreeFileLike = { epoch: 1, root: '', entries: [5, 3, 9].map((accountId) => ({ lockingBytecode: '51', cumulative: '7', accountId })) };
    expect(leaderboard(t).rows.map((r) => r.accountId)).toEqual([3, 5, 9]);
    expect(leaderboard(t).rows[0].shareBps).toBe(3333);
  });
});

describe('G25 root audit', () => {
  it('every published tree recomputes to its stored root', () => {
    const a = auditTrees(trees());
    expect(a).toHaveLength(2);
    for (const r of a) expect(r).toMatchObject({ fileOk: true, shapeOk: true, chainOk: undefined });
  });
  it('detects an edited entry and a chain root that does not match', () => {
    const bad = trees();
    bad[0].entries[0] = { ...bad[0].entries[0], cumulative: String(BigInt(bad[0].entries[0].cumulative) + 1n) };
    const chain = chainRootsByEpoch({ shards: [{ epoch: 2, root: t2.root }, { epoch: 0, root: '00' }], pending: [{ epoch: 2, root: tamperRoot(t2.root) }] });
    const a = auditTrees(bad, chain);
    expect(a[0].fileOk).toBe(false);
    expect(a[1].fileOk).toBe(true);
    expect(a[1].chainRoots).toEqual([t2.root, tamperRoot(t2.root)]);
    expect(a[1].chainOk).toBe(false);
    expect(auditTrees(trees(), new Map([[1, [t1.root]]]))[0].chainOk).toBe(true);
  });
});

describe('G26 proof path', () => {
  it('leaf → depth steps → root, each parent = SHA256 of the ordered pair, ends at the published root', () => {
    const p = proofPath(t2, member)!;
    expect(p.ok).toBe(true);
    expect(p.steps).toHaveLength(t2.depth!);
    expect(p.steps[0].node).toBe(p.leaf);
    for (let i = 1; i < p.steps.length; i++) expect(p.steps[i].node).toBe(p.steps[i - 1].parent);
    expect(p.steps[p.steps.length - 1].parent).toBe(t2.root);
    const proof = new MerkleTree(treeEntries(t2)).proof(p.leafIndex);
    expect(p.steps.map((s) => s.sibling).join('')).toBe(proof.siblings);
    expect(p.steps.map((s, i) => (s.isRight ? 1 << i : 0)).reduce((a, b) => a + b, 0)).toBe(proof.path);
    expect(proofPath(t2, '51')).toBeUndefined();
  });
  it('flags zero-padding siblings (last leaf of a non-power-of-two tree)', () => {
    const entries = [0, 1, 2].map((accountId) => ({ lockingBytecode: `5${accountId + 1}`, cumulative: String(accountId + 1), accountId }));
    const t: TreeFileLike = { epoch: 1, root: new MerkleTree(treeEntries({ epoch: 1, root: '', entries })).root, entries };
    const p = proofPath(t, '53')!;
    expect(p.ok).toBe(true);
    expect(p.steps[0].siblingIsPadding).toBe(true);
    expect(p.steps[1].siblingIsPadding).toBe(false);
  });
});

describe('G27 claim cost estimator', () => {
  it('matches the cost model at depth 9 and scales with depth', () => {
    expect(claimBytesAtDepth(9)).toBe(1800);
    expect(claimBytesAtDepth(10)).toBe(1832);
    const c = claimCost({ claims: 1, feeRate: 1, depth: 9, firstClaims: 0 });
    expect(c.laterClaimSats).toBe(costModel({ users: 1, epochs: 1, claimRate: 1, feeRate: 1, tokenDust: 1000, shards: 1 }).pull.userSatsPerClaim);
    expect(c.totalSats).toBe(c.laterClaimSats);
  });
  it('claims × size × fee rate, first claims lock one extra dust', () => {
    const c = claimCost({ claims: 12, feeRate: 2, depth: 9, firstClaims: 1, tokenDust: 1000 });
    expect(c.totalBytes).toBe(12 * 1800);
    expect(c.feeSats).toBe(12 * 3600);
    expect(c.dustSats).toBe(2000 + 11 * 1000);
    expect(c.totalSats).toBe(c.feeSats + c.dustSats);
    expect(claimCost({ claims: 0, feeRate: 1, depth: 9 }).totalSats).toBe(0);
    expect(() => claimCost({ claims: -1, feeRate: 1, depth: 9 })).toThrow();
  });
});

describe('G28 sandbox authority veto', () => {
  it('publish a bad root → audit flags it → cancel before the timelock → nothing to promote → publish the good root → claim', async () => {
    const sb = await DropsSandbox.create({ trees: trees(), rootTimelock: 3 });
    const good = sb.trees.find((t) => t.epoch === 1)!.root;
    await sb.publish(1, { root: tamperRoot(good) });
    let { pool } = await sb.status();
    expect(pool.pending.length).toBeGreaterThan(0);
    expect(pool.pending.every((p) => p.matchesTree === false && (p.remaining ?? 0) > 0)).toBe(true);
    expect(auditTrees(sb.trees, chainRootsByEpoch(pool))[0].chainOk).toBe(false);
    sb.mine(1);
    const txids = await sb.cancel(1);
    expect(txids).toHaveLength(pool.pending.length);
    ({ pool } = await sb.status());
    expect(pool.pending).toHaveLength(0);
    sb.mine(5);
    expect((await sb.promote()).promoted).toHaveLength(0);
    expect(await sb.cancel(1)).toEqual([]);
    await sb.publish(1);
    sb.mine(3);
    const pr = await sb.promote();
    expect(pr.promoted.length).toBeGreaterThan(0);
    ({ pool } = await sb.status());
    expect(auditTrees(sb.trees, chainRootsByEpoch(pool))[0].chainOk).toBe(true);
    const r = await sb.claim();
    expect(r.payout).toBe(100_000n);
  }, 60_000);
});
