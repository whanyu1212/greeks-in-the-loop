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

- Application code discovers a bounded active, optionable universe each cycle and records a deterministic symbol screen in shadow mode; one research agent compares the exact universe snapshot and may propose up to three directional debit verticals.
- `evaluateTradeIntentRiskV1` in `src/risk/risk-evaluation-v1.ts` is pure: no I/O, history, database access, or ambient state.
- Only candidate identity crosses from research into risk. Application code refreshes quotes, contracts, account state, portfolio state, and clock data.
- Application code calculates vertical-spread Greeks from refreshed legs as long minus short; only signed directional net delta is currently a hard Greek limit.
- Money is integer cents; exit marks are half-cents per share.
- No order-submission code exists. Runtime ends with a shadow decision in the ledger.

## Pipeline

```text
OptionUniverseSnapshotV2
  -> SymbolScreenResultV1 (application-owned, shadow-only)
  -> ResearchReportV6
  -> validateResearchDecisionV3
  -> confirm exact-leg quotes
  -> deriveTradeIntentV3
  -> capture application-owned risk state
  -> evaluateTradeIntentRiskV1
  -> append ledger events
```

`src/index.ts` is the composition root. `src/research/cycle.ts` orchestrates one cycle.

## Boundaries

- `src/contracts/`: strict Zod trust boundaries and pure derivation.
- `src/research/`: orchestration and retained context; OpenCode agent policies live in `.opencode/agents/`.
- `src/market-data/`: read-only Alpaca normalization and freshness.
- `src/risk/`: state capture, reconciliation, pure risk gate, shadow result.
- `src/scheduling/`: standard and dry-run eligibility.
- `src/event-ledger/`: append-only SQLite lifecycle.
- `src/backtest/`: self-contained deterministic replay.

`opencode.json` is globally deny-by-default. The checked-in `research` agent has read-only market authority and no arbitrary skill-loading, shell, subagent, web, or broker-mutation authority. The separate `trader` agent may read Alpaca state and submit option orders only through the paper-pinned Alpaca MCP; it has no stock, crypto, cancellation, replacement, filesystem, or external-research authority. The application worker does not invoke the trader yet and still ends with a shadow decision.

## Contract rules

Current breaking contracts are `OptionUniverseSnapshotV2`, `ResearchDecisionV3`, `ResearchReportV6`, and `TradeIntentV3`. Schemas are strict on proposal paths; safe `NO_ACTION` strips irrelevant prose. Do not add compatibility parsers without an explicit requirement.

Failures expose bounded reason codes, never raw model or provider input.

## Dry run

`--dry-run` requires `--once` and uses an isolated ledger. Current-session dry runs may reach shadow risk; historical sessions are research-only. Dry run never weakens validation, freshness, risk, or permissions.

## Before changing rules

Read the relevant schema and every caller. Preserve the pure risk function and agent/application ownership boundary. Update contract versions on breaking changes. Verify with `pnpm typecheck && pnpm test && pnpm build`.
