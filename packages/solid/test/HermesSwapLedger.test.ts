import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SignatureTemplate, Signer, randomUtxo } from '@solidcash/solidcash';
import { ContractFactory } from '@solidcash/solidcash/contract-factory';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import '@solidcash/solidcash/vitest';
import artifact from '../artifacts/solidcash/HermesSwapLedger.json' with { type: 'json' };

async function deploy() {
  const provider = new MockNetworkProvider();
  const key = randomBytes(32);
  const signer = new Signer(key, provider);
  for (let i = 0; i < 6; i++) provider.addUtxo(signer.address, randomUtxo({ satoshis: 1_000_000n }));
  const factory = new ContractFactory(artifact as any, signer);
  const contract: any = await factory.deploy(signer.publicKey, { addressType: 'p2sh32' });
  return { provider, signer, key, contract, sig: new SignatureTemplate(key) };
}

const swap = () => {
  const secret = randomBytes(32);
  return { secret, hashlock: createHash('sha256').update(secret).digest() };
};

describe('HermesSwapLedger (stateful SolidCash)', () => {
  it('deploys with zeroed counters', async () => {
    const { contract } = await deploy();
    expect(BigInt(await contract.state.settledCount())).toBe(0n);
    expect(BigInt(await contract.state.settledVolume())).toBe(0n);
  });

  it('records a settled swap, updates state and emits Settled', async () => {
    const { contract, sig } = await deploy();
    const s = swap();
    await contract.call.record(s.hashlock, s.secret, 500n, 1n, sig).send();
    expect(BigInt(await contract.state.settledCount())).toBe(1n);
    expect(BigInt(await contract.state.settledVolume())).toBe(500n);
    const events = await contract.queryFilter('Settled');
    expect(events.length).toBe(1);
    expect(BigInt(events[0].args.amount)).toBe(500n);
  });

  it('refuses a replay of the same hashlock', async () => {
    const { contract, sig } = await deploy();
    const s = swap();
    await contract.call.record(s.hashlock, s.secret, 500n, 1n, sig).send();
    await expect(contract.call.record(s.hashlock, s.secret, 500n, 1n, sig).send()).rejects.toThrow();
  });

  it('refuses a secret that does not open the hashlock, bad amounts and directions', async () => {
    const { contract, sig } = await deploy();
    const s = swap();
    await expect(contract.call.record(s.hashlock, randomBytes(32), 500n, 1n, sig).send()).rejects.toThrow();
    await expect(contract.call.record(s.hashlock, s.secret, 0n, 1n, sig).send()).rejects.toThrow();
    await expect(contract.call.record(s.hashlock, s.secret, 5n, 3n, sig).send()).rejects.toThrow();
  });

  it('refuses anyone but the operator', async () => {
    const { contract } = await deploy();
    const s = swap();
    await expect(contract.call.record(s.hashlock, s.secret, 500n, 2n, new SignatureTemplate(randomBytes(32))).send()).rejects.toThrow();
  });
});
