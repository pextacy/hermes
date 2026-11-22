# PLAN — Hermes technical design

Items marked **verify** must be confirmed with the XO, SolidCash, WizardConnect and PUSD docs or teams in Phase 0.

**Decided while building (2026-11-20):** BCH proof = BCH Schnorr over a prefixed SHA-256, plus a transaction-
commitment proof for WizardConnect (§2.1) · searchable tags as `i` tags, history embedded (§2.2) · EVM chain =
**Base Sepolia** (testnet), Base for mainnet later · BCH HTLC timeouts are unix timestamps (CLTV), same as EVM
`block.timestamp` · PUSD mainnet category `2469acc5…2544` (paryonusd.com; decimals read from BCMR, fallback 2) ·
SolidCash test environment = **solidhat** (`@solidcash/solidhat`) · Drops design in §5 (shards, bitmap, vault,
CSV-timelocked pending roots) · shared chain helpers live in `packages/chain`.

## 1. Architecture

```
                         ┌──────────────────────────────── apps/web (live demo + banner) ─────────────────────────────┐
                         │  Pay  ·  Identity  ·  Swap  ·  Claims                     WizardConnect / XO wallet layer  │
                         └───────┬───────────────┬───────────────────┬──────────────────────────┬──────────────────────┘
                                 │               │                   │                          │
                       packages/id        packages/pay        packages/swap              packages/drops
                                 │               │                   │                          │
          Nostr relays ◀─────────┤               │      Nostr (quotes)│                          │
   (binding events, quotes)      │               ▼                   ▼                          ▼
                                 │        BCH mainnet/chipnet ◀── XO templates / CashScript / SolidCash ──▶ pool covenant
                                 │        (Electrum / Fulcrum)       │                                 receipt NFTs
                                 │                                   │ same SHA-256 hashlock
                                 │                                   ▼
                                 │                    EVM chain: USDC HTLC (Solidity, Foundry)
                                 │
                        apps/solver (quotes, locks, claims; keys at runtime)      apps/watcher (F@H file → roots, audits)
```

## 2. Hermes ID (`packages/id`)

### 2.1 Binding payload (canonical JSON, keys sorted, UTF-8)

```json
{ "domain": "hermes-id", "v": 1, "seq": 0,
  "nostr": "<32-byte x-only pubkey hex>",
  "bch": "<33-byte compressed pubkey hex>", "addr": "<cashaddr>",
  "tokenAddr": "<token-aware cashaddr>", "ts": 1763650000,
  "prev": null }
```

- `bchSig` = **BCH Schnorr** signature (the 2019 BCH scheme used by OP_CHECKSIG/OP_CHECKDATASIG) over
  `SHA-256("Hermes ID signed message:\n" || canonicalPayload)` by the BCH key (decided; `packages/id/src/bch.ts`).
  Wallets that sign transactions but not messages (WizardConnect) use a **transaction-commitment proof**: the key
  signs a never-broadcast transaction that spends one of its own P2PKH coins and carries
  `OP_RETURN "HRMS" <same hash>`; verifiers run the BCH VM on it (`packages/id/src/txproof.ts`).
- `nostrSig` = the Nostr event signature (BIP-340 Schnorr) by the Nostr key over an event that contains the
  payload and `bchSig`.
- Valid iff both signatures verify over the same payload and `nostr ≠ bch` key material.

### 2.2 Publication and discovery

- Published as a **parameterised replaceable Nostr event**, kind `30078` (NIP-78 application data), tag
  `["d","hermes-id"]`, plus NIP-39-style tags `["i","bch:<addr>"]`, `["i","bch:<tokenAddr>"]`,
  `["i","bchpk:<key>"]` and, after a rotation, `["i","hermesprev:<prev hash>"]` (relays only index single-letter
  tags, so these make search by address, key and successor work on public relays).
- Replaceable events overwrite older versions, so each binding embeds its predecessor event in
  `content.history`; the rotation chain is verifiable back to seq 0 from the current event alone.
- Optional cross-reference in the Nostr profile in the style of **NIP-39** external identities.
- Optional **identity NFT** (CashTokens mutable NFT) held by the BCH key; commitment = `H(nostr) || seq`. When it
  exists, a binding whose `seq` doesn't match the NFT commitment is stale.
- Discovery: query ≥ 3 relays by author (npub → binding) or by tag (address → npub); take the highest valid
  `seq`; resolve conflicts by verifying the rotation chain.

### 2.3 Verification and authentication

- `verifyBinding(event) → {valid, nostr, bch, addr, seq, reasons[]}` — pure, no network.
- Challenge-response: verifier sends `{domain, nonce, ts, audience}`; user returns signatures from **both**
  keys; verifier checks freshness (`ts` within 120 s), nonce single-use, and the current binding.

### 2.4 Rotation and recovery

New binding with `seq + 1` and `prev = hash(previous payload)`, signed by the new keys **and** the old key of the
identity being kept (e.g. rotate BCH key: old BCH + Nostr sign; rotate Nostr key: old Nostr + BCH sign). If the
identity NFT exists, it's updated in the same flow. Loss of both keys = new identity (documented).

