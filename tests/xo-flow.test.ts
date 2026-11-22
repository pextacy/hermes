/**
 * hermes-xo party flow (packages/xo/src/flow.ts).
 *
 * Part 1 runs the real @xo-cash/engine on chipnet storage in a temp dir. The Electrum layer is
 * a process-wide singleton, so only one engine can live per process: the initiator runs here and
 * the counterparty joins from a separate `tsx probe.ts b` process, with the invitation passed as a
 * serialized file — exactly how two parties exchange it. Nothing is funded or broadcast.
 *
 * Part 2 drives the same helpers with a scripted engine to check coin selection, signing, the
 * follow-up input/output wiring and the error paths that need UTXOs a test wallet cannot hold.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { binToHex } from '@bitauth/libauth';
import {
  checkIncoming,
  counterpartyJoin,
  describeInvitation,
  exportInvitation,
  followUp,
  hermesHtlcTemplate,
  importHermesTemplates,
  importInvitation,
  initiatorCreateLock,
  initiatorFundAndExecute,
  openEngine,
  validateTemplate,
} from '@hermes/xo';

type T = any;
// Public XO playground mnemonic — never funded.
const TEST_MNEMONIC = 'page pencil stock planet limb cluster assault speak off joke private pioneer';
const ROOT = resolve(__dirname, '..');
const HASHLOCK = 'ab'.repeat(32);
const TIMEOUT = 1_800_000_000;

const varsOf = (inv: T) =>
  Object.fromEntries(inv.commits.flatMap((c: T) => c.data?.variables ?? []).map((v: T) => [v.variableIdentifier, v]));
const clone = (inv: T) => importInvitation(exportInvitation(inv)) as T;

describe('HTLC lock between two XO wallets (real engine, offline)', () => {
  let dir: string;
  let engine: Awaited<ReturnType<typeof openEngine>>;
  let htlcId: string;
  let lock: T;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-xo-flow-'));
    engine = await openEngine(TEST_MNEMONIC, { network: 'chipnet', databasePath: dir, databaseFilename: 'initiator' });
    const ids = await importHermesTemplates(engine);
    expect(Object.keys(ids)).toEqual(['htlc', 'identity', 'dropsClaim']);
    for (const id of Object.values(ids)) expect(await engine.getTemplate(id)).toBeDefined();
    htlcId = ids.htlc;
  }, 120_000);

  afterAll(async () => {
    await engine?.stop();
  });

  it('initiator creates a BCH lock carrying its key and terms', async () => {
    const s = await initiatorCreateLock(engine, htlcId, { hashlock: HASHLOCK, timeout: TIMEOUT, lockedSatoshis: 25_000 });
    lock = s.invitation;
    expect(lock.templateIdentifier).toBe(htlcId);
    expect(lock.actionIdentifier).toBe('lock');
    const v = varsOf(lock);
    expect(Object.keys(v).sort()).toEqual(['hashlock', 'initiatorPublicKey', 'lockedSatoshis', 'timeout']);
    for (const x of Object.values<T>(v)) expect(x.roleIdentifier).toBe('initiator');
    expect(v.hashlock.value).toBe(HASHLOCK);
    expect(String(v.lockedSatoshis.value)).toMatch(/^25000n?$/);
    // initiatorPublicKey is the engine's own generated initiatorKey (compressed secp256k1).
    expect(String(v.initiatorPublicKey.value)).toMatch(/^0[23][0-9a-f]{64}$/);

    const view = describeInvitation(exportInvitation(lock));
    expect(view).toMatchObject({ invitationIdentifier: lock.invitationIdentifier, pinned: true, templateName: 'Hermes HTLC', action: 'lock' });
  });

  it('a token lock fills category and amount instead of satoshis', async () => {
    const s = await initiatorCreateLock(engine, htlcId, { hashlock: HASHLOCK, timeout: TIMEOUT, token: { category: 'cd'.repeat(32), amount: 7n } });
    expect(s.invitation.actionIdentifier).toBe('lockTokens');
    const v = varsOf(s.invitation);
    expect(v.lockedSatoshis).toBeUndefined();
    expect(v.lockedTokenCategory.value).toBe('cd'.repeat(32));
    expect(String(v.lockedTokenAmount.value)).toMatch(/^7n?$/);
  });

  it('export/import round-trips an invitation through its string form', () => {
    const s = exportInvitation(lock);
    expect(typeof s).toBe('string');
    const back = importInvitation(s) as T;
    expect(back.invitationIdentifier).toBe(lock.invitationIdentifier);
    expect(exportInvitation(back)).toBe(s);
  });

  it('checkIncoming accepts a genuine invitation for a pinned template', async () => {
    await expect(checkIncoming(engine, clone(lock), [htlcId])).resolves.toBeUndefined();
  });

  it('checkIncoming refuses templates that are not pinned or not known', async () => {
    await expect(checkIncoming(engine, clone(lock), [])).rejects.toThrow(/unpinned template/);
    const foreign = clone(lock);
    foreign.templateIdentifier = 'ff'.repeat(32);
    await expect(checkIncoming(engine, foreign, ['ff'.repeat(32)])).rejects.toThrow(`unpinned template ${'ff'.repeat(32)}`);
  });

  it('checkIncoming rejects a tampered commit with a readable reason', async () => {
    const forged = clone(lock);
    const hashlockVar = forged.commits.flatMap((c: T) => c.data?.variables ?? []).find((v: T) => v.variableIdentifier === 'hashlock');
    hashlockVar.value = 'ee'.repeat(32); // swap the hashlock after the initiator signed
    const err = await checkIncoming(engine, forged, [htlcId]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Invitation has validation issues: /);
    // Issues are reported by message, not as `{}` (Error objects do not JSON-serialise).
    expect((err as Error).message).not.toContain('[{}');
    expect((err as Error).message.toLowerCase()).toContain('signature');
  });

  it('checkIncoming validates entity keys for the engine network (chipnet invitation refused on mainnet)', async () => {
    const mainnetView = { network: 'mainnet', getTemplate: (id: string) => engine.getTemplate(id) } as never;
    await expect(checkIncoming(mainnetView, clone(lock), [htlcId])).rejects.toThrow(/validation issues.*entityIdentifier|entityIdentifier/);
  });

  it(
    'counterparty joins from its own process; initiator merges, resolves the HTLC output, and stops at funding',
    async () => {
      writeFileSync(join(dir, 'inv1'), exportInvitation(lock));
      const out = execFileSync(join(ROOT, 'node_modules/.bin/tsx'), [join(ROOT, 'packages/xo/src/probe.ts'), 'b', dir], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      // After joining only the initiator's HTLC output is left to provide.
      expect(out).toContain('B joined; missing');
      expect(JSON.parse(out.split('missing ')[1])).toMatchObject({ templateRequirements: { outputs: ['htlcOutput'] } });

      const joined = importInvitation(readFileSync(join(dir, 'inv2'), 'utf8')) as T;
      expect(joined.invitationIdentifier).toBe(lock.invitationIdentifier);
      const cp = varsOf(joined).counterpartyPublicKey;
      expect(cp.roleIdentifier).toBe('counterparty');
      expect(String(cp.value)).not.toBe(String(varsOf(joined).initiatorPublicKey.value));

      await expect(initiatorFundAndExecute(engine, htlcId, joined, { broadcast: false })).rejects.toThrow(/No spendable UTXOs/);
      // The merge and output resolution happened before funding failed.
      const id = joined.invitationIdentifier;
      expect((await engine.listMissingRequirements(id)).templateRequirements).toEqual({});
      const bytecode = await engine.resolveInvitationOutputLockingBytecode(id, 'htlcOutput', 'initiator');
      expect(bytecode).toMatch(/^aa20[0-9a-f]{64}87$/); // P2SH32
    },
    120_000,
  );

  it('follow-up refund refuses when the wallet holds no HTLC UTXO', async () => {
    await expect(followUp(engine, htlcId, 'refund', { lockedSatoshis: 25_000n }, { broadcast: false })).rejects.toThrow(
      'HTLC UTXO not found in this XO wallet',
    );
  });
});

/** A scripted stand-in for the engine: records every call; `over` replaces individual methods. */
function scriptedEngine(over: Record<string, unknown> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const stored = (invitation: T) => ({ invitation });
  const base: Record<string, (...a: any[]) => unknown> = {
    listSecretData: async () => [
      { secretIdentifier: 'initiatorKey', templateIdentifier: 'tpl', secretLookupKey: 'old' },
      { secretIdentifier: 'counterpartyKey', templateIdentifier: 'tpl', secretLookupKey: 'cp' },
      { secretIdentifier: 'initiatorKey', templateIdentifier: 'other', secretLookupKey: 'wrong-template' },
      { secretIdentifier: 'initiatorKey', templateIdentifier: 'tpl', secretLookupKey: 'new' },
    ],
    getSecretPublicKey: async (k: string) => `pk-${k}`,
    createInvitation: async (p: T) => stored({ invitationIdentifier: 'inv', actionIdentifier: p.actionIdentifier, commits: [] }),
    acceptInvitation: async (inv: T) => stored(inv),
    appendInvitation: async () => stored({ invitationIdentifier: 'inv', actionIdentifier: 'lock', commits: [] }),
    listUnspentOutputs: async () => [],
    listOwnInputIndexes: async () => [0],
    signInvitation: async () => stored({ invitationIdentifier: 'inv', commits: [] }),
    executeAction: async () => ({ ok: true }),
  };
  const engine: Record<string, unknown> = { network: 'chipnet' };
  for (const [name, fn] of Object.entries({ ...base, ...over })) {
    engine[name] =
      typeof fn === 'function'
        ? vi.fn(async (...args: unknown[]) => {
            calls.push({ name, args });
            return (fn as (...a: unknown[]) => unknown)(...args);
          })
        : fn;
  }
  return { engine: engine as never, calls, fn: (n: string) => engine[n] as ReturnType<typeof vi.fn> };
}

