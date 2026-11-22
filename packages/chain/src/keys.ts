import {
  decodeBip39Mnemonic,
  decodePrivateKeyWif,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  deriveSeedFromBip39Mnemonic,
  encodeCashAddress,
  hash160,
  hexToBin,
  binToHex,
  secp256k1,
  validateSecp256k1PrivateKey,
} from '@bitauth/libauth';
import { SignatureTemplate } from 'cashscript';
import type { BchNetwork } from './config.js';

/** Accepts a WIF, a 64-hex private key, or a BIP39 mnemonic (m/44'/145'/0'/0/0). */
export function privateKeyFrom(input: string, path = "m/44'/145'/0'/0/0"): Uint8Array {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) {
    const key = hexToBin(s);
    // Zero or ≥ curve order is not a key; refusing it here avoids deriving an unspendable address.
    if (!validateSecp256k1PrivateKey(key)) throw new Error('invalid private key (out of secp256k1 range)');
    return key;
  }
  if (/^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(s)) {
    const d = decodePrivateKeyWif(s);
    if (typeof d === 'string') throw new Error(d);
    return d.privateKey;
  }
  if (s.split(/\s+/).length >= 12) {
    // Validate words and checksum: a mistyped mnemonic must fail, not silently derive another wallet.
    const mnemonic = s.split(/\s+/).join(' ');
    const entropy = decodeBip39Mnemonic(mnemonic);
    if (typeof entropy === 'string') throw new Error(`invalid BIP39 mnemonic: ${entropy}`);
    const seed = deriveSeedFromBip39Mnemonic(mnemonic);
    const node = deriveHdPrivateNodeFromSeed(seed as Uint8Array) as Exclude<ReturnType<typeof deriveHdPrivateNodeFromSeed>, string>;
    const child = deriveHdPath(node as never, path);
    if (typeof child === 'string') throw new Error(child);
    return (child as { privateKey: Uint8Array }).privateKey;
  }
  throw new Error('Unrecognised key format (expected WIF, 64-hex or BIP39 mnemonic)');
}

export interface KeyWallet {
  signer: SignatureTemplate;
  publicKey: Uint8Array;
  pkh: string;
  address: string;
  tokenAddress: string;
  lockingBytecode: string;
}

export function walletFromPrivateKey(privateKey: Uint8Array, network: BchNetwork | 'mock'): KeyWallet {
  const signer = new SignatureTemplate(privateKey);
  const derived = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof derived === 'string') throw new Error(derived);
  const publicKey = derived;
  const pkh = hash160(publicKey);
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  return {
    signer,
    publicKey,
    pkh: binToHex(pkh),
    address: encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload: pkh }).address,
    lockingBytecode: binToHex(Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac])),
  };
}
