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
pnpm agent -- --execute
pnpm execute:mock -- --long <OCC> --short <OCC> [--confirm]
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
- Order submission lives in `src/execution/`, reached only from application code after an `APPROVED` shadow decision is durably recorded. It is off unless `--execute` is passed, and is refused under `--dry-run`.
- No agent has execution authority. Per architecture plan section 6.A, deterministic code calls the Alpaca paper Trading API; the Alpaca MCP mutation tool is never enabled for a model. The `trader` agent and its authorization modules remain in the tree but are not wired into the executing path.

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
  -> append ledger events
  -> executeApprovedTradeV1 (only with --execute)
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
- `src/execution/`: pure order derivation, the only broker-mutating client, and crash-safe submission.

`opencode.json` is globally deny-by-default. The checked-in `research` agent has read-only market authority and no arbitrary skill-loading, shell, subagent, web, or broker-mutation authority. The separate `trader` agent may resolve one opaque ledger authorization, read Alpaca state, and submit option orders only through the paper-pinned Alpaca MCP; it has no stock, crypto, cancellation, replacement, filesystem, or external-research authority. The application invokes it in a separate session only for selected, risk-approved, positive-debit multi-leg authorizations. Credit, single-leg, expired, dry-run, and non-paper paths remain non-executing.

## Contract rules

Current breaking contracts are `OptionUniverseSnapshotV2`, `ResearchDecisionV4`, `ResearchReportV7`, and `TradeIntentV4`. Persisted V3/V6 decisions, reports, and trade intents remain readable. Schemas are strict on proposal paths; safe `NO_ACTION` strips irrelevant prose. Do not add other compatibility parsers without an explicit requirement.

Failures expose bounded reason codes, never raw model or provider input.

## Execution

`ORDER_SUBMITTED` is appended before the broker call, so a crash always leaves a
record that startup reconciliation resolves by client order id; it never
resubmits. The cycle id is the idempotency key in both the ledger (partial
unique index) and at the broker (`client_order_id`). SQLite migration 008 and
PostgreSQL migration 003 make an order that skipped the risk gate
unrepresentable.

`pnpm execute:mock` drives one real paper order using real quotes and the real
risk function over synthetic account, portfolio, contract, and window state. Use
it to exercise the execution path; it refuses the production ledger and any
non-paper endpoint.

## Backtest

Replay `7.0.0` is the frozen historical V3 debit-spread model. Replay `8.0.0` evaluates V4 risk inputs and requires explicit natural close-premium marks, per-leg entry and exit slippage, commissions, stop/profit thresholds, minimum DTE, and maximum holding sessions. These assumptions are retained in output; missing exit prices make the aggregate incomplete rather than fabricating a fill.

## Dry run

`--dry-run` requires `--once` and uses an isolated ledger. Current-session dry runs may reach shadow risk; historical sessions are research-only. Dry runs have no elapsed-time cycle deadline by default; set `AGENT_CYCLE_TIMEOUT_MS` to opt into one. Shutdown still cancels unbounded runs. Dry run never weakens validation, freshness, risk, or permissions.

## Before changing rules

Read the relevant schema and every caller. Preserve the pure risk function and agent/application ownership boundary. Update contract versions on breaking changes. Verify with `pnpm typecheck && pnpm test && pnpm build`.