describe('initiatorCreateLock / counterpartyJoin (scripted engine)', () => {
  it('uses the newest initiatorKey of this template and defaults lockedSatoshis to 0', async () => {
    const { engine, fn } = scriptedEngine();
    await initiatorCreateLock(engine, 'tpl', { hashlock: HASHLOCK, timeout: TIMEOUT });
    expect(fn('createInvitation')).toHaveBeenCalledWith({
      templateIdentifier: 'tpl',
      actionIdentifier: 'lock',
      intent: (hermesHtlcTemplate as T).start.find((s: T) => s.action === 'lock'),
    });
    expect(fn('getSecretPublicKey')).toHaveBeenCalledWith('new');
    const [id, params] = fn('appendInvitation').mock.calls[0] as [string, T];
    expect(id).toBe('inv');
    expect(params.variables).toEqual([
      { variableIdentifier: 'initiatorPublicKey', roleIdentifier: 'initiator', value: 'pk-new' },
      { variableIdentifier: 'hashlock', roleIdentifier: 'initiator', value: HASHLOCK },
      { variableIdentifier: 'timeout', roleIdentifier: 'initiator', value: TIMEOUT },
      { variableIdentifier: 'lockedSatoshis', roleIdentifier: 'initiator', value: 0 },
    ]);
  });

  it('fails clearly when the key secret was not generated or has no public key', async () => {
    const none = scriptedEngine({ listSecretData: async () => [] });
    await expect(initiatorCreateLock(none.engine, 'tpl', { hashlock: HASHLOCK, timeout: TIMEOUT })).rejects.toThrow(
      'secret initiatorKey not generated',
    );
    expect(none.fn('appendInvitation')).not.toHaveBeenCalled();
    const nopk = scriptedEngine({ getSecretPublicKey: async () => undefined });
    await expect(initiatorCreateLock(nopk.engine, 'tpl', { hashlock: HASHLOCK, timeout: TIMEOUT })).rejects.toThrow(
      'no public key for initiatorKey',
    );
  });

  it('counterpartyJoin accepts a pinned invitation as counterparty and adds its own claim key', async () => {
    const { HERMES_TEMPLATES } = await import('@hermes/xo');
    const pinned = HERMES_TEMPLATES.find((t) => t.name === 'Hermes HTLC')!.identifier;
    const incoming = { invitationIdentifier: 'fe'.repeat(16), templateIdentifier: pinned, actionIdentifier: 'lock', createdAtTimestamp: Date.now(), commits: [] };
    const { engine, fn, calls } = scriptedEngine({
      getTemplate: async () => validateTemplate(hermesHtlcTemplate),
      listSecretData: async () => [{ secretIdentifier: 'counterpartyKey', templateIdentifier: pinned, secretLookupKey: 'cp' }],
    });
    await counterpartyJoin(engine, pinned, incoming as never);
    expect(fn('acceptInvitation')).toHaveBeenCalledWith(incoming, { roleIdentifier: 'counterparty' });
    expect(fn('appendInvitation')).toHaveBeenCalledWith(incoming.invitationIdentifier, {
      variables: [{ variableIdentifier: 'counterpartyPublicKey', roleIdentifier: 'counterparty', value: 'pk-cp' }],
    });
    expect(calls.map((c) => c.name)).toEqual(['getTemplate', 'acceptInvitation', 'listSecretData', 'getSecretPublicKey', 'appendInvitation']);
  });

  it('counterpartyJoin never accepts an invitation for an unpinned template', async () => {
    const { engine, fn } = scriptedEngine({ getTemplate: async () => ({}) });
    const incoming = { templateIdentifier: 'evil', invitationIdentifier: 'x', actionIdentifier: 'lock', commits: [] } as never;
    await expect(counterpartyJoin(engine, 'tpl', incoming)).rejects.toThrow('Refusing invitation for unpinned template evil');
    expect(fn('acceptInvitation')).not.toHaveBeenCalled();
    expect(fn('appendInvitation')).not.toHaveBeenCalled();
  });
});

