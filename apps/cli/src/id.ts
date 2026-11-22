import * as nip19 from 'nostr-tools/nip19';
import type { Utxo } from 'cashscript';
import { Discovery, LocalBchSigner, LocalNostrSigner, createBinding, identityNftStatus, verifyChain, type ResolvedIdentity } from '@hermes/id';
import { getProvider, privateKeyFrom, walletFromPrivateKey, type BchNetwork } from '@hermes/chain';
import { promptSecret } from '@hermes/chain/prompt';
import { buildMintIdentityNft, buildRotateIdentityNft, findIdentityNft, prepareIdentityGenesis } from '@hermes/pay';
import { opt, guardMainnet } from './args.js';

type S = Utxo & { lockingBytecode: string };
type Provider = Parameters<typeof prepareIdentityGenesis>[0]['provider'];

/** `--relays ws://a,ws://b,ws://c` (e.g. the local dev relay) instead of config/networks.json. */
export const discoveryFromArgs = () => {
  const r = opt('relays');
  return new Discovery(r ? { relays: r.split(',').map((x) => x.trim()).filter(Boolean) } : {});
};

/** UTXOs at the token address of every version in the chain, tagged with their address. */
export async function chainTokenUtxos(provider: Provider, identity: ResolvedIdentity) {
  const addrs = [...new Set(identity.chain.map((b) => b.tokenAddr))];
  const lists = await Promise.all(addrs.map(async (a) => ((await provider.getUtxos(a)) as S[]).map((u) => ({ ...u, address: a }))));
  return lists.flat();
}

async function keys(network: BchNetwork) {
  const bchKey = privateKeyFrom(await promptSecret(`Identity BCH key for ${network} (WIF / hex / mnemonic): `));
  const nsec = await promptSecret('Nostr nsec: ');
  const sk = nip19.decode(nsec).data as Uint8Array;
  return { wallet: walletFromPrivateKey(bchKey, network), bch: new LocalBchSigner(bchKey), nostr: new LocalNostrSigner(sk) };
}

/** Core of `nft-mint` (injectable discovery/provider): genesis → re-issued binding with idCategory → mint → publish. */
export async function mintIdentityNftForBinding(args: {
  discovery: Discovery;
  provider: Parameters<typeof prepareIdentityGenesis>[0]['provider'];
  network: BchNetwork;
  wallet: ReturnType<typeof walletFromPrivateKey>;
  bch: LocalBchSigner;
  nostr: LocalNostrSigner;
}) {
  const { discovery, provider, network, wallet, bch, nostr } = args;
  const npub = nip19.npubEncode(await nostr.getPublicKey());
  const current = (await discovery.resolve(npub)).identity;
  if (!current) throw new Error(`No binding for ${npub} yet — link it first (web Identity tab).`);
  if (current.current.bch !== Buffer.from(await bch.getPublicKey()).toString('hex')) throw new Error('This BCH key is not the bound key');
  if (current.current.payload?.idCategory) {
    const st = identityNftStatus(current.chain, await chainTokenUtxos(provider, current));
    if (st.state !== 'missing') throw new Error(`This identity already has NFT ${st.category} (${st.message}) — use nft-sync instead of minting another.`);
  }
  const utxos = (await provider.getUtxos(wallet.address)) as S[];
  const { category, outpoint } = await prepareIdentityGenesis({ provider, address: wallet.address, utxos, signer: wallet.signer });
  const { event } = await createBinding({ bch, nostr, network, prev: current.current.payload!, idCategory: category, history: [current.current.event] });
  if (!verifyChain(event).ok) throw new Error('self-check failed');
  const seq = current.current.seq + 1;
  const mint = await buildMintIdentityNft({ provider, outpoint, category, tokenAddress: wallet.tokenAddress, address: wallet.address, signer: wallet.signer, nostr: await nostr.getPublicKey(), seq }).send();
  const published = await discovery.publish(event);
  return { category, seq, mintTxid: mint.txid, event, published };
}

/**
 * hermes id nft-mint: create the identity NFT and re-issue the binding with `idCategory`, so the
 * NFT pins the new version (category is known before signing: it is the genesis outpoint txid).
 */
