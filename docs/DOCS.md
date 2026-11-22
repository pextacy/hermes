# DOCS — Hermes reference

Facts gathered 2026-11-20 from the DoraHacks page and bchblaze.cash. **verify** = confirm in Phase 0.

## 1. Hackathon

| Item | Value |
|---|---|
| Name | BCH BLAZE 2026 (second edition) |
| Page | https://dorahacks.io/hackathon/bchblaze2026/detail · bounties: https://dorahacks.io/hackathon/bchblaze2026/bounties |
| Event site | https://bchblaze.cash · bounties https://bchblaze.cash/bounties/ (rules: `#rules`) |
| Telegram | https://t.me/bchblaze |
| Format | Virtual |
| Timeline (UTC) | registration Oct 10 – Nov 13 · submission Nov 14 – **Nov 22** (DoraHacks shows 2026/11/22 17:00 UTC+3) · judging Nov 23–27 · results & livestream Nov 28, 14:00 UTC |
| Stats (2026-11-20) | 91 builds · 491 hackers · 6 bounties |
| Prizes | Mainnet 1st $3,500 PUSD + BLISS 2027 tickets (team) · 2nd $1,500 PUSD + 1 ticket · 3rd $750 PUSD + 1 ticket · Media $1,000 PUSD · Community Choice $750 PUSD · TokenHunt completion pool $250 PUSD (**verify** what TokenHunt requires) · paid in PUSD, BLISS NFTs, BCH or CashTokens on BCH mainnet |
| Streams | Info session https://www.youtube.com/watch?v=9qudgWloY1g · Workshop 1 https://www.youtube.com/watch?v=AsJt8jfhaSY · Workshop 2 (XO) https://www.youtube.com/watch?v=MuWEHO5Ufrk · Workshop 3 https://www.youtube.com/watch?v=GAvbt4wdw_M · Kick-off https://www.youtube.com/watch?v=xWdo27QvzCo |
| Widget Factory template | https://docs.google.com/presentation/d/1Yfuk9CJkf4U9M_WukcELhumWgj3Ak6345Ewy8hSp-Hk/edit?usp=sharing |

**Mainnet track eligibility:** individuals or teams of 2–4 · register on DoraHacks, submit by deadline · at least
one feature sending BCH **mainnet** transactions that judges can easily make using the app · live usable demo
by link · original or significantly improved (pre-existing work declared) · **top-of-page banner** with the
Widget Factory presentation link, repo link and a CashTokens address for EMBER2026 donations (pre-existing
projects also link old repo + old demo) · **WizardConnect or XO Template integration** · roll call at one of
the prep streams (**closed**) · confirm the project is real in the BLAZE Telegram.

**Roll call closed:** late entrants can still compete but go to the **low-priority queue**, reviewed only if
judges have time. Escapes: a project compelling enough to attract attention via word of mouth/social media, or
joining a team that completed roll call.

**Media track:** any media (video, music, art, comics, sculpture, AI-assisted art, NFT collections); original or
significantly improved; live hosted link; banner or description with EMBER2026 CashTokens address; roll call +
Telegram confirmation as above. Builders may enter both tracks.

**Community Choice:** most EMBER2026 tokens sent to the project's address wins (EMBER2026 airdropped to BLISS
Belle NFT holders).

**Judging (Mainnet):** Elliot Price (BCH Bull, BCH Alliance) · Kallisti (Selene Wallet) · Sayoshi Nakamario
(FundMe.cash, Bitcoin Cash University) — 4 categories × 10 points × 3 judges = 120: Innovation & creativity ·
Design & usability · Technical strength · Business/investment potential. Tie → 2-of-3 judge vote. Expect "a
couple of minutes" of attention; simpler working things beat complex confusing ones.

## 2. Bounties