describe('initiatorFundAndExecute coin selection (scripted engine)', () => {
  // The engine stores templates in parsed form; that is what the pinned identifier hashes.
  const htlcTemplate = validateTemplate(hermesHtlcTemplate);
  // A well-formed invitation with no commits yet, for the pinned HTLC template: checkIncoming passes it.
  let pinned: string;
  let incoming: T;
  beforeAll(async () => {
    const { HERMES_TEMPLATES } = await import('@hermes/xo');
    pinned = HERMES_TEMPLATES.find((t) => t.name === 'Hermes HTLC')!.identifier;
    incoming = { invitationIdentifier: '0123456789abcdef0123456789abcdef', templateIdentifier: pinned, actionIdentifier: 'lock', createdAtTimestamp: Date.now(), commits: [] };
  });

  const utxo = (sats: number, i: number, token = false) => ({
    outpointTransactionHash: `${i}`.padStart(2, '0').repeat(32),
    outpointIndex: i,
    valueSatoshis: BigInt(sats),
    ...(token ? { token: { category: 'cd'.repeat(32), amount: 1n } } : {}),
  });

  function fundEngine(action: 'lock' | 'lockTokens', lockedSatoshis: number | string | undefined, utxos: T[], own = [0, 1]) {
    const commits = lockedSatoshis === undefined ? [] : [{ data: { variables: [{ variableIdentifier: 'lockedSatoshis', value: lockedSatoshis }] } }];
    const inv = { invitationIdentifier: 'inv', actionIdentifier: action, commits };
    return scriptedEngine({
      getTemplate: async () => htlcTemplate,
      updateInvitation: async () => ({ invitation: inv }),
      appendInvitation: async () => ({ invitation: inv }),
      resolveInvitationOutputLockingBytecode: async () => 'aa20' + '11'.repeat(32) + '87',
      listSpendableUnspentOutputs: async () => utxos,
      addChangeToInvitation: async () => ({ invitation: inv }),
      listOwnInputIndexes: async () => own,
      executeAction: async (_id: string, p: T) => ({ transactionHash: 'ff'.repeat(32), broadcast: p.broadcastTransaction }),
    });
  }
  const pickedInputs = (fn: (n: string) => T) => {
    const call = fn('appendInvitation').mock.calls.find((c: T) => c[1].inputs);
    return call[1].inputs.map((i: T) => ({ hash: binToHex(i.outpointTransactionHash), index: i.outpointIndex }));
  };

  it('skips token UTXOs, adds BCH inputs until the lock + fee + margin is covered, then signs and executes', async () => {
    const { engine, fn, calls } = fundEngine('lock', 10_000, [utxo(500_000, 1, true), utxo(60_000, 2), utxo(60_000, 3), utxo(60_000, 4)]);
    const r = await initiatorFundAndExecute(engine, pinned, incoming, { broadcast: false });
    expect(fn('updateInvitation')).toHaveBeenCalledWith(incoming);
    expect(fn('appendInvitation').mock.calls[0]).toEqual(['inv', { outputs: [{ outputIdentifier: 'htlcOutput' }] }]);
    expect(fn('resolveInvitationOutputLockingBytecode')).toHaveBeenCalledWith('inv', 'htlcOutput', 'initiator');
    // need = 10_000 locked + 1_000 fee + 1_000 dust margin; selection stops at need + 100_000.
    expect(pickedInputs(fn)).toEqual([
      { hash: '02'.repeat(32), index: 2 },
      { hash: '03'.repeat(32), index: 3 },
    ]);
    expect(fn('signInvitation').mock.calls).toEqual([['inv', 0], ['inv', 1]]);
    expect(fn('executeAction')).toHaveBeenCalledWith('inv', { broadcastTransaction: false });
    expect(r.lockingBytecode).toBe('aa20' + '11'.repeat(32) + '87');
    expect(r.result).toEqual({ transactionHash: 'ff'.repeat(32), broadcast: false });
    // Order: change is added after inputs and before any signature; execution is last.
    const order = calls.map((c) => c.name);
    expect(order.indexOf('addChangeToInvitation')).toBeLessThan(order.indexOf('signInvitation'));
    expect(order.at(-1)).toBe('executeAction');
  });

  it('selects enough inputs for a lock larger than the 100k margin (regression)', async () => {
    const { engine, fn } = fundEngine('lock', '1000000n', [utxo(500_000, 1), utxo(500_000, 2), utxo(500_000, 3), utxo(500_000, 4)]);
    await initiatorFundAndExecute(engine, pinned, incoming, { broadcast: true, feeSatoshis: 2_000 });
    // 1_000_000 + 2_000 + 1_000 + 100_000 → three 500k inputs, not one.
    expect(pickedInputs(fn).map((i: T) => i.index)).toEqual([1, 2, 3]);
    expect(fn('executeAction')).toHaveBeenCalledWith('inv', { broadcastTransaction: true });
  });

  it('a token lock funds the token HTLC output', async () => {
    const { engine, fn } = fundEngine('lockTokens', undefined, [utxo(200_000, 5)], [0]);
    await initiatorFundAndExecute(engine, pinned, { ...incoming, actionIdentifier: 'lockTokens' }, { broadcast: false });
    expect(fn('appendInvitation').mock.calls[0]).toEqual(['inv', { outputs: [{ outputIdentifier: 'htlcTokenOutput' }] }]);
    expect(fn('resolveInvitationOutputLockingBytecode')).toHaveBeenCalledWith('inv', 'htlcTokenOutput', 'initiator');
    expect(pickedInputs(fn)).toEqual([{ hash: '05'.repeat(32), index: 5 }]);
  });

  it('refuses to proceed (and signs nothing) when only token UTXOs are spendable', async () => {
    const { engine, fn } = fundEngine('lock', 10_000, [utxo(500_000, 1, true)]);
    await expect(initiatorFundAndExecute(engine, pinned, incoming, { broadcast: true })).rejects.toThrow(/No spendable UTXOs/);
    expect(fn('signInvitation')).not.toHaveBeenCalled();
    expect(fn('executeAction')).not.toHaveBeenCalled();
  });

  it('does not touch the wallet when the incoming invitation is for another template', async () => {
    const { engine, fn } = fundEngine('lock', 10_000, [utxo(500_000, 1)]);
    await expect(initiatorFundAndExecute(engine, 'some-other-template', incoming, { broadcast: true })).rejects.toThrow(/unpinned/);
    expect(fn('updateInvitation')).not.toHaveBeenCalled();
    expect(fn('listSpendableUnspentOutputs')).not.toHaveBeenCalled();
  });
});

