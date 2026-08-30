# Backtest Replay V1 and V2

Backtest replay is a standalone, read-only component. It has no broker mutation
dependency and cannot submit orders. It uses a separate SQLite file; the live
research event ledger is never opened or changed.

## Acquire a dataset

```bash
pnpm backtest:data -- \
  --from 2024-06-03 \
  --to 2024-06-28 \
  --option SPY240621C00530000 \
  --option SPY240621C00535000
```

The command reads `ALPACA_API_KEY` and `ALPACA_SECRET_KEY`, resolves the current
compile-time strategy manifest, downloads directly from Alpaca, and writes
`.state/backtests/<content-id>.sqlite`. The content-derived ID binds the complete
strategy/component manifest, explicit replay-executable feature/ranking/risk/exit
component identities, underlying, date range, data versions, historical
feed identity, and sorted retained option symbols. It deliberately excludes
`requestStartedAt`, so rerunning the same acquisition scope resolves the same
default file and resumes its original immutable request.

The final date must be earlier than the acquisition date so partial sessions
cannot enter a dataset. The immutable `requestStartedAt` must be at least 15
minutes after the exact historical request end. Calendar and underlying daily
bars include a fixed 90-calendar-day warm-up for SMA50. The requested interval
is used for minute bars and option data.

New acquisitions use manifest-bound Dataset V2. Current definitions bind the
V2 replay exit tuple (`simulateReplayScenario@1.0.0`). Its schema is
symbol-neutral, but the CLI can select only a manifest admitted by the
compile-time registry; the current registry therefore remains SPY-only. Generic
dataset decoding does not admit QQQ/IWM to runtime research.

Each normalized request is an immutable partition. Page tokens and normalized
records are committed atomically, so rerunning the same command resumes an
interrupted download and skips completed partitions. A changed acquisition
scope derives a new dataset ID. The requested option-symbol set is part of the
immutable dataset definition, and option bars/trades outside that explicit set
fail closed. Underlying and option records must match the embedded manifest
symbol. The manifest is complete only when every declared base and option
partition is sealed. The manifest and every completed partition have
deterministic SHA-256 checksums.

Legacy Dataset V1 SQLite files retain their original SPY-only definition,
partition names, record bytes, and checksums. They are decoded without being
rewritten. Dataset V2 uses neutral `underlying-daily` and
`underlying-minute` partition names with the same physical SQLite schema.

Option bars and trades are acquired only for explicit, repeated `--option`
symbols. This prevents an unbounded chain download and avoids pretending that
today's contract endpoint is a historical point-in-time chain.

Alpaca's historical option bars and trades endpoints do not accept a feed
parameter. The dataset therefore records `ALPACA_ACCOUNT_DEFAULT`; Alpaca
selects the historical source available to the authenticated account. This is
separate from latest quote and snapshot endpoints, which do accept explicit
`indicative` or `opra` feeds.

## Run a replay

```bash
pnpm backtest -- \
  --dataset .state/backtests/<content-id>.sqlite \
  --scenarios scenarios.json \
  --output report.json
```

`scenarios.json` selects its parser by `replayVersion`: Replay V1 uses
`backtestReplayInputV1Schema` and Replay V2 uses `backtestReplayInputV2Schema`.
Both fix execution slippage in half-cents per share, commission in cents per
contract, and an ordered list of scenarios. Omitting `--output` prints the
report.

| Dataset tuple | Replay V1 | Replay V2 |
| --- | --- | --- |
| Legacy Dataset V1 | Supported | Rejected |
| Dataset V2 with retained V1 replay/exit tuple | Supported | Rejected |
| Dataset V2 with current V2 replay/exit tuple | Rejected | Supported |

Replay V1 retains its original report bytes and can execute a retained Dataset
V2 + Replay V1 tuple even though the current registry is V2. Dataset and
snapshot schemas remain structurally decodable across these tuples; execution
admission is version-specific.

### Replay V2 identity and exact flow

A V2 scenario ID is the SHA-256 of the canonical scenario content (under a V2
domain tag) without `scenarioId`. The schema rejects a mismatched hash and
duplicate IDs. Scenario-file ordering does not affect those IDs, although
scenario order still defines the report equity curve.

V2 requires a complete Dataset V2. Every exact snapshot pair must validate and
its complete embedded strategy manifest must canonically equal the dataset
manifest. Resolution is a static allowlist of the recorded V2 feature, ranking,
risk, exit, and execution tuples; it does not look up the mutable current
registry. Manifest, component, replay, execution, snapshot-contract, dataset
identity, or symbol drift fails closed. Synthetic QQQ definitions stay
structurally decodable but are not admitted for V2 execution.

