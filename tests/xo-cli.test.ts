/**
 * hermes-xo command-line entry points: cli.ts (party steps), probe.ts (offline two-party probe)
 * and check-templates.ts (engine import check).
 *
 * cli.ts and probe.ts are run in-process with the engine-facing helpers of flow.ts mocked, so the
 * tests check what each command does with its arguments: which helper it calls with what, which
 * files it writes, the mainnet guard and the exit codes. (flow.ts itself is covered against the
 * real engine in xo-flow.test.ts.) check-templates.ts runs for real against an offline XO engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type T = any;

const h = vi.hoisted(() => ({ answer: '  page pencil stock  \n' }));

vi.mock('../packages/xo/src/flow.js', async (importOriginal) => {
  const actual = await importOriginal<T>();
  return {
    // Keep the real serialisation so files written by the commands can be decoded.
    exportInvitation: actual.exportInvitation,
    importInvitation: actual.importInvitation,
    openEngine: vi.fn(),
    importHermesTemplates: vi.fn(),
    initiatorCreateLock: vi.fn(),
    counterpartyJoin: vi.fn(),
    initiatorFundAndExecute: vi.fn(),
    followUp: vi.fn(),
    checkIncoming: vi.fn(),
  };
});

// The mnemonic prompt reads from a muted TTY; answer it directly.
vi.mock('node:readline', () => ({
  createInterface: () => ({ question: (_q: string, cb: (a: string) => void) => cb(h.answer), close: () => {} }),
}));

const flow = (await import('../packages/xo/src/flow.js')) as T;
const { HERMES_TEMPLATES, describeInvitation } = await import('../packages/xo/src/inspect.js');
const HTLC_ID = HERMES_TEMPLATES.find((t) => t.name === 'Hermes HTLC')!.identifier;

/** A well-formed (commit-less) invitation, as the engine would hand it out. */
const invitation = (id: string, templateIdentifier = HTLC_ID, actionIdentifier = 'lock') => ({
  invitationIdentifier: id,
  templateIdentifier,
  actionIdentifier,
  createdAtTimestamp: 1_760_000_000_000,
  commits: [],
});

const scripts = {
  cli: () => import('../packages/xo/src/cli.js'),
  probe: () => import('../packages/xo/src/probe.js'),
  check: () => import('../packages/xo/src/check-templates.js'),
};

let dir: string;
let engine: Record<string, ReturnType<typeof vi.fn>>;
let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const argv0 = process.argv;

class Exit extends Error {
  constructor(public code: number | undefined) {
    super(`exit ${code}`);
  }
}

/** Run a script module as `tsx <script> ...args` and resolve with its exit code. */
async function run(script: keyof typeof scripts, args: string[], opts: { throwOnExit?: boolean } = {}) {
  process.argv = ['node', script, ...args];
  vi.resetModules();
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    if (opts.throwOnExit) throw new Exit(code);
  }) as never);
  try {
    await scripts[script]();
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
  }
  await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 60_000 });
  return exit.mock.calls[0][0];
}
const printed = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-xo-cli-'));
  engine = {
    stop: vi.fn(async () => {}),
    listMissingRequirements: vi.fn(async () => ({ templateRequirements: { outputs: ['htlcOutput'] } })),
    updateInvitation: vi.fn(async (inv: T) => ({ invitation: inv })),
    appendInvitation: vi.fn(async (id: string) => ({ invitation: invitation(id) })),
    resolveInvitationOutputLockingBytecode: vi.fn(async () => 'aa20' + '11'.repeat(32) + '87'),
  };
  flow.openEngine.mockReset().mockResolvedValue(engine);
  flow.importHermesTemplates.mockReset().mockResolvedValue({ htlc: 'HTLC', identity: 'ID', dropsClaim: 'DC' });
  for (const k of ['initiatorCreateLock', 'counterpartyJoin', 'initiatorFundAndExecute', 'followUp', 'checkIncoming']) flow[k].mockReset();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.argv = argv0;
  vi.restoreAllMocks();
});

