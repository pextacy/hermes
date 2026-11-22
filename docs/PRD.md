# PRD — Hermes: pay a person, across chains, without trusting a bridge

| | |
|---|---|
| Hackathon | **BCH BLAZE 2026** — second edition of the BLAZE online hackathons for Bitcoin Cash (DoraHacks) |
| Link | https://dorahacks.io/hackathon/bchblaze2026/detail · Event site: https://bchblaze.cash |
| Deadline | Submission **Nov 22, 2026 14:00 UTC** (17:00 Istanbul) · judging Nov 23–27 · results livestream Nov 28 |
| Prize pool | $8,000+ (25 BCH): Mainnet 1st $3,500 PUSD + BLISS 2027 tickets for the team · 2nd $1,500 + 1 ticket · 3rd $750 + 1 ticket · Media $1,000 · Community Choice $750 · TokenHunt completion pool $250 · plus six bounties (11.5 BCH + $1,250 PUSD + 26M FLDCH) |
| Entries | **Mainnet track** + **Media track** (both allowed) + **Community Choice** (automatic with a CashTokens address) + bounties: **Decentralized Identity**, **Stablecoin Bridge**, **Build With XO**, **Best SolidCash Application**, **FoldingCash Reward Claims**. Rules: "A single project can submit to as many bounties as they like… winning one bounty [does not exclude] the recipient from others." |
| Name | *Hermes* (Ἑρμῆς): messenger of the gods, guide of travellers across borders, patron of merchants and trade. Hermes carries your message (Nostr), crosses the border between chains (atomic swaps) and delivers the payment (BCH). |

---

## 1. Problem

Bitcoin Cash is fast and cheap enough for everyday dollars, and it now has stablecoins (ParyonUSD, MoriaUSD)
and smart-contract capability (CashTokens, CashScript, XO, SolidCash). Three things still stop people from using
it as a dollar rail:

1. **Addresses, not people.** Paying someone means copying an address from a chat — error-prone and the root of
   address-poisoning scams. Identities live on Nostr and social apps, money lives on-chain, and nothing links
   them verifiably.
2. **Dollars are stuck elsewhere.** The world's stablecoin liquidity sits on Ethereum and its L2s. Getting USDC
   into PUSD (and back) today means a centralised exchange or a custodial bridge — the most hacked category in
   crypto.
3. **Mass payouts are trusted pushes.** Projects like FoldingCash pay thousands of users by pushing tokens
   monthly from an operator wallet: costs grow with users, small balances wait, and users must trust the
   operator's math.

## 2. Solution

| Module | User sees | Under the hood |
|---|---|---|
| **Hermes ID** | "Link my BCH wallet to my Nostr" — one flow, two signatures | Mutual-signature binding, published as a replaceable Nostr event; optional identity NFT (CashTokens mutable NFT) pins the current version; rotation and recovery chain |
| **Hermes Pay** | Type `npub…` or `name@domain` → see a verified identity → send BCH/PUSD on **mainnet** | Resolve → verify both proofs + current version → pay the bound address via XO / WizardConnect |
| **Hermes Swap** | "Get PUSD with my USDC" (and back) in one screen | Quotes over Nostr; HTLC on the EVM chain + HTLC on BCH with the same SHA-256 hashlock; ordered timeouts; refunds |
| **Hermes XO** | Same flows, as reusable XO templates other apps can import | Templates for HTLC swap (lock / claim / refund follow-ups), identity NFT mint/rotate, Merkle claim |
| **Hermes Solid** | — (developer artefact) | The HTLC written once in Solidity: compiled to EVM for the USDC side and to BCH with SolidCash for the PUSD side; tested in SolidCash's environment |
| **Hermes Drops** | "Claim my FLDCH" anytime, any amount | Merkle root of (address, cumulative earned) per epoch, pool covenant verifying proofs, receipt NFT preventing double claims, root timelock, watcher recomputing roots from the public Folding@home file |

**One idea, many prizes:** identity tells you *who*, swaps bring the *dollars*, drops pay *many people at
once*. Each module is a standalone deliverable for its bounty and a part of one product.

## 3. Users

| User | Job | Hermes gives |
|---|---|---|
| BCH users on Nostr | Pay a friend or merchant | Pay-to-npub with verification |
| EVM stablecoin holders | Try BCH payments | USDC → PUSD in one swap, no custodian |
| BCH merchants / freelancers | Get paid in dollars, cash out | PUSD in, USDC out |
| Token projects (FoldingCash first) | Pay thousands of users fairly | Pull claims with constant operator cost |
| BCH app developers | Reuse primitives | XO templates, verification library, SolidCash example |

## 4. Goals

- **G1 (Mainnet track gate):** any judge opens the live demo, connects a wallet (WizardConnect or XO) and makes a
  useful **BCH mainnet** transaction: pay a verified Nostr identity.
- **G2 (Identity bounty):** the four requirements — creation & management, cryptographic binding, decentralised
  discovery, verification & challenge-response — plus stretch: send-to-identity, rotation.
- **G3 (Bridge bounty):** both directions USDC ⇄ PUSD with one EVM ecosystem; HTLC refunds proven.
- **G4 (XO bounty):** a novel XO template with a chipnet/mainnet transaction from an invitation inspectable in
  the debug tool, follow-up actions, reproduction steps, owner-written feedback.
- **G5 (SolidCash bounty):** a SolidCash contract deployed and run on BCH mainnet, wide feature/syntax use, tests
  in the required environment, UI showing the lifecycle, PRs for issues found (owner-approved).
- **G6 (FoldingCash bounty):** reference tx code, chipnet demo with a few hundred leaves, cost comparison vs push
  model, docs another BCH dev can extend.
- **G7 (Media):** one engaging, shareable piece explaining "pay a person across chains" (owner-made).

## 5. Judging alignment (Mainnet track: 3 judges × 4 categories × 10 points)

| Category | Hermes |
|---|---|
| Innovation & creativity — *is it cool?* | Pay-to-npub with cryptographic proof; trustless dollars in from Ethereum; one Solidity HTLC on two chains |
| Design & usability — *is it slick?* | Landing screen does one thing in 30 seconds (pay a person); everything else behind clear tabs |
| Technical strength — *does it work?* | CashTokens, covenants, HTLCs with ordered timeouts, Merkle proofs within VM limits, XO templates, SolidCash |
| Business potential — *will it make money?* | Swap spread for solvers, hosted claims for token projects, identity verification API for wallets |

**Judges' warning (from the rules):** they give each project "a couple of minutes"; "simpler things that work are
better than complex things that are confusing". So Hermes is deep underneath but the first screen is one action.

## 6. Eligibility reality check

- **Roll call has closed.** Without it the project lands in the *low-priority* judging queue. Ways out (from the
  rules): join a team whose member completed roll call, or make the project compelling enough to draw attention
  on social media. Phase 0 tries the first; the Media piece and build-in-public posts serve the second.
- Must also: confirm the project is real in the BCH BLAZE Telegram; top-of-page banner with the Widget Factory
  presentation link, repo link and a CashTokens address for EMBER2026 donations; WizardConnect or XO integration.

## 7. Business model

Solver spread on swaps (Hermes runs the first solver; others can join the quote protocol) · hosted claim
infrastructure for token projects (FoldingCash first) · identity verification API and SDK for wallets.

## 8. Non-goals and honesty

No custody, no wrapped tokens, no yield. Testnets by default; mainnet in dust amounts with owner approval. No
claims of endorsement by ParyonUSD, General Protocols, Paytaca, FoldingCash, Circle or any chain.