An exact scenario re-screens that immutable snapshot. `NO_ACTION` must omit
risk input. A selected path accepts exactly one fully snapshot-bound risk input:
the screener's rank-one candidate fixes both legs, all economics, quote snapshot
reference, eligibility calendar and timing, and contract metrics. Risk rejection
is `NO_ENTRY`; V2 never tries another candidate. Approved risk then uses the
frozen exit simulation.

V2 proxy scenarios retain their intent and use retained dataset records to
derive monitor cycles when cycles are omitted. They report signal and risk as
`NOT_EVALUABLE` and cannot claim historical candidate selection or approval.
They remain exit-mechanics evidence only.

The report includes dataset provenance, full strategy/component identity,
execution identity, fidelity counts, P&L, risk rejection counts, results, and a
deterministic checksum over its canonical content. The checksum changes when
provenance, execution, or results change.

Plan-driven behavior evaluation is intentionally deferred to the final #57 PR;
replay never invokes a model or evaluates prompt behavior.

## Replay V1 fidelity modes

`EXACT_SNAPSHOT` contains the expected 50-session calendar, one dated completed
daily bar for each of those sessions, and every uniquely dated completed
regular-session minute bar through the retained observation instant,
the same-session IEX underlying quote with provider time, candidate intents,
historical option quotes and Greeks,
account state, reconciled portfolio, and contract metadata at one decision
instant. Replay recalculates the strict SMA/VWAP signal, runs the production
`evaluateTradeIntentRiskV1` rules for every candidate, and applies the frozen
lexicographic candidate ranking. Snapshot validation rejects missing, duplicate,
out-of-order, cross-session, or candidate-misaligned signal evidence before a
result can claim exact fidelity. The underlying quote must be no later than the
observation instant and no more than 60 seconds old both then and at every
candidate approval evaluation. Exact snapshots must be captured forward; the
Alpaca historical API cannot recreate them.
All exact candidates share one application-owned eligibility, account, and
portfolio approval context; only their contract snapshots may differ.
Every retained exact signal bar declares the strategy-required `IEX` feed, and
daily bars additionally retain `adjustment=all` provenance.
All 50 exact daily dates must match the retained market calendar.

`HISTORICAL_BAR_PROXY` contains a retained `TradeIntentV1`. When monitor cycles
are omitted, replay derives them from synchronized long/short option minute bars
in the selected SQLite dataset. The conservative spread mark is long-bar low
minus short-bar high. These runs always report signal and risk as
`NOT_EVALUABLE`; they never claim that the strategy would have selected or
approved the spread historically.

Both modes evaluate the strategy exit priority deterministically. Entry fill is
the retained entry limit; configured entry slippage is charged as an explicit
conservative cost so a limit fill is never reported above its limit. Exit fill
is the selected open-market mark less configured slippage. Explicit monitor DTE
must equal the calendar-day distance from its New York date to contract
expiration, and implicit proxy runs require both retained legs in the dataset
manifest and an entry session inside its acquired date interval. Four
per-contract commissions are charged for
the two-leg entry and two-leg exit. `BACKTEST_EXECUTION_MODEL_VERSION` changes
when these assumptions change.

A mark-independent exit without an observed execution mark is reported as
`EXIT_UNPRICED` with `pnlCents: null`; it is counted separately and never
silently valued at zero. A nonpositive bar-derived spread mark is a valid zero
observation and can trigger the stop-loss rule. If synchronized proxy marks stop,
the first retained five-minute open-market boundary is emitted as an unpriced
stale-data exit; closed-market time is not counted. All supplied and derived
marks are bounded by the vertical spread's contractual width.
An end-of-replay valuation uses the last open-market cycle; when none exists,
the exit remains unpriced.
Explicit holding-session indices must match the retained market calendar from
the intent entry session through each monitor cycle, and minutes to close are
recomputed from that cycle's retained session close.
Cycles marked open must fall within the retained session's open and close
instants. CLI report output is rejected when it aliases the SQLite dataset by
path, symlink, or hard link, and the same protection applies to the scenario
input JSON.
Explicit trend fields are accepted only when they match the prior 20 retained
daily bars, and late-fill protection remains latched once observed.

## Known limitations

- Alpaca historical options coverage begins in February 2024.
- Historical bars and trades do not reconstruct point-in-time NBBO quotes.
- Historical chains, Greeks, implied volatility, and open-interest history are
  unavailable unless captured separately.
- A proxy run requires a retained intent or explicit leg pair; it cannot perform
  historically exact contract discovery, entry approval, or fill simulation.
- Bar-derived marks are stress-style proxies, not evidence of an executable
  indicative or OPRA price.

These limitations are also retained in every dataset manifest.