export async function idNftMint() {
  const network = opt('network', 'chipnet') as BchNetwork;
  guardMainnet(network);
  const k = await keys(network);
  const discovery = discoveryFromArgs();
  const r = await mintIdentityNftForBinding({ discovery, provider: getProvider(network), network, wallet: k.wallet, bch: k.bch, nostr: k.nostr });
  console.log(`identity NFT ${r.category} minted (${r.mintTxid}) pinning version ${r.seq}`);
  console.log(`binding v${r.seq} published: ${r.published.filter((x) => x.ok).length}/${r.published.length} relays`);
  discovery.close();
}

/**
 * Core of `nft-sync` (injectable): after a rotation, spend the identity NFT from the key that
 * holds it and recreate it at the current token address with commitment H(current nostr) || seq.
 */
export async function syncIdentityNftForBinding(args: { discovery: Discovery; provider: Provider; npub: string; holder: ReturnType<typeof walletFromPrivateKey> }) {
  const { discovery, provider, npub, holder } = args;
  const current = (await discovery.resolve(npub)).identity;
  const cat = current?.current.payload?.idCategory;
  if (!current || !cat) throw new Error('Binding has no identity NFT category');
  const utxos = [...(await provider.getUtxos(holder.address)), ...(await provider.getUtxos(holder.tokenAddress))] as S[];
  const nft = findIdentityNft(utxos, cat);
  if (!nft) throw new Error('NFT not found at this key — use the key that holds it (the old BCH key after a BCH rotation)');
  const before = identityNftStatus(current.chain, [{ ...nft, address: holder.tokenAddress }]);
  if (before.state === 'synced') return { already: true as const, seq: current.current.seq, status: before };
  const tx = await buildRotateIdentityNft({ provider, nft, funding: utxos, signer: holder.signer, nextTokenAddress: current.current.tokenAddr, changeAddress: holder.address, nostr: current.current.nostr, seq: current.current.seq }).send();
  return { already: false as const, seq: current.current.seq, txid: tx.txid, to: current.current.tokenAddr, from: before };
}

/** hermes id nft-sync: after a rotation, move/update the NFT so it pins the current binding version. */
export async function idNftSync() {
  const network = opt('network', 'chipnet') as BchNetwork;
  guardMainnet(network);
  const npub = opt('npub');
  if (!npub) throw new Error('--npub required');
  const holderKey = privateKeyFrom(await promptSecret('Key currently holding the identity NFT (old BCH key after a BCH rotation): '));
  const discovery = discoveryFromArgs();
  const r = await syncIdentityNftForBinding({ discovery, provider: getProvider(network), npub, holder: walletFromPrivateKey(holderKey, network) });
  if (r.already) console.log(`NFT already pins v${r.seq}`);
  else {
    console.log(`NFT now pins v${r.seq} at ${r.to}: ${r.txid}`);
    console.log(`(before: ${r.from.message})`);
  }
  discovery.close();
}

/** hermes id nft-status <npub>: read-only — where the identity NFT is and which version it pins. */
export async function nftStatusFor(discovery: Discovery, provider: Provider, input: string) {
  const r = await discovery.resolve(input);
  if (!r.identity) throw new Error(r.error ?? 'not found');
  const status = identityNftStatus(r.identity.chain, r.identity.current.payload?.idCategory ? await chainTokenUtxos(provider, r.identity) : []);
  return { identity: r.identity, status };
}

export async function idNftStatus(input?: string) {
  if (!input) throw new Error('usage: hermes id nft-status <npub|name@domain|cashaddr> [--network chipnet] [--relays ws://…]');
  const network = opt('network', 'chipnet') as BchNetwork;
  const discovery = discoveryFromArgs();
  const { identity, status } = await nftStatusFor(discovery, getProvider(network), input);
  console.log(`binding v${identity.current.seq} · ${identity.current.tokenAddr}`);
  console.log(`${status.state}: ${status.message}`);
  if (status.needsSync) console.log(`fix: pnpm --filter cli hermes id nft-sync --network ${network} --npub ${input}`);
  discovery.close();
}
