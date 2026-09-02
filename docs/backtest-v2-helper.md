# Backtesting V2 forward-data helper

## Purpose

The helper prospectively captures real Alpaca option contract metadata, latest bid/ask snapshots, and canonical research-run JSON into a queryable SQLite lineage database.

It is deliberately separate from:

- `.state/research-ledger.sqlite`, which is the autonomous research authority.
- The immutable historical replay database consumed by `backtest:v2`.
- Per-run P&L databases under `workspace/backtest-v2/runs/`.

The mutable capture database builds forward evidence. `sealForwardCaptureV1` now provides the minimal bridge that selects `FRESH` observations from a closed window and writes an immutable historical dataset. The deterministic E2E smoke command exercises that bridge with live-shaped fixture data; real Alpaca captures still require a bounded live window and coverage review before sealing.

## Safety and evidence labels

- `bootstrap` retrieves contracts and underlying spots, but no option quotes.
- `once` is a connectivity/diagnostic poll. Outside the Alpaca calendar session, every otherwise valid quote is stored as `OUTSIDE_SESSION`, never `FRESH`.
- `session` waits until the Alpaca-provided open, polls only through the provided close, and performs no quote poll if the requested session already closed.
- Default option feed is `indicative`. It must not be described as OPRA.
- Provider event time and collector receipt time are stored separately.
- Real data is written under `workspace/`, which is gitignored.

## Tracked configuration

`config/backtest-v2/live-collection.json` defaults to:

```text
SPY, QQQ, SLV, GLD, IWM, MU, TSLA, META
DTE 7–45
moneyness 0.80–1.20
option feed indicative
underlying feed IEX
one-minute focused snapshot polling
15-minute contract refresh
100 option symbols per request batch
```

Use a smaller smoke subset first:

```text
SPY,QQQ
```

SQLite is compact and queryable, but it can still become large. Keep the database out of Git and monitor row count and file growth.

## Prerequisites

Set these in `.env` or the process environment:

```text
ALPACA_API_KEY
ALPACA_SECRET_KEY
```

Optional endpoint overrides already used by the application are:

```text
ALPACA_MARKET_DATA_BASE_URL
ALPACA_TRADING_BASE_URL
```

The collector is read-only with respect to Alpaca. It does not submit, replace, cancel, exercise, or close orders.

## Run the minimal E2E flow now

The quickest decision aid is a credential-free deterministic smoke run:

```bash
pnpm backtest:v2:e2e:smoke
```

It executes the complete implemented plumbing:

```text
10-minute live-shaped fixture collection at one-minute cadence
→ mutable forward capture SQLite
→ FRESH quote coverage
→ immutable historical dataset sealing
→ point-in-time option-chain reconstruction
→ bid/ask entry after 60-second latency
→ one declared exit cutoff
→ close fill, fees, ledger, and P&L
```

The output is explicitly labeled:

```text
TEST_FIXTURE_REPLAY
DETERMINISTIC_LIVE_SHAPED_FIXTURE_NOT_ALPACA_MARKET_PERFORMANCE
```

It is an infrastructure and accounting proof—not evidence that the strategy made money in a real market.

### Verified reference result

The committed deterministic scenario produces:

| Result | Value |
|---|---:|
| Collection window | 10 minutes |
| Poll cadence | 60 seconds |
| Polls | 10 |
| Contracts | 2 |
| Fresh quote observations | 20 |
| Imported research lineage artifacts | 1 fixture artifact |
| Opened / closed positions | 1 / 1 |
| Entry net price | 602 half-cents |
| Entry fees | 130 cents |
| Close net price | 798 half-cents |
| Exit fees | 130 cents |
| Net P&L | **9,540 cents / $95.40** |
| Ending equity | **1,009,540 cents / $10,095.40** |
| Exit reason | `PROFIT_TARGET` |

### Inspect the generated result

```bash
cat workspace/backtest-v2/e2e/minimal-fixture/report.md
cat workspace/backtest-v2/e2e/minimal-fixture/e2e-summary.json
```

```bash
sqlite3 -readonly workspace/backtest-v2/e2e/minimal-fixture/collection/capture.sqlite \
  "SELECT quality, COUNT(*) FROM option_quote_observations GROUP BY quality;"

sqlite3 -readonly workspace/backtest-v2/e2e/minimal-fixture/dataset/historical.sqlite \
  "SELECT dataset_id, evidence_tier, provider, feed, status FROM datasets;"

sqlite3 -readonly workspace/backtest-v2/e2e/minimal-fixture/replay/run.sqlite \
  "SELECT status, initial_equity_cents, ending_equity_cents, net_pnl_cents FROM backtest_runs;"

sqlite3 -readonly workspace/backtest-v2/e2e/minimal-fixture/replay/run.sqlite \
  "SELECT purpose, net_price_half_cents, fees_cents, net_cash_flow_cents FROM fills ORDER BY occurred_at;"

sqlite3 -readonly workspace/backtest-v2/e2e/minimal-fixture/replay/run.sqlite \
  "SELECT realized_pnl_cents, exit_reason FROM positions;"
```

