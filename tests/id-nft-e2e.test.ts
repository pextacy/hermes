/** `hermes id nft-mint` core against a local Nostr relay and the BCH VM, then resolution with the NFT pin. */
import { afterAll, describe, expect, it } from 'vitest';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { generatePrivateKey } from '@bitauth/libauth';
import { Discovery, LocalBchSigner, LocalNostrSigner, createBinding, npubOf, pinnedSeqFromUtxos } from '@hermes/id';
import { walletFromPrivateKey } from '@hermes/chain';
import { resolveRecipient } from '@hermes/pay';
import { mintIdentityNftForBinding } from '../apps/cli/src/id';
import { startDevRelay } from '../scripts/relay-core';

const relay = startDevRelay([7121, 7122, 7123]);
afterAll(() => relay.close());

describe('identity NFT mint flow', () => {
  it('re-issues the binding with idCategory, mints the NFT pinning it, and resolution honours the pin', async () => {
    const discovery = new Discovery({ relays: relay.urls, timeoutMs: 2000 });
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    const key = generatePrivateKey();
    const wallet = walletFromPrivateKey(key, 'chipnet');
    provider.addUtxo(wallet.address, randomUtxo({ satoshis: 100_000n }));
    const bch = new LocalBchSigner(key);
    const nostr = new LocalNostrSigner();
    const { event } = await createBinding({ bch, nostr, network: 'chipnet' });
    expect((await discovery.publish(event)).every((r) => r.ok)).toBe(true);

    const r = await mintIdentityNftForBinding({ discovery, provider, network: 'chipnet', wallet, bch, nostr });
    expect(r.seq).toBe(1);
    expect(r.published.every((x) => x.ok)).toBe(true);
    const utxos = await provider.getUtxos(wallet.tokenAddress);
    expect(pinnedSeqFromUtxos(utxos.map((u) => ({ token: u.token ? { category: u.token.category, nft: u.token.nft } : null })), r.category, await nostr.getPublicKey())).toBe(1);

    const resolved = await resolveRecipient(discovery, npubOf(await nostr.getPublicKey()), {
      network: 'chipnet',
      withProfile: false,
      nftUtxos: async (addr) => (await provider.getUtxos(addr)) as never,
    });
    expect(resolved.card.version).toBe(1);
    expect(resolved.identity.current.payload?.idCategory).toBe(r.category);
    expect(resolved.card.warnings.map((w) => w.code)).not.toContain('nft-mismatch');
    discovery.close();
  }, 60_000);
});
