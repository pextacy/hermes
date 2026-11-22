import { describe, expect, it } from 'vitest';
import type { Event, Filter } from 'nostr-tools';
import { MockNetworkProvider, SignatureTemplate, randomUtxo } from 'cashscript';
import { generatePrivateKey } from '@bitauth/libauth';
import { Discovery, LocalBchSigner, LocalNostrSigner, createBinding, npubOf, rotateBinding } from '@hermes/id';
import { cardFor, preparePayment, payLocal, resolveRecipient } from '@hermes/pay';
import { walletFromPrivateKey } from '@hermes/chain';

/** Discovery backed by an in-memory relay (filters on authors / #i tags like a real relay). */
class MemoryDiscovery extends Discovery {
  constructor(readonly events: Event[]) {
    super({ relays: ['wss://a', 'wss://b', 'wss://c'] });
  }
  override async query(filter: Filter) {
    const match = (e: Event) =>
      (!filter.kinds || filter.kinds.includes(e.kind)) &&
      (!filter.authors || filter.authors.includes(e.pubkey)) &&
      (!filter['#i'] || e.tags.some((t) => t[0] === 'i' && filter['#i']!.includes(t[1])));
    return { events: this.events.filter(match), answered: 3 };
  }
}

async function identity(network: 'mainnet' | 'chipnet' = 'chipnet') {
  const bch = new LocalBchSigner();
  const nostr = new LocalNostrSigner();
  const { event } = await createBinding({ bch, nostr, network });
  return { bch, nostr, event };
}

describe('hermes-pay resolver', () => {
  it('resolves an npub to the current verified destination', async () => {
    const id = await identity();
    const d = new MemoryDiscovery([id.event]);
    const r = await resolveRecipient(d, npubOf(id.event.pubkey), { network: 'chipnet', withProfile: false });
    expect(r.card.addr).toBe(JSON.parse(id.event.content).payload.addr);
    expect(r.card.payable).toBe(true);
    expect(r.card.version).toBe(0);
  });

  it('follows a rotation to the newest version and warns about the recent change', async () => {
    const id = await identity();
    const newBch = new LocalBchSigner();
    const v1 = await rotateBinding({ prevEvent: id.event, currentBch: id.bch, currentNostr: id.nostr, newBch, network: 'chipnet' });
    // Relays only keep the latest replaceable event, plus the old one may linger on another relay.
    const d = new MemoryDiscovery([id.event, v1.event]);
    const r = await resolveRecipient(d, id.event.pubkey, { network: 'chipnet', withProfile: false });
    expect(r.card.version).toBe(1);
    expect(r.card.rotations).toBe(1);
    expect(r.card.addr).toBe(v1.content.payload.addr);
    expect(r.card.warnings.map((w) => w.code)).toContain('recent-change');
  });

  it('old npub still resolves after a Nostr rotation followed by a BCH rotation (intermediate version overwritten)', async () => {
    const id = await identity();
    const newNostr = new LocalNostrSigner();
    const v1 = await rotateBinding({ prevEvent: id.event, currentBch: id.bch, currentNostr: id.nostr, newNostr, network: 'chipnet' });
    const newBch = new LocalBchSigner();
    const v2 = await rotateBinding({ prevEvent: v1.event, currentBch: id.bch, currentNostr: newNostr, newBch, network: 'chipnet' });
    // Relays keep one replaceable event per author: v0 (old key) and v2 (new key, replaced v1).
    const d = new MemoryDiscovery([id.event, v2.event]);
    const r = await resolveRecipient(d, id.event.pubkey, { network: 'chipnet', withProfile: false });
    expect(r.card.version).toBe(2);
    expect(r.card.addr).toBe(v2.content.payload.addr);
    void v1;
  });

  it('a stale binding never resolves once a newer valid one exists', async () => {
    const id = await identity();
    const v1 = await rotateBinding({ prevEvent: id.event, currentBch: id.bch, currentNostr: id.nostr, newBch: new LocalBchSigner(), network: 'chipnet' });
    const d = new MemoryDiscovery([v1.event]); // only the newest copy (which embeds v0)
    const r = await resolveRecipient(d, id.event.pubkey, { network: 'chipnet', withProfile: false });
    expect(r.card.addr).not.toBe(id.event.tags.find((t) => t[1].startsWith('bch:'))![1].slice(4));
  });

  it('refuses an identity bound on another network', async () => {
    const id = await identity('chipnet');
    const d = new MemoryDiscovery([id.event]);
    await expect(resolveRecipient(d, id.event.pubkey, { network: 'mainnet', withProfile: false })).rejects.toThrow(/chipnet/);
  });

  it('finds an identity by address (reverse lookup)', async () => {
    const id = await identity();
    const d = new MemoryDiscovery([id.event]);
    const addr = JSON.parse(id.event.content).payload.addr;
    const r = await resolveRecipient(d, addr, { network: 'chipnet', withProfile: false });
    expect(r.card.nostr).toBe(id.event.pubkey);
  });

  it('reports not found without throwing details from relays', async () => {
    const d = new MemoryDiscovery([]);
    await expect(resolveRecipient(d, (await identity()).event.pubkey, { network: 'chipnet', withProfile: false })).rejects.toThrow(/No valid Hermes ID/);
  });
});

describe('hermes-pay payments', () => {
  it('pays the bound address (BCH) and the token address (tokens), refuses non-payable cards', async () => {
    const id = await identity();
    const d = new MemoryDiscovery([id.event]);
    const recipient = await resolveRecipient(d, id.event.pubkey, { network: 'chipnet', withProfile: false });
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    const payer = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    provider.addUtxo(payer.address, randomUtxo({ satoshis: 100_000n }));
    const category = 'ab'.repeat(32);
    provider.addUtxo(payer.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category, amount: 500n } }));
    const utxos = [...(await provider.getUtxos(payer.address)), ...(await provider.getUtxos(payer.tokenAddress))] as never[];
    const signer = new SignatureTemplate(payer.signer.privateKey);

    const r1 = await payLocal({ recipient, network: 'chipnet', from: payer.address, fromTokenAddr: payer.tokenAddress, utxos, asset: { kind: 'bch', satoshis: 10_000n }, memo: 'invoice 42', signer }, provider);
    expect(r1.txid).toMatch(/^[0-9a-f]{64}$/);
    const got = await provider.getUtxos(recipient.card.addr);
    expect(got.some((u) => u.satoshis === 10_000n)).toBe(true);

    const utxos2 = [...(await provider.getUtxos(payer.address)), ...(await provider.getUtxos(payer.tokenAddress))] as never[];
    await payLocal({ recipient, network: 'chipnet', from: payer.address, fromTokenAddr: payer.tokenAddress, utxos: utxos2, asset: { kind: 'token', category, amount: 120n }, signer }, provider);
    const tokens = await provider.getUtxos(recipient.card.tokenAddr);
    expect(tokens.some((u) => u.token?.amount === 120n)).toBe(true);

    // Unsigned version for a WizardConnect wallet.
    const utxos3 = [...(await provider.getUtxos(payer.address))] as never[];
    const wc = await preparePayment({ recipient, network: 'chipnet', from: payer.address, utxos: utxos3, asset: { kind: 'bch', satoshis: 1000n } }, provider);
    expect(wc.sourceOutputs.length).toBeGreaterThan(0);

    const blocked = { ...recipient, card: { ...cardFor(recipient.identity), payable: false } };
    await expect(payLocal({ recipient: blocked, network: 'chipnet', from: payer.address, utxos: utxos3, asset: { kind: 'bch', satoshis: 1000n }, signer }, provider)).rejects.toThrow(/refusing/);
  });
});
