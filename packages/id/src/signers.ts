import { binToHex, generatePrivateKey, hexToBin } from '@bitauth/libauth';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools/pure';
import { publicKeyFromPrivate, signBchMessage } from './bch.js';
import type { BchProof } from './binding.js';

/** Anything that can prove control of a BCH key over a message. */
export interface BchSigner {
  getPublicKey(): Promise<Uint8Array>;
  prove(message: string): Promise<BchProof>;
}

/** Anything that can sign Nostr events (local key, NIP-07 extension, NIP-46 bunker). */
export interface NostrSigner {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
}

/** BCH key held in memory (entered by the owner at runtime or generated in the browser). */
export class LocalBchSigner implements BchSigner {
  readonly privateKey: Uint8Array;
  constructor(privateKey?: Uint8Array) {
    this.privateKey = privateKey ?? generatePrivateKey();
  }
  static fromHex(hex: string) {
    return new LocalBchSigner(hexToBin(hex));
  }
  async getPublicKey() {
    return publicKeyFromPrivate(this.privateKey);
  }
  async prove(message: string): Promise<BchProof> {
    return { type: 'schnorr-msg', sig: binToHex(signBchMessage(this.privateKey, message)) };
  }
}

export class LocalNostrSigner implements NostrSigner {
  readonly secretKey: Uint8Array;
  constructor(secretKey?: Uint8Array) {
    this.secretKey = secretKey ?? generateSecretKey();
  }
  async getPublicKey() {
    return getPublicKey(this.secretKey);
  }
  async signEvent(template: EventTemplate) {
    return finalizeEvent(template, this.secretKey);
  }
}

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
}

/** NIP-07 browser extension (Alby, nos2x, …). */
export class Nip07Signer implements NostrSigner {
  private get ext(): Nip07 {
    const ext = (globalThis as unknown as { nostr?: Nip07 }).nostr;
    if (!ext) throw new Error('No NIP-07 extension found (window.nostr)');
    return ext;
  }
  static available() {
    return !!(globalThis as unknown as { nostr?: Nip07 }).nostr;
  }
  getPublicKey() {
    return this.ext.getPublicKey();
  }
  signEvent(template: EventTemplate) {
    return this.ext.signEvent(template);
  }
}
