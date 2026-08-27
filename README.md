# greeks-in-the-loop

Read-only paper-trading research agent built with the OpenCode SDK, Alpaca, Financial Modeling Prep, and Exa.

The worker is intentionally non-executing. Its dedicated `research` agent can inspect read-only paper-account and market data, gather FMP and Exa evidence, write artifacts under `workspace/`, and emit a validated `ResearchDecisionV1` or non-executable `PreliminaryResearchV1`. Preliminary findings are durably carried forward for mandatory refresh. Only an eligible regular-session proposal is confirmed against a fresh, application-owned Alpaca indicative quote snapshot and deterministically converted into a non-executable `TradeIntentV1` for future risk evaluation.

The research agent is deny-by-default: broker mutations, generic shell execution, source edits, external-directory access, subagents, and unreviewed tools are unavailable. The managed runtime ignores user-global OpenCode plugins and MCP configuration, and each project MCP process receives only its own credentials. Risk and execution authority remain outside OpenCode.

## Strategy

The frozen MVP strategy is documented in [SPY Directional Debit Spreads](docs/strategy-v1.md). It assumes the project will remain on the free Alpaca Basic data tier. The specification defines future risk and execution behavior; the current worker remains non-executing and produces pre-risk intents only.

## Requirements

- Node.js 22
- pnpm 10
- Python 3.10+ and `uvx`
- Alpaca paper-trading, FMP, and Exa API keys

## Setup

```bash
pnpm install
cp .env.example .env
```

Populate `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `FMP_API_KEY`, and `EXA_API_KEY` in `.env`. `ALPACA_MARKET_DATA_BASE_URL` defaults to `https://data.alpaca.markets` and normally does not need to change.

## What you can run

Run one live research cycle. This reads the configured paper account and external data sources, writes local state, and never submits an order:

```bash
pnpm agent:once
```

Run continuously at `AGENT_INTERVAL_MS` (five minutes by default):

```bash
pnpm agent
```

Run one research-only cycle at any time on the current Alpaca trading date:

```bash
AGENT_CYCLE_TIMEOUT_MS=300000 pnpm agent:research-anytime
```

This mode bypasses only the time-of-day research window. Alpaca's calendar must
still identify today in New York as a trading date. The cycle is durably marked
`DRY_RUN_ANYTIME`, cannot open a trade-intent window, and cannot derive an
intent even if the model proposes one. It uses live read-only providers and
writes a dedicated `.state/research-anytime.sqlite` ledger plus the normal JSON
export. Substantive research requires Exa; FMP context is optional. No `.env`
change is required.

To use another isolated ledger, pass it explicitly. The command rejects the
configured production ledger:

```bash
pnpm agent:research-anytime -- --ledger .state/quality-run.sqlite
```

Build and run the compiled worker:

```bash
pnpm build
node dist/index.js --once
```

Useful environment controls are documented in [`.env.example`](.env.example):

| Setting | Purpose |
| --- | --- |
| `RESEARCH_LEDGER_PATH` | Selects the exclusively owned SQLite ledger. |
| `AGENT_PREMARKET_START_ET` | Sets the earliest research time on an Alpaca trading date, in `America/New_York`. |
| `AGENT_CYCLE_TIMEOUT_MS` | Limits one model/research cycle. Live research may need more than the 120-second default. |
| `AGENT_INTERVAL_MS` | Controls continuous-run spacing. |
| `AGENT_MAX_CYCLES` | Stops a continuous run after a bounded number of attempts. |
| `AGENT_TASK` | Adds an operator objective to the structured research prompt. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Optionally enables fail-open OTLP HTTP/protobuf tracing. See [Research tracing](docs/observability.md). |

The worker creates a fresh OpenCode session for every cycle and shuts down cleanly on `SIGINT` or `SIGTERM`. Every cycle selects the checked-in `research` agent; this identity cannot be overridden through `.env`. Each eligible cycle durably records exactly one bounded outcome: `VALIDATED_NO_ACTION`, `PRELIMINARY_RESEARCH_RETAINED`, `DECISION_REJECTED`, `INTENT_DERIVATION_REJECTED`, or `INTENT_DERIVED`. Cycles outside the configured research window are skipped before an OpenCode session is created.

