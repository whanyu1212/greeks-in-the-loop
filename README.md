# greeks-in-the-loop

CodeAct-oriented paper-trading agent built with the OpenCode SDK, Alpaca, and Financial Modeling Prep.

The worker is intentionally non-executing. It can inspect the paper account and market data, write and run analysis under `workspace/`, and emit a validated `ResearchDecisionV1`. A proposed trade is confirmed against a fresh, application-owned Alpaca indicative quote snapshot and deterministically converted into a non-executable `TradeIntentV1` for future risk evaluation. Alpaca mutation tools remain disabled until deterministic risk and execution gates are implemented.

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

## Run

Run one structured research cycle:

```bash
pnpm agent:once
```

Run continuously at the configured interval:

```bash
pnpm agent
```

The worker creates one persistent OpenCode session for its lifetime and shuts down cleanly on `SIGINT` or `SIGTERM`. Each cycle records exactly one bounded outcome: `VALIDATED_NO_ACTION`, `DECISION_REJECTED`, `INTENT_DERIVATION_REJECTED`, or `INTENT_DERIVED`. The current sink writes JSON lines to standard output; durable storage is deferred to issue #13.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
```
