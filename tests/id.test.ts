import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { binToHex, generatePrivateKey } from '@bitauth/libauth';
import {
  ChallengeVerifier,
  LocalBchSigner,
  LocalNostrSigner,
  bindingEventTemplate,
  buildPayload,
  canonicalJson,
  createBinding,
  identityCommitment,
  parseIdentityCommitment,
  parseRecipient,
  payloadMessage,
  pinnedSeqFromUtxos,
  resolveIdentity,
  respondToChallenge,
  rotateBinding,
  signBchMessage,
  verifyBinding,
  verifyChain,
  verifyTxProof,
  txProofOpReturn,
  type BindingContent,
} from '@hermes/id';

const keys = () => ({ bch: new LocalBchSigner(), nostr: new LocalNostrSigner() });

describe('canonical payload', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 0 }] } })).toBe('{"a":{"c":[2,{"y":0,"z":1}]},"b":1}');
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ x: Infinity })).toThrow();
  });
});

describe('binding needs both proofs', () => {
  it('a fresh binding verifies', async () => {
    const k = keys();
    const { event } = await createBinding({ ...k, network: 'mainnet' });
    const v = verifyBinding(event);
    expect(v.valid).toBe(true);
    expect(v.addr.startsWith('bitcoincash:q')).toBe(true);
    expect(v.tokenAddr.startsWith('bitcoincash:z')).toBe(true);
  });

  it('fails without a valid BCH signature (Nostr signature alone is not enough)', async () => {
    const k = keys();
    const payload = buildPayload({ nostr: await k.nostr.getPublicKey(), bch: binToHex(await k.bch.getPublicKey()), network: 'mainnet' });
    const other = new LocalBchSigner();
    const content: BindingContent = { payload, bchProof: await other.prove(payloadMessage(payload)) };
    const event = await k.nostr.signEvent(bindingEventTemplate(content));
    const v = verifyBinding(event);
    expect(v.valid).toBe(false);
    expect(v.reasons).toContain('bch signature invalid');
  });

  it('fails when the event is signed by a different Nostr key', async () => {
    const k = keys();
    const { content } = await createBinding({ ...k, network: 'chipnet' });
    const event = finalizeEvent(bindingEventTemplate(content), generateSecretKey());
    expect(verifyBinding(event).reasons).toContain('event author is not the bound nostr key');
  });

  it('tampered payload fails both proofs', async () => {
    const { event } = await createBinding({ ...keys(), network: 'chipnet' });
    const t = structuredClone(event);
    t.content = t.content.replace(/"ts":\d+/, '"ts":1');
    const r = verifyBinding(t).reasons;
    expect(r).toContain('nostr signature invalid');
    expect(r).toContain('bch signature invalid');
  });

  it('a mutated copy of an already-verified event is re-verified, not trusted from cache', async () => {
    const { event } = await createBinding({ ...keys(), network: 'chipnet' });
    expect(verifyBinding(event).valid).toBe(true); // nostr-tools marks the object as verified
    const copy = { ...event, content: event.content.replace(/"ts":\d+/, '"ts":2') };
    expect(verifyBinding(copy).reasons).toContain('nostr signature invalid');
  });

  it('tampered address fails', async () => {
    const { content } = await createBinding({ ...keys(), network: 'chipnet' });
    const sk = generateSecretKey();
    const nostr = getPublicKey(sk);
    const bch = new LocalBchSigner();
    const p = buildPayload({ nostr, bch: binToHex(await bch.getPublicKey()), network: 'chipnet' });
    p.addr = content.payload.addr; // someone else's address
    const c: BindingContent = { payload: p, bchProof: await bch.prove(payloadMessage(p)) };
    const ev = finalizeEvent(bindingEventTemplate(c), sk);
    expect(verifyBinding(ev).reasons).toContain('addr does not match bch key');
  });

  it('rejects reuse of one key for both identities', async () => {
    const priv = generatePrivateKey();
    const bch = new LocalBchSigner(priv);
    const nostr = new LocalNostrSigner(priv);
    const { event } = await createBinding({ bch, nostr, network: 'mainnet' });
    expect(verifyBinding(event).reasons).toContain('same key used for BCH and Nostr');
  });

  it('accepts a WizardConnect-style transaction-commitment proof only for the right message', async () => {
    // Build a tx-commit proof with libauth: spend a P2PKH coin of the key with OP_RETURN commitment.
    const { generateTransaction, importWalletTemplate, walletTemplateP2pkhNonHd, walletTemplateToCompilerBch, hash160, encodeTransaction, hexToBin, secp256k1 } = await import('@bitauth/libauth');
    const priv = generatePrivateKey();
    const pk = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
    const message = 'hello hermes';
    const template = importWalletTemplate(walletTemplateP2pkhNonHd);
    if (typeof template === 'string') throw new Error(template);
    const compiler = walletTemplateToCompilerBch(template);
    const lockingBytecode = compiler.generateBytecode({ data: { keys: { privateKeys: { key: priv } } }, scriptId: 'lock' });
    if (!lockingBytecode.success) throw new Error('lock');
    const result = generateTransaction({
      version: 2,
      locktime: 0,
      inputs: [{ outpointIndex: 0, outpointTransactionHash: new Uint8Array(32).fill(7), sequenceNumber: 0, unlockingBytecode: { compiler, data: { keys: { privateKeys: { key: priv } } }, script: 'unlock', valueSatoshis: 10_000n } }],
      outputs: [{ lockingBytecode: txProofOpReturn(message), valueSatoshis: 0n }, { lockingBytecode: lockingBytecode.bytecode, valueSatoshis: 9_000n }],
    });
    if (!result.success) throw new Error(JSON.stringify(result.errors));
    const proof = { type: 'tx-commit' as const, tx: binToHex(encodeTransaction(result.transaction)), sourceOutputs: [{ lockingBytecode: binToHex(lockingBytecode.bytecode), valueSatoshis: '10000' }] };
    expect(verifyTxProof(proof, binToHex(pk), message)).toEqual([]);
    expect(verifyTxProof(proof, binToHex(pk), 'another message').length).toBeGreaterThan(0);
    const otherPk = binToHex(secp256k1.derivePublicKeyCompressed(generatePrivateKey()) as Uint8Array);
    expect(verifyTxProof(proof, otherPk, message)).toContain('tx-proof: no input spends the bound key');
    void hash160;
    void hexToBin;
  });
});

