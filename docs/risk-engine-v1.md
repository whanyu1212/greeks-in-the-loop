# Deterministic Risk Engine V1

## Status

| Field | Value |
| --- | --- |
| Evaluation version | `1.0.0` |
| Rule version | `1.0.0` |
| Runtime status | Pure engine implemented; live inputs and shadow persistence pending |

The risk engine is the deterministic boundary between a non-executable
`TradeIntentV1` and future broker execution. It answers whether one intent is
eligible under fixed rules. It performs no I/O, has no credentials, and cannot
construct, submit, replace, or cancel an order.

## Trusted input

`evaluateTradeIntentRiskV1` accepts one strict object containing:

- a schema-valid `TradeIntentV1`;
- the application-calculated `ResearchEligibilityV1` at risk-evaluation time;
- application-verified account status, multileg approval, buying power, and
  equity values;
- reconciled position, pending-entry, same-day-entry, and breaker state; and
- application-verified contract identity, status, Greeks, volume, and open
  interest for the exact long and short legs.

The context requires the literal provenance `APPLICATION_VERIFIED`. Agent
reports, model output, web evidence, and previously retained research context
must not be adapted into this input as authoritative facts. Missing, malformed,
unknown, or extra input fails closed as `RISK_INPUT_INVALID`; validation errors
and raw input values are not returned.

The v1 upstream research and intent contracts currently admit SPY only. The
risk engine itself contains no symbol allowlist or symbol-specific rule. A
future versioned upstream contract can expand the eligible universe while
reusing the same normalized gate design.

## Fixed entry rules

The rule set is compiled into the engine and identified by `ruleVersion`. It is
not configurable through model output, environment variables, or caller-supplied
thresholds.

| Gate | V1 rule |
| --- | --- |
| Entry window | Application eligibility is true and evaluation precedes the retained deadline |
| Market freshness | Quotes and contract observations are not future-dated and are at most 60 seconds old |
| State freshness | Account and reconciliation observations are not future-dated and are at most five minutes old |
| Contract identity | One exact matching long leg and short leg |
| Contract status | Active, tradable, American-style, multiplier 100 |
| Expiration | 14–30 calendar days from the trading date, inclusive |
| Spread width | $1–$10 per share, inclusive |
| Long delta | Absolute delta 0.45–0.60, inclusive |
| Short delta | Absolute delta 0.20–0.35, inclusive |
| Required metrics | Positive implied volatility and finite delta, gamma, theta, and vega |
| Quote width | At most $0.20 and at most 10% of midpoint per leg |
| Volume | At least 100 contracts per leg for the current session |
| Open interest | At least 500 per leg, dated on the current or two preceding sessions |
| Entry debit | Positive, below spread width, and at most 60% of width |
| Maximum loss | At most $500 for one spread |
| Account | Active, unrestricted, and approved for the complete multileg spread |
| Reconciliation | Consistent, with no open strategy position or pending entry |
| Daily entry count | No entry already submitted on the trading date |
| Buying-power reserve | Projected buying power is at least 50% of pre-entry buying power |
| Daily breaker | Blocks at a $1,500 decline from `last_equity`, or when already latched |
| Competition breaker | Blocks at equity of $92,500 or below, or when already latched |

Money, entry-price percentages, buying-power reserve, and quote-width ratios use
integer or `BigInt` comparisons. The engine does not use binary floating-point
arithmetic for financial thresholds.

## Result contract

An approval contains the evaluation and rule versions, evaluation timestamp,
fixed quantity of one, maximum loss, and projected buying power. Approval is a
shadow decision in this delivery and grants no execution authority.

A rejection contains bounded reason codes in stable gate order. When several
valid gates fail, all applicable codes are returned once. Schema-invalid input
returns only `RISK_INPUT_INVALID` and a null evaluation timestamp because no
caller-supplied time was trusted.

## Deferred integration

Separate changes must provide application-owned Alpaca account, contract, order,
and position adapters; invoke the engine from the worker; persist versioned
risk events and breaker transitions; and recheck time-sensitive gates immediately
before submission. Broker execution, reconciliation, position protection, and
breaker reset behavior remain outside this module.
