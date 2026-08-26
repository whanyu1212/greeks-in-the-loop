# Pre-Market Research v1

Issue #20 separates the time in which research is useful from the narrower time in which an application-owned trade intent may be formed.

## Eligibility

Application code queries the read-only Alpaca market calendar for the current `America/New_York` date. Research is eligible from the configured `AGENT_PREMARKET_START_ET` through the session close. Trade-intent eligibility additionally requires the existing quarter-hour slot, 119-second start tolerance, five-minute deadline, regular-session open, and strategy cutoff `min(15:00, session_close - 60 minutes)`.

A missing trading session represents a weekend or holiday and fails closed. Calendar request and validation failures fail the cycle. The interval scheduler, retries, and deployment behavior remain owned by issue #9.

## Preliminary results

`PreliminaryResearchV1` is a strict, bounded agent-authored result. It may contain a thesis, optional candidate identity, invalidation conditions, and sourced facts or inference. Each sourced fact records its provider, observation timestamp, and one temporal class: `LIVE`, `DELAYED`, or `PRIOR_CLOSE`.

Every preliminary result has `requiresRefresh: true`. It cannot contain prices, risk calculations, sizing, approval, or order fields, and its TypeScript type is not accepted by `deriveTradeIntentV1`.

The agent returns that result inside a bounded `ResearchReportV2` dossier. The dossier retains agent-reported account checks, market-regime metrics, supporting and contradicting factors, conflicts, and at least one timestamped Exa citation. Exa is mandatory once a cycle reaches substantive market research; inability to obtain usable Exa evidence produces `REQUIRED_EXA_EVIDENCE_UNAVAILABLE`.

## Carry-forward and refresh

The ledger records a validated preliminary result as `PRELIMINARY_RESEARCH_RECORDED`, followed by `RESEARCH_CYCLE_COMPLETED` with status `PRELIMINARY_RESEARCH_RETAINED`. Restart reconstruction exposes only a normalized view of the latest result—direction, optional candidate identity, and observation metadata without model-authored prose—plus a `PRELIMINARY_RESEARCH` refresh marker.

In a later eligible cycle the finding is historical planning context only. The agent must emit a new `PROPOSE_TRADE`, and application code rechecks eligibility immediately before and after fetching fresh exact-leg quotes. Delayed, prior-close, stale, or future-dated quotes cannot enter `TradeIntentV1`.

No component introduced by this feature can place, replace, cancel, or otherwise mutate a broker order.
