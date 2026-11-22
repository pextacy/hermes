/**
 * SolidCash HTLC lifecycle (packages/solid): lock → claim and lock → refund evaluated in the BCH VM
 * through SolidCash's MockNetworkProvider — the same code path the web app's SolidLifecycle panel
 * runs — plus the lifecycle CLI (mock default, mainnet guard, and the "live" path with the Electrum
 * provider replaced by a mock so nothing is ever broadcast and no deployments file is written).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { hexToBin } from '@bitauth/libauth';
import { party, runSolidLifecycle, solidArtifact, type LifecycleStep } from '../packages/solid/src/lifecycle-core';

// @solidcash/solidcash is a dependency of packages/solid only; resolve it from there.
const req = createRequire(new URL('../packages/solid/package.json', import.meta.url));
const solidPath = (s: string) => realpathSync(req.resolve(s));
const MOCK = solidPath('@solidcash/solidcash/network/mock');
const ELECTRUM = solidPath('@solidcash/solidcash/network/electrum');
const ROOT = solidPath('@solidcash/solidcash');
const mockModule = () => import(/* @vite-ignore */ MOCK) as Promise<{ MockNetworkProvider: new () => any; MOCK_DEFAULT_BLOCK_TIME: number }>;
const rootModule = () => import(/* @vite-ignore */ ROOT) as Promise<{ randomUtxo: (o: { satoshis: bigint }) => any; TransactionBuilder: any }>;

const key = (b: number) => new Uint8Array(32).fill(b);

describe('party()', () => {
  it('derives pk / pkh / cashaddr for both prefixes', () => {
    const p = party(key(7), 'bchtest');
    expect(p.pk).toHaveLength(33);
    expect(p.pkh).toHaveLength(20);
    expect(p.address).toMatch(/^bchtest:q/);
    expect(party(key(7), 'bitcoincash').address).toMatch(/^bitcoincash:q/);
    expect(party(key(7), 'bitcoincash').pkh).toEqual(p.pkh);
  });
  it('exports the compiled HermesHtlc artifact', async () => {
    const { hermesHtlcSolidArtifact } = await import('../packages/solid/src/index');
    expect(hermesHtlcSolidArtifact).toEqual(solidArtifact);
    expect(solidArtifact.contractName).toBe('HermesHtlc');
    expect(solidArtifact.abi.map((f: { name: string }) => f.name).sort()).toEqual(['claim', 'refund']);
  });
});

describe('runSolidLifecycle (in-VM)', () => {
  it('mock funding: lock → wrong secret rejected → claim; lock → early refund rejected → refund', async () => {
    const { MockNetworkProvider } = await mockModule();
    const provider = new MockNetworkProvider();
    const seen: LifecycleStep[] = [];
    const steps = await runSolidLifecycle({ provider, mock: true, prefix: 'bchtest', locker: party(key(1), 'bchtest'), lockSats: 10_000n, now: Math.floor(Date.now() / 1000), onStep: (s) => seen.push(s) });
    expect(steps.map((s) => `${s.path}:${s.step}`)).toEqual(['claim:lock', 'claim:wrong-secret', 'claim:claim', 'refund:lock', 'refund:refund-early', 'refund:refund']);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(seen).toEqual(steps);
    // Each path uses its own HTLC (fresh secret / timeout) — different P2SH addresses.
    expect(steps[0].address).toMatch(/^bchtest:p/);
    expect(steps[0].address).not.toBe(steps[3].address);
    expect(steps[0].txid).toBeUndefined(); // mock funding is a UTXO, not a transaction
    expect(steps[2].txid).toMatch(/^[0-9a-f]{64}$/);
    expect(steps[5].txid).toMatch(/^[0-9a-f]{64}$/);
    // The refund returned the locked coins to the locker, minus the 1500-sat fee.
    const claimedTo = await provider.getUtxos(party(key(1), 'bchtest').address);
    expect(claimedTo.some((u: { satoshis: bigint }) => u.satoshis === 8_500n)).toBe(true);
  });

  it('funded path (mock=false): the locker pays the HTLC from its own UTXOs; works with a given recipient', async () => {
    const { MockNetworkProvider, MOCK_DEFAULT_BLOCK_TIME } = await mockModule();
    const { randomUtxo } = await rootModule();
    const provider = new MockNetworkProvider();
    const locker = party(key(2), 'bchtest');
    const recipient = party(key(3), 'bchtest');
    provider.addUtxo(locker.address, randomUtxo({ satoshis: 200_000n }));
    // now = the mock chain's block time so `now - 7200` (refund timeout) is already in the past.
    const steps = await runSolidLifecycle({ provider, mock: false, prefix: 'bchtest', locker, recipient, lockSats: 10_000n, now: MOCK_DEFAULT_BLOCK_TIME });
    expect(steps.every((s) => s.ok)).toBe(true);
    const locks = steps.filter((s) => s.step === 'lock');
    expect(locks).toHaveLength(2);
    for (const l of locks) expect(l.txid).toMatch(/^[0-9a-f]{64}$/);
    expect((await provider.getUtxos(recipient.address)).some((u: { satoshis: bigint }) => u.satoshis === 8_500n)).toBe(true);
  });

  it('funded path fails loudly when the locker has no coins', async () => {
    const { MockNetworkProvider } = await mockModule();
    await expect(runSolidLifecycle({ provider: new MockNetworkProvider(), mock: false, prefix: 'bchtest', locker: party(key(4), 'bchtest'), lockSats: 10_000n, now: 1_700_000_000 })).rejects.toThrow();
  });
});

