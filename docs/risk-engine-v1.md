# Deterministic Risk Engine V1

`evaluateTradeIntentRiskV1` is a pure function over one `TradeIntentV2` and one application-captured state snapshot. It performs no I/O and reads no history or ambient state.

The gate checks:

- application-owned eligibility and market-open state;
- active, unrestricted, multileg-approved account;
- consistent portfolio and durable breaker state;
- exact candidate identity and contract freshness;
- 14–30 DTE;
- long absolute delta 0.45–0.60 and short absolute delta 0.20–0.35;
- correctly signed call or put deltas and direction-adjusted net delta 0.10–0.40;
- positive IV, volume at least 100, and open interest at least 500 per leg;
- quote freshness, per-leg liquidity, and combined-spread quote uncertainty no
  greater than 20% of the exact midpoint debit;
- midpoint and natural-entry debits no greater than 60% of spread width;
- one-contract buying-power and loss limits, including the full maximum loss
  projected against the daily drawdown and competition equity floors.

Rule `1.1.0` adds the combined-spread and projected-loss checks. Rule `1.2.0`
calculates application-verified spread Greeks as long-leg values minus
short-leg values, records net delta, gamma, theta, and vega, and rejects a
spread whose signed net delta does not match the strategy. Stored rule `1.0.0`
and `1.1.0` decisions remain readable.

Gamma, theta, and vega are recorded for comparison and calibration but do not
have arbitrary rejection thresholds. High implied volatility alone is not a
rejection; the defined debit, quote quality, directional exposure, and loss
budgets bound the current strategy.

It returns bounded `APPROVED` or `REJECTED` data. Approval is a shadow decision only; no execution code exists.
