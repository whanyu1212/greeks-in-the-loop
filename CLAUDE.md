# CLAUDE.md

## Commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm agent
pnpm agent:once
pnpm agent:once -- --dry-run [--session YYYY-MM-DD]
pnpm research:run
pnpm research:evaluate
pnpm risk:report
pnpm backtest -- --scenarios <json> [--output <json>]
```

Run one test with `pnpm vitest run tests/<file>.test.ts`. Node 22 and pnpm 10 are enforced.

## Central invariant

The agent proposes; deterministic code disposes.

- Application code discovers a bounded active, optionable universe each cycle and records a deterministic symbol-strategy screen in shadow mode; one research agent compares the exact universe snapshot and may propose up to three screened option strategies.
- Named Alpaca strategy families are actionable when their application screen passes; the generic `DEFINED_RISK_MLEG` catch-all remains `APPLICATION_SUPPORT_PENDING`.
- `evaluateTradeIntentRiskV1` in `src/risk/risk-evaluation-v1.ts` is pure: no I/O, history, database access, or ambient state.
- Only candidate identity crosses from research into risk. Application code refreshes quotes, contracts, account state, portfolio state, and clock data.
- Application code calculates position-weighted Greeks from refreshed ordered legs; signed directional net delta is the hard Greek limit for bullish and bearish strategies.
- Money is integer cents; exit marks are half-cents per share.
- Only the isolated `trader` agent may submit an order, and only from an immutable, unexpired, application-derived authorization through the paper-pinned Alpaca MCP. Research remains non-executing.

## Pipeline

```text
OptionUniverseSnapshotV2
  -> SymbolScreenResultV2 (application-owned actionability)
  -> ResearchReportV7
  -> validateResearchDecisionV4
  -> confirm exact-leg quotes
  -> deriveTradeIntentV4
  -> capture application-owned risk state
  -> refresh TradeIntentV4
  -> evaluateTradeIntentRiskV1
  -> append ledger events, including any eligible paper authorization
  -> isolated trader resolves the opaque authorization ID
```

`src/index.ts` is the composition root. `src/research/cycle.ts` orchestrates one cycle.

## Boundaries

- `src/contracts/`: strict Zod trust boundaries and pure derivation.
- `src/research/`: orchestration and retained context; OpenCode agent policies live in `.opencode/agents/`.
- `src/market-data/`: read-only Alpaca normalization and freshness.
- `src/risk/`: state capture, reconciliation, pure risk gate, shadow result.
- `src/scheduling/`: standard and dry-run eligibility.
- `src/event-ledger/`: append-only lifecycle with PostgreSQL deployment and deprecated SQLite local/test adapters isolated under `deprecated/`.
- `src/backtest/`: self-contained deterministic replay.

`opencode.json` is globally deny-by-default. The checked-in `research` agent has read-only market authority and no arbitrary skill-loading, shell, subagent, web, or broker-mutation authority. The separate `trader` agent may resolve one opaque ledger authorization, read Alpaca state, and submit option orders only through the paper-pinned Alpaca MCP; it has no stock, crypto, cancellation, replacement, filesystem, or external-research authority. The application invokes it in a separate session only for selected, risk-approved, positive-debit multi-leg authorizations. Credit, single-leg, expired, dry-run, and non-paper paths remain non-executing.

## Contract rules

Current breaking contracts are `OptionUniverseSnapshotV2`, `ResearchDecisionV4`, `ResearchReportV7`, and `TradeIntentV4`. Persisted V3/V6 decisions, reports, and trade intents remain readable. Schemas are strict on proposal paths; safe `NO_ACTION` strips irrelevant prose. Do not add other compatibility parsers without an explicit requirement.

Failures expose bounded reason codes, never raw model or provider input.

## Backtest

Replay `7.0.0` is the frozen historical V3 debit-spread model. Replay `8.0.0` evaluates V4 risk inputs and requires explicit natural close-premium marks, per-leg entry and exit slippage, commissions, stop/profit thresholds, minimum DTE, and maximum holding sessions. These assumptions are retained in output; missing exit prices make the aggregate incomplete rather than fabricating a fill.

`pnpm backtest:bars -- --manifest <json> --output <json>` is a manual, credentialed offline adapter for exact historical bull-call and bear-put manifests. It uses only completed Alpaca account-default option trade bars (expected indicative on the configured free tier), retains synthetic spread, liquidity, account, and European-model Greek assumptions, and delegates unchanged V8 inputs to `runBacktestReplay`. Never run its live Alpaca requests in ordinary PR CI or treat proxy approval as historical NBBO evidence.

## Dry run

`--dry-run` requires `--once` and uses an isolated ledger. Current-session dry runs may reach shadow risk; historical sessions are research-only. Dry runs have no elapsed-time cycle deadline by default; set `AGENT_CYCLE_TIMEOUT_MS` to opt into one. Shutdown still cancels unbounded runs. Dry run never weakens validation, freshness, risk, or permissions.

## Before changing rules

Read the relevant schema and every caller. Preserve the pure risk function and agent/application ownership boundary. Update contract versions on breaking changes. Verify with `pnpm typecheck && pnpm test && pnpm build`.