describe('runSolidLifecycle reports a broken covenant', () => {
  afterEach(() => {
    vi.doUnmock(ROOT);
    vi.resetModules();
  });
  it('flags wrong-secret / early-refund acceptance as failed steps (ok=false)', async () => {
    vi.resetModules();
    // Simulate a covenant that accepts everything: debug() never throws.
    vi.doMock(ROOT, async (orig) => {
      const m = (await orig()) as { TransactionBuilder: new (...a: any[]) => any };
      class LaxBuilder extends m.TransactionBuilder {
        debug() {
          return {} as never;
        }
      }
      return { ...m, TransactionBuilder: LaxBuilder };
    });
    const core = await import('../packages/solid/src/lifecycle-core');
    const { MockNetworkProvider } = await mockModule();
    const steps = await core.runSolidLifecycle({ provider: new MockNetworkProvider(), mock: true, prefix: 'bchtest', locker: core.party(key(5), 'bchtest'), lockSats: 10_000n, now: 1_700_000_000 });
    expect(steps.find((s) => s.step === 'wrong-secret')).toMatchObject({ ok: false, note: 'wrong secret ACCEPTED (bug)' });
    expect(steps.find((s) => s.step === 'refund-early')).toMatchObject({ ok: false, note: 'early refund ACCEPTED (bug)' });
  });
});

