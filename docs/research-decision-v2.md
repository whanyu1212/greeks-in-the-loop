# Research Decision V2

`ResearchDecisionV2` is the strict boundary for untrusted agent conclusions.

It is either:

- `NO_ACTION` with bounded reason codes and at least one timestamped, provider-attributed fact; or
- `PROPOSE_TRADE` with direction, thesis, invalidation, evidence, and one candidate.

Candidates are limited to `SPY`, `QQQ`, or `IWM` and one `BULL_CALL_SPREAD` or `BEAR_PUT_SPREAD`. Both OCC symbols must match the selected underlying, expiration, option type, strike, and structure.

The contract contains no strategy registry version and no prices, sizing, buying power, or approval. See `src/contracts/research-decision-v2.ts` for the authoritative schema and reason-code enum.
