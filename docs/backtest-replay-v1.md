# Backtest Replay V1

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

The command reads `ALPACA_API_KEY` and `ALPACA_SECRET_KEY`, downloads directly
from Alpaca, and writes `.state/backtests/<dataset-id>.sqlite`. The final date
must be earlier than the acquisition date so partial sessions cannot enter a
dataset. The immutable `requestStartedAt` must be at least 15 minutes after the
exact historical request end. Calendar and SPY daily bars include a fixed 90-calendar-day warm-up for
SMA50. The requested interval is used for minute bars and option data.

Each normalized request is an immutable partition. Page tokens and normalized
records are committed atomically, so rerunning the same command resumes an
interrupted download and skips completed partitions. A changed request must use
a new dataset ID. The requested option-symbol set is part of the immutable
dataset definition, and the manifest is complete only when every declared base
and option partition is sealed. The manifest and every completed partition have
deterministic SHA-256 checksums.

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
  --dataset .state/backtests/SPY-2024-06-03-2024-06-28.sqlite \
  --scenarios scenarios.json \
  --output report.json
```

`scenarios.json` is validated by `backtestReplayInputV1Schema` in
`src/backtest/replay-v1.ts`. It fixes the replay and execution-model versions,
slippage in half-cents per share, commission in cents per contract, and an
ordered list of scenarios. Omitting `--output` prints the report.

The report includes dataset identity and checksum, fidelity counts, trade count,
P&L, return, maximum drawdown, hit rate, risk rejection counts, per-scenario
results, and its own deterministic checksum. Scenario order defines the equity
curve.

## Fidelity modes

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
