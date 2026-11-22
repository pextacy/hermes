/**
 * hermes CLI (apps/cli): argument helpers and the mainnet guard, the `id nft-mint` / `id nft-sync` /
 * `id verify` commands against a local Nostr relay and the BCH VM, `swap take` wiring, `evm deploy`
 * on a private anvil node (config writes intercepted), the `swap demo` on anvil + BCH VM, and the
 * command dispatcher. Keys are fed through a mocked prompt; nothing touches a public network.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { binToHex, generatePrivateKey } from '@bitauth/libauth';
import * as nip19 from 'nostr-tools/nip19';
import type { Hex } from 'viem';
import { Discovery, LocalBchSigner, LocalNostrSigner, createBinding, npubOf, parseIdentityCommitment, rotateBinding } from '@hermes/id';
import { NETWORKS } from '@hermes/chain';
import { walletFromPrivateKey } from '@hermes/chain';
import { evmConfig, publicClientFor, type EvmChainConfig } from '@hermes/swap';
import { startDevRelay } from '../scripts/relay-core';

class Exit extends Error {
  constructor(readonly code?: number) {
    super(`exit ${code}`);
  }
}
const ARGV = process.argv;
const relay = startDevRelay([7131, 7132, 7133]);
const tmp = mkdtempSync(join(tmpdir(), 'hermes-cli-'));
afterAll(() => {
  relay.close();
  rmSync(tmp, { recursive: true, force: true });
});

let logs: string[] = [];
let errs: string[] = [];
const setup = (args: string[], exit: 'throw' | ((c?: number) => void) = 'throw') => {
  vi.resetModules();
  process.argv = ['node', 'hermes', ...args];
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    if (exit === 'throw') throw new Exit(c);
    exit(c);
  }) as never);
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errs.push(a.map(String).join(' ')));
};
const answers = (list: string[]) => {
  const asked: string[] = [];
  vi.doMock('@hermes/chain/prompt', () => ({ promptSecret: async (q: string) => (asked.push(q), list.shift() ?? '') }));
  return asked;
};
/** Discovery bound to the local relay (the CLI constructs `new Discovery()` with public relays). */
const localDiscovery = () =>
  vi.doMock('@hermes/id', async (orig) => {
    const m = (await orig()) as typeof import('@hermes/id');
    return { ...m, Discovery: class extends m.Discovery {
      constructor() {
        super({ relays: relay.urls, timeoutMs: 1500 });
      }
    } };
  });
const withProvider = (provider: unknown) => vi.doMock('@hermes/chain', async (orig) => ({ ...((await orig()) as object), getProvider: () => provider }));
const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: Error) => e);

afterEach(() => {
  process.argv = ARGV;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const m of ['@hermes/chain/prompt', '@hermes/chain', '@hermes/id', '@hermes/swap', 'node:fs', '../apps/cli/src/taker-core', '../apps/cli/src/id', '../apps/cli/src/verify', '../apps/cli/src/evm-deploy', '../apps/cli/src/swap-demo', '../apps/cli/src/taker']) vi.doUnmock(m);
  vi.resetModules();
});

describe('args', () => {
  it('opt / flag read process.argv; guardMainnet refuses mainnet without approval', async () => {
    setup(['swap', 'take', '--amount', '7', '--mock-usdc']);
    const a = await import('../apps/cli/src/args');
    expect(a.argv).toEqual(['swap', 'take', '--amount', '7', '--mock-usdc']);
    expect(a.opt('amount')).toBe('7');
    expect(a.opt('network', 'chipnet')).toBe('chipnet');
    expect(a.opt('network')).toBeUndefined();
    expect(a.flag('mock-usdc')).toBe(true);
    expect(a.flag('i-have-owner-approval')).toBe(false);
    a.guardMainnet('chipnet'); // no-op
    expect(() => a.guardMainnet('mainnet')).toThrow(new Exit(1));
    expect(errs[0]).toMatch(/Mainnet needs the owner’s explicit approval/);
  });
  it('guardMainnet lets mainnet through with --i-have-owner-approval', async () => {
    setup(['--network', 'mainnet', '--i-have-owner-approval']);
    const a = await import('../apps/cli/src/args');
    expect(() => a.guardMainnet('mainnet')).not.toThrow();
  });
});

