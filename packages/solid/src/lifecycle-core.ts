/**
 * Hermes Solid lifecycle core (browser- and Node-safe): lock → claim and lock → refund for the
 * SolidCash HTLC. Each step reports the transaction and the contract state so the web app can
 * render the lifecycle. Funding is a mock UTXO on the mock network, or a real payment otherwise.
 */
import { encodeCashAddress, hash160, secp256k1, binToHex } from '@bitauth/libauth';
import { Contract, SignatureTemplate, Signer, TransactionBuilder, randomUtxo } from '@solidcash/solidcash';
import artifact from '../artifacts/solidcash/HermesHtlc.json' with { type: 'json' };
import ledgerArtifact from '../artifacts/solidcash/HermesSwapLedger.json' with { type: 'json' };

export type HtlcPath = 'claim' | 'refund';

export interface LifecycleStep {
  path: HtlcPath | 'ledger';
  step: 'lock' | 'claim' | 'wrong-secret' | 'refund-early' | 'refund' | 'deploy' | 'record' | 'replay' | 'not-operator' | 'state';
  ok: boolean;
  txid?: string;
  address?: string;
  /** Serialized size of the transaction (bytes), when one was built. */
  bytes?: number;
  note: string;
}

/** Shape of packages/solid/deployments/<network>.json, written by the lifecycle CLI on live networks. */
export interface DeploymentRecord {
  network: string;
  at: string;
  contract: string;
  contracts?: string[];
  lockSats?: string;
  steps: LifecycleStep[];
}

const rand = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
const sha256 = async (b: Uint8Array) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>));

export function party(priv: Uint8Array, prefix: 'bitcoincash' | 'bchtest') {
  const pk = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const pkh = hash160(pk);
  return { priv, signer: new SignatureTemplate(priv), pk, pkh, address: encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh }).address };
}

export async function runSolidLifecycle(opts: {
  provider: any;
  mock: boolean;
  prefix: 'bitcoincash' | 'bchtest';
  locker: ReturnType<typeof party>;
  recipient?: ReturnType<typeof party>;
  lockSats: bigint;
  now: number;
  /** Which paths to run (default both, claim first). */
  paths?: HtlcPath[];
  onStep?: (s: LifecycleStep) => void;
}): Promise<LifecycleStep[]> {
  const steps: LifecycleStep[] = [];
  const push = (s: LifecycleStep) => {
    steps.push(s);
    opts.onStep?.(s);
  };
  const recipient = opts.recipient ?? party(rand(), opts.prefix);
  for (const path of opts.paths ?? (['claim', 'refund'] as const)) {
    const secret = rand();
    const hashlock = await sha256(secret);
    const timeout = path === 'refund' ? (opts.mock ? 500_000_100 : opts.now - 7200) : opts.now + 3600;
    const contract = new Contract(artifact as any, [recipient.pkh, opts.locker.pkh, hashlock, BigInt(timeout)], { provider: opts.provider });
    if (opts.mock) {
      opts.provider.addUtxo(contract.address, randomUtxo({ satoshis: opts.lockSats }));
      push({ path, step: 'lock', ok: true, address: contract.address, note: `HTLC funded with ${opts.lockSats} sats (hashlock ${binToHex(hashlock).slice(0, 12)}…)` });
    } else {
      const utxos = (await opts.provider.getUtxos(opts.locker.address)).filter((u: any) => !u.token);
      const lock = await new TransactionBuilder({ provider: opts.provider })
        .addInputs(utxos, opts.locker.signer.unlockP2PKH())
        .addOutput({ to: contract.address, amount: opts.lockSats })
        .addBchChangeOutputIfNeeded({ to: opts.locker.address, feeRate: 1 })
        .send();
      push({ path, step: 'lock', ok: true, txid: lock.txid, address: contract.address, bytes: lock.hex.length / 2, note: `HTLC funded with ${opts.lockSats} sats` });
    }
    const [utxo] = await contract.getUtxos();
    if (path === 'claim') {
      try {
        new TransactionBuilder({ provider: opts.provider }).addInput(utxo, contract.unlock.claim(recipient.pk, recipient.signer, rand())).addOutput({ to: recipient.address, amount: utxo.satoshis - 1500n }).debug();
        push({ path, step: 'wrong-secret', ok: false, note: 'wrong secret ACCEPTED (bug)' });
      } catch {
        push({ path, step: 'wrong-secret', ok: true, note: 'claim with a wrong secret rejected by the covenant' });
      }
      const tx = await new TransactionBuilder({ provider: opts.provider }).addInput(utxo, contract.unlock.claim(recipient.pk, recipient.signer, secret)).addOutput({ to: recipient.address, amount: utxo.satoshis - 1500n }).send();
      push({ path, step: 'claim', ok: true, txid: tx.txid, bytes: tx.hex.length / 2, note: `recipient claimed with the 32-byte secret ${binToHex(secret).slice(0, 12)}…` });
    } else {
      try {
        new TransactionBuilder({ provider: opts.provider }).setLocktime(timeout - 1).addInput(utxo, contract.unlock.refund(opts.locker.pk, opts.locker.signer), { sequence: 0xfffffffe }).addOutput({ to: opts.locker.address, amount: utxo.satoshis - 1500n }).debug();
        push({ path, step: 'refund-early', ok: false, note: 'early refund ACCEPTED (bug)' });
      } catch {
        push({ path, step: 'refund-early', ok: true, note: 'refund before the timeout rejected' });
      }
      const tx = await new TransactionBuilder({ provider: opts.provider }).setLocktime(timeout).addInput(utxo, contract.unlock.refund(opts.locker.pk, opts.locker.signer), { sequence: 0xfffffffe }).addOutput({ to: opts.locker.address, amount: utxo.satoshis - 1500n }).send();
      push({ path, step: 'refund', ok: true, txid: tx.txid, bytes: tx.hex.length / 2, note: 'locker refunded after the timeout' });
    }
  }
  return steps;
}

