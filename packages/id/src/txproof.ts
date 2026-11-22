import {
  binToHex,
  createVirtualMachineBch,
  decodeTransaction,
  encodeLockingBytecodeP2pkh,
  hash160,
  hexToBin,
  utf8ToBin,
  type Output,
} from '@bitauth/libauth';
import { bchMessageHash } from './bch.js';
import { TX_PROOF_MARKER } from './constants.js';

/**
 * Transaction-commitment proof: for wallets that can sign transactions but not
 * arbitrary messages (WizardConnect today), the BCH key proves the binding by
 * signing a transaction that spends one of its own P2PKH outputs and carries
 * `OP_RETURN "HRMS" <SHA-256(prefix || message)>`. The signature commits to all
 * outputs (SIGHASH_ALL), so the key holder approved the commitment. The
 * transaction need not be broadcast: verification runs the BCH VM against the
 * provided source outputs, which proves key control regardless.
 */
export interface TxProofSourceOutput {
  lockingBytecode: string; // hex
  valueSatoshis: string; // decimal string
}

export interface TxProof {
  type: 'tx-commit';
  tx: string; // hex
  sourceOutputs: TxProofSourceOutput[];
}

export function txProofOpReturn(message: string): Uint8Array {
  const marker = utf8ToBin(TX_PROOF_MARKER);
  const hash = bchMessageHash(message);
  // OP_RETURN <push4 "HRMS"> <push32 hash>
  return Uint8Array.from([0x6a, marker.length, ...marker, hash.length, ...hash]);
}

export function verifyTxProof(proof: TxProof, publicKeyHex: string, message: string): string[] {
  const reasons: string[] = [];
  let tx;
  try {
    tx = decodeTransaction(hexToBin(proof.tx));
  } catch (error) {
    return [`tx-proof: undecodable transaction (${String(error)})`];
  }
  if (typeof tx === 'string') return [`tx-proof: ${tx}`];
  if (proof.sourceOutputs.length !== tx.inputs.length) return ['tx-proof: source output count mismatch'];

  const expected = binToHex(txProofOpReturn(message));
  if (!tx.outputs.some((o) => binToHex(o.lockingBytecode) === expected && o.valueSatoshis === 0n)) {
    reasons.push('tx-proof: commitment output missing or wrong');
  }

  const p2pkh = binToHex(encodeLockingBytecodeP2pkh(hash160(hexToBin(publicKeyHex))));
  const sourceOutputs: Output[] = proof.sourceOutputs.map((o) => ({
    lockingBytecode: hexToBin(o.lockingBytecode),
    valueSatoshis: BigInt(o.valueSatoshis),
  }));
  const signedByKey = sourceOutputs.some((o) => binToHex(o.lockingBytecode) === p2pkh);
  if (!signedByKey) reasons.push('tx-proof: no input spends the bound key');

  const vm = createVirtualMachineBch();
  const result = vm.verify({ transaction: tx, sourceOutputs });
  if (result !== true) reasons.push(`tx-proof: VM verification failed (${result})`);
  return reasons;
}
