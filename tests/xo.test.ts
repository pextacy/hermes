import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  bigIntToVmNumber,
  binToHex,
  createVirtualMachineBch2026,
  generatePrivateKey,
  generateTransaction,
  importWalletTemplate,
  secp256k1,
  walletTemplateToCompilerBch,
  hash160,
} from '@bitauth/libauth';
import { hermesDropsClaimTemplate, hermesHtlcTemplate, hermesIdentityTemplate, validateTemplate, describeInvitation, HERMES_TEMPLATES } from '@hermes/xo';
import { MockNetworkProvider } from 'cashscript';
import { dropsContracts, lockingBytecodeOf, vmCategory } from '@hermes/drops';

// Templates are checked structurally; loosen the engine type for traversal.
type T = any;

describe('XO templates are internally consistent', () => {
  for (const t of [hermesHtlcTemplate, hermesIdentityTemplate, hermesDropsClaimTemplate] as T[]) {
    it(`${t.name}: passes the official XO template schema`, () => {
      expect(() => validateTemplate(t)).not.toThrow();
    });
    it(`${t.name}: every reference resolves`, () => {
      for (const s of t.start) expect(t.actions[s.action]).toBeDefined();
      for (const [id, a] of Object.entries<any>(t.actions)) {
        expect(t.transactions![a.transaction], `${id}.transaction`).toBeDefined();
        for (const p of a.requirements?.participants ?? []) expect(t.roles[p.role]).toBeDefined();
        for (const role of Object.values<any>(a.roles ?? {})) {
          for (const v of role.requirements?.variables ?? []) expect(t.variables[v], `${id} var ${v}`).toBeDefined();
          for (const v of role.requirements?.secrets ?? []) expect(t.variables[v]).toBeDefined();
        }
      }
      for (const tx of Object.values<any>(t.transactions!)) {
        for (const i of tx.inputs) expect(t.inputs[i.input]).toBeDefined();
        for (const o of tx.outputs) expect(t.outputs[o.output]).toBeDefined();
      }
      for (const o of Object.values<any>(t.outputs)) {
        if (!o.lockingScript.startsWith('$(')) expect(t.lockingScripts[o.lockingScript]).toBeDefined();
      }
      for (const ls of Object.values<any>(t.lockingScripts)) {
        expect(t.scripts[ls.lockingBytecode]).toBeDefined();
        for (const r of Object.values<any>(ls.roles ?? {})) for (const a of r.actions ?? []) expect(t.actions[a.action]).toBeDefined();
      }
      for (const i of Object.values<any>(t.inputs)) expect(t.scripts[i.unlockingScript]).toBeDefined();
    });
  }

  it('HTLC follow-ups are offered by the HTLC locking script to the right roles', () => {
    const roles = (hermesHtlcTemplate as T).lockingScripts.htlcLockingScript.roles;
    expect(roles.counterparty.actions.map((a: any) => a.action)).toEqual(['claim', 'claimTokens']);
    expect(roles.initiator.actions.map((a: any) => a.action)).toEqual(['refund', 'refundTokens']);
  });
});

/**
 * Execute the XO HTLC redeem script in the BCH 2026 VM. The template's scripts are loaded
 * into a Libauth wallet template (XO's script language is CashAssembly), compiled as P2SH32,
 * and claim/refund transactions are generated and verified.
 */
describe('XO HTLC script semantics', () => {
  const xo = hermesHtlcTemplate as T;
  const initiator = generatePrivateKey();
  const counterparty = generatePrivateKey();
  const secret = randomBytes(32);
  const hashlock = createHash('sha256').update(secret).digest();
  const timeout = 1_800_000_000;
  const pub = (k: Uint8Array) => secp256k1.derivePublicKeyCompressed(k) as Uint8Array;
  const p2pkh = (k: Uint8Array) => Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(pub(k)), 0x88, 0xac]);

  const shared = ['enforceTokensPreserved', 'enforcePaysCounterparty', 'enforcePaysInitiator'];
  const template = importWalletTemplate({
    $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
    supported: ['BCH_2026_05'],
    version: 0,
    entities: {
      party: {
        variables: {
          initiatorKey: { type: 'Key' },
          counterpartyKey: { type: 'Key' },
          initiatorPublicKey: { type: 'AddressData' },
          counterpartyPublicKey: { type: 'AddressData' },
          hashlock: { type: 'AddressData' },
          timeout: { type: 'AddressData' },
          secret: { type: 'AddressData' },
        },
      },
    },
    scripts: {
      ...Object.fromEntries(shared.map((s) => [s, { script: xo.scripts[s] }])),
      htlc: { lockingType: 'p2sh32', script: xo.scripts.htlcRedeemBytecode },
      claim: { script: xo.scripts.claimUnlockingBytecode, unlocks: 'htlc' },
      refund: { script: xo.scripts.refundUnlockingBytecode, unlocks: 'htlc', timeLockType: 'timestamp' },
    },
  } as never);
  if (typeof template === 'string') throw new Error(template);
  const compiler = walletTemplateToCompilerBch(template);
  const data = (s: Uint8Array = secret) => ({
    keys: { privateKeys: { initiatorKey: initiator, counterpartyKey: counterparty } },
    bytecode: {
      initiatorPublicKey: pub(initiator),
      counterpartyPublicKey: pub(counterparty),
      hashlock,
      timeout: bigIntToVmNumber(BigInt(timeout)),
      secret: s,
    },
  });
  const lock = compiler.generateBytecode({ data: data(), scriptId: 'htlc' });
  if (!lock.success) throw new Error(JSON.stringify(lock.errors));
  const vm = createVirtualMachineBch2026();

  const spend = (script: 'claim' | 'refund', opts: { to?: Uint8Array; locktime?: number; secret?: Uint8Array; value?: bigint } = {}) => {
    const result = generateTransaction({
      version: 2,
      locktime: opts.locktime ?? 0,
      inputs: [
        {
          outpointIndex: 0,
          outpointTransactionHash: new Uint8Array(32).fill(1),
          sequenceNumber: script === 'refund' ? 0xfffffffe : 0,
          unlockingBytecode: { compiler, data: data(opts.secret), script, valueSatoshis: 10_000n },
        },
      ],
      outputs: [{ lockingBytecode: opts.to ?? p2pkh(script === 'claim' ? counterparty : initiator), valueSatoshis: opts.value ?? 8_500n }],
    });
    if (!result.success) return `generation failed: ${JSON.stringify(result.errors).slice(0, 200)}`;
    return vm.verify({ transaction: result.transaction, sourceOutputs: [{ lockingBytecode: lock.bytecode, valueSatoshis: 10_000n }] });
  };

  it('compiles to a P2SH32 locking bytecode', () => {
    expect(binToHex(lock.bytecode)).toMatch(/^aa20[0-9a-f]{64}87$/);
  });
  it('claim with the secret paying the counterparty verifies', () => {
    expect(spend('claim')).toBe(true);
  });
  it('claim with a wrong secret, to another address, or losing more than the fee bound fails', () => {
    expect(spend('claim', { secret: randomBytes(32) })).not.toBe(true);
    expect(spend('claim', { to: p2pkh(initiator) })).not.toBe(true);
    expect(spend('claim', { value: 6_000n })).not.toBe(true);
  });
  it('refund needs the timeout (CLTV) and pays the initiator', () => {
    expect(spend('refund', { locktime: timeout })).toBe(true);
    expect(spend('refund', { locktime: timeout - 1 })).not.toBe(true);
    expect(spend('refund', { locktime: timeout, to: p2pkh(counterparty) })).not.toBe(true);
  });
});

