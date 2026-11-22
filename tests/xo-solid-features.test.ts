/**
 * F19–F24 (XO + SolidCash) — behaviour added on top of xo*.test.ts and solid-lifecycle.test.ts:
 *
 * F19  the Drops XO template's CashAssembly unlocking scripts produce the exact bytes of a claim
 *      the covenant accepts (first claim and claim-again, BCH 2026 VM), and a Drops claim
 *      invitation opened in a real XO engine decodes as a pinned Hermes template.
 * F20  party CLI: `secret`, argument checks before the mnemonic prompt, `inspect` with the XO
 *      engine's validation issues (run as real subprocesses, offline, no wallet).
 * F21  invitation validation used by the Developers-tab viewer (sample, tamper, network, foreign).
 * F22  lifecycle path selection (lock → claim only / lock → refund only) with transaction sizes.
 * F23  the stateful HermesSwapLedger driven end to end (state, mapping, event, modifiers).
 * F24  the deployment record the lifecycle CLI writes (with the ledger) and the committed records.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { MockNetworkProvider, TransactionBuilder, randomUtxo, type Utxo } from 'cashscript';
import { bigIntToVmNumber, binToHex, decodeTransaction, generatePrivateKey, hexToBin, importWalletTemplate, walletTemplateToCompilerBch } from '@bitauth/libauth';
import { walletFromPrivateKey } from '@hermes/chain';
import { MerkleTree, buildClaim, dropsContracts, emptyShard, encodeReceipt, encodeShardState, vmCategory, withClaimBit, type ClaimContext, type DropsConfig, type Entitlement } from '@hermes/drops';
import { HERMES_TEMPLATES, describeInvitation, hermesDropsClaimTemplate, listInvitationIssues } from '@hermes/xo';
import { party, runLedgerDemo, runSolidLifecycle, type DeploymentRecord, type LifecycleStep } from '../packages/solid/src/lifecycle-core';

type T = any;
type S = Utxo & { lockingBytecode: string };
const ROOT = resolve(__dirname, '..');
const SAMPLE = readFileSync(resolve(ROOT, 'packages/xo/examples/hermes-htlc-lock.invitation.json'), 'utf8');
const rnd = () => binToHex(generatePrivateKey());

// ---------------------------------------------------------------------------------------------
// F19 — the XO Drops claim template, compiled with libauth, against the real covenant.
// ---------------------------------------------------------------------------------------------

/** Compile the template's shard / vault unlocking scripts (P2SH32: arguments + redeem push). */
function xoUnlocking(x: { cfg: DropsConfig; c: ReturnType<typeof dropsContracts>; entry: Entitlement; siblings: string; path: number; again: boolean }) {
  const t = hermesDropsClaimTemplate as T;
  const template = importWalletTemplate({
    $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
    supported: ['BCH_2026_05'],
    version: 0,
    entities: {
      claimer: {
        variables: Object.fromEntries(
          ['receiptCategoryVm', 'pendingCategoryVm', 'rewardCategoryVm', 'vaultBytecode', 'pendingBytecode', 'leafLockingBytecode', 'cumulative', 'accountId', 'proof', 'path'].map((k) => [k, { type: 'AddressData' }]),
        ),
      },
    },
    scripts: {
      shard: { lockingType: 'p2sh32', script: t.scripts.shardRedeem },
      vault: { lockingType: 'p2sh32', script: t.scripts.vaultRedeem },
      shardUnlock: { unlocks: 'shard', script: x.again ? t.scripts.shardClaimAgainUnlock : t.scripts.shardFirstClaimUnlock },
      vaultUnlock: { unlocks: 'vault', script: t.scripts.vaultUnlock || '' },
    },
  } as never);
  if (typeof template === 'string') throw new Error(template);
  const compiler = walletTemplateToCompilerBch(template);
  const data = {
    bytecode: {
      receiptCategoryVm: hexToBin(vmCategory(x.cfg.receiptCategory)),
      pendingCategoryVm: hexToBin(vmCategory(x.cfg.pendingCategory)),
      rewardCategoryVm: hexToBin(vmCategory(x.cfg.rewardCategory)),
      vaultBytecode: hexToBin(x.c.vaultBytecode),
      pendingBytecode: hexToBin(x.c.pendingBytecode),
      leafLockingBytecode: hexToBin(x.entry.lockingBytecode),
      cumulative: bigIntToVmNumber(x.entry.cumulative),
      accountId: bigIntToVmNumber(BigInt(x.entry.accountId)),
      proof: hexToBin(x.siblings),
      path: bigIntToVmNumber(BigInt(x.path)),
    },
  };
  const out = (scriptId: string) => {
    const r = compiler.generateBytecode({ data, scriptId });
    if (!r.success) throw new Error(`${scriptId}: ${JSON.stringify(r.errors)}`);
    return binToHex(r.bytecode);
  };
  return { shard: out('shardUnlock'), vault: out('vaultUnlock') };
}