describe('hermes id nft-mint / nft-sync (local relay + BCH VM)', () => {
  const provider = new MockNetworkProvider({ updateUtxoSet: true });
  const k0 = generatePrivateKey();
  const k1 = generatePrivateKey();
  const w0 = walletFromPrivateKey(k0, 'chipnet');
  const w1 = walletFromPrivateKey(k1, 'chipnet');
  const nostr = new LocalNostrSigner();
  const nsec = nip19.nsecEncode(nostr.secretKey);
  let npub: string;
  let category: string;

  beforeAll(async () => {
    provider.addUtxo(w0.address, randomUtxo({ satoshis: 200_000n }));
    npub = npubOf(await nostr.getPublicKey());
    const d = new Discovery({ relays: relay.urls, timeoutMs: 1500 });
    const { event } = await createBinding({ bch: new LocalBchSigner(k0), nostr, network: 'chipnet' });
    expect((await d.publish(event)).every((r) => r.ok)).toBe(true);
    d.close();
  });

  it('refuses mainnet before asking for keys', async () => {
    setup(['id', 'nft-mint', '--network', 'mainnet']);
    const asked = answers([]);
    const { idNftMint } = await import('../apps/cli/src/id');
    expect(await caught(idNftMint())).toEqual(new Exit(1));
    expect(asked).toEqual([]);
  });

  it('nft-mint refuses a BCH key that is not the bound key', async () => {
    setup(['id', 'nft-mint']);
    answers([binToHex(generatePrivateKey()), nsec]);
    localDiscovery();
    withProvider(provider);
    const { idNftMint } = await import('../apps/cli/src/id');
    expect((await caught(idNftMint()))?.message).toBe('This BCH key is not the bound key');
  });

  it('nft-mint refuses when the npub has no binding yet', async () => {
    setup(['id', 'nft-mint']);
    const other = new LocalNostrSigner();
    answers([binToHex(k0), nip19.nsecEncode(other.secretKey)]);
    localDiscovery();
    withProvider(provider);
    const { idNftMint } = await import('../apps/cli/src/id');
    expect((await caught(idNftMint()))?.message).toMatch(/^No binding for npub1.* yet — link it first/);
  });

  it('nft-sync: --npub required; a binding without an identity NFT is refused', async () => {
    setup(['id', 'nft-sync']);
    answers([binToHex(k0)]);
    const { idNftSync } = await import('../apps/cli/src/id');
    expect((await caught(idNftSync()))?.message).toBe('--npub required');

    setup(['id', 'nft-sync', '--npub', npub]);
    answers([binToHex(k0)]);
    localDiscovery();
    withProvider(provider);
    const m = await import('../apps/cli/src/id');
    expect((await caught(m.idNftSync()))?.message).toBe('Binding has no identity NFT category');
  });

  it('nft-mint: prompts for both keys, mints the NFT and publishes binding v1 pinning it', async () => {
    setup(['id', 'nft-mint', '--network', 'chipnet']);
    const asked = answers([binToHex(k0), nsec]);
    localDiscovery();
    withProvider(provider);
    const { idNftMint } = await import('../apps/cli/src/id');
    await idNftMint();
    expect(asked).toEqual(['Identity BCH key for chipnet (WIF / hex / mnemonic): ', 'Nostr nsec: ']);
    const m = logs[0].match(/^identity NFT ([0-9a-f]{64}) minted \(([0-9a-f]{64})\) pinning version 1$/);
    expect(m).toBeTruthy();
    category = m![1];
    expect(logs[1]).toBe('binding v1 published: 3/3 relays');
    const nft = (await provider.getUtxos(w0.tokenAddress)).find((u) => u.token?.category === category);
    expect(nft?.token?.nft?.capability).toBe('mutable');
    expect(parseIdentityCommitment(nft!.token!.nft!.commitment)?.seq).toBe(1);
  });

  it('nft-sync: no-op when the NFT already pins the current version; NFT must be at the given key', async () => {
    setup(['id', 'nft-sync', '--npub', npub]);
    answers([binToHex(k0)]);
    localDiscovery();
    withProvider(provider);
    const { idNftSync } = await import('../apps/cli/src/id');
    await idNftSync();
    expect(logs).toEqual(['NFT already pins v1']);

    setup(['id', 'nft-sync', '--npub', npub]);
    answers([binToHex(generatePrivateKey())]);
    localDiscovery();
    withProvider(provider);
    const m = await import('../apps/cli/src/id');
    expect((await caught(m.idNftSync()))?.message).toMatch(/^NFT not found at this key/);
  });

  it('nft-sync after a BCH key rotation: moves the NFT to the new key, pinning v2', async () => {
    const d = new Discovery({ relays: relay.urls, timeoutMs: 1500 });
    const current = (await d.resolve(npub)).identity!;
    expect(current.current.seq).toBe(1);
    const { event } = await rotateBinding({ prevEvent: current.current.event, currentBch: new LocalBchSigner(k0), currentNostr: nostr, newBch: new LocalBchSigner(k1), network: 'chipnet' });
    expect((await d.publish(event)).every((r) => r.ok)).toBe(true);
    d.close();

    setup(['id', 'nft-sync', '--npub', npub]);
    const asked = answers([binToHex(k0)]);
    localDiscovery();
    withProvider(provider);
    const { idNftSync } = await import('../apps/cli/src/id');
    await idNftSync();
    expect(asked[0]).toMatch(/^Key currently holding the identity NFT/);
    expect(logs[0]).toMatch(new RegExp(`^NFT now pins v2 at ${w1.tokenAddress}: [0-9a-f]{64}$`));
    expect((await provider.getUtxos(w0.tokenAddress)).some((u) => u.token?.category === category)).toBe(false);
    const nft = (await provider.getUtxos(w1.tokenAddress)).find((u) => u.token?.category === category);
    expect(parseIdentityCommitment(nft!.token!.nft!.commitment)?.seq).toBe(2);
  });
});

