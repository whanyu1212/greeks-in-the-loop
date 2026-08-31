# Deterministic replay

```bash
pnpm backtest -- --scenarios workspace/scenarios.json
pnpm backtest -- --scenarios workspace/scenarios.json --output workspace/report.json
```

The input is one JSON object with `replayVersion`, initial equity, execution assumptions, ordered market sessions with exact open and close instants covering every scenario, and one or more scenarios. Each scenario contains an exact `RiskEvaluationInputV1` and ordered monitor cycles. Replay rejects any cycle whose `holdingSessionIndex`, `marketOpen`, or `minutesToClose` does not match that calendar.

Replay calls `evaluateTradeIntentRiskV1`. Rejected inputs are not simulated; approved inputs use the deterministic monitor and execution model in `src/backtest/replay-core.ts`.

The aggregate has `status: "COMPLETE"` and numeric metrics only when every entered scenario has a priced exit. Any `EXIT_UNPRICED` scenario instead produces `status: "INCOMPLETE"` with reason `UNPRICED_EXIT`.

There is no dataset downloader, SQLite dataset store, proxy fidelity, or strategy registry.