async function pool(opts: { claimedBefore?: bigint } = {}) {
  const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
  const cfg: DropsConfig = { receiptCategory: rnd(), pendingCategory: rnd(), rewardCategory: rnd(), authorityPkh: '44'.repeat(20), rootTimelock: 144 };
  const c = dropsContracts(cfg, provider);
  const users = Array.from({ length: 9 }, () => walletFromPrivateKey(generatePrivateKey(), 'chipnet'));
  const entries: Entitlement[] = users.map((u, i) => ({ lockingBytecode: u.lockingBytecode, cumulative: BigInt(1000 + i), accountId: i }));
  const tree = new MerkleTree(entries);
  let state = { ...emptyShard(0), epoch: 2, root: tree.root };
  // claim-again: the account bit is already set and the user holds a receipt from an earlier epoch.
  if (opts.claimedBefore !== undefined) state = withClaimBit(state, 4);
  provider.addUtxo(c.shard.tokenAddress, randomUtxo({ satoshis: 2000n, token: { category: cfg.receiptCategory, amount: 0n, nft: { capability: 'minting', commitment: encodeShardState(state) } } }));
  provider.addUtxo(c.vault.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: cfg.rewardCategory, amount: 1_000_000n } }));
  provider.addUtxo(users[4].address, randomUtxo({ satoshis: 50_000n }));
  if (opts.claimedBefore !== undefined)
    provider.addUtxo(users[4].tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: cfg.receiptCategory, amount: 0n, nft: { capability: 'none', commitment: encodeReceipt(4, opts.claimedBefore) } } }));
  const ctx = async (): Promise<ClaimContext> => ({
    provider,
    contracts: c,
    rewardCategory: cfg.rewardCategory,
    receiptCategory: cfg.receiptCategory,
    shardUtxos: (await provider.getUtxos(c.shard.tokenAddress)) as S[],
    vaultUtxos: (await provider.getUtxos(c.vault.tokenAddress)) as S[],
  });
  return { provider, cfg, c, users, entries, tree, ctx, state };
}

