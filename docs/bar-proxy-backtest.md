# Alpaca Bar-Proxy Backtest

The bar-proxy adapter converts historical Alpaca indicative option trade bars into explicit synthetic bid/ask inputs for the existing replay `8.0.0` engine. It is an offline robustness tool, not historical NBBO reconstruction and not a test of research-agent selection quality.

The adapter leaves replay and risk behavior unchanged:

```text
versioned trade manifest
  -> completed Alpaca option and stock bars
  -> synthetic bid/ask proxies
  -> entry risk input and 30-minute monitor cycles
  -> replay 8.0.0
  -> retained source evidence, V8 inputs, assumptions, and sensitivity results
```

## Data Boundary

V1 supports one-unit `BULL_CALL_SPREAD` and `BEAR_PUT_SPREAD` scenarios. Every scenario supplies exact Alpaca option symbols and an entry timestamp. It does not discover trades or rerun historical research.

The option source is Alpaca's account-default historical feed, expected to be `indicative` for the configured free-tier account. The historical bars endpoint does not accept a feed selector, so this expectation is retained explicitly rather than presented as provider-verified metadata. Its bars aggregate trades, not OPRA NBBO quotes. Historical options coverage begins around February 2024. Stock minute and daily bars use the IEX feed with raw adjustment. The generated report labels both sources.

A one-minute bar is usable only when its end is not after the decision timestamp. The current minute is never used before completion. Entry option and underlying bars must be no more than one minute old. Monitor prices may carry forward only within the same session; at five stale minutes the close premium is omitted so V8 returns an unpriced exit rather than fabricating a fill.

## Manifest

The manifest is strict and versioned. It requires exactly three sensitivity bands in optimistic, base, and conservative order:

```json
{
  "manifestVersion": "1.0.0",
  "initialEquityCents": 10000000,
  "monitoring": {
    "cadenceMinutes": 30
  },
  "exitPolicy": {
    "stopLossBpsOfMaxLoss": 5000,
    "profitTargetBps": 3000,
    "minimumDte": 3,
    "maxHoldingSessions": 5
  },
  "marketAssumptions": {
    "interestRateBps": 450,
    "assumedOpenInterest": 500,
    "dividendYieldBpsByUnderlying": {
      "SPY": 120
    }
  },
  "accountAssumptions": {
    "buyingPowerCents": 20000000,
    "cashCents": 20000000,
    "equityCents": 10000000
  },
  "sensitivityBands": [
    {
      "name": "OPTIMISTIC",
      "spreadBps": 250,
      "minimumSpreadCents": 1,
      "entrySlippageCentsPerLeg": 0,
      "exitSlippageCentsPerLeg": 0,
      "commissionCentsPerContract": 50
    },
    {
      "name": "BASE",
      "spreadBps": 500,
      "minimumSpreadCents": 2,
      "entrySlippageCentsPerLeg": 1,
      "exitSlippageCentsPerLeg": 2,
      "commissionCentsPerContract": 50
    },
    {
      "name": "CONSERVATIVE",
      "spreadBps": 1000,
      "minimumSpreadCents": 5,
      "entrySlippageCentsPerLeg": 3,
      "exitSlippageCentsPerLeg": 5,
      "commissionCentsPerContract": 50
    }
  ],
  "scenarios": [
    {
      "scenarioId": "spy-bull-call-2025-01-10",
      "underlying": "SPY",
      "strategy": "BULL_CALL_SPREAD",
      "entryAt": "2025-01-10T15:00:00.000Z",
      "legs": [
        {
          "symbol": "SPY250131C00580000",
          "intent": "BUY_TO_OPEN"
        },
        {
          "symbol": "SPY250131C00585000",
          "intent": "SELL_TO_OPEN"
        }
      ]
    }
  ]
}
```

The spread values above are starting sensitivity assumptions, not calibrated facts. `assumedOpenInterest` is explicitly conditional: setting it to the current threshold means the replay asks how the trade behaves if that unknown historical liquidity gate passed.

The manifest permits at most 100 scenarios and caps `exitPolicy.maxHoldingSessions` at 20 so provider pagination and the option holding horizon remain bounded. Every underlying requires an explicit dividend-yield assumption, including zero.

## Quote And Risk Proxies

For each completed option bar:

```text
referenceCents = round(last completed bar close to cents)
halfSpread = max(minimumSpreadCents, ceil(referenceCents * spreadBps / 20,000))
bid = referenceCents - halfSpread
ask = referenceCents + halfSpread
```

Opening natural debit uses buy-leg asks minus sell-leg bids. Closing natural value uses long-leg bids minus short-leg asks. V8 then applies its existing per-leg execution slippage and commissions separately.

Entry IV and Greeks use a bounded Black-Scholes European proxy with ACT/365 time, explicit interest and dividend assumptions, and expiration at 16:00 New York time. The adapter rejects prices outside no-arbitrage bounds or without a convergent IV. Actual contracts remain American, and the report records this model mismatch.

Session volume is the cumulative volume of completed entry-session bars up to the entry decision. Open interest, active/tradable state, American exercise, multiplier 100, account state, and an empty starting portfolio are explicit retained assumptions. Risk approval therefore means conditional approval under the proxy inputs, not a historically verified approval.

## Run

Use a trusted local checkout after normal CI passes and after every scenario's maximum holding horizon is complete:

```bash
pnpm backtest:bars -- \
  --manifest workspace/trades.json \
  --output workspace/bar-proxy-report.json
```

The command reads the existing `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_MARKET_DATA_BASE_URL`, and `ALPACA_TRADING_BASE_URL` settings. Reports are written with mode `0600`. Credentials, request headers, raw provider errors, and raw payloads are never retained.

Do not run this command in ordinary pull-request CI. Run it manually during review of strategy, risk, exit, execution, or proxy-model changes. A stable benchmark corpus can later move to a separate scheduled evaluation job.

## Report Interpretation

The report retains the parsed manifest, its SHA-256 digest, normalized-data digests and counts, exact selected entry bar ends, all generated V8 inputs, per-scenario failures, and each V8 output. A rejected or unpriceable scenario is never silently dropped from coverage.

Sensitivity classifications are:

- `ROBUST_ACROSS_BANDS`: aggregate P&L is positive in all three complete bands.
- `SENSITIVE`: aggregate direction changes across bands.
- `FRAGILE`: only the optimistic complete band is positive.
- `NOT_SUPPORTED`: no complete band is positive.
- `INCOMPLETE`: any scenario or replay exit is unpriced or rejected before generation.

These classifications measure execution-model robustness for the supplied trades. They do not establish strategy edge, actual historical liquidity, historical NBBO fills, or research-agent selection quality.
