# ProofCast demo recording script (2–3 minutes)

## 00:00–00:20 — Hook

“ProofCast makes prediction signals executable without making them blindly trusted. Every signal is versioned, bounded, and tied to a market generation.”

## 00:20–01:00 — Product and contract

Show `contracts/ProofCast.sol`. Highlight `Card`, `Receipt`, `maxCost`, `expiry`, `marketGeneration`, and the typed-only native execution function. Show `arbitraryCall` reverting.

## 01:00–01:40 — Native DreamDEX proof

Show the card, authorization, and native IOC transaction links from `README.md`. Explain the exact market binding and the on-chain executed receipt.

## 01:40–02:10 — Verification

Run `npm test` and show 15 passing tests, then `npm run compile`. Explain that receipts distinguish authorization, execution, revocation, and future settlement.

## 02:10–02:40 — Future

Show `finalizeMarket` and `redeem` as expiry-gated capabilities, then explain the creator/follower UI and searchable public evidence cards.