describe('cli.ts', () => {
  it('refuses mainnet without the owner-approval flag, before asking for a mnemonic', async () => {
    const code = await run('cli', ['create', '--network', 'mainnet', '--hashlock', 'aa'], { throwOnExit: true });
    expect(code).toBe(1);
    expect(printed(error)).toContain('Mainnet needs the owner’s explicit approval');
    expect(flow.openEngine).not.toHaveBeenCalled();
  });

  it('mainnet with --i-have-owner-approval opens a mainnet engine', async () => {
    flow.followUp.mockResolvedValue({});
    const code = await run('cli', ['refund', '--network', 'mainnet', '--i-have-owner-approval']);
    expect(code).toBe(0);
    expect(flow.openEngine).toHaveBeenCalledWith('page pencil stock', { network: 'mainnet', databaseFilename: 'hermes-xo-mainnet' });
    expect(engine.stop).toHaveBeenCalledOnce();
  });

  it('help for an unknown command is printed without asking for a mnemonic', async () => {
    const code = await run('cli', ['help']);
    expect(code).toBe(0);
    // Usage is printed from the file header.
    expect(printed(log)).toContain('tsx src/cli.ts create');
    expect(printed(log)).toContain('tsx src/cli.ts refund');
    expect(printed(log)).toContain('tsx src/cli.ts secret');
    expect(flow.openEngine).not.toHaveBeenCalled();
  });

  it('create (BCH): trims the mnemonic, locks with the given terms and writes the invitation file', async () => {
    flow.initiatorCreateLock.mockResolvedValue({ invitation: invitation('11'.repeat(16)) });
    const out = join(dir, 'inv1.json');
    const code = await run('cli', ['create', '--hashlock', 'ab'.repeat(32), '--timeout', '1800000000', '--sats', '25000', '--out', out, '--db', 'alice']);
    expect(code).toBe(0);
    expect(flow.openEngine).toHaveBeenCalledWith('page pencil stock', { network: 'chipnet', databaseFilename: 'alice' });
    expect(flow.initiatorCreateLock).toHaveBeenCalledWith(engine, 'HTLC', { hashlock: 'ab'.repeat(32), timeout: 1_800_000_000, lockedSatoshis: 25_000 });
    expect(describeInvitation(readFileSync(out, 'utf8'))).toMatchObject({ invitationIdentifier: '11'.repeat(16), pinned: true });
    expect(printed(log)).toContain(`invitation ${'11'.repeat(16)} → ${out}`);
    expect(engine.stop).toHaveBeenCalledOnce();
  });

  it('create (tokens): passes category and a bigint amount', async () => {
    flow.initiatorCreateLock.mockResolvedValue({ invitation: invitation('12'.repeat(16), HTLC_ID, 'lockTokens') });
    const out = join(dir, 'inv1.json');
    await run('cli', ['create', '--hashlock', 'ab'.repeat(32), '--timeout', '1800000000', '--token', 'cd'.repeat(32), '--amount', '700', '--out', out]);
    expect(flow.initiatorCreateLock).toHaveBeenCalledWith(engine, 'HTLC', {
      hashlock: 'ab'.repeat(32),
      timeout: 1_800_000_000,
      token: { category: 'cd'.repeat(32), amount: 700n },
    });
    expect(existsSync(out)).toBe(true);
  });

  it('join: reads the incoming file, joins as counterparty and writes the reply', async () => {
    const inFile = join(dir, 'inv1.json');
    const outFile = join(dir, 'inv2.json');
    writeFileSync(inFile, flow.exportInvitation(invitation('21'.repeat(16))));
    flow.counterpartyJoin.mockResolvedValue({ invitation: invitation('21'.repeat(16)) });
    expect(await run('cli', ['join', '--in', inFile, '--out', outFile])).toBe(0);
    const [e, tpl, incoming] = flow.counterpartyJoin.mock.calls[0];
    expect([e, tpl, incoming.invitationIdentifier]).toEqual([engine, 'HTLC', '21'.repeat(16)]);
    expect(describeInvitation(readFileSync(outFile, 'utf8')).invitationIdentifier).toBe('21'.repeat(16));
    expect(printed(log)).toContain('joined as counterparty');
  });

  it('fund: passes --broadcast and prints bytes as hex and bigints as strings', async () => {
    const inFile = join(dir, 'inv2.json');
    writeFileSync(inFile, flow.exportInvitation(invitation('31'.repeat(16))));
    flow.initiatorFundAndExecute.mockResolvedValue({ lockingBytecode: 'aa20beef87', result: { tx: Uint8Array.from([0xde, 0xad]), fee: 1234n } });
    expect(await run('cli', ['fund', '--in', inFile, '--broadcast'])).toBe(0);
    expect(flow.initiatorFundAndExecute.mock.calls[0][3]).toEqual({ broadcast: true });
    expect(printed(log)).toContain('HTLC locking bytecode aa20beef87');
    expect(JSON.parse(log.mock.calls[1][0] as string)).toEqual({ tx: 'dead', fee: '1234' });
  });

  it('fund without --broadcast only builds the transaction', async () => {
    const inFile = join(dir, 'inv2.json');
    writeFileSync(inFile, flow.exportInvitation(invitation('32'.repeat(16))));
    flow.initiatorFundAndExecute.mockResolvedValue({ lockingBytecode: 'x', result: {} });
    await run('cli', ['fund', '--in', inFile]);
    expect(flow.initiatorFundAndExecute.mock.calls[0][3]).toEqual({ broadcast: false });
  });

  it('claim with tokens: claimTokens with token variables plus the secret', async () => {
    flow.followUp.mockResolvedValue({ txid: Uint8Array.from([1, 2]), value: 9n });
    expect(await run('cli', ['claim', '--secret', 'ee'.repeat(32), '--token', 'cd'.repeat(32), '--amount', '5'])).toBe(0);
    expect(flow.followUp).toHaveBeenCalledWith(
      engine,
      'HTLC',
      'claimTokens',
      { lockedTokenCategory: 'cd'.repeat(32), lockedTokenAmount: 5n, secret: 'ee'.repeat(32) },
      { broadcast: false },
    );
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({ txid: '0102', value: '9' });
  });

  it('refund (BCH): default 10000 sats as a bigint, never a secret', async () => {
    flow.followUp.mockResolvedValue({});
    await run('cli', ['refund', '--broadcast']);
    expect(flow.followUp).toHaveBeenCalledWith(engine, 'HTLC', 'refund', { lockedSatoshis: 10_000n }, { broadcast: true });
  });

  it('reports a failing step with exit code 1 and still stops the engine', async () => {
    flow.followUp.mockRejectedValue(new Error('HTLC UTXO not found in this XO wallet'));
    expect(await run('cli', ['claim', '--secret', 'ee'.repeat(32), '--sats', '20000'])).toBe(1);
    expect(flow.followUp.mock.calls[0][3]).toEqual({ lockedSatoshis: 20_000n, secret: 'ee'.repeat(32) });
    expect(String(error.mock.calls[0][0])).toContain('HTLC UTXO not found');
    expect(engine.stop).toHaveBeenCalledOnce();
  });

  it('inspect: decodes a Hermes invitation without opening a wallet', async () => {
    const inFile = join(dir, 'inv.json');
    writeFileSync(inFile, flow.exportInvitation(invitation('41'.repeat(16))));
    expect(await run('cli', ['inspect', '--in', inFile])).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toMatchObject({ invitationIdentifier: '41'.repeat(16), pinned: true, templateName: 'Hermes HTLC' });
    expect(warn).not.toHaveBeenCalled();
    expect(flow.openEngine).not.toHaveBeenCalled();
  });

  it('inspect: warns not to sign an invitation for a foreign template', async () => {
    const inFile = join(dir, 'inv.json');
    writeFileSync(inFile, flow.exportInvitation(invitation('42'.repeat(16), 'ff'.repeat(32))));
    await run('cli', ['inspect', '--in', inFile]);
    expect(JSON.parse(log.mock.calls[0][0] as string).pinned).toBe(false);
    expect(printed(warn)).toContain('not a Hermes template — do not sign');
  });
});

