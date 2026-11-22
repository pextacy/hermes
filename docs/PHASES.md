# PHASES — Hermes delivery plan

Now: 2026-11-20 evening (Istanbul) · **Submission deadline 2026-11-22 14:00 UTC (17:00 Istanbul)** · target
submit **Nov 22, 12:00 UTC**. The owner asked for the full, complex design regardless of time, so every module is
specified; the phases below are ordered by **cut-lines**: whatever is finished at the deadline is a coherent,
eligible submission.

Owner rules: **no git commit/push/PR without explicit approval** · **no mainnet transaction without approval** ·
**tests are written and run in the final build phase** · **no `.env` files** · **XO feedback written by the
owner, not an agent**.

---

## Phase 0 — Eligibility and setup (Nov 20, evening)

- [ ] Confirm the project is real in the BLAZE Telegram (https://t.me/bchblaze).
- [ ] Roll call has closed → ask in Telegram whether a roll-called team will take a new member, or accept the
      low-priority queue knowingly. Record: `________`
- [ ] Chipnet wallet + faucet coins; WizardConnect and XO quick start; `@xo-cash/engine` latest `0.1.0-next.*`.
- [ ] Ask General Protocols (t.me/generalprotocols) if an HTLC with CashTokens is feasible in XO today.
- [ ] Ask mainnet_pat about the SolidCash test environment name and setup.
- [ ] Decide EVM chain for USDC (testnet) and get test USDC.

**Exit:** a chipnet payment sent from the web app skeleton through WizardConnect or XO.

## Cut-line A — Hermes ID + Pay (Nov 21, morning) → Mainnet track + Identity bounty

- [x] `packages/id`: payload, both signatures, `verifyBinding`, publish to relays, discovery by npub and address.
- [x] Challenge-response login demo page.
- [ ] Pay tab: resolve → verification card → send (chipnet, then **mainnet with owner approval**, dust amount).
- [x] Rotation flow (stretch).
- [ ] Live demo deployed with the required banner (presentation link can be a draft).

**Exit:** a judge can link identities and pay an npub on mainnet in under two minutes.

## Cut-line B — XO HTLC + Swap (Nov 21, afternoon–night) → Build With XO + Stablecoin Bridge

- [x] XO template: HTLC with `lock`, follow-ups `claim` / `refund` (+ token variants); imports into the engine,
      two-party invitation compiles the HTLC offline. [ ] Funded chipnet transaction from an invitation, checked in
      https://blaze.xo.cash/ (owner step: XO wallet mnemonic at runtime).
- [x] EVM HTLC (Foundry) on the chosen testnet.
- [x] Solver bot (testnet), quote protocol over Nostr.
- [x] Swap tab: USDC → PUSD and PUSD → USDC, refund path shown.
- [ ] Keep a running list of XO issues (raw notes) for the owner's feedback.

**Exit:** both swap directions complete on testnets; one refund demonstrated.

## Cut-line C — Hermes Drops (Nov 22, early morning) → FoldingCash bounty

- [x] Tree builder + proofs; pool covenant + receipt NFT + root timelock (verified in the BCH 2026 VM; chipnet deploy = owner step).
- [x] Demo with 400 leaves: real FoldingCash members (public distribution API) + documented sample padding.
- [x] Cost comparison table: push vs pull.
- [x] Watcher recomputing the root.

**Exit:** several users claim different amounts; a double claim fails; a pending root can't be used early.

## Cut-line D — Hermes Solid (stretch) → SolidCash bounty

- [x] HTLC in SolidCash (Solidity dialect) compiled and tested in solidhat (9 tests). [ ] Exercised on mainnet
      with dust via `pnpm --filter @hermes/solid lifecycle -- --network mainnet` (owner approval + key).
- [ ] PRs for SolidCash issues found — **only after owner approval**.

## Final build phase — Tests (Nov 22, 06:00–10:00 UTC)

Per the owner, the suite is written and run now, after the features exist.

- [x] `tests/id.test.ts` — binding valid only with both signatures; tampered payload fails; key reuse rejected;
      rotation chain; stale `seq` never resolves; challenge freshness and nonce reuse.
- [x] `tests/pay.test.ts` — resolver picks the current binding; warnings on recent changes.
- [x] `tests/swap.test.ts` — timeout ordering enforced; state machine both directions; refund after expiry only;
      preimage length check.
- [x] `forge test` — EVM HTLC lock/claim/refund, reentrancy, wrong preimage.
- [x] `tests/drops.test.ts` — proof verification; payout = cumulative − claimed; double claim blocked; timelock;
      no minimum.
- [x] XO HTLC script executed in the BCH 2026 VM (tests/xo.test.ts); SolidCash tests in solidhat. [ ] XO run on
      chipnet with funds (owner step).
- [x] Fix failures until green.

**Exit:** suites green — 2026-11-20: 87 vitest (incl. anvil ⇄ BCH-VM swap E2E, verifier API) + 14 forge + 14 solidhat.

## Ship (Nov 22, 10:00–13:00 UTC)

- [ ] Widget Factory presentation (owner-reviewed, real numbers only).
- [ ] Banner final: presentation link, repo link, EMBER2026 CashTokens address.
- [ ] With owner approval: README, push repo(s).
- [ ] Media-track piece published (owner-made) with the EMBER2026 address in its description.
- [ ] DoraHacks BUIDL submission; apply to each bounty with its deliverables:
      Identity (architecture + verification docs) · Bridge · Build With XO (template, invitation, repro steps,
      **owner-written ~500-word feedback**) · FoldingCash (tx code, chipnet demo, cost comparison, docs) ·
      SolidCash (if Cut-line D done).
- [ ] Build-in-public post on X/Nostr tagging BLAZE (helps escape the low-priority queue).

**Exit:** submitted by 13:00 UTC; one hour of buffer.

## Remaining features (35) — gap list from PRD/PLAN vs code, 2026-11-20 — all done; re-audited in a browser 2026-11-21 (tests: 479 vitest + 14 forge + 14 solidhat)

Runtime evidence (every path executed, not just compiled): browser E2E with headless Chrome against a local
relay (`pnpm dev:relay`) for F1/F4/F5/F8/F33 (link → NIP-39 → challenge-response → Nostr rotation → BCH rotation
→ old npub resolves to v2 via a pay link); `tests/solver-e2e.test.ts` runs the real solver and taker (F13–F15,
F17, F18) over Nostr + anvil + BCH VM in both directions; `tests/id-nft-e2e.test.ts` (F2/F3); `hermes evm deploy`
run against anvil through a pseudo-terminal (F12); `tests/drops-e2e.test.ts` deploy → publish → promote →
claimForWallet (F25/F26/F29); `tests/watcher-alerts.test.ts` against a WebSocket relay (F28); XO CLI create → join →
inspect → fund (stops at "no spendable UTXOs") with two wallets (F20). Bugs found this way and fixed: duplicated
UTXOs from plain + token addresses, lost successor link after Nostr-then-BCH rotation (lineage tag added),
doubled NIP-39 prefix, legacy-address regex, XO template-id normalisation. Not executable without funds/captcha:
real chipnet/mainnet broadcasts (owner steps below).

Identity
- [x] F1 Nostr key rotation in the web app
- [x] F2 Identity NFT mint + rotate (CLI, local key)
- [x] F3 Identity tab shows the NFT pin / pinned version
- [x] F4 NIP-39 profile cross-reference (kind 0 `i` tag) builder + button
- [x] F5 "Verify any binding" tool (npub or raw event → verdict with reasons)
- [x] F6 Browser BCH key backup/import (WIF) + key-loss guidance
- [x] F7 Verification HTTP API (`apps/verifier`): resolve, verify event, challenge issue/verify
Pay
- [x] F8 Shareable pay links (`#pay?to=…&amount=…&memo=…`) + QR for your own identity
- [x] F9 Local payment history with explorer links
- [x] F10 NIP-05 name verified on the card (name resolves to the same key)
- [x] F11 Optional encrypted payment note to the recipient over Nostr
Swap
- [x] F12 EVM HTLC deploy script in TypeScript (viem, key prompted) that writes config
- [x] F13 Solver identity on quotes (npub, local completed-swap count)
- [x] F14 Best-quote ordering + live expiry countdown
- [x] F15 Headless taker CLI
- [x] F16 `swap demo` script: anvil + BCH VM, both directions, printed like the Drops demo
- [x] F17 Multiple BCH stablecoins (PUSD + MoriaUSD slot) selectable by config
- [x] F18 Solver `status` command
XO
- [x] F19 XO template for Drops claims (shard covenant expressed in CashAssembly)
- [x] F20 XO HTLC party CLI (create / join / fund / claim / refund via invitation files)
- [x] F21 Invitation viewer in the Developers tab
SolidCash
- [x] F22 SolidCash lifecycle UI in the web app (lock → claim / refund, in-browser VM)
- [x] F23 Second SolidCash contract using state, events and modifiers (+ solidhat tests)
- [x] F24 SolidCash deployment record written by the lifecycle script and shown in the UI
Drops
- [x] F25 Real chipnet claim from the Claims tab
- [x] F26 Authority `cancel` (veto) command + test
- [x] F27 Folding@home daily summary parser as an alternative watcher source
- [x] F28 Watcher alerts published to Nostr (opt-in)
- [x] F29 `proof --address` CLI for other developers
- [x] F30 Drops developer guide (PLAN §5.1)
Web / ship
- [x] F31 Responsive + dark-mode pass (verified with screenshots)
- [x] F32 Error boundary + relay/Electrum status indicator
- [x] F33 Settings: custom relays and Electrum servers (persisted)
- [x] F34 Static hosting config (SPA headers, base path) + verified production build
- [x] F35 `pnpm check:submission` script for the submission checklist

## Owner runtime steps (need keys, funds or approval — code is ready)

1. Chipnet: fund a key from a faucet, then `pnpm --filter solver mint-test-tokens -- --network chipnet`; put the
   tPUSD category in `config/networks.json` → `bch.chipnet.tokens.PUSD.category`.
2. Base Sepolia: `pnpm --filter cli hermes evm deploy --evm baseSepolia` (writes `config/networks.json`; or the
   forge script with `--interactives 1`); get test USDC.
3. Run the solver: `pnpm --filter solver dev -- --network chipnet --evm baseSepolia` (BCH, EVM, Nostr keys typed in).
4. Drops on chipnet: `pnpm --filter @hermes/drops exec tsx src/cli.ts deploy --network chipnet`, then `publish
   --epoch 1`, wait `ROOT_TIMELOCK` blocks (or deploy with `--timelock 2` for the live demo), `promote`; run the
   watcher.
5. XO: run the HTLC invitation flow with a funded chipnet XO wallet; inspect it in https://blaze.xo.cash/.
6. Mainnet (approval each time): publish your own Hermes ID binding and make the judge-path dust payment;
   SolidCash lifecycle on mainnet with dust.
7. Optional: `pnpm --filter cli hermes id nft-mint --network mainnet --i-have-owner-approval` (identity NFT);
   `pnpm --filter verifier start` to offer the verification API. Run `pnpm check:submission` before submitting.
8. Banner: set `config/hermes.json` → `web.banner` (`repoUrl`, `ember2026Address`, final presentation link);
   deploy `apps/web` (`pnpm --filter web build` → static `apps/web/dist`).

---

## Demo path for judges (2 minutes)

1. Open link → banner → "Pay a person".
2. Paste an npub → green "verified: BCH ⇄ Nostr, v3" card → send 0.001 BCH on mainnet.
3. Swap tab: watch a recorded/testnet USDC → PUSD swap complete; see the HTLC transactions.
4. Claims tab: claim FLDCH on chipnet; try again → "already claimed".
5. Developers tab: XO template, SolidCash contract, verification library.

## Submission checklist

- [ ] Mainnet tx usable by judges · [ ] live demo link · [ ] banner (presentation, repo, EMBER2026 address)
- [ ] WizardConnect or XO integration · [ ] Telegram confirmation · [ ] roll-call situation handled
- [ ] Bounty deliverables per bounty · [ ] Media piece · [ ] no secrets in repo

## Round 3 — 42 features (2026-11-22) — all must work without a wallet or funds, browser-verified

Pay
- [x] G1 Payment request watcher: a pay link / request card polls the receiving address and flips to “paid ✓” with the txid
- [x] G2 Batch pay: paste lines `npub-or-name, amount` → each resolved + verified → one transaction with many outputs (preview, then send)
- [x] G3 Address-poisoning guard: pasting a raw cashaddr reverse-looks-up its Hermes ID (relay tag `l=bch:<addr>`) and shows owner or a warning
- [x] G4 Contacts: save verified identities locally; re-verified on every use; flags a changed binding version
- [x] G5 Payment receipt: downloadable JSON receipt (recipient binding event id + version, txid, amount, memo) after a send
- [x] G6 Fee and size preview before sending (inputs, outputs, bytes, fee in sats)
- [x] G7 Scan a QR (npub / pay link) with the camera via BarcodeDetector, graceful fallback when unsupported
Identity
- [x] G8 “Verified on Hermes” badge: downloadable SVG + embeddable snippet for the current binding
- [x] G9 Relay consistency audit: which relay holds which binding version, stale relays highlighted, one-click republish
- [x] G10 Rotation timeline visualisation (versions, which key changed, when)
- [x] G11 Reverse lookup by BCH address in “Verify any binding”
- [x] G12 Portable proof: download a self-contained proof bundle (full chain JSON) and verify a bundle offline (upload)
- [x] G13 QR for my npub + download of my binding event JSON
- [x] G14 Binding diff: compare two versions field by field
Swap
- [x] G15 Simulator: custom amount and spread
- [x] G16 Simulator: malicious-solver scenarios (wrong hashlock, too-short timeout, short amount) refused by the taker before it claims
- [x] G17 Simulator: step-through mode (Next step) with an explanation per step
- [x] G18 Simulator: download the full transcript (JSON with tx hex / calldata)
- [x] G19 Quote fee breakdown: gross, spread, net, effective rate, per direction
- [x] G20 Swap history export (CSV)
- [x] G21 Timeout ladder diagram (T₁, T₂, safety margin, now) per swap and in the simulator
Claims
- [x] G22 Download a Merkle proof (JSON) for an address from the web
- [x] G23 Per-epoch entitlement history chart for an address
- [x] G24 Leaderboard: top cumulative earners of the latest tree
- [x] G25 In-browser root audit: recompute each published tree's root and compare with the file and the chain
- [x] G26 Merkle proof path visualiser (leaf → root, sibling hashes)
- [x] G27 Claim cost estimator (claims × tx size × fee rate, using the drops cost model)
- [x] G28 Sandbox: authority veto step (publish a bad root, cancel it before the timelock)
Developers
- [x] G29 Verifier API playground (resolve / verify / challenge against a URL, request + response shown)
- [x] G30 Contract source viewer: HermesHTLC.sol, HermesHtlc.cash, SolidCash sources, with copy/download
- [x] G31 Test report: counts per suite generated at build time and shown in the app
- [x] G32 Canonical payload explorer: paste a binding payload → canonical JSON, payload hash, message signed by each key
- [x] G33 Hashlock tool: generate a secret, compute SHA-256 hashlock, check a preimage against a hashlock
- [x] G34 Nostr event kinds reference (all kinds and tags Hermes uses, with examples)
- [x] G35 Drops leaf encoder: address + cumulative → leaf bytes and hash
Web shell
- [x] G36 Manual light/dark/system theme toggle (persisted)
- [x] G37 Keyboard shortcuts (g p / g i / g s / g c / g d, ? for help)
- [x] G38 Installable PWA: manifest + service worker caching the static app shell
- [x] G39 Toast notifications for finished async actions
- [x] G40 Mainnet safety: switching Pay to mainnet asks for confirmation; persistent mainnet warning strip
- [x] G41 Accessibility pass: skip link, visible focus, aria-live on status messages
- [x] G42 Share/deep links that restore state (#swap?sim=…, #claims?addr=…, #developers?tool=…) — all three browser-verified
