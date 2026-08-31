# Deterministic Risk Engine V1

`evaluateTradeIntentRiskV1` is a pure function over one `TradeIntentV2` and one application-captured state snapshot. It performs no I/O and reads no history or ambient state.

The gate checks:

- application-owned eligibility and market-open state;
- active, unrestricted, multileg-approved account;
- consistent portfolio and durable breaker state;
- exact candidate identity and contract freshness;
- 14–30 DTE;
- long absolute delta 0.45–0.60 and short absolute delta 0.20–0.35;
- positive IV, volume at least 100, and open interest at least 500 per leg;
- quote freshness and exact integer-cent economics;
- one-contract buying-power and loss limits.

It returns bounded `APPROVED` or `REJECTED` data. Approval is a shadow decision only; no execution code exists.