describe('rotation and resolution', () => {
  it('rotating the BCH key needs the old BCH key; chain verifies to seq 0', async () => {
    const k = keys();
    const v0 = await createBinding({ ...k, network: 'chipnet' });
    const newBch = new LocalBchSigner();
    const v1 = await rotateBinding({ prevEvent: v0.event, currentBch: k.bch, currentNostr: k.nostr, newBch, network: 'chipnet' });
    expect(verifyChain(v1.event).ok).toBe(true);
    const resolved = resolveIdentity([v0.event, v1.event], { nostr: await k.nostr.getPublicKey() }, { now: v1.content.payload.ts + 10 });
    expect(resolved?.current.seq).toBe(1);
    expect(resolved?.current.bch).toBe(binToHex(await newBch.getPublicKey()));
    expect(resolved?.warnings.map((w) => w.code)).toContain('recent-change');
  });

  it('rotating the Nostr key needs the old Nostr key; old npub resolves to the successor', async () => {
    const k = keys();
    const v0 = await createBinding({ ...k, network: 'chipnet' });
    const newNostr = new LocalNostrSigner();
    const v1 = await rotateBinding({ prevEvent: v0.event, currentBch: k.bch, currentNostr: k.nostr, newNostr, network: 'chipnet' });
    expect(verifyChain(v1.event).ok).toBe(true);
    const r = resolveIdentity([v0.event, v1.event], { nostr: await k.nostr.getPublicKey() });
    expect(r?.current.nostr).toBe(await newNostr.getPublicKey());
    expect(r?.warnings.map((w) => w.code)).toContain('rotated');
  });

  it('a rotation without the old key’s approval is rejected and the stale binding never resolves past it', async () => {
    const k = keys();
    const v0 = await createBinding({ ...k, network: 'chipnet' });
    // Attacker who stole only the Nostr key tries to swap the BCH key without the old BCH key.
    const thief = new LocalBchSigner();
    const forged = await rotateBinding({ prevEvent: v0.event, currentBch: thief, currentNostr: k.nostr, newBch: new LocalBchSigner(), network: 'chipnet' });
    expect(verifyChain(forged.event).ok).toBe(false);
    const r = resolveIdentity([v0.event, forged.event], { nostr: await k.nostr.getPublicKey() });
    expect(r?.current.seq).toBe(0);
  });

  it('two different bindings at the same version are flagged as a fork and not payable', async () => {
    const k = keys();
    const v0 = await createBinding({ ...k, network: 'chipnet' });
    const a = await rotateBinding({ prevEvent: v0.event, currentBch: k.bch, currentNostr: k.nostr, newBch: new LocalBchSigner(), network: 'chipnet' });
    const b = await rotateBinding({ prevEvent: v0.event, currentBch: k.bch, currentNostr: k.nostr, newBch: new LocalBchSigner(), network: 'chipnet' });
    const r = resolveIdentity([a.event, b.event], { nostr: await k.nostr.getPublicKey() });
    expect(r?.payable).toBe(false);
    expect(r?.warnings.map((w) => w.code)).toContain('fork');
  });

  it('the identity NFT pins the current version; newer unpinned versions are ignored', async () => {
    const k = keys();
    const v0 = await createBinding({ ...k, network: 'chipnet' });
    const v1 = await rotateBinding({ prevEvent: v0.event, currentBch: k.bch, currentNostr: k.nostr, newBch: new LocalBchSigner(), network: 'chipnet' });
    const nostr = await k.nostr.getPublicKey();
    const commitment = identityCommitment(nostr, 0);
    expect(parseIdentityCommitment(commitment)?.seq).toBe(0);
    const pinned = pinnedSeqFromUtxos([{ token: { category: 'aa'.repeat(32), nft: { capability: 'mutable', commitment } } }], 'aa'.repeat(32), nostr);
    const r = resolveIdentity([v0.event, v1.event], { nostr }, { pinnedSeq: () => pinned });
    expect(r?.current.seq).toBe(0);
    expect(r?.warnings.map((w) => w.code)).toContain('nft-pinned');
  });
});