The append-only SQLite event ledger defaults to `.state/research-ledger.sqlite`; override it with `RESEARCH_LEDGER_PATH` only when the worker retains exclusive write ownership. On startup, incomplete cycles are marked `PROCESS_RESTART`, cycle numbering resumes from durable history, and a bounded context projection is rebuilt for the next prompt. Prior evidence is planning context only and must be refreshed. OpenCode session memory is never authoritative durable state.

The anytime command intentionally ignores `RESEARCH_LEDGER_PATH` unless it is
needed to detect an unsafe collision. Its default ledger is isolated so dry-run
research cannot enter the normal worker's durable prompt context.

Every completed eligible cycle is projected into a versioned `ResearchRunV1` after the worker rereads its committed events. The projection consolidates cycle identity and timing, initial eligibility, evidence snapshot references, the validated outcome and intermediate records, the full bounded [`ResearchReportV2`](docs/research-report-v2.md), and ledger sequence metadata. A byte-for-byte regenerable inspection-only JSON export is then written under `workspace/research/<session-date>/cycle-<number>-<cycle-id>.json`. SQLite is the sole source of truth: the worker never builds the export from a separate in-memory result, and an export failure does not undo the committed ledger outcome.

## Inspect a run

Show the latest completed run directly from an isolated ledger, or select a cycle:

```bash
pnpm research:run -- --ledger .state/research-anytime.sqlite
pnpm research:run -- --ledger .state/research-anytime.sqlite --cycle <cycle-id>
```

Regenerate its human-readable JSON export from SQLite (`--force` replaces an existing export):

```bash
pnpm research:run -- --ledger .state/research-anytime.sqlite --export --force
```

Inspect the event timeline or the validated JSON payloads in a ledger:

```bash
sqlite3 .state/research-anytime.sqlite "SELECT sequence, event_type, occurred_at FROM ledger_events ORDER BY sequence;"
sqlite3 -json .state/research-anytime.sqlite "SELECT sequence, event_type, json(payload_json) AS payload FROM ledger_events ORDER BY sequence;"
```

To inspect exact quotes and calculated spread economics when an intent was successfully derived:

```bash
sqlite3 -json .state/research-ledger.sqlite "SELECT json(payload_json) AS trade_intent FROM ledger_events WHERE event_type = 'TRADE_INTENT_DERIVED' ORDER BY sequence DESC LIMIT 1;"
```

## What gets saved

SQLite stores an append-only event stream in `ledger_events`. Each row contains event identity, version, timestamps, correlation/causation identifiers, cycle and session identifiers, and a schema-validated `payload_json`.

| Data | SQLite | JSON artifact | Notes |
| --- | --- | --- | --- |
| Session and cycle lifecycle | Yes | Yes | Includes cycle/session identity, timing, initial eligibility, completion status, and ledger sequence metadata. Interruptions remain in SQLite but are not exported as completed runs. |
| Full bounded `ResearchReportV2` | Yes, as `RESEARCH_REPORT_RECORDED` | Yes | Includes agent-reported account checks, market regime and indicators, optional candidate Greeks/liquidity diagnostics, Exa citations, optional FMP context, supporting and contradicting factors, and conflicts. |
| Preliminary research | Yes, as `PRELIMINARY_RESEARCH_RECORDED` | Yes, inside the outcome/report | Retains thesis, direction, candidate identity when present, invalidations, evidence, and the mandatory-refresh marker. It cannot directly become a trade intent. |
| Validated decision | Yes, as `RESEARCH_DECISION_VALIDATED` | Yes, inside the outcome/report | Records `NO_ACTION` or the validated proposal contract. |
| Evidence snapshot reference | Yes, as `EVIDENCE_SNAPSHOT_REFERENCED` | Yes, as a consolidated list | Stores reference, provider, source, retrieval/freshness timestamps, and temporal class—not the raw provider response. |
| Confirmed exact-leg option quotes | Only after successful intent derivation, inside `TRADE_INTENT_DERIVED` | Yes, inside the derived outcome | Stores each OCC symbol, indicative feed label, bid and ask in integer cents per share, and provider timestamp. If quote confirmation or intent derivation fails, exact bid/ask values are not retained. |
| Derived spread economics | Only after successful intent derivation | Yes, inside the derived outcome | Includes evaluated time, entry limit, width, maximum loss/profit, and deterministic stop/target marks. It is still non-executable. |
| Rejections | Yes | Yes, inside the outcome | Stores bounded reason codes or validation issue codes/paths, not rejected raw content. |