describe('lifecycle CLI (packages/solid/src/lifecycle.ts)', () => {
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
  const runCli = async (args: string[]) => {
    vi.resetModules();
    process.argv = ['node', 'lifecycle.ts', ...args];
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Exit(c);
    }) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = await import('../packages/solid/src/lifecycle').then(() => undefined, (x) => x);
    return { exit: e instanceof Exit ? e.code : e, log: log.mock.calls.map((c) => String(c[0])), err: err.mock.calls.map((c) => String(c[0])) };
  };

  it('mock network (default): runs both paths and exits 0', async () => {
    const r = await runCli([]);
    expect(r.exit).toBe(0);
    expect(r.log).toHaveLength(6);
    expect(r.log.every((l) => l.includes('✔'))).toBe(true);
    expect(r.log[0]).toMatch(/^\[claim\] ✔ lock/);
    expect(r.log[5]).toMatch(/^\[refund\] ✔ refund/);
  });

  it('refuses mainnet without owner approval', async () => {
    const r = await runCli(['--network', 'mainnet']);
    expect(r.exit).toBe(1);
    expect(r.err[0]).toMatch(/owner’s explicit approval/);
  });

  it('live path (chipnet) with a mocked Electrum provider: prompts for the key, records the steps, never broadcasts', async () => {
    const { MockNetworkProvider, MOCK_DEFAULT_BLOCK_TIME } = await mockModule();
    const { randomUtxo } = await rootModule();
    const hex = '11'.repeat(32);
    const locker = party(hexToBin(hex), 'bchtest');
    const networks: string[] = [];
    vi.doMock(ELECTRUM, () => ({
      ElectrumNetworkProvider: class extends MockNetworkProvider {
        constructor(network: string) {
          super();
          networks.push(network);
          this.addUtxo(locker.address, randomUtxo({ satoshis: 100_000n }));
        }
      },
    }));
    const questions: string[] = [];
    vi.doMock('node:readline', () => ({ createInterface: () => ({ question: (q: string, cb: (a: string) => void) => (questions.push(q), cb(`  ${hex}  `)), close: () => {} }) }));
    const written: { file: string; data: string }[] = [];
    vi.doMock('node:fs', async (orig) => ({ ...((await orig()) as object), writeFileSync: (f: URL, d: string) => written.push({ file: String(f), data: d }) }));
    vi.useFakeTimers({ toFake: ['Date'], now: MOCK_DEFAULT_BLOCK_TIME * 1000 });
    const r = await runCli(['--network', 'chipnet']);
    expect(r.exit).toBe(0);
    expect(networks).toEqual(['chipnet']);
    expect(questions[0]).toMatch(/Funding key \(WIF\/hex\) for chipnet/);
    expect(r.log[0]).toMatch(/^recipient demo key \(keep it to recover a claim\): [0-9a-f]{64}$/);
    expect(written).toHaveLength(1);
    expect(written[0].file).toMatch(/packages\/solid\/deployments\/chipnet\.json$/);
    const rec = JSON.parse(written[0].data);
    expect(rec).toMatchObject({ network: 'chipnet', contract: 'HermesHtlc.scash' });
    expect(rec.steps).toHaveLength(6);
    expect(rec.steps.every((s: LifecycleStep) => s.ok)).toBe(true);
    expect(JSON.stringify(rec)).not.toContain(hex); // the funding key is never recorded
    expect(r.log.at(-1)).toBe('recorded in packages/solid/deployments/chipnet.json');
  });

  it('live path rejects an invalid funding key', async () => {
    vi.doMock(ELECTRUM, async () => ({ ElectrumNetworkProvider: (await mockModule()).MockNetworkProvider }));
    vi.doMock('node:readline', () => ({ createInterface: () => ({ question: (_q: string, cb: (a: string) => void) => cb('not-a-key'), close: () => {} }) }));
    const r = await runCli(['--network', 'chipnet']);
    expect(r.exit).toBeInstanceOf(Error);
    expect(String((r.exit as Error).message)).toMatch(/WIF|base58|checksum|length/i);
  });

  it('accepts a WIF funding key', async () => {
    const { MockNetworkProvider, MOCK_DEFAULT_BLOCK_TIME } = await mockModule();
    const { randomUtxo } = await rootModule();
    const { encodePrivateKeyWif } = await import('@bitauth/libauth');
    const priv = key(9);
    const wif = encodePrivateKeyWif(priv, 'testnet');
    const locker = party(priv, 'bchtest');
    vi.doMock(ELECTRUM, () => ({
      ElectrumNetworkProvider: class extends MockNetworkProvider {
        constructor() {
          super();
          this.addUtxo(locker.address, randomUtxo({ satoshis: 100_000n }));
        }
      },
    }));
    vi.doMock('node:readline', () => ({ createInterface: () => ({ question: (_q: string, cb: (a: string) => void) => cb(wif), close: () => {} }) }));
    vi.doMock('node:fs', async (orig) => ({ ...((await orig()) as object), writeFileSync: () => {} }));
    vi.useFakeTimers({ toFake: ['Date'], now: MOCK_DEFAULT_BLOCK_TIME * 1000 });
    const r = await runCli(['--network', 'chipnet']);
    expect(r.exit).toBe(0);
  });
});
