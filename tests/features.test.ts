import { describe, expect, it } from 'vitest';
import { MockNetworkProvider, SignatureTemplate, randomUtxo, type Utxo } from 'cashscript';
import { binToHex, generatePrivateKey } from '@bitauth/libauth';
import { decrypt as nip04Decrypt } from 'nostr-tools/nip04';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { LocalBchSigner, LocalNostrSigner, bindingReport, createBinding, nip39Claims, nip39ProfileTemplate, parseIdentityCommitment, rotateBinding, verifyBinding } from '@hermes/id';
import { buildMintIdentityNft, buildRotateIdentityNft, findIdentityNft, parsePayLink, payLinkUrl, paymentNoteTemplate, prepareIdentityGenesis } from '@hermes/pay';
import { stablecoins, walletFromPrivateKey } from '@hermes/chain';
import { rankQuotes, type Quote } from '@hermes/swap';
import { addressFromFahName, buildCancel, distroFromFahSnapshots, dropsContracts, encodePending, parseFahSummary } from '@hermes/drops';

type S = Utxo & { lockingBytecode: string };

describe('identity NFT transactions (F2)', () => {
  it('mints a mutable NFT pinning a version and rotates it to the next version / new key', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true });
    const w = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    provider.addUtxo(w.address, randomUtxo({ satoshis: 100_000n }));
    const nostr = getPublicKey(generateSecretKey());
    const { category, outpoint } = await prepareIdentityGenesis({ provider, address: w.address, utxos: (await provider.getUtxos(w.address)) as S[], signer: w.signer });
    await buildMintIdentityNft({ provider, outpoint, category, tokenAddress: w.tokenAddress, address: w.address, signer: w.signer, nostr, seq: 1 }).send();
    const nft = findIdentityNft((await provider.getUtxos(w.tokenAddress)) as S[], category)!;
    expect(parseIdentityCommitment(nft.token!.nft!.commitment)?.seq).toBe(1);
    const next = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    await buildRotateIdentityNft({ provider, nft, funding: (await provider.getUtxos(w.address)) as S[], signer: w.signer, nextTokenAddress: next.tokenAddress, changeAddress: w.address, nostr, seq: 2 }).send();
    const moved = findIdentityNft((await provider.getUtxos(next.tokenAddress)) as S[], category)!;
    expect(parseIdentityCommitment(moved.token!.nft!.commitment)?.seq).toBe(2);
    expect(() => buildRotateIdentityNft({ provider, nft: moved, funding: [], signer: next.signer, nextTokenAddress: next.tokenAddress, changeAddress: next.address, nostr, seq: 2 })).toThrow(/already pins/);
  });
});

describe('identity extras (F4, F5)', () => {
  it('NIP-39 profile tag keeps existing content and replaces older bitcoincash claims', async () => {
    const { event } = await createBinding({ bch: new LocalBchSigner(), nostr: new LocalNostrSigner(), network: 'mainnet' });
    const b = verifyBinding(event);
    const old = { kind: 0, created_at: 100, tags: [['i', 'github:alice', 'gist'], ['i', 'bitcoincash:qold']], content: '{"name":"alice"}', pubkey: b.nostr, id: 'x', sig: 'y' };
    const t = nip39ProfileTemplate(old as never, b);
    expect(t.content).toBe('{"name":"alice"}');
    expect(t.tags).toContainEqual(['i', 'github:alice', 'gist']);
    expect(nip39Claims({ ...old, tags: t.tags } as never)).toEqual([{ addr: b.addr, proof: event.id }]);
    expect(t.tags.find((x) => x[0] === 'i' && x[1].startsWith('bitcoincash:'))![1]).toBe(b.addr); // not bitcoincash:bitcoincash:
  });

  it('verification report lists every check and the rotation step', async () => {
    const bch = new LocalBchSigner();
    const nostr = new LocalNostrSigner();
    const v0 = await createBinding({ bch, nostr, network: 'chipnet' });
    const v1 = await rotateBinding({ prevEvent: v0.event, currentBch: bch, currentNostr: nostr, newBch: new LocalBchSigner(), network: 'chipnet' });
    const rep = bindingReport(v1.event);
    expect(rep.ok).toBe(true);
    expect(rep.versions).toBe(2);
    expect(rep.steps.some((s) => s.label.includes('rotation from v0'))).toBe(true);
    const bad = bindingReport({ ...v1.event, content: v1.event.content.replace('"seq":1', '"seq":1 ') });
    expect(bad.ok).toBe(false);
  });
});