describe('probe.ts (offline two-party lock probe)', () => {
  it('a1: the initiator creates a 10k-sat lock and writes inv1', async () => {
    flow.initiatorCreateLock.mockResolvedValue({ invitation: invitation('51'.repeat(16)) });
    expect(await run('probe', ['a1', dir])).toBe(0);
    expect(flow.openEngine).toHaveBeenCalledWith(expect.any(String), { network: 'chipnet', databasePath: dir, databaseFilename: 'a' });
    expect(flow.initiatorCreateLock).toHaveBeenCalledWith(engine, 'HTLC', { hashlock: 'aa'.repeat(32), timeout: 1_800_000_000, lockedSatoshis: 10_000 });
    expect(describeInvitation(readFileSync(join(dir, 'inv1'), 'utf8')).invitationIdentifier).toBe('51'.repeat(16));
    expect(printed(log)).toContain(`A created ${'51'.repeat(16)}`);
    expect(engine.stop).toHaveBeenCalled();
  });

  it('b: the counterparty uses a fresh mnemonic, joins inv1 and writes inv2', async () => {
    writeFileSync(join(dir, 'inv1'), flow.exportInvitation(invitation('52'.repeat(16))));
    flow.counterpartyJoin.mockResolvedValue({ invitation: invitation('52'.repeat(16)) });
    expect(await run('probe', ['b', dir])).toBe(0);
    const mnB = readFileSync(join(dir, 'mnB'), 'utf8');
    expect(mnB.split(' ')).toHaveLength(12);
    expect(flow.openEngine).toHaveBeenCalledWith(mnB, { network: 'chipnet', databasePath: dir, databaseFilename: 'b' });
    expect(flow.counterpartyJoin.mock.calls[0][2].invitationIdentifier).toBe('52'.repeat(16));
    expect(existsSync(join(dir, 'inv2'))).toBe(true);
    expect(printed(log)).toContain('B joined; missing {"templateRequirements":{"outputs":["htlcOutput"]}}');
  });

  it('a2: the initiator validates inv2 before merging it, then resolves the HTLC output', async () => {
    writeFileSync(join(dir, 'inv2'), flow.exportInvitation(invitation('53'.repeat(16))));
    const order: string[] = [];
    flow.checkIncoming.mockImplementation(async () => void order.push('check'));
    engine.updateInvitation.mockImplementation(async (inv: T) => (order.push('merge'), { invitation: inv }));
    expect(await run('probe', ['a2', dir])).toBe(0);
    expect(order).toEqual(['check', 'merge']);
    expect(flow.checkIncoming.mock.calls[0][2]).toEqual(['HTLC']);
    expect(engine.appendInvitation).toHaveBeenCalledWith('53'.repeat(16), { outputs: [{ outputIdentifier: 'htlcOutput' }] });
    expect(engine.resolveInvitationOutputLockingBytecode).toHaveBeenCalledWith('53'.repeat(16), 'htlcOutput', 'initiator');
    expect(printed(log)).toContain(`HTLC locking bytecode aa20${'11'.repeat(32)}87`);
  });

  it('a2 stops (non-zero exit) when inv2 fails validation, without merging', async () => {
    writeFileSync(join(dir, 'inv2'), flow.exportInvitation(invitation('54'.repeat(16))));
    flow.checkIncoming.mockRejectedValue(new Error('Refusing invitation for unpinned template'));
    process.argv = ['node', 'probe', 'a2', dir];
    vi.resetModules();
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    await expect(scripts.probe()).rejects.toThrow('Refusing invitation');
    expect(engine.updateInvitation).not.toHaveBeenCalled();
  });
});