### Generated files

```text
workspace/backtest-v2/e2e/minimal-fixture/
├── e2e-summary.json
├── report.md
├── collection/
│   └── capture.sqlite
├── dataset/
│   ├── historical.sqlite
│   └── manifest.json
└── replay/
    ├── config.json
    └── run.sqlite
```

Re-running the convenience command replaces only this gitignored fixture result directory. For a custom directory under `workspace/backtest-v2/e2e/`:

```bash
node --import tsx src/backtest-v2/live-collection/e2e-smoke-cli.ts \
  --reset \
  --output workspace/backtest-v2/e2e/my-evaluation
```

The current E2E smoke has three explicit limitations:

1. It uses one declared exit cutoff, not a recurring five-minute monitor loop.
2. Its directional signal is fixed fixture input, not replayed from `ResearchReportV7`.
3. Its bootstrap spot is a causal proxy, not full underlying daily/intraday bar history.

These boundaries are also written into `e2e-summary.json` so downstream presentation cannot silently omit them.

## Tonight: contract bootstrap only

Choose the next intended market session date. For example:

```bash
pnpm backtest:v2:collect -- \
  --mode bootstrap \
  --session-date 2026-09-03 \
  --symbols SPY,QQQ,SLV,GLD,IWM,MU,TSLA,META
```

The output note must be:

```text
CONTRACT_METADATA_ONLY_NO_QUOTES_COLLECTED
```

This command:

1. Reads the Alpaca calendar.
2. Retrieves current underlying snapshots for moneyness filtering.
3. Retrieves and paginates active option contracts.
4. Keeps active, tradable, American, multiplier-100 contracts in the configured DTE and moneyness ranges.
5. Stores the spot, complete provider count, retained contracts, membership, content hash, and request lineage.
6. Imports any canonical research artifacts already present under `workspace/research`.

It does not claim that an after-hours price is live.

## Optional after-hours diagnostic

To test the quote endpoint once:

```bash
pnpm backtest:v2:collect -- \
  --mode once \
  --session-date 2026-09-02 \
  --symbols SPY,QQQ
```

After the session closes, valid returned prices are retained as `OUTSIDE_SESSION`. This is useful for connectivity and schema verification only. It is not execution-grade evidence.

## Next option session: durable collection

Run before the requested session opens:

```bash
pnpm backtest:v2:collect -- \
  --mode session \
  --session-date 2026-09-03 \
  --symbols SPY,QQQ,SLV,GLD,IWM,MU,TSLA,META
```

For a smaller smoke collection:

```bash
pnpm backtest:v2:collect -- \
  --mode session \
  --session-date 2026-09-03 \
  --symbols SPY,QQQ \
  --poll-seconds 60
```

The session mode:

```text
calendar lookup
→ contract/spot bootstrap
→ wait for official open when early
→ batched option snapshots
→ classify FRESH/STALE/INVALID
→ SQLite transaction
→ scan canonical research artifacts
→ refresh contracts every 15 minutes
→ stop at official close
→ final research-artifact scan
```

Early closes and holidays come from Alpaca's calendar rather than hard-coded `09:30–16:00` assumptions.

## Capture the autonomous research run at the same time

Run the collector and agent in separate terminals.

Terminal 1:

```bash
pnpm backtest:v2:collect -- \
  --mode session \
  --session-date 2026-09-03 \
  --symbols SPY,QQQ,SLV,GLD,IWM,MU,TSLA,META
```

Terminal 2:

```bash
pnpm agent
```

The agent continues writing canonical JSON under:

```text
workspace/research/<session-date>/cycle-<number>-<cycle-id>.json
```

During every collection cycle and at shutdown, the helper scans that root and imports valid research runs into `research_artifacts`. Import is content-hash-idempotent. The original research event ledger remains authoritative; the capture database is a correlated backtest evidence catalog.

The collector does not force the live research shortlist to equal the collector symbol list. The stored `ResearchReportV7`, `OptionUniverseSnapshotV2`, and `SymbolScreenResultV2` remain the authority for what the agent actually considered.

## Inspect collection status

```bash
pnpm backtest:v2:collect:inspect -- \
  --database workspace/backtest-v2/live-collection/options-forward.sqlite
```

The report includes:

- SQLite integrity check.
- Collection-run count and latest status.
- Latest bootstrap and retained contract count.
- Latest poll coverage.
- Quote counts by quality.
- Imported research-artifact count.

Useful direct queries:

