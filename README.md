# Hermes — pay a person, not an address

**Identity-native, cross-chain dollars for Bitcoin Cash.** Hermes binds a BCH key to a Nostr identity with
proofs from *both* keys, lets anyone verify that binding without a server, and moves dollars to that person —
PUSD on BCH, or USDC from another chain through a trust-minimised **HTLC atomic swap** (no bridge, no custodian,
no wrapped IOU). The same primitives power **pull-based Merkle reward claims** for CashTokens, built for FoldingCash.

Built for **BCH BLAZE 2026**.

> **Live demo:** https://hermes-bch.netlify.app · **Presentation:** _link added at submission_

## Try it in two minutes — no wallet, no funds

The web app opens with a 2-minute tour. Every step works without a wallet or testnet coins:

1. **Pay** → *Create my Hermes ID in one click*: this browser's BCH key and Nostr key sign the same statement,
   the binding is published to Nostr relays and resolved back — a card **verified with both signatures**.
2. **Swap** → *Run the swap*: a complete USDC ⇄ PUSD atomic swap **in your browser**, on the **real contracts** —
   the compiled HermesHTLC bytecode on an in-browser EVM and the HermesHtlc covenant on the BCH 2026 VM. The
   secret really travels from one chain to the other; wrong secrets, early refunds and double claims are
   rejected by the contracts themselves. Also: *solver disappears → refund*.
3. **Claims** → the Drops sandbox: publish a root → wait out the timelock → claim → claim again
   (“already claimed”) → next epoch pays only the difference.
4. **Identity** → rotate a key, then paste a tampered binding into *Verify any binding*.
5. **Developers** → XO templates and the invitation viewer, the SolidCash lifecycle and ledger, the
   verification library.

## Modules

| Module | What it does |
|---|---|
| `packages/id` | BCH ⇄ Nostr binding (both proofs over one canonical payload), relay discovery, rotation chain, challenge-response login, identity NFT pin, NIP-39 |
| `packages/pay` | npub / NIP-05 → verified BCH destination → payment (BCH, PUSD, any CashToken), pay links + QR, encrypted payment notes |
| `packages/swap` | Quote protocol over Nostr, HTLC parameters, swap state machine, BCH HTLC covenant, EVM HTLC client, in-browser simulator |
| `packages/evm-htlc` | `HermesHTLC.sol` (Foundry): SHA-256 hashlock, preimage length check, reentrancy guard, fee-on-transfer rejection |
| `packages/solid` | The HTLC and a stateful swap ledger written in Solidity and compiled to BCH with SolidCash |
| `packages/xo` | XO templates: HTLC swap, identity NFT mint/rotate, Drops claim; invitation CLI |
| `packages/drops` | Merkle pull-claim pool: cumulative leaves, receipt NFTs, claimed bitmap, root timelock, authority veto |
| `apps/web` | The web app (React + Vite, static, hash-routed) |
| `apps/solver` | Liquidity provider bot for swaps (keys typed at runtime) |
| `apps/watcher` | Recomputes FoldingCash roots independently (API or Folding@home summaries), audits pending roots, Nostr alerts |
| `apps/verifier` | Hermes ID verification HTTP API (resolve, verify, challenge-response) |
| `apps/cli` | `hermes` CLI: identity NFT, binding verify, EVM HTLC deploy, swap demo, headless taker |

## Security invariants

1. A binding needs **both** proofs — a BCH-key signature over the Nostr key and a Nostr signature over the BCH
   key, over the same canonical payload. One without the other is invalid.
2. The current binding is the latest valid version of a rotation chain verified back to the first binding.
3. **Hermes never custodies funds**: no bridge vault, no pooled balances, no server-side user keys.
4. HTLC timeouts are ordered: the side that locks first gets the longer timeout (`T₁ ≥ T₂ + safety margin`);
   a quote that violates this is refused by both taker and solver.
5. Secrets are 32 random bytes; the hashlock is SHA-256 on both chains; preimage length is checked on-chain.
6. Token amounts are integers in base units; decimals are read from metadata, never assumed.
7. Merkle leaves commit to *cumulative* earnings; payout = cumulative − already claimed; a new root becomes
   claimable only after the root timelock, so anyone can audit it first.

## Tests

```bash
pnpm test        # vitest (tests/) + forge test + solidhat test
```

484 TypeScript tests (unit, BCH VM, anvil + real solver over a local Nostr relay, in-browser simulator),
14 Foundry tests (incl. fuzzing, reentrancy, fee-on-transfer) and 14 SolidCash tests.

## Run locally

```bash
pnpm install
pnpm dev                 # web app on http://localhost:5173
pnpm dev:relay           # local Nostr relays (set them in Settings) for offline demos
pnpm --filter cli hermes swap demo        # both swap directions + refund on anvil + BCH VM
pnpm --filter verifier start              # verification API on :8787
pnpm check:submission                     # what is still open before submitting
```

Non-secret configuration lives in `config/*.json`. There are no `.env` files: keys and mnemonics are typed at
runtime and never written to the repository.

## Status

- Everything above runs locally and in the browser today.
- Live chipnet / Base Sepolia deployments (test stablecoin, EVM HTLC, Drops pool) and the mainnet payment are
  owner steps listed by `pnpm check:submission`.

