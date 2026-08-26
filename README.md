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

Run an isolated one-cycle smoke test without touching the default ledger. Setting an earlier research-window start is useful when exercising pre-market research; Alpaca's calendar still determines whether the date is a trading session and when the research window closes.

```bash
RESEARCH_LEDGER_PATH=.state/manual-dry-run.sqlite AGENT_PREMARKET_START_ET=07:00 AGENT_CYCLE_TIMEOUT_MS=300000 pnpm agent:once
```

This is a dry run with respect to trading, not data access or local storage: it uses live read-only providers as the cycle requires and writes the isolated SQLite ledger plus a JSON artifact. Substantive research requires Exa; FMP context is optional. Use a new `RESEARCH_LEDGER_PATH` when testing a branch whose migrations differ from an existing local ledger.

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

The worker creates a fresh OpenCode session for every cycle and shuts down cleanly on `SIGINT` or `SIGTERM`. Every cycle selects the checked-in `research` agent; this identity cannot be overridden through `.env`. Each eligible cycle durably records exactly one bounded outcome: `VALIDATED_NO_ACTION`, `PRELIMINARY_RESEARCH_RETAINED`, `DECISION_REJECTED`, `INTENT_DERIVATION_REJECTED`, or `INTENT_DERIVED`. Cycles outside the configured research window are skipped before an OpenCode session is created.

The append-only SQLite event ledger defaults to `.state/research-ledger.sqlite`; override it with `RESEARCH_LEDGER_PATH` only when the worker retains exclusive write ownership. On startup, incomplete cycles are marked `PROCESS_RESTART`, cycle numbering resumes from durable history, and a bounded context projection is rebuilt for the next prompt. Prior evidence is planning context only and must be refreshed. OpenCode session memory is never authoritative durable state.

Every completed eligible cycle also writes its validated outcome and, when the agent returned a valid contract, the full bounded [`ResearchReportV2`](docs/research-report-v2.md) dossier as inspection-only JSON under `workspace/research/<session-date>/cycle-<number>-<cycle-id>.json`. The dossier retains normalized account checks, market-regime calculations, option diagnostics, mandatory timestamped Exa context, supporting and contradicting factors, and conflicts. Agent-reported analysis remains distinct from application-confirmed quotes. The artifact never contains the raw model response and is not authoritative; a write failure does not undo the durable ledger outcome.

## Inspect a run

List generated reports and open one with `jq`:

```bash
rg --files workspace/research | sort
jq . workspace/research/<session-date>/cycle-<number>-<cycle-id>.json
```

Inspect the event timeline or the validated JSON payloads in a ledger:

```bash
sqlite3 .state/manual-dry-run.sqlite "SELECT sequence, event_type, occurred_at FROM ledger_events ORDER BY sequence;"
sqlite3 -json .state/manual-dry-run.sqlite "SELECT sequence, event_type, json(payload_json) AS payload FROM ledger_events ORDER BY sequence;"
```

To inspect exact quotes and calculated spread economics when an intent was successfully derived:

```bash
sqlite3 -json .state/manual-dry-run.sqlite "SELECT json(payload_json) AS trade_intent FROM ledger_events WHERE event_type = 'TRADE_INTENT_DERIVED' ORDER BY sequence DESC LIMIT 1;"
```

## What gets saved

SQLite stores an append-only event stream in `ledger_events`. Each row contains event identity, version, timestamps, correlation/causation identifiers, cycle and session identifiers, and a schema-validated `payload_json`.

| Data | SQLite | JSON artifact | Notes |
| --- | --- | --- | --- |
| Session and cycle lifecycle | Yes | Cycle identity only | Includes starts, completion status, interruptions, and bounded interruption reasons. |
| Full bounded `ResearchReportV2` | Yes, as `RESEARCH_REPORT_RECORDED` | Yes | Includes agent-reported account checks, market regime and indicators, optional candidate Greeks/liquidity diagnostics, Exa citations, optional FMP context, supporting and contradicting factors, and conflicts. |
| Preliminary research | Yes, as `PRELIMINARY_RESEARCH_RECORDED` | Yes, inside the outcome/report | Retains thesis, direction, candidate identity when present, invalidations, evidence, and the mandatory-refresh marker. It cannot directly become a trade intent. |
| Validated decision | Yes, as `RESEARCH_DECISION_VALIDATED` | Yes, inside the outcome/report | Records `NO_ACTION` or the validated proposal contract. |
| Evidence snapshot reference | Yes, as `EVIDENCE_SNAPSHOT_REFERENCED` | Through the outcome where applicable | Stores reference, provider, source, retrieval/freshness timestamps, and temporal class—not the raw provider response. |
| Confirmed exact-leg option quotes | Only after successful intent derivation, inside `TRADE_INTENT_DERIVED` | Yes, inside the derived outcome | Stores each OCC symbol, indicative feed label, bid and ask in integer cents per share, and provider timestamp. If quote confirmation or intent derivation fails, exact bid/ask values are not retained. |
| Derived spread economics | Only after successful intent derivation | Yes, inside the derived outcome | Includes evaluated time, entry limit, width, maximum loss/profit, and deterministic stop/target marks. It is still non-executable. |
| Rejections | Yes | Yes, inside the outcome | Stores bounded reason codes or validation issue codes/paths, not rejected raw content. |

The JSON artifact is intended for humans and downstream inspection. The SQLite ledger is the authoritative restart/audit record; artifact-write failure does not roll back a committed ledger outcome.

The project intentionally does **not** retain raw model responses, hidden reasoning, full OpenCode transcripts, raw Alpaca/FMP/Exa responses, credentials, or secret-bearing URLs. The bounded report is the retained analysis record, and all its observations remain labeled `AGENT_REPORTED`; only application-confirmed quotes and deterministic intent calculations cross that trust boundary.

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
