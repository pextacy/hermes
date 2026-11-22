import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeCashAddress, hash160, secp256k1 } from '@bitauth/libauth';
import { Contract, SignatureTemplate, TransactionBuilder, randomToken, randomUtxo } from '@solidcash/solidcash';
import { MockNetworkProvider } from '@solidcash/solidcash/network/mock';
import '@solidcash/solidcash/vitest';
import artifact from '../artifacts/solidcash/HermesHtlc.json' with { type: 'json' };

function party() {
  const priv = randomBytes(32);
  const pk = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const pkh = hash160(pk);
  return {
    signer: new SignatureTemplate(priv),
    pk,
    pkh,
    address: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address,
    tokenAddress: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address,
  };
}

const TIMEOUT = 500_000_100; // a past unix timestamp the mock network accepts
const setup = (opts: { secret?: Buffer; token?: boolean } = {}) => {
  const provider = new MockNetworkProvider();
  const locker = party();
  const recipient = party();
  const secret = opts.secret ?? randomBytes(32);
  const hashlock = createHash('sha256').update(secret).digest();
  const contract = new Contract(artifact as any, [recipient.pkh, locker.pkh, hashlock, BigInt(TIMEOUT)], { provider });
  const utxo = randomUtxo({ satoshis: 10_000n, ...(opts.token ? { token: randomToken({ amount: 1234n }) } : {}) });
  provider.addUtxo(contract.address, utxo);
  return { provider, locker, recipient, secret, contract, utxo };
};

describe('Hermes HTLC (SolidCash)', () => {
  it('claim: recipient with the right 32-byte secret, paid to the recipient', () => {
    const t = setup();
    const tx = new TransactionBuilder({ provider: t.provider })
      .addInput(t.utxo, t.contract.unlock.claim(t.recipient.pk, t.recipient.signer, t.secret))
      .addOutput({ to: t.recipient.address, amount: 8_500n });
    expect(tx).not.toFailRequire();
  });

  it('claim keeps CashTokens (PUSD) on the payout', () => {
    const t = setup({ token: true });
    const ok = new TransactionBuilder({ provider: t.provider })
      .addInput(t.utxo, t.contract.unlock.claim(t.recipient.pk, t.recipient.signer, t.secret))
      .addOutput({ to: t.recipient.tokenAddress, amount: 8_500n, token: t.utxo.token });
    expect(ok).not.toFailRequire();
  });

  it('claim fails with a wrong secret', () => {
    const t = setup();
    const tx = new TransactionBuilder({ provider: t.provider })
      .addInput(t.utxo, t.contract.unlock.claim(t.recipient.pk, t.recipient.signer, randomBytes(32)))
      .addOutput({ to: t.recipient.address, amount: 8_500n });
    expect(tx).toFailRequire();
  });

  it('claim fails with a secret of the wrong length even if its hash matches', () => {
    const long = randomBytes(33);
    const t = setup({ secret: long });
    const tx = new TransactionBuilder({ provider: t.provider })
      .addInput(t.utxo, t.contract.unlock.claim(t.recipient.pk, t.recipient.signer, long))
      .addOutput({ to: t.recipient.address, amount: 8_500n });
    expect(() => tx.debug()).toThrow();
  });

  it('claim fails when signed by someone else', () => {
    const t = setup();
    const tx = new TransactionBuilder({ provider: t.provider })
      .addInput(t.utxo, t.contract.unlock.claim(t.locker.pk, t.locker.signer, t.secret))
      .addOutput({ to: t.locker.address, amount: 8_500n });
    expect(tx).toFailRequireWith('not the recipient');
  });

  it('claim fails when the payout is redirected or over-charged', () => {
    const t = setup();
    const redirected = new TransactionBuilder({ provider: t.provider })
      .addInput(t.utxo, t.contract.unlock.claim(t.recipient.pk, t.recipient.signer, t.secret))
      .addOutput({ to: t.locker.address, amount: 8_500n });
    expect(redirected).toFailRequireWith('payout must go to the recipient');
    const greedyFee = new TransactionBuilder({ provider: t.provider })
      .addInput(t.utxo, t.contract.unlock.claim(t.recipient.pk, t.recipient.signer, t.secret))
      .addOutput({ to: t.recipient.address, amount: 5_000n });
    expect(greedyFee).toFailRequireWith('payout must go to the recipient');
  });

  it('refund: locker after the timeout', () => {
    const t = setup();
    const tx = new TransactionBuilder({ provider: t.provider })
      .setLocktime(TIMEOUT)
      .addInput(t.utxo, t.contract.unlock.refund(t.locker.pk, t.locker.signer), { sequence: 0xfffffffe })
      .addOutput({ to: t.locker.address, amount: 8_500n });
    expect(tx).not.toFailRequire();
  });

  it('refund fails before the timeout', () => {
    const t = setup();
    const tx = new TransactionBuilder({ provider: t.provider })
      .setLocktime(TIMEOUT - 1)
      .addInput(t.utxo, t.contract.unlock.refund(t.locker.pk, t.locker.signer), { sequence: 0xfffffffe })
      .addOutput({ to: t.locker.address, amount: 8_500n });
    expect(tx).toFailRequireWith('timeout not reached');
  });

  it('refund fails for anyone but the locker', () => {
    const t = setup();
    const tx = new TransactionBuilder({ provider: t.provider })
      .setLocktime(TIMEOUT)
      .addInput(t.utxo, t.contract.unlock.refund(t.recipient.pk, t.recipient.signer), { sequence: 0xfffffffe })
      .addOutput({ to: t.recipient.address, amount: 8_500n });
    expect(tx).toFailRequireWith('not the refunder');
  });
});