describe('F19 XO Drops claim template drives the real covenant (BCH 2026 VM)', () => {
  it('claim: the template’s CashAssembly unlocking bytecode equals the accepted claim’s, byte for byte', async () => {
    const p = await pool();
    const u = p.users[4];
    const utxos = [...(await p.provider.getUtxos(u.address)), ...(await p.provider.getUtxos(u.tokenAddress))] as S[];
    const { builder, payout, firstClaim } = buildClaim({ ctx: await p.ctx(), tree: p.tree, entry: p.entries[4], claimerAddress: u.address, claimerTokenAddress: u.tokenAddress, claimerUtxos: utxos, signer: u.signer });
    expect(firstClaim).toBe(true);
    const tx = decodeTransaction(hexToBin(await builder.build()));
    if (typeof tx === 'string') throw new Error(tx);
    const proof = p.tree.proof(p.tree.indexOfAccount(4));
    const xo = xoUnlocking({ cfg: p.cfg, c: p.c, entry: p.entries[4], siblings: proof.siblings, path: proof.path, again: false });
    expect(binToHex(tx.inputs[0].unlockingBytecode)).toBe(xo.shard);
    expect(binToHex(tx.inputs[1].unlockingBytecode)).toBe(xo.vault);
    // The same transaction is accepted by the VM (send evaluates every input on the mock network).
    await builder.send();
    expect(payout).toBe(1004n);
    // A tampered cumulative changes the XO-compiled bytes — the covenant would see another leaf.
    expect(xoUnlocking({ cfg: p.cfg, c: p.c, entry: { ...p.entries[4], cumulative: 9999n }, siblings: proof.siblings, path: proof.path, again: false }).shard).not.toBe(xo.shard);
  });

  it('claimAgain: the XO layout (receipt as input 2) is accepted by the covenant and pays only the difference', async () => {
    const p = await pool({ claimedBefore: 600n });
    const u = p.users[4];
    const ctx = await p.ctx();
    const shard = ctx.shardUtxos[0];
    const vault = ctx.vaultUtxos[0];
    const receipt = (await p.provider.getUtxos(u.tokenAddress)).find((x) => x.token?.category === p.cfg.receiptCategory)!;
    const funding = (await p.provider.getUtxos(u.address))[0];
    const e = p.entries[4];
    const proof = p.tree.proof(p.tree.indexOfAccount(4));
    const payout = e.cumulative - 600n;
    const xo = xoUnlocking({ cfg: p.cfg, c: p.c, entry: e, siblings: proof.siblings, path: proof.path, again: true });
    const build = (receiptCommitment: string) =>
      new TransactionBuilder({ provider: p.provider })
        // Template claimAgainTransaction: inputs 0 shard / 1 vault / 2 receipt, funding after.
        .addInput(shard, p.c.shard.unlock.claim(hexToBin(e.lockingBytecode), e.cumulative, BigInt(e.accountId), hexToBin(proof.siblings), BigInt(proof.path), 2n))
        .addInput(vault, p.c.vault.unlock.release())
        .addInput(receipt, u.signer.unlockP2PKH())
        .addInput(funding, u.signer.unlockP2PKH())
        .addOutput({ to: p.c.shard.tokenAddress, amount: shard.satoshis, token: { category: p.cfg.receiptCategory, amount: 0n, nft: { capability: 'minting', commitment: encodeShardState(p.state) } } })
        .addOutput({ to: p.c.vault.tokenAddress, amount: vault.satoshis, token: { category: p.cfg.rewardCategory, amount: vault.token!.amount - payout } })
        .addOutput({ to: u.tokenAddress, amount: 1000n, token: { category: p.cfg.receiptCategory, amount: 0n, nft: { capability: 'none', commitment: receiptCommitment } } })
        .addOutput({ to: u.tokenAddress, amount: 1000n, token: { category: p.cfg.rewardCategory, amount: payout } });
    const honest = build(encodeReceipt(4, e.cumulative));
    const tx = decodeTransaction(hexToBin(await honest.build()));
    if (typeof tx === 'string') throw new Error(tx);
    expect(binToHex(tx.inputs[0].unlockingBytecode)).toBe(xo.shard);
    // A receipt that lies about the new claimed total is refused.
    expect(() => build(encodeReceipt(4, e.cumulative - 1n)).debug()).toThrow();
    await honest.send();
    const paid = (await p.provider.getUtxos(u.tokenAddress)).filter((x) => x.token?.category === p.cfg.rewardCategory);
    expect(paid.map((x) => x.token!.amount)).toEqual([payout]);
  });

});

// ---------------------------------------------------------------------------------------------
// F20 — party CLI, as real subprocesses (offline: no mnemonic, no wallet, no network).
// ---------------------------------------------------------------------------------------------