describe('pay extras (F8, F11)', () => {
  it('pay links round-trip and sanitise input', () => {
    const url = payLinkUrl('https://hermes.example/', { to: 'npub1abc', amount: '0.5', asset: 'PUSD', memo: 'invoice 7' });
    expect(url).toBe('https://hermes.example/#pay?to=npub1abc&amount=0.5&asset=PUSD&memo=invoice+7');
    expect(parsePayLink(url.slice(url.indexOf('#')))).toEqual({ to: 'npub1abc', amount: '0.5', asset: 'PUSD', memo: 'invoice 7' });
    expect(parsePayLink('#pay?to=x&amount=1e9&asset=DOGE&memo=%3Cscript%3E\u0007')).toEqual({ to: 'x', amount: undefined, asset: undefined, memo: '<script>' });
    expect(parsePayLink('#pay')).toBeUndefined();
  });

  it('payment note is NIP-04 encrypted to the recipient only', async () => {
    const sender = generateSecretKey();
    const recipient = generateSecretKey();
    const tpl = await paymentNoteTemplate({ senderSecret: sender, recipientPubkey: getPublicKey(recipient), amount: '0.001', asset: 'BCH', txid: 'ab'.repeat(32), memo: 'rent' });
    expect(tpl.kind).toBe(4);
    expect(tpl.content).not.toContain('rent');
    const plain = await nip04Decrypt(recipient, getPublicKey(sender), tpl.content);
    expect(plain).toContain('0.001 BCH');
    expect(plain).toContain('rent');
  });
});

describe('swap extras (F14, F17)', () => {
  it('ranks quotes by amount out, then by the taker’s timeout', () => {
    const q = (id: string, out: string, tFirst: number) => ({ quoteId: id, amountOut: out, tFirst }) as Quote;
    expect(rankQuotes([q('a', '100', 5), q('b', '120', 1), q('c', '120', 9)]).map((x) => x.quoteId)).toEqual(['c', 'b', 'a']);
  });
  it('lists configured BCH stablecoins with a category (PUSD on mainnet; MoriaUSD slot until verified)', () => {
    const m = stablecoins('mainnet');
    expect(m.map((t) => t.key)).toContain('PUSD');
    expect(m.every((t) => t.stable && t.category)).toBe(true);
  });
});

describe('drops extras (F26, F27)', () => {
  it('the authority can cancel a pending root; nobody else can', async () => {
    const provider = new MockNetworkProvider({ updateUtxoSet: true, vmTarget: 'BCH_2026_05' });
    const authority = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    const cfg = { receiptCategory: binToHex(generatePrivateKey()), pendingCategory: binToHex(generatePrivateKey()), rewardCategory: binToHex(generatePrivateKey()), authorityPkh: authority.pkh, rootTimelock: 144 };
    const c = dropsContracts(cfg, provider);
    provider.addUtxo(c.pending.tokenAddress, randomUtxo({ satoshis: 1000n, token: { category: cfg.pendingCategory, amount: 0n, nft: { capability: 'none', commitment: encodePending(0, 2, 'cd'.repeat(32)) } } }));
    provider.addUtxo(authority.address, randomUtxo({ satoshis: 20_000n }));
    const pendingUtxo = (await provider.getUtxos(c.pending.tokenAddress))[0] as S;
    const thief = walletFromPrivateKey(generatePrivateKey(), 'chipnet');
    provider.addUtxo(thief.address, randomUtxo({ satoshis: 20_000n }));
    expect(() => buildCancel({ provider, contracts: c, authority: new SignatureTemplate(thief.signer.privateKey), authorityAddress: thief.address, pendingUtxo, funding: [] }).debug()).toThrow();
    await buildCancel({ provider, contracts: c, authority: authority.signer, authorityAddress: authority.address, pendingUtxo, funding: (await provider.getUtxos(authority.address)) as S[] }).send();
    expect(await provider.getUtxos(c.pending.tokenAddress)).toHaveLength(0);
  });

  it('parses Folding@home summaries and distributes credit gained by BCH-address users', () => {
    const header = 'Fri Nov 20 2026\nname\tnewcredit\tsum(total)\tteam\n';
    const start = parseFahSummary(header + 'alice_bitcoincash:qzf8t0e95mfc3e5pa4nwxpufjyxg53ezcsawjkd2c4\t1000\t10\t1\nbob_1BoatSLRHtKNngkdXEeobR76b53LETtpyT\t500\t5\t1\nnoaddr\t99\t1\t1\n');
    const end = parseFahSummary(header + 'alice_bitcoincash:qzf8t0e95mfc3e5pa4nwxpufjyxg53ezcsawjkd2c4\t4000\t20\t1\nbob_1BoatSLRHtKNngkdXEeobR76b53LETtpyT\t1500\t9\t1\nnoaddr\t500\t3\t1\ncarol_qzf8t0e95mfc3e5pa4nwxpufjyxg53ezcsawjkd2c4\t0\t0\t2\n');
    expect(addressFromFahName('x_qzf8t0e95mfc3e5pa4nwxpufjyxg53ezcsawjkd2c4')?.bitcoinCashAddress).toMatch(/^bitcoincash:q/);
    const d = distroFromFahSnapshots(start, end, 1000);
    expect(d).toHaveLength(2);
    expect(Math.round(d.find((x) => x.bitcoinCashAddress)!.amount)).toBe(750);
    expect(Math.round(d.find((x) => x.bitcoinAddress)!.amount)).toBe(250);
    expect(distroFromFahSnapshots(start, end, 1000, 2)).toHaveLength(0);
  });
});
