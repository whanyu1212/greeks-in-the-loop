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

- One research agent selects among `SPY`, `QQQ`, and `IWM`, performs strategy-driven research, and returns at most one directional debit vertical.
- `evaluateTradeIntentRiskV1` in `src/risk/risk-evaluation-v1.ts` is pure: no I/O, history, database access, or ambient state.
- Only candidate identity crosses from research into risk. Application code refreshes quotes, contracts, account state, portfolio state, and clock data.
- Money is integer cents; exit marks are half-cents per share.
- No order-submission code exists. Runtime ends with a shadow decision in the ledger.

## Pipeline

```text
ResearchReportV3
  -> validateResearchDecisionV2
  -> confirm exact-leg quotes
  -> deriveTradeIntentV2
  -> capture application-owned risk state
  -> evaluateTradeIntentRiskV1
  -> append ledger events
```

`src/index.ts` is the composition root. `src/research/research-cycle.ts` orchestrates one cycle.

## Boundaries

- `src/contracts/`: strict Zod trust boundaries and pure derivation.
- `src/research/`: generic agent prompt, orchestration, retained context.
- `src/market-data/`: read-only Alpaca normalization and freshness.
- `src/risk/`: state capture, reconciliation, pure risk gate, shadow result.
- `src/scheduling/`: standard and dry-run eligibility.
- `src/event-ledger/`: append-only SQLite lifecycle.
- `src/backtest/`: self-contained deterministic replay.

`opencode.json` is deny-by-default. The research agent has no shell, subagent, skill, arbitrary web, or broker-mutation authority. It can write only under `workspace/`.

## Contract rules

Current breaking contracts are `ResearchDecisionV2`, `PreliminaryResearchV2`, `TradeIntentV2`, and `ResearchReportV3`. Schemas are strict on proposal paths; safe `NO_ACTION` strips irrelevant prose. Do not add compatibility parsers without an explicit requirement.

Failures expose bounded reason codes, never raw model or provider input.

## Dry run

`--dry-run` requires `--once` and uses an isolated ledger. Current-session dry runs may reach shadow risk; historical sessions are research-only. Dry run never weakens validation, freshness, risk, or permissions.

## Before changing rules

Read the relevant schema and every caller. Preserve the pure risk function and agent/application ownership boundary. Update contract versions on breaking changes. Verify with `pnpm typecheck && pnpm test && pnpm build`.
