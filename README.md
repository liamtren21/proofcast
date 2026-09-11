# ProofCast

Pre-authorize the limits. Follow a session without watching the clock. Verify the result.

ProofCast lets people enroll in a creator's DreamDEX event-contract session before its trading signals appear. Followers choose their own price limits, allowed sides, order size, and total risk budget. Once a signal is anchored on Somnia, the protocol can execute within those limits without asking the follower to sign again.

Each enrollment has its own vault. The creator supplies the signal; the follower controls the capital.

[Demo video](https://youtu.be/R3BhyNo9zUo) · [Workflow](#session-workflow) · [Architecture](#architecture) · [Quick start](#quick-start) · [Testnet lifecycle](#testnet-lifecycle)

## Why build this?

A short-lived trading signal can become unaffordable before a follower reads the post and signs a transaction. Even when both people predict the same outcome correctly, different entry prices can produce very different returns.

ProofCast moves consent ahead of the signal. The follower approves a finite session and specific limits in advance. Execution depends on those limits and the native market state, so a late or expensive opportunity does not justify a wider authorization.

The session also gives the creator a durable record. Registered markets remain identifiable even if the creator abstains, misses a signal window, or withdraws the session.

## A session in practice

A creator registers two existing BTC event markets and an enrollment deadline. A follower deposits 5 tUSDC into a personal vault and permits YES buys up to 0.48, with a 2 tUSDC order cap and a 5 tUSDC lifetime risk budget.

After enrollment closes, the creator anchors a YES signal at 0.46. A relayer can request execution while the signal and market remain valid. The follower's browser can be closed.

A signal priced at 0.60 fails that follower's price limit. Insufficient liquidity does not authorize a worse price. Any actual fill is recorded separately from the creator's prediction, and settled proceeds return to the follower's vault.

These numbers illustrate a policy; they are not a forecast or a claim about live liquidity.

## Session workflow

```mermaid
sequenceDiagram
    actor Creator
    actor Follower
    participant Registry as ProofCastRegistry
    participant Factory as ProofCastFactory
    participant Executor as ProofCastExecutor
    participant Vault as Follower vault
    participant Relay as Relayer service
    participant Native as Adapter / DreamDEX

    Creator->>Registry: Register manifest, terms and 1-3 market references
    Follower->>Factory: Create personal enrollment vault
    Factory-->>Follower: Vault address
    Follower->>Vault: Approve collateral and deposit
    Follower->>Executor: Enroll with price, side, cost and risk limits
    Executor->>Registry: Check enrollment is still open
    Executor->>Vault: Initialize fixed enrollment policy
    Note over Creator,Follower: Enrollment closes before signal publication
    Creator->>Registry: Anchor YES, NO or ABSTAIN before cutoff
    Relay->>Executor: execute(enrollmentId, marketId)
    Executor->>Registry: Read anchored signal and registered market
    Executor->>Vault: Derive and validate bounded trade
    Vault->>Native: Submit typed IOC request
    Native-->>Vault: Actual cost and fill result
    Vault-->>Executor: Execution result
    Note over Executor,Vault: Record execution in contract state and events
    Relay->>Executor: Recover eligible settled position
    Executor->>Vault: Recover through native adapter
    Follower->>Vault: Withdraw available collateral
```

Enrollment is allowed only before `enrollUntil`. Signal publication starts at that deadline and ends at the market's decision cutoff. The protocol does not require an immediate follower signature when the creator publishes.

## What is committed

| Record | Contents and behavior |
| --- | --- |
| Session | Creator, manifest hash, terms hash, enrollment deadline, session expiry, and 1-3 existing market references |
| Market reference | Market ID, generation, pool, module, collateral, outcome IDs, and trading deadlines |
| Enrollment | Follower vault, allowed sides, separate YES/NO price caps, order cap, lifetime risk budget, expiry, nonce, and accepted terms hash |
| Signal | YES, NO, or ABSTAIN; price; validity; evidence hash; and on-chain anchor time |
| Annotation | Additional content hashes with increasing versions; annotations do not replace the executable signal |
| Execution | Native order ID, requested quantity, actual cost, filled amount, and execution status |
| Recovery | Market-specific cost basis, recovered position, and collateral received |

A session allows one executable signal per registered market. The registry supports direct creator publication and EIP-712 signed publication. An already-consumed signal cannot execute again for the same enrollment and market.

The on-chain record stores commitments and events. Human-readable explanations are separate content whose hashes can be checked against those commitments.

## History that includes non-trades

The registered market list defines what belongs in the session history. A creator cannot overwrite an anchored signal, and withdrawing a session does not delete its registry records.

| Outcome | Meaning |
| --- | --- |
| ABSTAIN | The creator explicitly chose not to trade |
| NO_SIGNAL | No signal was found by cutoff after the relevant chain range was observed |
| DATA_UNAVAILABLE | Observation is incomplete; absence is not treated as an abstention or a loss |
| Rejected or reverted | Authorization or execution conditions were not met |
| Zero, partial, or full fill | What the native execution actually acquired |
| Payout pending | Settlement has not yet produced the collateral needed to close the position |
| Recovered | The position's recovery and actual collateral delta have been accounted for |

The session and receipt models distinguish these outcomes. Indexer observations, preflight rejection, mined execution, and settlement evidence have different meanings; a local rejection is not an on-chain transaction receipt.

This history covers registered ProofCast sessions. It does not establish a creator's identity or describe activity in unrelated wallets.

## Architecture

```mermaid
flowchart TB
    UI["Creator / follower web interface"]
    API["Fastify API"]
    DB[("Postgres")]
    Indexer["Chain indexer"]
    Relay["Relayer service"]

    subgraph Shannon["Somnia Shannon"]
        Catalog["LiveShannonDreamDexCatalog"]
        Registry["ProofCastRegistry"]
        Factory["ProofCastFactory"]
        Executor["ProofCastExecutor"]
        Vault["ProofCastFollowerVault"]
        Adapter["ProofCastDreamDexAdapter"]
        Native["DreamDEX pool / settlement"]
    end

    UI -->|"read sessions and receipts"| API
    API --> DB
    UI -->|"wallet-signed session actions"| Registry
    UI -->|"wallet-signed enrollment"| Executor
    Factory -->|"deploy per enrollment"| Vault
    Registry -->|"validate market references"| Catalog
    Relay -->|"execute / recover"| Executor
    Relay -->|"durable transaction journal"| DB
    Executor -->|"read signal and terms"| Registry
    Executor -->|"authorized trade / recovery"| Vault
    Vault --> Adapter
    Adapter --> Native
    Indexer -->|"read canonical logs via RPC"| Shannon
    Indexer -->|"events and cursor"| DB
```

The on-chain `ProofCastExecutor` and the off-chain relayer have different roles. The contract derives the order from the anchored signal and follower policy. A relayer supplies gas and calls `execute(enrollmentId, marketId)`; it does not choose arbitrary prices, quantities, or recipients.

Execution is permissionless through that guarded contract. The included relayer uses a dedicated signer, transaction journal, confirmation checks, and an STT run budget. Each follower vault trusts the executor contract fixed at creation, not the relayer's wallet.

## Capital and control

- A separate vault holds each enrollment's collateral; followers do not share a pooled balance.
- The follower chooses allowed sides, price caps, maximum order cost, and total risk budget.
- Realized losses and unsettled cost share a lifetime budget. Profits do not cancel earlier losses or increase that budget.
- The accepted policy is initialized once. The creator cannot widen it after enrollment.
- Followers can revoke future execution and withdraw unused cash. Confirmed revocation does not unwind existing positions.
- Recovery remains available after revocation and returns funds through the vault's native recovery path.

Budget limits use collateral units; STT gas is separate. Price caps limit what a follower authorizes, but do not guarantee a fill, a profit, or the creator's entry price.

## Contracts

| Source | Responsibility |
| --- | --- |
| [ProofCastRegistry.sol](contracts/src/ProofCastRegistry.sol) | Session registration, publication phases, signal signatures, annotations, and withdrawal records |
| [ProofCastFactory.sol](contracts/src/ProofCastFactory.sol) | Creates one follower-owned vault per enrollment |
| [ProofCastExecutor.sol](contracts/src/ProofCastExecutor.sol) | Enrollment authorization, signal-derived execution, replay protection, and recovery entry point |
| [ProofCastFollowerVault.sol](contracts/src/ProofCastFollowerVault.sol) | Collateral custody, policy limits, actual-cost accounting, and withdrawals |
| [ProofCastDreamDexAdapter.sol](contracts/src/ProofCastDreamDexAdapter.sol) | Native IOC execution and settlement integration |
| [LiveShannonDreamDexCatalog.sol](contracts/src/LiveShannonDreamDexCatalog.sol) | Validates market references against Shannon's native market state |

[ProofCastDemoCreator.sol](contracts/src/ProofCastDemoCreator.sol) supplies an owner-controlled publisher for lifecycle demonstrations. It has no follower spending privileges.

## Quick start

Requirements: Node.js 24, npm, and Docker Compose for the included PostgreSQL 16 service. Run from a checkout of this repository.

```powershell
cd proofcast
npm ci
npm run compile
npm test
npm run build
```

Start the database:

```powershell
docker compose up -d postgres
```

Use this environment block in each terminal that runs the API or indexer:

```powershell
$env:DATABASE_URL = 'postgres://proofcast:proofcast@127.0.0.1:5544/proofcast'
$env:SOMNIA_RPC_URL = 'https://dream-rpc.somnia.network'
$env:DREAMDEX_INDEXER_URL = 'https://dev.smk.somnia.host/v1/graphql'
$env:INDEXER_START_BLOCK = '485283588'
$env:PUBLIC_ORIGIN = 'http://localhost:3120'
```

Run `npm run db:migrate` once after the database becomes healthy. Start each service in its own terminal:

| Command | Local address |
| --- | --- |
| `npm run dev:api` | [API](http://localhost:3121/api/v1/health) |
| `npm run dev:worker` | [Indexer health](http://localhost:9120/health) |
| `npm run dev:web` | [Web interface](http://localhost:3120) |

The Compose credentials are for local development. Runtime commands read process environment variables; they do not automatically load the project's `.env`.

### Optional relayer service

Run `npm run dev:executor` in a separate terminal with the database and RPC settings above plus:

| Variable | Purpose |
| --- | --- |
| `EXECUTOR_ENABLED` | Set to `1` to enable the service |
| `EXECUTOR_PRIVATE_KEY` | Dedicated STT-funded relayer signer |
| `EXECUTOR_CONFIG` | Path to deployment JSON containing executor, registry, factory, and adapter addresses |
| `EXECUTOR_RUN_ID` | Identifier for the journaled run |
| `EXECUTOR_RUN_BUDGET_WEI` | Total permitted STT gas expenditure for the run, in wei |
| `EXECUTOR_MAX_GAS` | Maximum gas per transaction |
| `EXECUTOR_MAX_FEE_PER_GAS_WEI` | Per-gas fee ceiling |

The lifecycle deployment JSON can be used as `EXECUTOR_CONFIG` to inspect its recorded enrollment. New sessions require current market references and their own enrollment. See [executor.js](apps/worker/src/executor.js) for configuration validation and defaults.

## Testnet lifecycle

The recorded Shannon lifecycle includes session registration, follower vault creation, funding, enrollment before signal publication, native execution, revocation, withdrawal of unused cash, and settlement recovery.

| Item | Address |
| --- | --- |
| Network | Somnia Shannon, chain ID `50312` |
| tUSDC | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` |
| Catalog | `0xa0d637b87263Cc7A85f763Dba3C5a504b0c69834` |
| Factory | `0xB6A466c418B3a6C2F576D5dAEac88C4D7985cc89` |
| Example follower vault | `0x8A2d55d133ec5507068a5AB2B5B0547a09bf50e8` |

[Transaction record](docs/evidence/lifecycle-2026-09-10-dynamic-20260911.json) · [Receipt verification](docs/evidence/lifecycle-verification-2026-09-11-dynamic.json) · [Deployment configuration](config/shannon.json)

After compilation, `node scripts/verify-lifecycle.mjs` rechecks the recorded transactions and position state against Shannon and writes a refreshed verification artifact. It does not submit a trade. The example market has expired.

The [web interface](https://proofcast-shannon.vercel.app) is an additional entry point. Browser enrollment and funding remain gated while the complete creator/follower flow is integrated. The contract lifecycle can be inspected through the source, scripts, and transaction records.

## Repository structure

```text
contracts/src/          Registry, executor, factory, vault, catalog, and adapter
contracts/test/         Solidity session, policy, native, and recovery tests
apps/web/              React interface and wallet controls
apps/api/              Fastify API and SQL migrations
apps/worker/           Indexer and relayer services
packages/protocol/     Content, manifest, units, and type helpers
src/                   Session and receipt models
scripts/               Compilation, deployment, and lifecycle tools
docs/evidence/         Deployment and transaction records
test/                  Node session, API, worker, and wallet tests
compose.yaml           Local Postgres service
Dockerfile.*           Separate API, worker, and executor images
```

## Development and tests

`npm test` runs the Node test suite. PostgreSQL integration tests use `API_TEST_DATABASE_URL`, `WORKER_TEST_DATABASE_URL`, and `EXECUTOR_TEST_DATABASE_URL` and skip when their database configuration is absent. With Foundry installed, `forge test --root contracts` runs Solidity tests. `npm run test:contracts` checks Solidity test compilation but does not execute those tests.

Tests cover publication deadlines, enrollment limits, replay protection, lifetime risk, execution records, recovery, API authentication, and transaction reconciliation.

## Next development steps

Finish the creator and follower browser journey, expand the session-history presentation, and support external creator integrations. Optional sponsored trials are a future module: a sponsor would fund a finite trial budget so a participant could try a session without depositing trading capital.

ProofCast is testnet software with no independent audit. The Solidity sources carry MIT SPDX identifiers; see their individual file headers.
