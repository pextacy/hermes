import { binToHex, decodePrivateKeyWif, encodePrivateKeyWif, generatePrivateKey, hexToBin, validateSecp256k1PrivateKey } from '@bitauth/libauth';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import { LocalBchSigner, LocalNostrSigner, Nip07Signer, type NostrSigner } from '@hermes/id';
import { walletFromPrivateKey, type BchNetwork, type KeyWallet } from '@hermes/chain';
import { load, save, remove } from './storage';

/**
 * Browser-local keys. These are *burner* keys for the demo (identity key, testnet taker,
 * claims); they live in this browser only. Real funds should come through WizardConnect.
 */
const bchKeyName = (network: BchNetwork) => `hermes.bchkey.${network}`;

const isKeyHex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) && validateSecp256k1PrivateKey(hexToBin(v));

/** The stored key, or undefined when absent or corrupted (never a wrong-length / invalid key). */
export function getLocalBchKey(network: BchNetwork): Uint8Array | undefined {
  const hex = load<unknown>(bchKeyName(network), null);
  return isKeyHex(hex) ? hexToBin(hex) : undefined;
}

export function ensureLocalBchKey(network: BchNetwork): Uint8Array {
  const k = getLocalBchKey(network);
  if (k) return k;
  // Keep whatever unreadable value was there instead of silently overwriting it.
  const raw = load<unknown>(bchKeyName(network), null);
  if (raw !== null) save(`${bchKeyName(network)}.corrupt`, raw);
  const fresh = generatePrivateKey();
  save(bchKeyName(network), binToHex(fresh));
  return fresh;
}

export function setLocalBchKey(network: BchNetwork, key: Uint8Array) {
  if (key.length !== 32 || !validateSecp256k1PrivateKey(key)) throw new Error('Invalid BCH private key');
  // Never silently drop a key that may still hold coins or the identity NFT: keep it aside.
  const old = getLocalBchKey(network);
  if (old && binToHex(old) !== binToHex(key)) archivePrevious(`${bchKeyName(network)}.previous`, binToHex(old));
  save(bchKeyName(network), binToHex(key));
}

export interface PreviousKey {
  key: string;
  ts: number;
}
const MAX_PREVIOUS = 20;
function archivePrevious(name: string, key: string) {
  const list = load<unknown>(name, []);
  const prev = (Array.isArray(list) ? list : []).filter((x): x is PreviousKey => !!x && typeof x.key === 'string' && x.key !== key);
  save(name, [{ key, ts: Math.floor(Date.now() / 1000) }, ...prev].slice(0, MAX_PREVIOUS));
}
function loadPrevious(name: string): PreviousKey[] {
  const list = load<unknown>(name, []);
  return (Array.isArray(list) ? list : []).filter((x): x is PreviousKey => !!x && typeof x.key === 'string' && typeof x.ts === 'number');
}

/** Browser BCH keys replaced by a rotation or an import (newest first), with WIF + address to sweep them. */
export function previousBchKeys(network: BchNetwork): { wif: string; address: string; tokenAddress: string; ts: number }[] {
  return loadPrevious(`${bchKeyName(network)}.previous`)
    .filter((p) => isKeyHex(p.key))
    .map((p) => {
      const k = hexToBin(p.key);
      const w = walletFromPrivateKey(k, network);
      return { wif: encodePrivateKeyWif(k, wifNet(network)), address: w.address, tokenAddress: w.tokenAddress, ts: p.ts };
    });
}

/** Nostr keys replaced by a rotation or an import (newest first). */
export function previousNsecs(): { nsec: string; npub: string; ts: number }[] {
  return loadPrevious('hermes.nsec.previous')
    .filter((p) => isNsec(p.key))
    .map((p) => ({ nsec: p.key, npub: nip19.npubEncode(getPublicKey(nip19.decode(p.key).data as Uint8Array)), ts: p.ts }));
}