export const solidArtifact = artifact;
export const solidLedgerArtifact = ledgerArtifact;

const reason = (e: unknown) => {
  const m = (e as Error)?.message ?? String(e);
  return m.match(/failing require in [^(]*\(([^)]+)\)/)?.[1] ?? m.slice(0, 120);
};

/**
 * HermesSwapLedger (stateful SolidCash: state vars, mapping, event, modifiers): deploy → record a
 * settled swap with its secret → replay / wrong secret / non-operator refused (each attempt fails the
 * BCH 2026 preflight before anything is broadcast) → read state and the `Settled` event back.
 * The operator key also funds the deployment and calls.
 */
export async function runLedgerDemo(opts: {
  provider: any;
  mock: boolean;
  operatorKey: Uint8Array;
  amount?: bigint;
  direction?: 1n | 2n;
  onStep?: (s: LifecycleStep) => void;
}): Promise<LifecycleStep[]> {
  const steps: LifecycleStep[] = [];
  const push = (s: Omit<LifecycleStep, 'path'>) => {
    const full = { path: 'ledger' as const, ...s };
    steps.push(full);
    opts.onStep?.(full);
  };
  const { ContractFactory } = await import('@solidcash/solidcash/contract-factory');
  const signer = new Signer(opts.operatorKey, opts.provider);
  if (opts.mock) for (let i = 0; i < 6; i++) opts.provider.addUtxo(signer.address, randomUtxo({ satoshis: 1_000_000n }));
  const contract: any = await new ContractFactory(ledgerArtifact as any, signer).deploy(signer.publicKey, { addressType: 'p2sh32' });
  const dtx = contract.deploymentTransaction?.();
  push({ step: 'deploy', ok: true, txid: dtx?.txid, bytes: dtx?.hex ? dtx.hex.length / 2 : undefined, address: contract.address, note: 'ledger deployed: settledCount = 0, settledVolume = 0 (state NFTs)' });

  const amount = opts.amount ?? 500n;
  const direction = opts.direction ?? 1n;
  const secret = rand();
  const hashlock = await sha256(secret);
  const op = new SignatureTemplate(opts.operatorKey);
  const refused = async (step: LifecycleStep['step'], what: string, call: () => Promise<unknown>) => {
    try {
      await call();
      push({ step, ok: false, note: `${what} ACCEPTED (bug)` });
    } catch (e) {
      push({ step, ok: true, note: `${what} refused: ${reason(e)}` });
    }
  };
  await refused('wrong-secret', 'record with a secret that does not open the hashlock', () => contract.call.record(hashlock, rand(), amount, direction, op).send());
  await refused('not-operator', 'record signed by someone other than the operator', () => contract.call.record(hashlock, secret, amount, direction, new SignatureTemplate(rand())).send());
  const tx = await contract.call.record(hashlock, secret, amount, direction, op).send();
  push({ step: 'record', ok: true, txid: tx.txid, bytes: tx.hex.length / 2, note: `swap ${binToHex(hashlock).slice(0, 12)}… recorded (${amount} base units, ${direction === 1n ? 'USDC→PUSD' : 'PUSD→USDC'}); modifiers onlyOperator + opens passed` });
  await refused('replay', 'second record of the same hashlock', () => contract.call.record(hashlock, secret, amount, direction, op).send());
  const [count, volume, stored] = await Promise.all([contract.state.settledCount(), contract.state.settledVolume(), contract.state.settledAmount(hashlock)]);
  const events = await contract.queryFilter('Settled');
  const ev = events.at(-1);
  const ok = BigInt(count) === 1n && BigInt(volume) === amount && BigInt(stored) === amount && events.length === 1 && BigInt(ev.args.amount) === amount;
  push({ step: 'state', ok, txid: ev?.txid, note: `state: settledCount = ${count}, settledVolume = ${volume}, settledAmount[hashlock] = ${stored}; ${events.length} Settled event(s), amount ${ev?.args.amount}, direction ${ev?.args.direction}` });
  return steps;
}
