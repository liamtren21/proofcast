# ProofCast — Shannon testnet submission brief

ProofCast records a creator session, follower enrollment and bounded native order authorization before execution. It gives followers a full on-chain record of enrollment, signal, fill and recovery rather than a creator-controlled performance claim.

## What is live

- Public frontend: https://proofcast-shannon.vercel.app
- Shannon chain ID: `50312`.
- Dynamic catalog: `0xa0d637b87263Cc7A85f763Dba3C5a504b0c69834`.
- Factory: `0xB6A466c418B3a6C2F576D5dAEac88C4D7985cc89`.
- Completed native lifecycle vault: `0x8A2d55d133ec5507068a5AB2B5B0547a09bf50e8`.
- Canonical lifecycle evidence: `docs/evidence/lifecycle-2026-09-10-dynamic-20260911.json`.
- Browser funded owner-control evidence: `docs/evidence/browser-e2e-funded-20260911.json`.

The completed lifecycle includes deploy, session registration, follower vault creation, tUSDC approval/deposit, enrollment, anchored signal, native IOC, revoke, settlement recovery and withdrawal. Receipt verification reports `complete: true`, `openRiskRaw: 0`, `cashRaw: 0`, and `realizedLossRaw: 20`.

## Run locally

```powershell
cd D:\dorahack\proofcast
npm test
npm run build
.\scripts\run-api-local.ps1
.\scripts\run-worker-local.ps1
```

The executor uses an independent, gas-funded signer, durable Postgres journal, two confirmations and a bounded run budget. It does not load a creator, follower or deployer key.

## Honest scope

The public Vercel deployment serves the frontend and its on-chain wallet controls. API, indexer and executor remain separate production-local services with their own Postgres and key isolation; they are not represented as a public hosted backend.
