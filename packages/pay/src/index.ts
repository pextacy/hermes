import {
  Discovery,
  npubOf,
  pinnedSeqFromUtxos,
  type IdentityWarning,
  type ResolvedIdentity,
  type VerifiedBinding,
} from '@hermes/id';
import {
  buildPayment,
  explorerTxUrl,
  withFailover,
  type BchNetwork,
  type PaymentAsset,
  type SignatureTemplate,
  type SpendableUtxo,
  type WcTransactionObject,
} from '@hermes/chain';

export interface NostrProfile {
  name?: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
}

export interface VerificationCard {
  npub: string;
  nostr: string;
  profile?: NostrProfile;
  addr: string;
  tokenAddr: string;
  network?: BchNetwork;
  version: number;
  firstSeen: number;
  updated: number;
  proofs: { bch: boolean; nostr: boolean; chain: boolean };
  warnings: IdentityWarning[];
  payable: boolean;
  rotations: number;
}

export interface ResolvedRecipient {
  identity: ResolvedIdentity;
  card: VerificationCard;
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, max) : undefined);

/** Kind-0 profile for display only. Profile text is data: we only read a few short fields. */
export async function fetchProfile(discovery: Discovery, pubkey: string): Promise<NostrProfile | undefined> {
  const { events } = await discovery.query({ kinds: [0], authors: [pubkey], limit: 3 });
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return undefined;
  try {
    const j = JSON.parse(latest.content);
    const picture = clean(j.picture, 512);
    return {
      name: clean(j.name, 64),
      displayName: clean(j.display_name ?? j.displayName, 64),
      picture: picture && /^https:\/\//.test(picture) ? picture : undefined,
      nip05: clean(j.nip05, 128),
    };
  } catch {
    return undefined;
  }
}

export function cardFor(identity: ResolvedIdentity, profile?: NostrProfile): VerificationCard {
  const c: VerifiedBinding = identity.current;
  return {
    npub: npubOf(c.nostr),
    nostr: c.nostr,
    profile,
    addr: c.addr,
    tokenAddr: c.tokenAddr,
    network: c.network,
    version: c.seq,
    firstSeen: identity.firstSeen,
    updated: c.ts,
    // verifyChain only admits bindings whose both proofs and rotation chain verify.
    proofs: { bch: c.valid, nostr: c.valid, chain: true },
    warnings: identity.warnings,
    payable: identity.payable,
    rotations: identity.chain.length - 1,
  };
}

/**
 * npub / hex / NIP-05 / cashaddr → current verified binding → destination.
 * If the binding names an identity NFT category, the NFT at the token address pins
 * the current version (stale relay copies never resolve).
 */
export async function resolveRecipient(
  discovery: Discovery,
  input: string,
  opts: { network: BchNetwork; withProfile?: boolean; nftUtxos?: (tokenAddr: string) => Promise<SpendableUtxo[]> },
): Promise<ResolvedRecipient> {
  let nftPin: number | undefined;
  const first = await discovery.resolve(input);
  if (!first.identity) throw new Error(first.error ?? 'not found');
  let identity = first.identity;
  const cat = identity.current.payload?.idCategory;
  if (cat) {
    const lookup =
      opts.nftUtxos ??
      ((addr: string) => withFailover(opts.network, (p) => p.getUtxos(addr)) as Promise<SpendableUtxo[]>);
    const utxos = await lookup(identity.current.tokenAddr).catch(() => []);
    nftPin = pinnedSeqFromUtxos(
      utxos.map((u) => ({ token: u.token ? { category: u.token.category, nft: u.token.nft } : null })),
      cat,
      identity.current.nostr,
    );
    if (nftPin !== undefined) {
      const again = await discovery.resolve(input, { pinnedSeq: () => nftPin });
      if (again.identity) identity = again.identity;
    }
  }
  if (identity.current.network && identity.current.network !== opts.network) {
    throw new Error(`This identity is bound to a ${identity.current.network} address, not ${opts.network}.`);
  }
  const profile = opts.withProfile === false ? undefined : await fetchProfile(discovery, identity.current.nostr).catch(() => undefined);
  return { identity, card: cardFor(identity, profile) };
}

export interface PayArgs {
  recipient: ResolvedRecipient;
  network: BchNetwork;
  from: string;
  fromTokenAddr?: string;
  utxos: SpendableUtxo[];
  asset: PaymentAsset;
  memo?: string;
  signer?: SignatureTemplate;
  /** Required when the card has warnings that make it non-payable (fork / NFT mismatch). */
  overrideWarnings?: boolean;
}

function destination(args: PayArgs) {
  const { card } = args.recipient;
  if (!card.payable && !args.overrideWarnings) throw new Error('Identity has unresolved warnings; refusing to pay.');
  return args.asset.kind === 'token' ? card.tokenAddr : card.addr;
}

/** Unsigned payment for a wallet (WizardConnect) to sign. */
export async function preparePayment(args: PayArgs, provider: Parameters<typeof buildPayment>[0]['provider']): Promise<WcTransactionObject> {
  const to = destination(args);
  return buildPayment({ ...args, provider, to, signer: undefined }).generateWcTransactionObject({
    broadcast: false,
    userPrompt: `Hermes Pay → ${args.recipient.card.profile?.name ?? args.recipient.card.npub.slice(0, 16)}`,
  });
}

/** Payment signed by a local key and broadcast. */
export async function payLocal(args: PayArgs & { signer: SignatureTemplate }, provider: Parameters<typeof buildPayment>[0]['provider']) {
  const to = destination(args);
  const tx = await buildPayment({ ...args, provider, to }).send();
  return { txid: tx.txid, explorer: explorerTxUrl(args.network, tx.txid) };
}

export const paymentMemo = (reference?: string) => (reference ? reference.replace(/[^\x20-\x7e]/g, '').slice(0, 64) : undefined);
export * from './identity-nft.js';
export * from './links.js';
export * from './extras.js';
export * from './round3.js';