The JSON artifact is a deterministic `ResearchRunV1` view intended for humans and downstream inspection. It can be deleted and regenerated from SQLite. The SQLite ledger is the authoritative restart/audit record; artifact-write failure does not roll back a committed ledger outcome.

The project intentionally does **not** retain raw model responses, hidden reasoning, full OpenCode transcripts, raw Alpaca/FMP/Exa responses, credentials, or secret-bearing URLs. The bounded report is the retained analysis record, and all its observations remain labeled `AGENT_REPORTED`; only application-confirmed quotes and deterministic intent calculations cross that trust boundary.

## Offline evaluation

Evaluate the latest completed run, or select one by cycle ID:

```bash
pnpm research:evaluate
pnpm research:evaluate -- --cycle <cycle-id>
pnpm research:evaluate -- --ledger .state/research-anytime.sqlite
pnpm research:evaluate -- --ledger .state/research-anytime.sqlite --cycle <cycle-id>
```

The command reads SQLite without changing it and prints a deterministic,
content-free `ResearchRunEvaluationV1` JSON result. Failed dimensions are
reported as data and do not make the command fail; a missing, interrupted, or
invalid run does. See [Offline research evaluation](docs/research-evaluation.md)
for the dimensions, privacy boundary, and current limitations.

## Backtest replay

Acquire a resumable, checksummed Alpaca dataset for fully completed historical
dates. Repeat `--option` for each retained spread leg whose bars and trades are
needed:

```bash
pnpm backtest:data -- --from 2024-06-03 --to 2024-06-28 \
  --option SPY240621C00530000 --option SPY240621C00535000
```

Run the standalone deterministic replay against that immutable SQLite dataset:

```bash
pnpm backtest -- --dataset .state/backtests/SPY-2024-06-03-2024-06-28.sqlite \
  --scenarios scenarios.json --output report.json
```

Exact forward-captured snapshots rerun the strategy signal, production risk
rules, and candidate ranking. Historical option-bar runs are explicitly labeled
proxy fidelity and cannot claim historical signal or risk approval. See
[Backtest Replay V1](docs/backtest-replay-v1.md) for scenario contracts,
execution assumptions, output metrics, and Alpaca data limitations.

## Observability

Optional manual OpenTelemetry/OpenInference tracing shows coarse research-cycle
timing and outcomes without copying research content into the telemetry
backend. It is disabled by default, fails open, works with OTLP-compatible
backends such as Phoenix, and does not alter the SQLite audit record. See
[Research tracing](docs/observability.md) for configuration, backend examples,
the exact span/attribute boundary, and intentionally deferred work.

## Research procedure

Every unattended cycle loads the project-local `spy-debit-spread-research` skill. The checklist and [source/freshness policy](docs/research-source-policy.md) define source precedence, evidence classification, stale-data handling, conflict resolution, candidate eligibility, and fail-closed `NO_ACTION` behavior. Alpaca remains authoritative for broker and market facts. Exa evidence is mandatory once a cycle reaches substantive research; FMP is optional supporting context and cannot replace Exa.

## Security boundary

OpenCode permissions enforce the agent's tool and workspace boundary. Application code independently validates `ResearchDecisionV1`, retrieves trusted option quotes, and derives `TradeIntentV1`. Prompt instructions describe desired behavior but are not treated as an authorization control.

Generated artifacts are ignored by Git and may be written only under `workspace/`. Generic shell access is intentionally disabled because OpenCode command permissions do not provide a filesystem or environment sandbox.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm agent:config
pnpm agent:mcp
pnpm agent:skills
```

The resolved agent must deny unknown tools and broker mutations. The MCP check requires configured credentials and should report only Alpaca, FMP, and Exa.