## 3. Hermes Pay (`packages/pay`) — the mainnet slice

`resolve(input)` accepts `npub`, hex pubkey or a NIP-05 name → binding → `verifyBinding` → current destination.
UI shows a verification card (both proofs ✔, version, first-seen date, warnings like "binding changed in the
last 24 h"). Payment built with XO (or the WizardConnect wallet) to `addr` (BCH) or `tokenAddr` (PUSD /
CashTokens). Optional memo in OP_RETURN with a payment reference.

## 4. Hermes Swap (`packages/swap`)

### 4.1 Quote protocol over Nostr

1. Taker publishes an RFQ event (`kind` app-specific, ephemeral) with direction, amount, chains, taker's
   destination, expiry.
2. Solvers reply with signed quotes: rate, fees, `T_first`, `T_second`, solver's addresses, quote expiry.
3. Taker accepts by locking first.

### 4.2 USDC → PUSD

```
taker: s ← 32 random bytes, h = SHA256(s)
1. taker locks USDC in EVM HTLC(recipient=solver, h, T_first = now + 3h)
2. solver waits N_evm confirmations, locks PUSD in BCH HTLC(recipient=taker, h, T_second = now + 1h)
3. taker claims PUSD on BCH revealing s
4. solver reads s from the BCH transaction, claims USDC on EVM
refunds: after T_second solver reclaims PUSD; after T_first taker reclaims USDC
```

PUSD → USDC is the mirror image (taker locks PUSD first with the longer timeout).

Invariant: `T_first ≥ T_second + SAFETY_MARGIN` where the margin covers BCH block time variance (10-min target)
plus EVM finality and solver reaction time.

### 4.3 BCH HTLC (three implementations, same semantics)

- **XO template** (primary, Build With XO bounty): roles `initiator` and `counterparty`; actions `lock`,
  follow-ups `claim(preimage)` and `refund(after locktime)`.
- **SolidCash** (SolidCash bounty): the same contract in Solidity compiled to BCH.
- **CashScript** (fallback if a feature is missing in XO at the time).

Covenant rules: `claim` requires `OP_SHA256(preimage) == h`, preimage length 32, output to recipient with the same
token category and amount; `refund` requires `tx.locktime ≥ T` (CLTV) and output to the locker.

### 4.4 EVM HTLC (`packages/evm-htlc`)

`lock(token, amount, recipient, hashlock, timeout)` · `claim(id, preimage)` · `refund(id)`; SHA-256 hashlock;
reentrancy-safe; events for the solver/watcher. USDC address per chain from Circle's official list (**verify**).

### 4.5 Solver (`apps/solver`)