| Bounty | Sponsor | Prize | Key requirements | Link |
|---|---|---|---|---|
| Stablecoin Bridge | BCH BLAZE | $750 PUSD | other-chain stablecoins ⇄ BCH stablecoins, both ways; ≥ 1 other ecosystem; PUSD priority (MoriaUSD optional); WizardConnect recommended on BCH, WalletConnect on the other chain; stretch: more BCH stablecoins, ShapeShift/THORChain routing | https://bchblaze.cash/bounties/stablecoin-bridge/ |
| FoldingCash Reward Claims | FoldingCash (StrungSafe) | 26,000,000 FLDCH | Merkle root of (address, cumulative) per epoch on-chain; pool contract verifying proofs, no expiry; receipt NFT with claimed total; root timelock; no threshold. Deliver: reference tx code, chipnet demo with a few hundred leaves, cost comparison vs push, extensible docs | https://bchblaze.cash/bounties/foldingcash-reward-claims/ |
| Build With XO | General Protocols | 0.3 BCH × up to 10 | novel functional XO template; a chipnet/mainnet tx from an invitation inspectable in the debug tool; follow-up actions; template + invitation + reproduction steps; **~500 words personally written feedback (AI-written rejected)**; latest `@xo-cash/engine 0.1.0-next.*` | https://bchblaze.cash/bounties/build-with-xo/ |
| Migrate To XO | General Protocols | 1 BCH × up to 5 | migrate an *existing* project to XO (not applicable unless an existing project is used) | https://bchblaze.cash/bounties/migrate-to-xo/ |
| Decentralized Identity | Paytaca | $500 PUSD | self-custodied BCH ⇄ Nostr link; cryptographic binding with proofs from both keys (listing an address in a profile doesn't count); decentralised discovery; independent verification + challenge-response; deliver prototype, code, setup, architecture docs. Stretch: send to identity, attestations/VCs, reputation, rotation/recovery, selective disclosure, libraries, CashTokens commitments. Full spec: Google Doc linked on the page | https://bchblaze.cash/bounties/decentralized-identity/ |
| Best SolidCash Application | mainnet_pat | 3.5 BCH (2 / 1 / 0.5) | Solidity compiled to BCH with SolidCash, deployed and running on **mainnet**; use most features and wide syntax; tests in the required "solidhat" environment (**verify** name); UI showing lifecycle; PRs for issues found | https://bchblaze.cash/bounties/best-solidcash-application/ |

**Bounty rules:** a project may enter as many bounties as it qualifies for; winning one doesn't exclude others;
sponsors decide what is sufficiently impressive; payouts on/after Nov 28; submissions waive IP rights for the
bounty (read the rules page).

## 3. Tools and links

| Tool | Link |
|---|---|
| XO docs | https://stack.xo.cash/ · getting started https://stack.xo.cash/getting-started.html · API https://stack.xo.cash/api/ |
| XO packages | https://www.npmjs.com/org/xo-cash · engine versions https://www.npmjs.com/package/@xo-cash/engine?activeTab=versions |
| XO source / templates | https://gitlab.com/GeneralProtocols/xo · https://gitlab.com/GeneralProtocols/xo/templates |
| XO debug tool | https://blaze.xo.cash/ |
| XO engine flow | `Engine.create(mnemonic, { network })` · `importTemplate` · `setDefaultPolicies` · `generateLockingBytecodeFromDefaultPolicy` · `createInvitation` · `listMissingRequirements` · `appendInvitation` · `addChangeToInvitation` · `signInvitation` · `executeAction({ broadcastTransaction: true })` · `serializeInvitation` (`@xo-cash/utils`) · `acceptInvitation` · `updateInvitation` · `listInvitationValidationIssues` · `listScriptHashData` · `listOutputResolutions` / `appendOwnOutputResolutions` · `XO_SUPPORTED_NETWORKS.chipnet` |
| XO notes | templates are JSON objects (`roles`, `actions`, variables, outputs, locking scripts); `templateIdentifier` = hash of content; importing checks shape not safety; commits only add; inputs are reserved per invitation |
| SolidCash | https://github.com/solidcash/solidcash · sponsor https://x.com/mainnet_pat · `@solidcash/solidc`, `@solidcash/solidcash`, test env `@solidcash/solidhat` 0.51.1 (needs `@noble/curves` v1 via pnpm packageExtensions) |
| Chipnet faucets | https://tbch.googol.cash/ · https://chipnet.bch.ninja/ |
| Stablecoins | ParyonUSD https://paryonusd.com (PUSD category `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544`, 2 decimals per its launch post) · MoriaUSD https://moria.money |
| WizardConnect | `@wizardconnect/core` 0.2.11, `@wizardconnect/dapp`, `@wizardconnect/react` 0.2.7 (gitlab.com/riftenlabs/lib/wizardconnect). Protocol `hdwalletv1`: xpub sharing + transaction signing; **no message signing** (hence Hermes' transaction-commitment proof) |
| FoldingCash | https://folding.cash · API https://api.folding.cash (`/v1/GetDistro?startDate&endDate&amount&includeFoldingUserTypes=15` → per-address amounts; 61–69 members/month in Sep–Oct 2026) · GitHub https://github.com/foldingcash · token https://tokenexplorer.cash/?tokenId=0adb865ee9cc3038de87fba682e6cd361414edc9acff0da2fd0690d75341c640 · F@H file https://apps.foldingathome.org/daily_user_summary.txt.bz2 |
| BCH libraries | Libauth · CashScript · Electrum Cash / Fulcrum servers — **verify** versions |
| Nostr | NIP-01 (events), NIP-05 (names), NIP-39 (external identities), NIP-78 (kind 30078 app data) |
| EVM | Foundry, viem; USDC (Circle): Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — **verify** before mainnet |
| Code resources | https://bitcoincashpodcast.com/code |

## 4. Hermes constants (defaults)

| Name | Default |
|---|---|
| Binding domain / version | `hermes-id` / 1 |
| Challenge freshness | 120 s |
| Relays queried | ≥ 3 |
| `T_first` / `T_second` | 3 h / 1 h |
| `SAFETY_MARGIN` | 1 h |
| Quote expiry | 60 s |
| Solver cap | 100 USD per swap, 500 USD per hour (testnet: unlimited) |
| `ROOT_TIMELOCK` | 144 blocks (~1 day) |
| Pool shards `K` | 8 |
| Chipnet demo leaves | 300–500 |