const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const cli = async (args: string[]) => {
  try {
    const r = await promisify(execFile)(TSX, ['src/cli.ts', ...args], { cwd: resolve(ROOT, 'packages/xo'), timeout: 60_000 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
};

describe('F20 XO HTLC party CLI', () => {
  it('secret: prints a fresh 32-byte secret and its SHA-256 hashlock', async () => {
    const r = await cli(['secret']);
    expect(r.code).toBe(0);
    const secret = r.out.match(/secret {3}([0-9a-f]{64})/)![1];
    const hashlock = r.out.match(/hashlock ([0-9a-f]{64})/)![1];
    expect(createHash('sha256').update(Buffer.from(secret, 'hex')).digest('hex')).toBe(hashlock);
    expect((await cli(['secret'])).out).not.toContain(secret);
  });

  it('bad arguments are reported before any mnemonic prompt (exit 1)', async () => {
    const r = await cli(['create', '--hashlock', 'abc', '--timeout', 'soon']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--hashlock must be 32 bytes of hex');
    expect(r.err).toContain('--timeout must be a unix timestamp');
    expect(r.out).not.toContain('mnemonic');
    const c = await cli(['claim', '--secret', '12', '--token', 'xyz']);
    expect(c.code).toBe(1);
    expect(c.err).toContain('--secret must be the 32-byte secret');
    expect(c.err).toContain('--token must be a 32-byte token category');
    expect((await cli(['join'])).err).toContain('--in is required');
  });

  it('help needs no mnemonic and lists every command', async () => {
    const r = await cli(['help']);
    expect(r.code).toBe(0);
    for (const c of ['create', 'join', 'fund', 'claim', 'refund', 'inspect', 'secret']) expect(r.out).toContain(`tsx src/cli.ts ${c}`);
  });

  it('inspect: decodes and validates a real two-party invitation; a network mismatch exits 2 (no approval needed to read)', async () => {
    const ok = await cli(['inspect', '--in', 'examples/hermes-htlc-lock.invitation.json']);
    expect(ok.code).toBe(0);
    const v = JSON.parse(ok.out);
    expect(v).toMatchObject({ pinned: true, templateName: 'Hermes HTLC', action: 'lock', network: 'chipnet', issues: [] });
    const main = await cli(['inspect', '--in', 'examples/hermes-htlc-lock.invitation.json', '--network', 'mainnet']);
    expect(main.code).toBe(2);
    expect(JSON.parse(main.out).issues.join(' ')).toMatch(/network mismatch: expected mainnet, got testnet/);
    expect(main.err).toContain('validation issue(s) on mainnet — do not sign');
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// F21 — invitation validation used by the Developers-tab viewer.
// ---------------------------------------------------------------------------------------------

describe('F21 invitation viewer validation', () => {
  it('the bundled sample is a genuine HTLC lock joined by a counterparty', async () => {
    const v = describeInvitation(SAMPLE);
    expect(v).toMatchObject({ pinned: true, templateName: 'Hermes HTLC', action: 'lock' });
    expect(v.commits.map((c) => c.role)).toEqual(['initiator', 'initiator', 'counterparty', 'counterparty']);
    const vars = v.commits.flatMap((c) => c.variables.map((x) => x.id));
    expect(vars).toEqual(['initiatorPublicKey', 'hashlock', 'timeout', 'lockedSatoshis', 'counterpartyPublicKey']);
    expect(await listInvitationIssues(SAMPLE, 'chipnet')).toEqual([]);
  });

  it('flags commits past their expiry', () => {
    const v = describeInvitation(SAMPLE, Date.UTC(2100, 0, 1));
    expect(v.commits.every((c) => c.expired)).toBe(true);
    expect(describeInvitation(SAMPLE, 0).commits.some((c) => c.expired)).toBe(false);
  });

  it('reports a tampered variable, the wrong network and a foreign template', async () => {
    const tampered = JSON.parse(SAMPLE);
    tampered.commits[1].data.variables[1].value = 'cd'.repeat(32);
    expect((await listInvitationIssues(JSON.stringify(tampered))).join(' ')).toMatch(/Commit signature invalid/);
    expect((await listInvitationIssues(SAMPLE, 'mainnet')).join(' ')).toMatch(/expected mainnet, got testnet/);
    const foreign = { ...JSON.parse(SAMPLE), templateIdentifier: 'ff'.repeat(32) };
    expect(await listInvitationIssues(JSON.stringify(foreign))).toEqual([expect.stringMatching(/not a pinned Hermes template/)]);
    expect(describeInvitation(JSON.stringify(foreign)).pinned).toBe(false);
  });

  it('malformed text is rejected by the decoder', async () => {
    expect(() => describeInvitation('{"not":"an invitation"}')).toThrow();
    await expect(listInvitationIssues('not json')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// F22 / F23 / F24 — SolidCash.
// ---------------------------------------------------------------------------------------------

const req = createRequire(new URL('../packages/solid/package.json', import.meta.url));
const solidPath = (s: string) => realpathSync(req.resolve(s));
const MOCK = solidPath('@solidcash/solidcash/network/mock');
const ELECTRUM = solidPath('@solidcash/solidcash/network/electrum');
const solidMock = () => import(/* @vite-ignore */ MOCK) as Promise<{ MockNetworkProvider: new () => any; MOCK_DEFAULT_BLOCK_TIME: number }>;
const key = (b: number) => new Uint8Array(32).fill(b);

describe('F22 SolidCash lifecycle path selection', () => {
  it('runs only lock → refund, or only lock → claim, and reports tx sizes', async () => {
    const { MockNetworkProvider } = await solidMock();
    const refund = await runSolidLifecycle({ provider: new MockNetworkProvider(), mock: true, prefix: 'bchtest', locker: party(key(3), 'bchtest'), lockSats: 10_000n, now: 1_700_000_000, paths: ['refund'] });
    expect(refund.map((s) => `${s.path}:${s.step}`)).toEqual(['refund:lock', 'refund:refund-early', 'refund:refund']);
    expect(refund.every((s) => s.ok)).toBe(true);
    expect(refund[2].bytes).toBeGreaterThan(100);
    const claim = await runSolidLifecycle({ provider: new MockNetworkProvider(), mock: true, prefix: 'bchtest', locker: party(key(4), 'bchtest'), lockSats: 10_000n, now: 1_700_000_000, paths: ['claim'] });
    expect(claim.map((s) => s.step)).toEqual(['lock', 'wrong-secret', 'claim']);
    expect(claim[2].txid).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('F23 HermesSwapLedger (state, mapping, events, modifiers)', () => {
  it('deploy → refused records → record → replay refused → state and Settled event read back', async () => {
    const { MockNetworkProvider } = await solidMock();
    const seen: LifecycleStep[] = [];
    const steps = await runLedgerDemo({ provider: new MockNetworkProvider(), mock: true, operatorKey: key(8), amount: 750n, direction: 2n, onStep: (s) => seen.push(s) });
    expect(steps.map((s) => s.step)).toEqual(['deploy', 'wrong-secret', 'not-operator', 'record', 'replay', 'state']);
    expect(steps.every((s) => s.ok && s.path === 'ledger')).toBe(true);
    expect(seen).toEqual(steps);
    expect(steps[0].address).toMatch(/^bchtest:p/);
    expect(steps[0].txid).toMatch(/^[0-9a-f]{64}$/);
    // Each refusal names the failing `require` of the contract (modifier or body).
    expect(steps[1].note).toContain('secret does not open the hashlock');
    expect(steps[2].note).toContain('operator signature required');
    expect(steps[4].note).toContain('already recorded');
    expect(steps[3].note).toContain('PUSD→USDC');
    expect(steps[5].note).toContain('settledCount = 1, settledVolume = 750, settledAmount[hashlock] = 750; 1 Settled event(s), amount 750, direction 2');
  });
});

describe('F24 SolidCash deployment record', () => {
  class Exit extends Error {
    constructor(readonly code?: number) {
      super(`exit ${code}`);
    }
  }
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
    vi.doUnmock(ELECTRUM);
    vi.doUnmock('node:readline');
    vi.doUnmock('node:fs');
    vi.useRealTimers();
    vi.resetModules();
  });

  it('a live run with --ledger records both contracts, the amount and every step — never the key', async () => {
    const { MockNetworkProvider, MOCK_DEFAULT_BLOCK_TIME } = await solidMock();
    const { randomUtxo: solidUtxo } = (await import(/* @vite-ignore */ solidPath('@solidcash/solidcash'))) as T;
    const hex = '22'.repeat(32);
    const locker = party(hexToBin(hex), 'bchtest');
    vi.doMock(ELECTRUM, () => ({
      ElectrumNetworkProvider: class extends MockNetworkProvider {
        constructor() {
          super();
          for (let i = 0; i < 8; i++) this.addUtxo(locker.address, solidUtxo({ satoshis: 1_000_000n }));
        }
      },
    }));
    vi.doMock('node:readline', () => ({ createInterface: () => ({ question: (_q: string, cb: (a: string) => void) => cb(hex), close: () => {} }) }));
    const written: { file: string; data: string }[] = [];
    vi.doMock('node:fs', async (orig) => ({ ...((await orig()) as object), writeFileSync: (f: URL, d: string) => written.push({ file: String(f), data: d }) }));
    vi.useFakeTimers({ toFake: ['Date'], now: MOCK_DEFAULT_BLOCK_TIME * 1000 });
    vi.resetModules();
    process.argv = ['node', 'lifecycle.ts', '--network', 'chipnet', '--ledger'];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Exit(c);
    }) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const e = await import('../packages/solid/src/lifecycle').then(() => undefined, (x) => x);
    expect(e).toBeInstanceOf(Exit);
    expect((e as Exit).code).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0].file).toMatch(/packages\/solid\/deployments\/chipnet\.json$/);
    const rec = JSON.parse(written[0].data) as DeploymentRecord;
    expect(rec).toMatchObject({ network: 'chipnet', contract: 'HermesHtlc.scash', contracts: ['HermesHtlc.scash', 'HermesSwapLedger.scash'], lockSats: '10000' });
    expect(rec.steps.map((s) => s.path)).toEqual([...Array(3).fill('claim'), ...Array(3).fill('refund'), ...Array(6).fill('ledger')]);
    expect(rec.steps.every((s) => s.ok)).toBe(true);
    expect(rec.steps.filter((s) => s.txid).length).toBe(7);
    expect(written[0].data).not.toContain(hex);
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[ledger] ✔'))).toHaveLength(6);
  }, 120_000);

  it('--path validates its value', async () => {
    vi.resetModules();
    process.argv = ['node', 'lifecycle.ts', '--path', 'both'];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Exit(c);
    }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = await import('../packages/solid/src/lifecycle').then(() => undefined, (x) => x);
    expect((e as Exit).code).toBe(1);
    expect(String(err.mock.calls[0][0])).toContain('--path must be claim or refund');
  });

  it('committed records (if any) are well-formed and contain no keys', () => {
    const dir = resolve(ROOT, 'packages/solid/deployments');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    for (const f of files) {
      const rec = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as DeploymentRecord;
      expect(['chipnet', 'mainnet']).toContain(rec.network);
      expect(f).toBe(`${rec.network}.json`);
      expect(Array.isArray(rec.steps)).toBe(true);
      expect(JSON.stringify(rec)).not.toMatch(/priv|wif|mnemonic/i);
    }
  });
});

// Last in the file: a stopped XO engine may still settle its background Electrum header sync.
describe('F19 Drops claim invitation from a real XO engine (offline)', () => {
  it(
    'a claim invitation from a real XO engine decodes as the pinned Hermes Drops template with no validation issues',
    async () => {
      const { openEngine, exportInvitation } = await import('@hermes/xo');
      const engine = await openEngine('page pencil stock planet limb cluster assault speak off joke private pioneer', { network: 'chipnet', databaseFilename: `xo-f19-${Date.now()}` });
      try {
        const { templateIdentifier } = await engine.importTemplate(hermesDropsClaimTemplate as never);
        expect(templateIdentifier).toBe(HERMES_TEMPLATES.find((t) => t.name === 'Hermes Drops claim')!.identifier);
        const inv = await engine.createInvitation({ templateIdentifier, actionIdentifier: 'claim', intent: (hermesDropsClaimTemplate as T).start[0] } as never);
        const text = exportInvitation(inv.invitation);
        const view = describeInvitation(text);
        expect(view).toMatchObject({ pinned: true, templateName: 'Hermes Drops claim', action: 'claim' });
        expect(view.commits[0].role).toBe('claimer');
        expect(await listInvitationIssues(text, 'chipnet')).toEqual([]);
        const missing = await engine.listMissingRequirements(inv.invitation.invitationIdentifier);
        expect(missing.templateRequirements.inputs).toEqual(['shardInput', 'vaultInput']);
      } finally {
        await engine.stop();
      }
    },
    120_000,
  );
});
