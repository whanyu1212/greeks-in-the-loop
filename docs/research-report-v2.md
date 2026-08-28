# Research Report V2

`ResearchReportV2` is the bounded audit dossier returned by the research agent. It separates agent-reported analysis from application-confirmed snapshots and embeds the existing safe decision contract in `result`.

```json
{
  "reportVersion": "2.0.0",
  "result": { "outcome": "NO_ACTION | PRELIMINARY_RESEARCH | PROPOSE_TRADE" },
  "analysis": {
    "provenance": "AGENT_REPORTED",
    "asOf": "RFC3339 milliseconds",
    "accountChecks": {
      "verification": "AGENT_REPORTED",
      "observedAt": "RFC3339 milliseconds",
      "accountStatus": "ACTIVE | INACTIVE | UNKNOWN",
      "optionsTradingApproved": true,
      "conflictingStrategyExposure": false
    },
    "marketRegime": {
      "verification": "AGENT_REPORTED",
      "temporalClass": "LIVE | DELAYED | PRIOR_CLOSE",
      "observedAt": "RFC3339 milliseconds",
      "signal": "BULLISH | BEARISH | MIXED | UNAVAILABLE",
      "dailyClose": 650,
      "sma20": 645,
      "sma50": 640,
      "sessionVwap": 648,
      "spotMidpoint": 651,
      "dailySessionCount": 50,
      "intradayBarCount": 0
    },
    "candidateEvaluation": {
      "verification": "AGENT_REPORTED",
      "observedAt": "RFC3339 milliseconds",
      "dte": 21,
      "legs": [
        {
          "role": "LONG",
          "contractSymbol": "SPY260918C00650000",
          "delta": 0.52,
          "impliedVolatility": 0.2,
          "gamma": 0.02,
          "theta": -0.1,
          "vega": 0.15,
          "volume": 200,
          "openInterest": 1000,
          "openInterestDate": "YYYY-MM-DD"
        },
        {
          "role": "SHORT",
          "contractSymbol": "SPY260918C00655000",
          "delta": 0.28,
          "impliedVolatility": 0.19,
          "gamma": 0.015,
          "theta": -0.08,
          "vega": 0.12,
          "volume": 180,
          "openInterest": 900,
          "openInterestDate": "YYYY-MM-DD"
        }
      ]
    },
    "externalContext": [],
    "supportingFactors": [],
    "contradictingFactors": [],
    "conflicts": []
  }
}
```

## Exact result shapes

The `result` discriminator is always `outcome`; `decision`, `type`, `strategy`, and `statement` are not contract fields.

A no-action result has this shape:

```json
{
  "contractVersion": "1.0.0",
  "strategyVersion": "1.1.0",
  "outcome": "NO_ACTION",
  "reasonCodes": ["SIGNAL_NOT_ACTIONABLE"]
}
```

A proposal has this shape:

```json
{
  "contractVersion": "1.0.0",
  "strategyVersion": "1.1.0",
  "outcome": "PROPOSE_TRADE",
  "direction": "BULLISH",
  "thesis": "Bounded thesis",
  "candidate": {
    "underlying": "SPY",
    "structure": "BULL_CALL_SPREAD",
    "expiration": "YYYY-MM-DD",
    "longLeg": {
      "contractSymbol": "SPY260918C00650000",
      "strike": 650
    },
    "shortLeg": {
      "contractSymbol": "SPY260918C00655000",
      "strike": 655
    }
  },
  "invalidation": ["One concrete invalidation condition"],
  "evidence": [
    {
      "claimId": "exact-leg-fact",
      "kind": "SOURCED_FACT",
      "claim": "The exact legs were present in the application-owned quote snapshot.",
      "snapshotRef": "alpaca-proposal-quotes-v1"
    }
  ]
}
```

For a bearish proposal, use direction `BEARISH`, structure `BEAR_PUT_SPREAD`, and put OCC symbols. Every proposal sourced fact is limited to the exact-leg quote snapshot and may contain only `claimId`, `kind`, `claim`, `snapshotRef`, and optional `locator`. Proposal evidence never contains `provider`, `observedAt`, or `temporalClass`; those fields belong to preliminary sourced facts. Daily, intraday, account, external, and directional facts remain in `analysis`, not proposal result evidence. An inference evidence item uses `kind: "INFERENCE"`, a bounded `claim`, and `basedOn` containing sourced-fact `claimId` values.

A preliminary result has this shape:

```json
{
  "contractVersion": "1.0.0",
  "strategyVersion": "1.1.0",
  "outcome": "PRELIMINARY_RESEARCH",
  "targetSessionDate": "YYYY-MM-DD",
  "direction": "UNDETERMINED",
  "thesis": "Bounded planning thesis",
  "invalidation": ["One concrete invalidation condition"],
  "evidence": [],
  "requiresRefresh": true
}
```

`candidateEvaluation` is required for a proposal and omitted when no candidate was evaluated. A proposal requires active, approved, non-conflicting account checks observed within five minutes of application evaluation and rechecked after quote confirmation. Its `LIVE` market regime must be observed within 60 seconds at both boundaries, retain exactly 50 daily sessions, and report exactly the completed regular-session one-minute intervals implied by the application session date and snapshot instant. All five market-regime metrics and their documented SMA/VWAP ordering must support the signal. Candidate diagnostics share the market snapshot instant, match the decision legs and application-calculated DTE, and satisfy the 14–30 DTE, delta, volume, and open-interest prefilters. Each open-interest date must be the current session or one of the two immediately preceding sessions returned by the application-owned Alpaca calendar lookup.

Substantive research requires at least one Exa item with `sourceId`, provider `EXA`, verification `AGENT_REPORTED`, `title`, HTTP(S) `url`, `publishedAt`, `retrievedAt`, `summary`, and `relevance` (`SUPPORTS`, `CONTRADICTS`, or `NEUTRAL`). At least one Exa item must have been retrieved between the application-owned cycle start and processing time. Optional FMP items use provider `FMP`, `dataset`, `observedAt`, and the shared retrieval, summary, and relevance fields. FMP cannot satisfy the Exa requirement.

All strings, arrays, timestamps, metrics, and URLs are bounded and validated. Raw provider responses and tool transcripts are not retained. The application continues to confirm the exact option quotes independently before deriving `TradeIntentV1`.