describe('check-templates.ts (real XO engine, offline)', () => {
  it(
    'imports the official and Hermes templates and opens an invitation for every starting action',
    async () => {
      const code = await run('check', ['--official']);
      const out = printed(log);
      expect(printed(error)).not.toContain('FAILED');
      expect(code).toBe(0);
      expect(out).toMatch(/imported Hermes HTLC: [0-9a-f]{64}/);
      expect(out).toContain(`imported Hermes HTLC: ${HTLC_ID}`);
      expect(out).toMatch(/imported Hermes Identity/);
      expect(out).toMatch(/imported Hermes Drops claim: [0-9a-f]{64}/);
      for (const action of ['claim', 'claimAgain']) expect(out).toMatch(new RegExp(`  ${action}: invitation [0-9a-f]+, missing \\{`));
      for (const action of ['lock', 'lockTokens']) expect(out).toMatch(new RegExp(`  ${action}: invitation [0-9a-f]+, missing \\{`));
      // --official adds the XO reference templates before the Hermes ones.
      expect(out.indexOf('imported Hermes HTLC')).toBeGreaterThan(out.indexOf('imported '));
      expect(out.split('\n').filter((l) => l.startsWith('imported ')).length).toBe(5);
    },
    120_000,
  );
});

describe('export-templates.ts', () => {
  it('writes each template as JSON (bigints as "123n") and the committed copies are in sync', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const writes: [string, string][] = [];
    vi.doMock('node:fs', () => ({ ...actualFs, writeFileSync: (p: URL, data: string) => void writes.push([String(p), data]) }));
    try {
      vi.resetModules();
      await import('../packages/xo/src/export-templates.js');
    } finally {
      vi.doUnmock('node:fs');
    }
    expect(writes.map(([p]) => p.split('/packages/xo/')[1])).toEqual([
      'templates/hermes-htlc.json',
      'templates/hermes-identity.json',
      'templates/hermes-drops-claim.json',
    ]);
    for (const [p, data] of writes) {
      expect(data.endsWith('}\n')).toBe(true);
      const parsed = JSON.parse(data);
      expect(parsed.start.length).toBeGreaterThan(0);
      // The JSON a wallet / the XO debug tool loads is what the engine pins.
      expect(HERMES_TEMPLATES.map((t) => t.name)).toContain(parsed.name);
      expect(readFileSync(new URL(p), 'utf8'), `${p} is stale — run pnpm --filter @hermes/xo export`).toBe(data);
    }
    expect(printed(log)).toContain('templates/hermes-htlc.json');
  });
});