```bash
sqlite3 -readonly workspace/backtest-v2/live-collection/options-forward.sqlite \
  "SELECT run_id, mode, status, session_date, started_at, completed_at FROM collection_runs ORDER BY started_at;"

sqlite3 -readonly workspace/backtest-v2/live-collection/options-forward.sqlite \
  "SELECT underlying, COUNT(*) AS contracts FROM option_contracts GROUP BY underlying ORDER BY underlying;"

sqlite3 -readonly workspace/backtest-v2/live-collection/options-forward.sqlite \
  "SELECT scheduled_at, session_state, requested_contract_count, fresh_count, stale_count, invalid_count, status FROM quote_poll_attempts ORDER BY scheduled_at;"

sqlite3 -readonly workspace/backtest-v2/live-collection/options-forward.sqlite \
  "SELECT quality, COUNT(*) AS observations FROM option_quote_observations GROUP BY quality ORDER BY quality;"

sqlite3 -readonly workspace/backtest-v2/live-collection/options-forward.sqlite \
  "SELECT session_date, cycle_number, cycle_id, outcome_status FROM research_artifacts ORDER BY session_date, cycle_number;"
```

## SQLite tables

| Table | Purpose |
|---|---|
| `collection_runs` | Mode, status, session date, and canonical configuration hash |
| `market_sessions` | Alpaca calendar open and close |
| `contract_bootstraps` | Contract request window, counts, and content hash |
| `underlying_spot_observations` | Spot used for point-in-time moneyness filtering |
| `option_contracts` | Current normalized contract identity and metadata |
| `contract_universe_membership` | Exact contracts retained by each bootstrap |
| `quote_poll_attempts` | Coverage and outcome of each scheduled poll |
| `option_quote_observations` | Bid, ask, size, provider time, receipt time, feed, age, and quality |
| `collection_quality_events` | Reserved bounded operational-quality events |
| `research_artifacts` | Canonical research-run JSON plus cycle and content-hash lineage |

## Quote quality

| Quality | Meaning | Replay eligibility |
|---|---|---:|
| `FRESH` | Inside session and no older than configured freshness | Candidate for sealing |
| `STALE` | Inside session but too old | No |
| `OUTSIDE_SESSION` | Retrieved outside official session | No |
| `MISSING` | Snapshot omitted the contract | No |
| `INVALID_PRICE` | Missing, zero, locked, crossed, or non-representable price | No |
| `INVALID_TIMESTAMP` | Provider time missing or invalid | No |
| `FUTURE_TIMESTAMP` | Provider time follows receipt time | No |

Repeated latest snapshots remain separate poll observations. Receipt time is never substituted for provider event time.

## Reference file structure

```text
greeks-in-the-loop/
├── config/backtest-v2/
│   └── live-collection.json
├── src/backtest-v2/live-collection/
│   ├── contracts-v1.ts
│   ├── alpaca-provider-v1.ts
│   ├── collection-store-v1.ts
│   ├── collector-v1.ts
│   ├── collector-cli.ts
│   ├── inspect-cli.ts
│   ├── seal-capture-v1.ts
│   └── e2e-smoke-cli.ts
├── tests/
│   ├── backtest-v2-live-collection.test.ts
│   └── backtest-v2-e2e-smoke.test.ts
├── docs/
│   ├── backtest-v2-helper.md
│   └── backtest-v2-plan.md
└── workspace/                         # gitignored real data
    ├── backtest-v2/live-collection/
    │   └── options-forward.sqlite
    ├── backtest-v2/e2e/minimal-fixture/
    │   ├── collection/capture.sqlite
    │   ├── dataset/historical.sqlite
    │   ├── replay/run.sqlite
    │   ├── e2e-summary.json
    │   └── report.md
    └── research/<session-date>/
        ├── cycle-*.json
        └── cycle-*.md
```

## Current boundary and next work

Implemented now:

- Direct Alpaca active-contract acquisition and pagination.
- Underlying snapshot filtering.
- Configurable symbol subsets.
- Durable batched latest option bid/ask polling.
- Explicit session and freshness quality labels.
- Research-artifact import and lineage.
- SQLite inspection.
- Minimal closed-window sealing of `FRESH` capture observations into the immutable replay schema.
- Credential-free collection → sealing → replay → P&L integration smoke test.

Still required before calling this an authoritative historical agent backtest:

1. Add a bounded real collector mode such as `--duration-minutes 10` / `--max-polls 10`, plus coverage approval before sealing.
2. Add a production sealing CLI and manifest warnings for real Alpaca captures; the current sealer is exercised by the deterministic helper.
3. Collect full daily and intraday underlying bars needed by `ResearchReportV7`.
4. Add point-in-time IV, Greeks, volume, open interest, event-risk, and surface-feature inputs.
5. Replay frozen `ResearchReportV7 → ResearchDecisionV4 → TradeIntentV4` instead of the current manual signal.
6. Replace one fixture `exitAt` with chronological quote-event monitoring.
7. Add WebSocket focused-leg collection after REST polling is calibrated.
8. Validate actual account entitlement, provider batch limits, and rate limits with the configured Alpaca plan.

A forward latest-snapshot collector cannot recover historical quotes from before it started and must not be labeled `EXACT_CHAIN_REPLAY`. A suitable eventual evidence label is `ONE_MINUTE_QUOTE_SNAPSHOT_REPLAY`.
