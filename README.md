# greeks-in-the-loop

Read-only paper-trading research agent built with the OpenCode SDK, Alpaca, and Financial Modeling Prep.

The worker is intentionally non-executing. Its dedicated `research` agent can inspect read-only paper-account and market data, gather FMP and Exa evidence, write artifacts under `workspace/`, and emit a validated `ResearchDecisionV1`. A proposed trade is confirmed against a fresh, application-owned Alpaca indicative quote snapshot and deterministically converted into a non-executable `TradeIntentV1` for future risk evaluation.

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

## Run

Run one structured research cycle:

```bash
pnpm agent:once
```

Run continuously at the configured interval:

```bash
pnpm agent
```

The worker creates one persistent OpenCode session for its lifetime and shuts down cleanly on `SIGINT` or `SIGTERM`. Every cycle selects the checked-in `research` agent; this identity cannot be overridden through `.env`. Each cycle records exactly one bounded outcome: `VALIDATED_NO_ACTION`, `DECISION_REJECTED`, `INTENT_DERIVATION_REJECTED`, or `INTENT_DERIVED`. The current sink writes JSON lines to standard output; durable storage is deferred to issue #13.

## Research procedure

Every unattended cycle loads the project-local `spy-debit-spread-research` skill. The checklist and [source/freshness policy](docs/research-source-policy.md) define source precedence, evidence classification, stale-data handling, conflict resolution, candidate eligibility, and fail-closed `NO_ACTION` behavior. Alpaca remains authoritative for broker and market facts; FMP and Exa provide optional supporting context.

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