describe('XO Drops claim template = the CashScript covenant', () => {
  it('compiles the shard and vault covenants to the same P2SH32 addresses as CashScript', () => {
    const cfg = { receiptCategory: 'a1'.repeat(32), pendingCategory: 'b2'.repeat(32), rewardCategory: 'c3'.repeat(32), authorityPkh: '44'.repeat(20), rootTimelock: 144 };
    const c = dropsContracts(cfg, new MockNetworkProvider());
    const xo = hermesDropsClaimTemplate as T;
    const template = importWalletTemplate({
      $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',
      supported: ['BCH_2026_05'],
      version: 0,
      entities: { e: { variables: Object.fromEntries(['receiptCategoryVm', 'pendingCategoryVm', 'rewardCategoryVm', 'vaultBytecode', 'pendingBytecode'].map((k) => [k, { type: 'AddressData' }])) } },
      scripts: { shard: { lockingType: 'p2sh32', script: xo.scripts.shardRedeem }, vault: { lockingType: 'p2sh32', script: xo.scripts.vaultRedeem } },
    } as never);
    if (typeof template === 'string') throw new Error(template);
    const compiler = walletTemplateToCompilerBch(template);
    const hex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
    const data = {
      bytecode: {
        receiptCategoryVm: hex(vmCategory(cfg.receiptCategory)),
        pendingCategoryVm: hex(vmCategory(cfg.pendingCategory)),
        rewardCategoryVm: hex(vmCategory(cfg.rewardCategory)),
        vaultBytecode: hex(c.vaultBytecode),
        pendingBytecode: hex(c.pendingBytecode),
      },
    };
    const shard = compiler.generateBytecode({ data, scriptId: 'shard' });
    const vault = compiler.generateBytecode({ data, scriptId: 'vault' });
    if (!shard.success || !vault.success) throw new Error('compile failed');
    expect(binToHex(shard.bytecode)).toBe(lockingBytecodeOf(c.shard.address));
    expect(binToHex(vault.bytecode)).toBe(c.vaultBytecode);
  });
});

describe('XO invitation viewer', () => {
  it('knows the Hermes template identifiers and rejects malformed invitations', () => {
    expect(HERMES_TEMPLATES).toHaveLength(3);
    expect(new Set(HERMES_TEMPLATES.map((t) => t.identifier)).size).toBe(3);
    expect(() => describeInvitation('{"not":"an invitation"}')).toThrow();
  });
});

describe('XO engine accepts the templates', () => {
  it(
    'imports both templates and opens an invitation for each starting action',
    async () => {
      const { openEngine } = await import('@hermes/xo');
      // Public XO playground mnemonic — never funded.
      const engine = await openEngine('page pencil stock planet limb cluster assault speak off joke private pioneer', {
        network: 'chipnet',
        databaseFilename: `xo-test-${Date.now()}`,
      });
      try {
        for (const t of [hermesHtlcTemplate, hermesIdentityTemplate, hermesDropsClaimTemplate] as T[]) {
          const { templateIdentifier } = await engine.importTemplate(t as never);
          for (const s of t.start) {
            const inv = await engine.createInvitation({ templateIdentifier, actionIdentifier: s.action, intent: s } as never);
            const missing = await engine.listMissingRequirements(inv.invitation.invitationIdentifier);
            expect(missing.templateRequirements).toBeDefined();
            if (t === hermesHtlcTemplate) {
              const { exportInvitation } = await import('@hermes/xo');
              const view = describeInvitation(exportInvitation(inv.invitation));
              expect(view.pinned).toBe(true);
              expect(view.templateName).toBe('Hermes HTLC');
            }
          }
        }
      } finally {
        await engine.stop();
      }
    },
    120_000,
  );
});