describe('hermes id verify', () => {
  let event: Awaited<ReturnType<typeof createBinding>>['event'];
  beforeAll(async () => {
    event = (await createBinding({ bch: new LocalBchSigner(), nostr: new LocalNostrSigner(), network: 'chipnet' })).event;
  });
  it('requires an input', async () => {
    setup([]);
    const { verifyCmd } = await import('../apps/cli/src/verify');
    await expect(verifyCmd()).rejects.toThrow(/^usage: hermes id verify/);
  });
  it('verifies a binding event from a JSON file', async () => {
    setup([]);
    const f = join(tmp, 'event.json');
    writeFileSync(f, JSON.stringify(event));
    const { verifyCmd } = await import('../apps/cli/src/verify');
    await verifyCmd(f);
    expect(logs.at(-1)).toBe('VALID (1 version(s))');
    expect(logs.slice(0, -1).every((l) => l.startsWith('✔'))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
  it('reports a tampered event as INVALID with exit code 2', async () => {
    setup([]);
    const f = join(tmp, 'bad.json');
    writeFileSync(f, JSON.stringify({ ...event, content: event.content.replace('"seq":0', '"seq":1') }));
    const { verifyCmd } = await import('../apps/cli/src/verify');
    await verifyCmd(f);
    expect(logs.at(-1)).toBe('INVALID');
    expect(logs.some((l) => l.startsWith('✘'))).toBe(true);
    expect(process.exitCode).toBe(2);
  });
  it('resolves an npub through relays, and fails for an unknown one', async () => {
    const d = new Discovery({ relays: relay.urls, timeoutMs: 1500 });
    await d.publish(event);
    d.close();
    setup([]);
    localDiscovery();
    const { verifyCmd } = await import('../apps/cli/src/verify');
    await verifyCmd(npubOf(event.pubkey));
    expect(logs[0]).toMatch(/^resolved from 3 relay\(s\); warnings: /);
    expect(logs.at(-1)).toBe('VALID (1 version(s))');
    await expect(verifyCmd(npubOf(await new LocalNostrSigner().getPublicKey()))).rejects.toThrow();
  });
});

describe('hermes swap take', () => {
  it('refuses mainnet without approval', async () => {
    setup(['swap', 'take', '--network', 'mainnet']);
    const { take } = await import('../apps/cli/src/taker');
    expect(await caught(take())).toEqual(new Exit(1));
  });
  it('refuses when the EVM HTLC / stablecoin are not configured (before asking for keys)', async () => {
    setup(['swap', 'take', '--network', 'chipnet', '--evm', 'baseSepolia']);
    const asked = answers([]);
    const { take } = await import('../apps/cli/src/taker');
    expect((await caught(take()))?.message).toMatch(/^Configure evm htlc\/usdc and the stablecoin category first/);
    expect(asked).toEqual([]);
  });

  const wire = (direction?: string) => {
    const TOKEN = 'ab'.repeat(32);
    const calls: Record<string, any>[] = [];
    vi.doMock('../apps/cli/src/taker-core', () => ({ runTaker: async (d: Record<string, unknown>) => void calls.push(d) }));
    vi.doMock('@hermes/chain', async (orig) => {
      const m = (await orig()) as typeof import('@hermes/chain');
      return { ...m, getProvider: () => ({ mock: 'provider' }), stablecoins: () => [{ key: 'PUSD', symbol: 'tPUSD', category: TOKEN, decimalsFallback: 2, stable: true, source: '' }] };
    });
    vi.doMock('@hermes/swap', async (orig) => {
      const m = (await orig()) as typeof import('@hermes/swap');
      return { ...m, evmConfig: (k: string) => ({ ...m.evmConfig(k as never), htlc: '0x' + '11'.repeat(20), usdc: '0x' + '22'.repeat(20) }), tokenDecimals: async () => 6 };
    });
    const bchKey = generatePrivateKey();
    const asked = answers([binToHex(bchKey), '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80']);
    return { TOKEN, calls, asked, bchKey, direction };
  };

  it('usdc-to-pusd: reads USDC decimals from the token, passes keys / relays / amounts to the taker', async () => {
    setup(['swap', 'take', '--evm', 'anvil', '--amount', '5', '--relays', 'ws://a,ws://b']);
    const w = wire();
    const { take } = await import('../apps/cli/src/taker');
    await take();
    expect(w.asked).toEqual(['BCH chipnet key: ', 'EVM key for Anvil (local): ']);
    expect(w.calls).toHaveLength(1);
    const d = w.calls[0];
    expect(d).toMatchObject({ relays: ['ws://a', 'ws://b'], evmChainId: 31337, htlc: '0x' + '11'.repeat(20), usdc: '0x' + '22'.repeat(20), bchToken: w.TOKEN, direction: 'usdc-to-pusd', amountIn: 5_000_000n, provider: { mock: 'provider' } });
    expect(d.bch.address).toBe(walletFromPrivateKey(w.bchKey, 'chipnet').address);
    expect(d.wallet.account.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  });

  it('pusd-to-usdc: uses the stablecoin decimals and the default public relays', async () => {
    setup(['swap', 'take', '--evm', 'anvil', '--direction', 'pusd-to-usdc', '--amount', '1.5']);
    const w = wire();
    const { take } = await import('../apps/cli/src/taker');
    const { NETWORKS } = await import('@hermes/chain');
    await take();
    expect(w.calls[0].amountIn).toBe(150n);
    expect(w.calls[0].direction).toBe('pusd-to-usdc');
    expect(w.calls[0].relays).toEqual(NETWORKS.nostr.relays);
  });
});

describe('hermes evm deploy (private anvil)', () => {
  const PORT = 8549;
  const cfg: EvmChainConfig = { ...evmConfig('anvil'), rpc: `http://127.0.0.1:${PORT}`, explorerTx: 'http://explorer.local/tx/' };
  let anvil: ChildProcess;
  beforeAll(async () => {
    anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
    const client = publicClientFor(cfg);
    for (let i = 0; i < 50; i++) {
      try {
        await client.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }, 30_000);
  afterAll(() => anvil?.kill());

  it('refuses EVM mainnet without approval (before asking for the key)', async () => {
    setup(['evm', 'deploy', '--evm', 'base']);
    const asked = answers([]);
    const { evmDeploy } = await import('../apps/cli/src/evm-deploy');
    await expect(evmDeploy()).rejects.toThrow(/EVM mainnet deploy needs the owner’s explicit approval/);
    expect(asked).toEqual([]);
  });

  const deployWith = async (args: string[]) => {
    setup(['evm', 'deploy', '--evm', 'anvil', ...args]);
    const asked = answers(['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80']);
    vi.doMock('@hermes/swap', async (orig) => ({ ...((await orig()) as object), evmConfig: () => cfg }));
    const writes: { file: string; data: string }[] = [];
    vi.doMock('node:fs', async (orig) => ({ ...((await orig()) as object), writeFileSync: (f: URL, d: string) => void writes.push({ file: String(f), data: d }) }));
    const { evmDeploy } = await import('../apps/cli/src/evm-deploy');
    await evmDeploy();
    return { asked, writes };
  };

  it('deploys HermesHTLC + MockUSDC and records them in config/networks.json (write intercepted)', async () => {
    const { asked, writes } = await deployWith(['--mock-usdc']);
    expect(asked).toEqual(['Deployer key for Anvil (local) (0x…): ']);
    const htlc = logs[0].match(/^HermesHTLC (0x[0-9a-fA-F]{40}) \(http:\/\/explorer\.local\/tx\/0x[0-9a-f]{64}\)$/)![1];
    const usdc = logs[1].match(/^MockUSDC (0x[0-9a-fA-F]{40})$/)![1];
    expect(logs[2]).toBe('config/networks.json → evm.anvil updated');
    expect(writes).toHaveLength(1);
    expect(writes[0].file).toMatch(/config\/networks\.json$/);
    const json = JSON.parse(writes[0].data);
    expect(json.evm.anvil).toMatchObject({ htlc, usdc, usdcSource: 'Hermes MockUSDC (demo only)' });
    expect(json.evm.baseSepolia.htlc).toBe(NETWORKS.evm.baseSepolia.htlc); // nothing else touched
    const code = await publicClientFor(cfg).getCode({ address: htlc as Hex });
    expect(code && code.length > 2).toBe(true);
  });

  it('without --mock-usdc only the HTLC is deployed and USDC is left as configured', async () => {
    const { writes } = await deployWith([]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/^HermesHTLC 0x/);
    const json = JSON.parse(writes[0].data);
    expect(json.evm.anvil.usdc).toBeNull();
    expect(json.evm.anvil.usdcSource).toBeUndefined();
  });
});

describe('hermes swap demo (anvil + BCH VM)', () => {
  it('runs both directions and the refund, printing each step', async () => {
    setup(['swap', 'demo']);
    const { swapDemo } = await import('../apps/cli/src/swap-demo');
    await swapDemo();
    const out = logs.join('\n');
    expect(out).not.toContain('BUG');
    expect(logs[0]).toBe('timeouts ok: true (T_first = T_second + 2 h)');
    expect(out).toContain('3 taker claims PUSD on BCH, revealing the secret (taker PUSD 104.97)');
    expect(out).toContain('4 solver reads the secret from BCH and claims USDC (solver USDC 105)');
    expect(out).toContain('3 taker claims USDC (taker USDC 104.95)');
    expect(out).toContain('4 solver reads the secret from the EVM event and claims PUSD (solver PUSD 105.03)');
    expect(out).toContain('early refund rejected ✔');
    expect(out).toContain('refund after T_first ✔ (taker USDC 104.95)');
  }, 60_000);
});

describe('hermes dispatcher (apps/cli/src/index.ts)', () => {
  const dispatch = async (args: string[]) => {
    let done!: (c?: number) => void;
    const exited = new Promise<number | undefined>((r) => (done = r));
    setup(args, (c) => done(c));
    await import('../apps/cli/src/index');
    return exited;
  };
  it('prints usage for an unknown command', async () => {
    expect(await dispatch([])).toBe(0);
    expect(logs[0].split('\n')).toHaveLength(9);
    expect(logs[0]).toContain('hermes id nft-status');
    expect(logs[0]).toContain('hermes id nft-mint --network chipnet');
    expect(logs[0]).toContain('hermes swap take');
  });
  it('reports a failing command with exit code 1', async () => {
    expect(await dispatch(['id', 'verify'])).toBe(1);
    expect(errs[0]).toMatch(/^usage: hermes id verify/);
  });
  it('routes every command to its implementation', async () => {
    const hit: string[] = [];
    const rec = (n: string) => async (...a: unknown[]) => void hit.push([n, ...a].join(' '));
    vi.doMock('../apps/cli/src/id', () => ({ idNftMint: rec('mint'), idNftSync: rec('sync') }));
    vi.doMock('../apps/cli/src/verify', () => ({ verifyCmd: rec('verify') }));
    vi.doMock('../apps/cli/src/evm-deploy', () => ({ evmDeploy: rec('deploy') }));
    vi.doMock('../apps/cli/src/swap-demo', () => ({ swapDemo: rec('demo') }));
    vi.doMock('../apps/cli/src/taker', () => ({ take: rec('take') }));
    for (const a of [['id', 'nft-mint'], ['id', 'nft-sync'], ['id', 'verify', 'npub1x'], ['evm', 'deploy'], ['swap', 'demo'], ['swap', 'take']]) expect(await dispatch(a)).toBe(0);
    expect(hit).toEqual(['mint', 'sync', 'verify npub1x', 'deploy', 'demo', 'take']);
  });
});
