# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm typecheck                  # tsc -p tsconfig.json
pnpm test                       # vitest run (189 test files under tests/)
pnpm build                      # tsc -p tsconfig.build.json
pnpm agent                      # long-running scheduler (tsx src/index.ts)
pnpm agent:once                 # single cycle
pnpm agent:once -- --research-anytime   # bypass the market-window gate for research
pnpm agent:once -- --shadow-anytime     # bypass the window gate for shadow risk
pnpm risk:report                # aggregate shadow decisions from the ledger
pnpm research:run               # replay a stored research run
pnpm research:evaluate          # offline research-run evaluation
pnpm backtest:data -- --from <date> --to <date> --option <OCC>   # acquire dataset
pnpm backtest -- --dataset <path> --scenarios <path> --output <path>
```

Run one test file: `pnpm vitest run tests/risk-state-v1.test.ts`
Run by name: `pnpm vitest run -t "rejects stale quotes"`

There is no lint step. `pnpm typecheck && pnpm test` is the gate — the README's "Verify" section adds `pnpm build`.

Node 22 (`>=22 <23`) and pnpm 10 are enforced by `engines`.

## Architecture

A non-executing research agent. An LLM proposes SPY debit spreads; deterministic
application code validates, prices, and risk-gates them. **No order-submission
code exists anywhere in the repo** — the pipeline ends by recording a shadow
decision to an event ledger.

### The central invariant

The agent proposes; deterministic code disposes. Concretely:

- `evaluateTradeIntentRiskV1` (`src/risk/risk-evaluation-v1.ts`) is a **pure function** — no I/O, no history, no ambient state. It takes one intent plus currently captured state and returns APPROVED/REJECTED. It is versioned (`RISK_RULE_VERSION`) and must stay pure; anything that would make its output depend on database contents or past results is a design error.
- Only the proposed spread's *identity* crosses from research into risk (direction, structure, expiration, two OCC leg symbols). Every financial input — equity, buying power, positions, quotes, greeks, volume/OI, market clock — is **re-fetched by the risk layer itself**. Research's numbers are never trusted for the gate.
- All money is integer cents; exit marks are half-cents per share so the strategy's 50% thresholds stay exact. No floats in financial paths.

### Pipeline

```
research agent (OpenCode)
  → validateResearchDecisionV1     src/contracts/research-decision-v1.ts
  → confirm quotes (app-owned)     src/market-data/alpaca-option-quotes.ts
  → deriveTradeIntentV1            src/contracts/trade-intent-v1.ts
  → shadowRiskEvaluator.evaluate   src/risk/shadow-risk-service.ts
      ├ durable control state (breakers, entry counts) from ledger
      ├ provider.capture()         src/risk/alpaca-risk-state-provider.ts
      ├ deriveTradeIntentV1 again with freshly captured quotes
      └ evaluateTradeIntentRiskV1  src/risk/risk-evaluation-v1.ts
  → ledger events                  src/event-ledger/
```

`src/index.ts` is the composition root — it wires the SQLite ledger store, the
Alpaca risk-state provider, and the shadow risk evaluator, then runs the
scheduler. `src/research/research-cycle.ts` orchestrates one cycle.

### Directory roles

| Path | Role |
|---|---|
| `src/contracts/` | Zod schemas + pure derivation. The trust boundary; agent output is untrusted until it passes here |
| `src/risk/` | State capture, reconciliation, the pure gate, shadow decision assembly |
| `src/research/` | Cycle orchestration, agent invocation, durable context reconstruction |
| `src/market-data/` | Alpaca quote normalization and freshness |
| `src/event-ledger/` | Append-only SQLite audit record; migrations enforce invariants in SQL |
| `src/scheduling/` | Market-window eligibility (`ResearchEligibilityV1`) |
| `src/backtest/` | Offline deterministic replay — see below |
| `src/evaluation/` | Offline research-run scoring |
| `src/strategy/` | Strategy identity and the component/version registry |
| `src/shared/` | Cross-cutting policy shared by risk, contracts, and replay (OCC option identity) |
| `src/observability/` | Tracing spans and telemetry |

### Contract versioning

Contracts are versioned and schemas are `.strict()` on trusted paths (unknown
fields on a proposal could be mistaken for trusted data). Additive fields take a
`minor` bump per `docs/strategy-v1.md`. `NO_ACTION` decisions use `.strip()`
deliberately so irrelevant prose cannot block the safe branch.

Failures return **bounded reason codes**, never raw model input. See
`RISK_REJECTION_CODES`, `RISK_STATE_CAPTURE_FAILURE_CODES`,
`NO_ACTION_REASON_CODES`.

### Backtest replay

`pnpm backtest` is a separate offline entry point, not a pipeline stage. It
feeds `EXACT_SNAPSHOT` scenarios into the *same* `evaluateTradeIntentRiskV1`
with no agent in the loop; it never invokes a model or prompt. Its report file is never read back by runtime code — no backtest result
influences a live decision, by design.

Two fidelities: `EXACT_SNAPSHOT` (reruns signal + risk) and
`HISTORICAL_BAR_PROXY` (`riskStatus: "NOT_EVALUABLE"`, exit mechanics only —
cannot claim historical risk approval). The acquired dataset holds sessions,
underlying bars, option bars, trades, and contracts; Alpaca's free tier serves
no historical greeks or IV (open interest is retained on contracts but dated
independently of the decision instant), so contract-quality thresholds are only
testable against `EXACT_SNAPSHOT` scenarios. These are hand-authored today — no
runtime code forward-captures them.

Only the dataset is checksummed into the report (`datasetChecksum`); the
scenarios file is not. Comparing two runs to attribute a difference to a rule
change requires holding that file fixed as well.

## Agent boundary

`opencode.json` is deny-by-default. The `research` agent may call
`alpaca_get_*`, `fmp_*`, `exa_*`, and `trusted_time`; read `docs/**` (except
`docs/.vitepress/**`, the docs-site build config) and `workspace/**`; write only
`workspace/**`. Bash, task/subagents, webfetch, websearch, and external
directories are denied. Only the
`spy-debit-spread-research` skill is allowed.

Prompt instructions describe desired behavior but are **not** an authorization
control — permissions and application-side validation are. Generated artifacts
belong only under `workspace/` (gitignored, along with `.state/`).

## Docs

`docs/` holds the authoritative specs: `strategy-v1.md` (frozen MVP strategy),
`risk-engine-v1.md`, `trade-intent-v1.md`, `research-decision-v1.md`,
`research-report-v2.md`, `event-ledger-v1.md`, `backtest-replay-v1.md`,
`pre-market-research-v1.md`, `research-market-snapshots-v1.md` (data only;
capture and use are unbuilt), `research-source-policy.md`,
`research-evaluation.md`, `research-behavior-evaluation.md`, `observability.md`.
Consult these before changing contract or rule behavior. The README's Strategy
section indexes the same set with one-line descriptions.
