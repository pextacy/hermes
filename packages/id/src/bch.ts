import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeCashAddress,
  hash160,
  hexToBin,
  lockingBytecodeToCashAddress,
  secp256k1,
  utf8ToBin,
} from '@bitauth/libauth';
import { sha256Bytes } from './canonical.js';
import { BCH_MESSAGE_PREFIX } from './constants.js';

export type BchNetwork = 'mainnet' | 'chipnet' | 'testnet4';

export const cashAddrPrefix = (network: BchNetwork) => (network === 'mainnet' ? 'bitcoincash' : 'bchtest');

export function networkOfAddress(address: string): BchNetwork | undefined {
  if (address.startsWith('bitcoincash:')) return 'mainnet';
  if (address.startsWith('bchtest:')) return 'chipnet';
  return undefined;
}

export function isCompressedPublicKeyHex(hex: string): boolean {
  return /^(02|03)[0-9a-f]{64}$/.test(hex);
}

/** P2PKH cashaddr (plain and token-aware) for a compressed public key. */
export function addressesForPublicKey(publicKey: Uint8Array | string, network: BchNetwork) {
  const pk = typeof publicKey === 'string' ? hexToBin(publicKey) : publicKey;
  const payload = hash160(pk);
  const prefix = cashAddrPrefix(network);
  const addr = encodeCashAddress({ prefix, type: 'p2pkh', payload }).address;
  const tokenAddr = encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload }).address;
  return { addr, tokenAddr, pkh: binToHex(payload) };
}

export function lockingBytecodeForAddress(address: string): Uint8Array {
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === 'string') throw new Error(`invalid cashaddr: ${result}`);
  return result.bytecode;
}

export function addressForLockingBytecode(bytecode: Uint8Array, network: BchNetwork, tokenSupport = false): string {
  const result = lockingBytecodeToCashAddress({ bytecode, prefix: cashAddrPrefix(network), tokenSupport });
  if (typeof result === 'string') throw new Error(result);
  return result.address;
}

export function bchMessageHash(message: string): Uint8Array {
  return sha256Bytes(utf8ToBin(BCH_MESSAGE_PREFIX + message));
}

export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  const pk = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof pk === 'string') throw new Error(pk);
  return pk;
}

/** BCH Schnorr signature (64 bytes) over the Hermes message hash. */
export function signBchMessage(privateKey: Uint8Array, message: string): Uint8Array {
  const sig = secp256k1.signMessageHashSchnorr(privateKey, bchMessageHash(message));
  if (typeof sig === 'string') throw new Error(sig);
  return sig;
}

export function verifyBchMessage(publicKeyHex: string, message: string, signatureHex: string): boolean {
  try {
    const sig = hexToBin(signatureHex);
    if (sig.length !== 64) return false;
    return secp256k1.verifySignatureSchnorr(sig, hexToBin(publicKeyHex), bchMessageHash(message));
  } catch {
    return false;
  }
}