/** Plain-text backup of this browser's identity keys (downloaded by the user, never uploaded). */
export function backupText(network: BchNetwork, binding?: { npub?: string; addr?: string; seq?: number }): string {
  const nsec = getLocalNsec();
  const lines = [
    'Hermes ID key backup — keep this file offline. Anyone with it controls your identity and coins.',
    `created: ${new Date().toISOString()}`,
    `network: ${network}`,
    binding?.npub ? `identity npub: ${binding.npub}` : '',
    binding?.addr ? `bound BCH address: ${binding.addr} (binding v${binding.seq ?? '?'})` : '',
    '',
    `BCH key (WIF, ${network}): ${exportBchWif(network)}`,
    `BCH address: ${localWallet(network).address}`,
    nsec ? `Nostr key (nsec): ${nsec}` : 'Nostr key: held by your browser extension (NIP-07), not in this file',
  ];
  const prevB = previousBchKeys(network);
  const prevN = previousNsecs();
  if (prevB.length || prevN.length) lines.push('', 'Previous keys (rotated or replaced — sweep any coins left on them):');
  for (const p of prevB) lines.push(`  BCH ${p.address}  WIF ${p.wif}`);
  for (const p of prevN) lines.push(`  Nostr ${p.npub}  ${p.nsec}`);
  lines.push(
    '',
    'Lost one key? Restore the other from this file and rotate the lost one in the Identity tab.',
    'Lost both? The identity cannot be recovered: create a new one and tell your contacts.',
  );
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n') + '\n';
}

const wifNet = (network: BchNetwork) => (network === 'mainnet' ? 'mainnet' : 'testnet');

/** WIF backup of the browser key (compressed; mainnet prefix on mainnet, testnet prefix on chipnet). */
export function exportBchWif(network: BchNetwork): string {
  return encodePrivateKeyWif(ensureLocalBchKey(network), wifNet(network));
}

/**
 * Replace the browser key with an imported WIF. Rejects malformed WIFs, uncompressed keys
 * (they derive a different address than the compressed one Hermes uses) and a WIF made for
 * the other network (almost always the wrong backup).
 */
export function importBchWif(network: BchNetwork, wif: string): Uint8Array {
  const key = decodeBchWif(network, wif);
  setLocalBchKey(network, key);
  return key;
}

/** Validate a WIF for `network` without storing it (same rules as `importBchWif`). */
export function decodeBchWif(network: BchNetwork, wif: string): Uint8Array {
  const d = decodePrivateKeyWif(wif.trim());
  if (typeof d === 'string') throw new Error(`Invalid WIF: ${d}`);
  if (d.type.endsWith('Uncompressed')) throw new Error('Uncompressed WIF keys are not supported');
  if (d.type !== wifNet(network)) throw new Error(`This is a ${d.type} WIF; switch the BCH key network to ${d.type === 'mainnet' ? 'Mainnet' : 'Chipnet'} to import it`);
  return d.privateKey;
}

export function forgetLocalBchKey(network: BchNetwork) {
  remove(bchKeyName(network));
}

export function localWallet(network: BchNetwork): KeyWallet {
  return walletFromPrivateKey(ensureLocalBchKey(network), network);
}

export function localBchSigner(network: BchNetwork) {
  return new LocalBchSigner(ensureLocalBchKey(network));
}

const isNsec = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    return nip19.decode(v).type === 'nsec';
  } catch {
    return false;
  }
};

/** The stored nsec, or undefined when absent or corrupted. */
export function getLocalNsec(): string | undefined {
  const v = load<unknown>('hermes.nsec', null);
  return isNsec(v) ? v : undefined;
}

export function ensureLocalNostr(): LocalNostrSigner {
  let nsec = getLocalNsec();
  if (!nsec) {
    const raw = load<unknown>('hermes.nsec', null);
    if (raw !== null) save('hermes.nsec.corrupt', raw);
    nsec = nip19.nsecEncode(generateSecretKey());
    save('hermes.nsec', nsec);
  }
  return new LocalNostrSigner(nip19.decode(nsec).data as Uint8Array);
}

export function setLocalNsec(nsec: string) {
  let d: ReturnType<typeof nip19.decode>;
  try {
    d = nip19.decode(nsec.trim());
  } catch {
    throw new Error('not an nsec');
  }
  if (d.type !== 'nsec') throw new Error('not an nsec');
  const old = getLocalNsec();
  if (old && old !== nsec.trim()) archivePrevious('hermes.nsec.previous', old);
  save('hermes.nsec', nsec.trim());
}

export type NostrMode = 'nip07' | 'local';
export function nostrSigner(mode: NostrMode): NostrSigner {
  return mode === 'nip07' ? new Nip07Signer() : ensureLocalNostr();
}