describe('challenge-response', () => {
  it('accepts a fresh response from the current keys once, rejects replay, stale and wrong keys', async () => {
    const k = keys();
    const { event } = await createBinding({ ...k, network: 'mainnet' });
    const current = verifyBinding(event);
    const verifier = new ChallengeVerifier('https://hermes.test');
    const t0 = 1_800_000_000;
    const ch = verifier.issue(t0);
    const resp = await respondToChallenge(ch, k.bch, k.nostr);
    expect(verifier.verify(resp, current, t0 + 5).ok).toBe(true);
    expect(verifier.verify(resp, current, t0 + 6).reasons).toContain('nonce already used');

    const late = verifier.issue(t0);
    const lateResp = await respondToChallenge(late, k.bch, k.nostr);
    expect(verifier.verify(lateResp, current, t0 + 121).reasons).toContain('challenge expired');

    const ch2 = verifier.issue(t0);
    const wrong = await respondToChallenge(ch2, new LocalBchSigner(), k.nostr);
    expect(verifier.verify(wrong, current, t0 + 1).reasons).toContain('bch key is not the current binding');

    const foreign = await respondToChallenge({ ...verifier.issue(t0), audience: 'https://evil.test' }, k.bch, k.nostr);
    expect(verifier.verify(foreign, current, t0 + 1).reasons).toContain('wrong audience');
  });
});

describe('recipient parsing', () => {
  it('understands npub, hex, NIP-05 and cashaddr', () => {
    const pk = getPublicKey(generateSecretKey());
    expect(parseRecipient(pk).kind).toBe('nostr');
    expect(parseRecipient('alice@example.com').kind).toBe('nip05');
    expect(parseRecipient('bitcoincash:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfnhks603').kind).toBe('bch');
    expect(parseRecipient('nonsense').kind).toBe('invalid');
  });
  it('BCH message signatures are BCH Schnorr over the prefixed hash', () => {
    const sig = signBchMessage(generatePrivateKey(), 'x');
    expect(sig.length).toBe(64);
  });
});
