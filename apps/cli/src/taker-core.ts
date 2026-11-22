import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools/pure';
import { binToHex } from '@bitauth/libauth';
import type { Address, PublicClient, WalletClient } from 'viem';
import type { NetworkProvider, Utxo } from 'cashscript';
import type { KeyWallet } from '@hermes/chain';
import {
  buildClaim,
  buildLock,
  evmClaim,
  evmLock,
  findEvmLocks,
  generateSecret,
  htlcContract,
  noticeTemplate,
  parseQuote,
  quoteFilter,
  rankQuotes,
  rfqTemplate,
  type Direction,
  type Quote,
  type Rfq,
} from '@hermes/swap';

type S = Utxo & { lockingBytecode: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

export interface TakerDeps {
  relays: string[];
  provider: NetworkProvider;
  client: PublicClient;
  wallet: WalletClient;
  bch: KeyWallet;
  evmChainId: number;
  htlc: Address;
  usdc: Address;
  bchToken: string;
  direction: Direction;
  amountIn: bigint;
  quoteWaitMs?: number;
  pollMs?: number;
  log?: (s: string) => void;
}

/** Taker side of the Hermes quote protocol, end to end: RFQ → best quote → lock → notice → claim. */
export async function runTaker(d: TakerDeps) {
  const log = d.log ?? console.log;
  const sk = generateSecretKey();
  const pool = new SimplePool();
  const taker = d.wallet.account!.address;
  try {
    const rfq: Rfq = {
      v: 1,
      id: binToHex(crypto.getRandomValues(new Uint8Array(16))),
      direction: d.direction,
      amountIn: d.amountIn.toString(),
      evmChainId: d.evmChainId,
      evmToken: d.usdc,
      bchToken: d.bchToken,
      takerEvm: taker,
      takerBch: d.bch.tokenAddress,
      takerBchPkh: d.bch.pkh,
      expiry: now() + 120,
    };
    const quotes: { quote: Quote; event: Event }[] = [];
    const rfqEv = finalizeEvent(rfqTemplate(rfq), sk);
    const sub = pool.subscribeMany(d.relays, quoteFilter(rfqEv.id), {
      onevent: (e) => {
        const { quote } = parseQuote(e, rfq);
        if (quote && !quotes.some((q) => q.quote.quoteId === quote.quoteId)) quotes.push({ quote, event: e });
      },
    });
    await Promise.allSettled(pool.publish(d.relays, rfqEv));
    log(`RFQ ${rfq.id.slice(0, 8)} published; collecting quotes…`);
    await sleep(d.quoteWaitMs ?? 20_000);
    sub.close();
    const best = rankQuotes(quotes.map((q) => q.quote))[0];
    const chosen = quotes.find((q) => q.quote.quoteId === best?.quoteId);
    if (!chosen) throw new Error('No valid quote received');
    const q = chosen.quote;
    log(`best quote: ${q.amountIn} → ${q.amountOut} from ${chosen.event.pubkey.slice(0, 12)}…`);
    const { secret, hashlock } = generateSecret();
    const c = htlcContract(
      d.direction === 'usdc-to-pusd'
        ? { recipientPkh: d.bch.pkh, refundPkh: q.solverBchPkh, hashlock, timeout: q.tSecond }
        : { recipientPkh: q.solverBchPkh, refundPkh: d.bch.pkh, hashlock, timeout: q.tFirst },
      d.provider,
    );
    let ref: string;
    if (d.direction === 'usdc-to-pusd') {
      ref = (await evmLock({ wallet: d.wallet, client: d.client, htlc: d.htlc, token: d.usdc, amount: BigInt(q.amountIn), recipient: q.solverEvm as Address, hashlock: `0x${hashlock}`, timeout: BigInt(q.tFirst) })).id;
    } else {
      const utxos = [...(await d.provider.getUtxos(d.bch.address)), ...(await d.provider.getUtxos(d.bch.tokenAddress))] as S[];
      ref = `${(await buildLock({ provider: d.provider, contract: c, from: d.bch.address, utxos, token: { category: d.bchToken, amount: BigInt(q.amountIn) }, signer: d.bch.signer }).send()).txid}:0`;
    }
    log(`first leg locked (${ref.slice(0, 20)}…)`);
    await Promise.allSettled(pool.publish(d.relays, finalizeEvent(noticeTemplate({ v: 1, quoteId: q.quoteId, hashlock, chain: d.direction === 'usdc-to-pusd' ? 'evm' : 'bch', ref }, chosen.event.pubkey), sk)));
    while (now() < q.tSecond - 600) {
      if (d.direction === 'usdc-to-pusd') {
        const u = ((await d.provider.getUtxos(c.tokenAddress)) as S[]).find((x) => x.token?.category === d.bchToken && x.token.amount >= BigInt(q.amountOut));
        if (u) {
          const tx = await buildClaim({ provider: d.provider, contract: c, utxo: u, recipient: d.bch.signer, recipientTokenAddr: d.bch.tokenAddress, preimage: secret }).send();
          log(`claimed ${q.amountOut} on BCH: ${tx.txid}`);
          return { quote: q, claim: tx.txid, secret };
        }
      } else {
        const l = (await findEvmLocks(d.client, d.htlc, { recipient: taker })).find((x) => x.hashlock.slice(2) === hashlock && x.amount >= BigInt(q.amountOut));
        if (l) {
          const h = await evmClaim({ wallet: d.wallet, client: d.client, htlc: d.htlc, id: l.id, preimage: `0x${secret}` });
          log(`claimed ${q.amountOut} on EVM: ${h}`);
          return { quote: q, claim: h, secret };
        }
      }
      await sleep(d.pollMs ?? 15_000);
    }
    throw new Error('second leg never arrived; refund the first leg after T_first');
  } finally {
    pool.close(d.relays);
  }
}
