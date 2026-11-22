/**
 * Push vs pull cost model (FoldingCash bounty deliverable). Sizes are measured from real
 * transactions built by this package (see `measureClaimBytes` in demo.ts); the defaults
 * below are those measurements rounded up.
 *
 * Push (today): every epoch the operator sends one token output per user.
 *   operatorCost = epochs × (txOverhead + N × outputBytes + ceil(N / outputsPerTx) × inputBytes) × feeRate
 *                  + epochs × N × tokenDust            (dust is locked in users' outputs)
 * Pull (Hermes Drops): every epoch the operator publishes K pending roots and K promotions.
 *   operatorCost = epochs × (publishBytes + K × promoteBytes) × feeRate + K × pendingDust
 *   Users pay their own claims when they want: claimBytes × feeRate + 2 × tokenDust (receipt + payout).
 */
export interface CostInputs {
  users: number;
  epochs: number;
  claimRate: number; // fraction of users who claim each epoch
  feeRate: number; // sats/byte
  tokenDust: number;
  shards: number;
  sizes?: Partial<typeof DEFAULT_SIZES>;
}

export const DEFAULT_SIZES = {
  pushOutputBytes: 80, // P2PKH output carrying fungible tokens
  pushInputBytes: 150, // token input + funding
  pushOutputsPerTx: 1000,
  txOverhead: 12,
  publishBytes: 600, // authority input + K pending NFT outputs (K = 8)
  promoteBytes: 1300, // measured 1271 bytes (mock demo)
  claimBytes: 1800, // measured 1782 bytes for a depth-9 proof (400 leaves), see demo.ts
};

export function costModel(i: CostInputs) {
  const s = { ...DEFAULT_SIZES, ...i.sizes };
  const pushTxs = Math.ceil(i.users / s.pushOutputsPerTx);
  const pushBytesPerEpoch = s.txOverhead * pushTxs + i.users * s.pushOutputBytes + pushTxs * s.pushInputBytes;
  const pushOperatorSats = i.epochs * (pushBytesPerEpoch * i.feeRate + i.users * i.tokenDust);
  const pullOperatorSats = i.epochs * (s.publishBytes + i.shards * s.promoteBytes) * i.feeRate;
  const claimsPerEpoch = Math.round(i.users * i.claimRate);
  const userSatsPerClaim = s.claimBytes * i.feeRate + 2 * i.tokenDust - i.tokenDust; // old receipt dust is recovered
  const pullUserSatsTotal = i.epochs * claimsPerEpoch * userSatsPerClaim;
  return {
    push: { operatorSats: pushOperatorSats, perUserPerEpochSats: pushOperatorSats / i.epochs / i.users },
    pull: {
      operatorSats: pullOperatorSats,
      userSatsTotal: pullUserSatsTotal,
      userSatsPerClaim,
      totalSats: pullOperatorSats + pullUserSatsTotal,
    },
    operatorSavingsSats: pushOperatorSats - pullOperatorSats,
    breakEvenUsers: Math.ceil(((s.publishBytes + i.shards * s.promoteBytes) * i.feeRate) / (s.pushOutputBytes * i.feeRate + i.tokenDust)),
  };
}
