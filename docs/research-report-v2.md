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

`candidateEvaluation` is required for a proposal and omitted when no candidate was evaluated. A proposal requires an active account, options trading approval, no conflicting strategy exposure, and a `LIVE` market regime observed no more than 60 seconds before application evaluation and rechecked after quote confirmation. It must retain all five market-regime metrics; their documented SMA/VWAP ordering, the signal label, and the diagnostic leg symbols must all match the decision.

Substantive research requires at least one Exa item with `sourceId`, provider `EXA`, verification `AGENT_REPORTED`, `title`, HTTP(S) `url`, `publishedAt`, `retrievedAt`, `summary`, and `relevance` (`SUPPORTS`, `CONTRADICTS`, or `NEUTRAL`). Optional FMP items use provider `FMP`, `dataset`, `observedAt`, and the shared retrieval, summary, and relevance fields. FMP cannot satisfy the Exa requirement.

All strings, arrays, timestamps, metrics, and URLs are bounded and validated. Raw provider responses and tool transcripts are not retained. The application continues to confirm the exact option quotes independently before deriving `TradeIntentV1`.
