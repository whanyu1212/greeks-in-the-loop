# greeks-in-the-loop

A non-executing options research worker. One agent selects the best current opportunity from a small ETF universe, researches it, and proposes at most one directional debit spread. Deterministic application code validates the proposal, refreshes financial inputs, and runs the risk gate.

No order-submission code exists in this repository.

## Pipeline

```text
research + strategy selection (agent)
  -> ResearchReportV3
  -> ResearchDecisionV2 / PreliminaryResearchV2
  -> application-owned quote confirmation
  -> TradeIntentV2
  -> deterministic shadow risk gate
  -> append-only ledger
```

The agent may choose one of `SPY`, `QQQ`, or `IWM`. It may propose only a `BULL_CALL_SPREAD` or `BEAR_PUT_SPREAD`. The allowlist is intentionally small; add another underlying only when liquidity and operational evidence justify it.

The central invariant is: **the agent proposes; deterministic code disposes**. Research never supplies trusted prices, account state, buying power, sizing, or risk approval.

## Setup

Requires Node 22 and pnpm 10.

```bash
pnpm install
cp .env.example .env
pnpm typecheck
pnpm test
```

Required credentials are `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `FMP_API_KEY`, and `EXA_API_KEY`. Alpaca access is read-only from the agent's perspective; application adapters also use read-only account, calendar, contract, and market-data endpoints.

## Run

```bash
pnpm agent
pnpm agent:once
```

Standard mode researches only within the application-owned market window. The production ledger defaults to `.state/research-ledger.sqlite`.

### Dry run

```bash
# Current New York trading date, or latest completed session if today has none
pnpm agent:once -- --dry-run

# Explicit trading session
pnpm agent:once -- --dry-run --session 2026-08-28

# Optional isolated ledger
pnpm agent:once -- --dry-run --ledger .state/my-dry-run.sqlite
```

`--dry-run` requires a single cycle and defaults to `.state/dry-run.sqlite`. It can never use the configured production ledger.

- A current-session dry run may reach quote confirmation and deterministic shadow risk, even outside the normal entry window.
- A historical or latest-completed-session dry run is research-only and may return `PreliminaryResearchV2`, never a trade intent.
- Dry run changes scheduling, not permissions, freshness rules, validation, or risk thresholds.

The old `--research-anytime` and `--shadow-anytime` flags are intentionally unsupported.

## Inspect and evaluate

```bash
pnpm research:run
pnpm research:evaluate
pnpm risk:report
```

Use each command's `--help` output for ledger, cycle, and output options.

## Deterministic replay

```bash
pnpm backtest -- --scenarios workspace/scenarios.json
pnpm backtest -- --scenarios workspace/scenarios.json --output workspace/report.json
```

Replay accepts self-contained exact risk inputs and monitor cycles. It calls the same pure `evaluateTradeIntentRiskV1` used by runtime shadow risk. It does not download, persist, or version a market dataset.

## Safety boundary

`opencode.json` is deny-by-default. The research agent can use reviewed Alpaca, FMP, Exa, and trusted-time tools; it cannot use shell, subagents, arbitrary web access, skills, or mutation tools. It may write only under `workspace/`.

The risk evaluator is pure and all monetary values use integer cents. Application code re-fetches proposed-leg quotes and account/portfolio state before evaluating risk. The pipeline ends at a recorded shadow decision.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm docs:build
```

See [the docs](docs/index.md) for the concise contract and boundary references.