describe('followUp claim/refund wiring (scripted engine)', () => {
  const tpl = hermesHtlcTemplate as T;
  const cases = [
    { action: 'claim', role: 'counterparty' },
    { action: 'claimTokens', role: 'counterparty' },
    { action: 'refund', role: 'initiator' },
    { action: 'refundTokens', role: 'initiator' },
  ] as const;

  for (const { action, role } of cases) {
    it(`${action}: spends the HTLC UTXO with the template's input/output as ${role}`, async () => {
      const { engine, fn } = scriptedEngine({
        listUnspentOutputs: async () => [
          { lockingScriptIdentifier: 'initiatorWallet', outpointTransactionHash: '01'.repeat(32), outpointIndex: 0 },
          { lockingScriptIdentifier: 'htlcLockingScript', outpointTransactionHash: '02'.repeat(32), outpointIndex: 3 },
        ],
        listOwnInputIndexes: async () => [0],
        executeAction: async () => ({ done: action }),
      });
      const vars = action === 'claim' ? { secret: 'cc'.repeat(32), lockedSatoshis: 25_000n } : { lockedSatoshis: 25_000n };
      const r = await followUp(engine, 'tpl', action, vars, { broadcast: true });
      expect(r).toEqual({ done: action });
      expect(fn('createInvitation')).toHaveBeenCalledWith({ templateIdentifier: 'tpl', actionIdentifier: action, roleIdentifier: role });
      const [[, varParams], [, ioParams]] = fn('appendInvitation').mock.calls as [string, T][];
      expect(varParams.variables).toEqual(Object.entries(vars).map(([variableIdentifier, value]) => ({ variableIdentifier, roleIdentifier: role, value })));

      // The identifiers must be the ones the template's transaction for this action uses.
      const tx = tpl.transactions[tpl.actions[action].transaction];
      expect(ioParams.inputs).toHaveLength(1);
      expect(ioParams.inputs[0].inputIdentifier).toBe(tx.inputs[0].input);
      expect(binToHex(ioParams.inputs[0].outpointTransactionHash)).toBe('02'.repeat(32));
      expect(ioParams.inputs[0].outpointIndex).toBe(3);
      expect(ioParams.outputs).toEqual([{ outputIdentifier: tx.outputs[0].output }]);
      // The template offers this action to this role from the HTLC locking script.
      expect(tpl.lockingScripts.htlcLockingScript.roles[role].actions.map((a: T) => a.action)).toContain(action);

      expect(fn('signInvitation')).toHaveBeenCalledWith('inv', 0);
      expect(fn('executeAction')).toHaveBeenCalledWith('inv', { broadcastTransaction: true });
    });
  }

  it('ignores non-HTLC UTXOs and fails before signing when no HTLC UTXO exists', async () => {
    const { engine, fn } = scriptedEngine({
      listUnspentOutputs: async () => [{ lockingScriptIdentifier: 'initiatorWallet', outpointTransactionHash: '01'.repeat(32), outpointIndex: 0 }],
    });
    await expect(followUp(engine, 'tpl', 'claim', { secret: 'cc'.repeat(32) }, { broadcast: true })).rejects.toThrow('HTLC UTXO not found');
    expect(fn('signInvitation')).not.toHaveBeenCalled();
    expect(fn('executeAction')).not.toHaveBeenCalled();
  });
});