Holds inventory on both chains (owner's keys, supplied at runtime), publishes quotes, watches locks, locks the
counter-leg, claims with the revealed secret, refunds expired legs. Exposure caps per swap and per hour.

## 5. Hermes Drops (`packages/drops`) — FoldingCash

- **Leaf** = `SHA256(lockingBytecode || cumulativeEarned (8-byte LE) || accountId (4-byte LE))`; tree =
  **positional** pairs (path bits say left/right), zero-padded to a power of two. (Decided instead of sorted pairs:
  the BCH VM compares numbers, not 32-byte strings, and a path integer is cheaper.) `accountId` is a stable,
  append-only id assigned the first time an address appears.
- **Shard state** (`DropsShard`): `K` UTXOs, each a *minting* NFT of the receipt category; commitment =
  `shardIndex | epoch | activeRoot | firstClaimBitmap(88 bytes)` = 125 bytes (2026 128-byte commitments). Account
  `a` lives in shard `a / 704`, bit `a % 704`.
- **Claim**: verifies the proof (loop, BCH 2026) against the active root; on the *first* claim sets the account's
  bitmap bit (so a second "first claim" is impossible without a global nullifier set); later claims burn the
  claimer's **receipt NFT** (`accountId | claimedTotal`) and mint the new one; pays `cumulative − claimedTotal` from
  a **vault** (`DropsVault`, FLDCH, spendable only as input 1 of a shard claim); exact output layout, no stray
  tokens. No expiry, no minimum; the claimer pays dust and fee.
- **Root timelock** (`DropsPending`): the authority mints one pending-root NFT per shard to a covenant that can
  only be promoted after `ROOT_TIMELOCK` blocks **of its own age** (CSV on that UTXO — cannot be shortened or
  griefed); the authority can cancel (veto) before promotion; anyone can promote.
- **Watcher** (`apps/watcher`): downloads the public Folding@home daily summary, applies FoldingCash inclusion
  rules (trusted input, documented), recomputes the tree and alerts if a pending root differs.
- **Cost model**: push (N outputs per month, fee per output) vs pull (fixed root publication + per-claim fee paid
  by claimers) — table and chart in the demo.
- **VM limits**: proof depth `d = ⌈log2(N)⌉`, contract allows `d ≤ 20`; measured claim tx 1,782 bytes at
  `d = 9` (400 leaves) under BCH 2026 rules (mock VM). Capacity `K × 704` accounts (5,632 at `K = 8`); add shards
  to grow.
- **Inputs (trusted)**: FoldingCash's public distribution API (`api.folding.cash/v1/GetDistro`), itself derived
  from the Folding@home stats; the watcher recomputes every root from it and alerts during the timelock.

### 5.1 Developer guide (extending Hermes Drops)

**Byte formats** (`packages/drops/src/state.ts`, must match `contracts/DropsShard.cash`):

| Item | Layout |
|---|---|
| Leaf | `SHA256(lockingBytecode ‖ cumulative u64 LE ‖ accountId u32 LE)` |
| Node | `SHA256(left ‖ right)`; proof = concatenated siblings, `path` bit *i* = 1 ⇒ right child at level *i* |
| Shard commitment (minting NFT, receipt category) | `shardIndex u8 ‖ epoch u32 LE ‖ root 32 ‖ bitmap 88` (125 bytes) |
| Pending-root commitment (authority category) | `shardIndex u8 ‖ epoch u32 LE ‖ root 32` (37 bytes) |
| Receipt commitment (immutable NFT, receipt category) | `accountId u32 LE ‖ claimedTotal u64 LE` (12 bytes) |

**Lifecycle**: `tree` (build epochs from a distribution; ids are append-only in `registry.json`) → `deploy`
(authority genesis, `K` shards, vault funding) → `publish --epoch N` (one pending NFT per shard) → wait
`ROOT_TIMELOCK` blocks while the watcher audits (`cancel` to veto) → `promote` (anyone) → users `claim`
(`buildClaim`, the web Claims tab, or the XO template `hermes-drops-claim`).

**Claim transaction**: inputs `0 shard · 1 vault · funding · [receipt at receiptIndex ≥ 2]`; outputs
`0 shard′ · 1 vault′ − payout · 2 receipt′ → leaf · 3 payout → leaf · [4 BCH change, no tokens]`.

**Extending**
- *Another reward token*: deploy with `--reward-category <cat>`; vault UTXOs hold that token; nothing else changes.
- *More accounts*: deploy more shards (`--shards K`, ≤ 128); capacity is `704·K`. Shards never need to know each other.
- *Another data source*: produce `DistroUser[]` (address + amount per window) and feed `accumulate()`; the
  watcher must use the same source and rules (`apps/watcher --source fah` shows a second, independent source).
- *Multisig authority*: replace the authority key by a covenant that holds the pending-category minting NFT; the
  pool covenants only check the category, so they are unaffected.
- *Proofs for other clients*: `tsx src/cli.ts proof --address <cashaddr>` prints the leaf, siblings, path and root
  (`proofFor()` returns the same JSON in code).
- *Wallet integration*: `readPoolStatus` (active epoch per shard, pending roots and blocks left on their timelock, vault)
  and `readAccountStatus` (entitlement, receipt `claimedTotal`, claimable or "already claimed") are read-only; then
  `claimForWallet` with the tree whose root is active. `DropsSandbox` runs the same code on the mock VM (Claims tab).
- *Demo addresses*: `tree --include` records `params.include` in `tree-N.json`; the watcher re-applies it, so roots
  still match. Watcher alerts go to stderr; `--alerts nostr [--alert-identity]` also posts `#hermesdrops` notes.
- *Tests to copy*: `tests/drops.test.ts` builds a pool on CashScript's mock network and tries adversarial claims;
  `tests/drops-features.test.ts` covers status, sandbox, cancel, proof, F@H and alerts.

## 6. Web app (`apps/web`)

- **Banner (required):** link to the Widget Factory presentation · repo link · CashTokens address for EMBER2026
  donations · (if any pre-existing code) links to old repo/demo.
- **Home = Pay:** one input ("npub or name"), verification card, amount, Send. Mainnet.
- Tabs: Identity (link / rotate / prove) · Swap (USDC ⇄ PUSD) · Claims (FLDCH demo on chipnet) · Developers
  (XO templates, SolidCash contract, verification library).
- Wallet: WizardConnect and/or XO; network badge (MAINNET / CHIPNET) always visible.

## 7. Risks

| Risk | Mitigation |
|---|---|
| ~44 h to deadline | Cut-lines in PHASES: Pay + ID first (mainnet-eligible), then XO swap, then Drops, then SolidCash |
| Roll call missed → low-priority queue | Ask to join a roll-called team; social build-in-public; Media piece |
| XO early-stage gaps | Talk to the XO team early; CashScript fallback; record issues for feedback |
| SolidCash maturity | Keep the contract small but syntax-rich; PRs for issues (owner-approved) |
| Free-option problem in swaps | Short quote expiry, small amounts, solver caps |
| PUSD/USDC liquidity for demo | Testnet tokens / own test category on chipnet; mainnet only for Pay |
