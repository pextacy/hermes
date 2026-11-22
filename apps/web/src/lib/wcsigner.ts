import type { DappConnectionManager } from '@wizardconnect/dapp';
import type { NetworkProvider } from 'cashscript';
import { txProofOpReturn, type BchProof, type BchSigner } from '@hermes/id';
import type { BchNetwork } from '@hermes/chain';
import { wcAddresses } from './wizard';
import { TransactionBuilder, placeholderP2PKHUnlocker, type Utxo } from 'cashscript';

/**
 * BCH key proof through WizardConnect. WizardConnect signs transactions, not messages, so
 * the wallet signs a (never broadcast) transaction that spends one of its own receive/0
 * coins and commits to the binding with OP_RETURN "HRMS" <hash>. See packages/id/src/txproof.ts.
 */
export class WizardConnectBchSigner implements BchSigner {
  constructor(
    readonly manager: DappConnectionManager,
    readonly provider: NetworkProvider,
    readonly network: BchNetwork,
  ) {}

  private get key() {
    const a = wcAddresses(this.manager, this.network, 1).find((x) => x.path === 'receive' && x.index === 0);
    if (!a) throw new Error('Wallet did not share its receive key');
    return a;
  }

  async getPublicKey() {
    return this.key.publicKey;
  }

  get address() {
    return this.key.address;
  }

  async prove(message: string): Promise<BchProof> {
    const k = this.key;
    const coins = ((await this.provider.getUtxos(k.address)) as (Utxo & { lockingBytecode: string })[]).filter((u) => !u.token);
    const coin = coins.sort((a, b) => Number(b.satoshis - a.satoshis))[0];
    if (!coin) throw new Error(`The wallet's first address (${k.address}) needs a small BCH coin to sign the proof (it is not spent).`);
    const b = new TransactionBuilder({ provider: this.provider })
      .addInput(coin, placeholderP2PKHUnlocker(k.address))
      .addOutput({ to: txProofOpReturn(message), amount: 0n })
      .addBchChangeOutputIfNeeded({ to: k.address, feeRate: 1 });
    const wc = b.generateWcTransactionObject({ broadcast: false, userPrompt: 'Hermes ID: prove this address belongs to your Nostr identity (not broadcast)' });
    const res = await this.manager.signTransaction({
      transaction: { transaction: wc.transaction, sourceOutputs: wc.sourceOutputs, broadcast: false, userPrompt: 'Hermes ID binding proof' } as never,
      inputPaths: [[0, 'receive', 0]],
    });
    if (res.error) throw new Error(`Wallet: ${res.error}`);
    return {
      type: 'tx-commit',
      tx: res.signedTransaction,
      sourceOutputs: [{ lockingBytecode: coin.lockingBytecode, valueSatoshis: coin.satoshis.toString() }],
    };
  }
}
