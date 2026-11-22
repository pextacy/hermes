import { binToHex, hexToBin, numberToBinUint32LE, binToNumberUint32LE } from '@bitauth/libauth';
import { sha256Bytes } from './canonical.js';

/**
 * Identity NFT (optional): a CashTokens mutable NFT held at the binding's token address.
 * Commitment = SHA-256(nostr x-only pubkey) (32 bytes) || seq (uint32 LE) = 36 bytes.
 * When it exists, a binding whose seq differs from the commitment is stale.
 */
export function identityCommitment(nostrHex: string, seq: number): string {
  const h = sha256Bytes(hexToBin(nostrHex));
  return binToHex(Uint8Array.from([...h, ...numberToBinUint32LE(seq)]));
}

export function parseIdentityCommitment(commitmentHex: string): { nostrHash: string; seq: number } | undefined {
  const bin = hexToBin(commitmentHex);
  if (bin.length !== 36) return undefined;
  return { nostrHash: binToHex(bin.slice(0, 32)), seq: binToNumberUint32LE(bin.slice(32)) };
}

export interface TokenUtxoLike {
  token?: { category: string; nft?: { capability: string; commitment: string } } | null;
}

/**
 * Given the UTXOs at the binding's token address, return the seq pinned by the
 * identity NFT of `category` for this Nostr key — or undefined when there is no NFT.
 * Note: after a Nostr rotation the commitment hashes the *current* Nostr key.
 */
export function pinnedSeqFromUtxos(utxos: TokenUtxoLike[], category: string, nostrHex: string): number | undefined {
  const want = binToHex(sha256Bytes(hexToBin(nostrHex)));
  for (const u of utxos) {
    const t = u.token;
    if (!t?.nft || t.category !== category) continue;
    const parsed = parseIdentityCommitment(t.nft.commitment);
    if (parsed && parsed.nostrHash === want) return parsed.seq;
  }
  return undefined;
}

export interface NftStatus {
  /** none: binding names no NFT · synced: pins the current version at the current token address ·
   *  behind/ahead: pins another version · moved: still at an older key's token address ·
   *  old-nostr: commitment hashes a previous Nostr key · missing: not found at any of the identity's addresses. */
  state: 'none' | 'synced' | 'behind' | 'ahead' | 'moved' | 'old-nostr' | 'missing';
  category?: string;
  pinned?: number;
  current: number;
  at?: string;
  message: string;
  /** True when `hermes id nft-sync` fixes it. */
  needsSync: boolean;
}

/**
 * Where the identity NFT stands relative to the current binding. `utxos` are the UTXOs at
 * the token addresses of every version in the chain (the NFT stays at the old key's token
 * address after a BCH rotation until `nft-sync` moves it), each tagged with its address.
 */
export function identityNftStatus(
  chain: { nostr: string; seq: number; tokenAddr: string; payload?: { idCategory?: string } }[],
  utxos: (TokenUtxoLike & { address?: string })[],
): NftStatus {
  const cur = chain[chain.length - 1];
  const category = cur?.payload?.idCategory;
  const current = cur?.seq ?? 0;
  if (!cur || !category) return { state: 'none', current, message: 'No identity NFT: this binding is pinned by relays only.', needsSync: false };
  const hashes = new Map(chain.map((b) => [binToHex(sha256Bytes(hexToBin(b.nostr))), b.nostr]));
  const nfts = utxos.filter((u) => u.token?.category === category && u.token.nft);
  for (const u of nfts) {
    const p = parseIdentityCommitment(u.token!.nft!.commitment);
    if (!p) continue;
    const at = u.address;
    const nostr = hashes.get(p.nostrHash);
    if (!nostr) continue;
    if (nostr !== cur.nostr)
      return { state: 'old-nostr', category, pinned: p.seq, current, at, message: `NFT pins v${p.seq} for a previous Nostr key; run nft-sync to pin v${current}.`, needsSync: true };
    if (at && at !== cur.tokenAddr)
      return { state: 'moved', category, pinned: p.seq, current, at, message: `NFT pins v${p.seq} but still sits at an older key's address; run nft-sync to move it and pin v${current}.`, needsSync: true };
    if (p.seq === current) return { state: 'synced', category, pinned: p.seq, current, at, message: `NFT pins v${p.seq}, the current version.`, needsSync: false };
    if (p.seq < current)
      return { state: 'behind', category, pinned: p.seq, current, at, message: `NFT pins v${p.seq}; relays show v${current}. Payers follow the pin (v${p.seq}) until you run nft-sync.`, needsSync: true };
    return { state: 'ahead', category, pinned: p.seq, current, at, message: `NFT pins v${p.seq}, which relays do not have (they show v${current}). Republish that version.`, needsSync: false };
  }
  return { state: 'missing', category, current, message: `NFT ${category.slice(0, 10)}… not found at this identity's token addresses (unconfirmed, spent, or Electrum lagging).`, needsSync: false };
}
