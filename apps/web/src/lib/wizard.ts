import { encodeCashAddress, hash160, binToHex } from '@bitauth/libauth';
import type { DappConnectionManager } from '@wizardconnect/dapp';
import {
  TransactionBuilder,
  placeholderP2PKHUnlocker,
  type NetworkProvider,
  type Output,
  type Utxo,
} from 'cashscript';
import type { BchNetwork } from '@hermes/chain';

/**
 * WizardConnect adapter: derives the wallet's receive/change addresses from the shared
 * xpubs, gathers their UTXOs, builds a transaction with placeholder unlockers and asks the
 * wallet to sign it (it never sees a server; the dapp broadcasts the signed hex itself).
 */
export interface WcAddress {
  path: 'receive' | 'change';
  childIndex: number;
  index: number;
  publicKey: Uint8Array;
  address: string;
  tokenAddress: string;
  lockingBytecode: string;
}

type S = Utxo & { lockingBytecode: string };

export function wcAddresses(manager: DappConnectionManager, network: BchNetwork, count = 8): WcAddress[] {
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const out: WcAddress[] = [];
  for (const [path, childIndex] of [['receive', 0], ['change', 1]] as const) {
    for (let i = 0; i < count; i++) {
      const pk = manager.getPubkey(childIndex, BigInt(i));
      if (!pk) continue;
      const pkh = hash160(pk);
      out.push({
        path,
        childIndex,
        index: i,
        publicKey: pk,
        address: encodeCashAddress({ prefix, type: 'p2pkh', payload: pkh }).address,
        tokenAddress: encodeCashAddress({ prefix, type: 'p2pkhWithTokens', payload: pkh }).address,
        lockingBytecode: binToHex(Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac])),
      });
    }
  }
  return out;
}

export async function wcUtxos(provider: NetworkProvider, addrs: WcAddress[]) {
  const all: { utxo: S; owner: WcAddress }[] = [];
  for (const a of addrs) {
    for (const u of (await provider.getUtxos(a.address)) as S[]) all.push({ utxo: u, owner: a });
  }
  return all;
}

/** Build, have the wallet sign, broadcast. `outputs` are the payment outputs; change goes to receive/0. */
export async function wcSendOutputs(args: {
  manager: DappConnectionManager;
  provider: NetworkProvider;
  network: BchNetwork;
  outputs: Output[];
  tokenInputs?: { category: string; amount: bigint };
  opReturn?: string[];
  userPrompt: string;
  broadcast?: boolean;
}): Promise<{ txid: string; hex: string }> {
  const addrs = wcAddresses(args.manager, args.network);
  if (!addrs.length) throw new Error('Wallet shared no addresses');
  const coins = (await wcUtxos(args.provider, addrs)).filter((c, i, a) => a.findIndex((x) => x.utxo.txid === c.utxo.txid && x.utxo.vout === c.utxo.vout) === i);
  const b = new TransactionBuilder({ provider: args.provider, maximumFeeSatsPerByte: 5 });
  const used: { owner: WcAddress }[] = [];
  const add = (c: { utxo: S; owner: WcAddress }) => {
    b.addInput(c.utxo, placeholderP2PKHUnlocker(c.owner.address));
    used.push(c);
  };
  if (args.tokenInputs) {
    let have = 0n;
    for (const c of coins.filter((c) => c.utxo.token?.category === args.tokenInputs!.category && !c.utxo.token.nft)) {
      if (have >= args.tokenInputs.amount) break;
      add(c);
      have += c.utxo.token!.amount;
    }
    if (have < args.tokenInputs.amount) throw new Error('Not enough tokens in the connected wallet');
  }
  const need = args.outputs.reduce((n, o) => n + o.amount, 0n) + 3000n;
  let bch = used.reduce((n, c) => n + (c as { utxo?: S }).utxo!.satoshis, 0n);
  for (const c of coins.filter((c) => !c.utxo.token).sort((a, b) => Number(b.utxo.satoshis - a.utxo.satoshis))) {
    if (bch >= need) break;
    add(c);
    bch += c.utxo.satoshis;
  }
  if (bch < need - 2000n) throw new Error('Not enough BCH in the connected wallet');
  b.addOutputs(args.outputs);
  if (args.opReturn) b.addOpReturnOutput(args.opReturn);
  if (args.tokenInputs) b.addTokenChangeOutputIfNeeded({ category: args.tokenInputs.category, to: addrs[0].tokenAddress });
  b.addBchChangeOutputIfNeeded({ to: addrs[0].address, feeRate: 1 });
  const wc = b.generateWcTransactionObject({ broadcast: false, userPrompt: args.userPrompt });
  const inputPaths = used.map((c, i) => [i, c.owner.path, c.owner.index] as [number, string, number]);
  const res = await args.manager.signTransaction({
    transaction: { transaction: wc.transaction, sourceOutputs: wc.sourceOutputs, broadcast: false, userPrompt: args.userPrompt } as never,
    inputPaths,
  });
  if (res.error) throw new Error(`Wallet: ${res.error}`);
  if (args.broadcast === false) return { txid: '', hex: res.signedTransaction };
  const txid = await args.provider.sendRawTransaction(res.signedTransaction);
  return { txid, hex: res.signedTransaction };
}
