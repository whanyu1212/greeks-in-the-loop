# greeks-in-the-loop

CodeAct-oriented paper-trading agent built with the OpenCode SDK, Alpaca, and Financial Modeling Prep.

The initial loop is intentionally observation-only. It can inspect the paper account and market data, write and run analysis under `workspace/`, and report an opportunity or `NO_ACTION`. Alpaca mutation tools remain disabled until deterministic risk and execution gates are implemented.

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

Populate `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `FMP_API_KEY`, and `EXA_API_KEY` in `.env`.

## Run

Run one observation cycle:

```bash
pnpm agent:once
```

Run continuously at the configured interval:

```bash
pnpm agent
```

The worker creates one persistent OpenCode session for its lifetime and shuts down cleanly on `SIGINT` or `SIGTERM`.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
```
