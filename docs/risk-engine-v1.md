# Deterministic Risk Engine V1

## Status

| Field | Value |
| --- | --- |
| Evaluation version | `1.0.0` |
| Rule version | `1.0.0` |
| Runtime status | Pure engine and read-only live risk-state capture implemented; worker invocation and shadow persistence pending |

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
- one application-verified contract snapshot slot and observation time, plus
  contract identity, status, Greeks, volume, and open interest for the exact
  long and short legs.

The context requires the literal provenance `APPLICATION_VERIFIED`. Agent
reports, model output, web evidence, and previously retained research context
must not be adapted into this input as authoritative facts. Missing, malformed,
unknown, or extra input fails closed as `RISK_INPUT_INVALID`; validation errors
and raw input values are not returned.

The v1 upstream research and intent contracts currently admit SPY only. The
risk engine itself contains no symbol allowlist or symbol-specific rule. A
future versioned upstream contract can expand the eligible universe while
reusing the same normalized gate design.

## Application risk-state capture

`createAlpacaRiskStateProvider` is the read-only live-state adapter for PR1. It
exposes only `capture(input)` and performs GET-only Alpaca reads for account,
positions, open nested orders, same-day nested order history, exact option
contracts, and exact option snapshots from the indicative feed.

The provider records one application evaluation timestamp across account,
contract, quote, and reconciliation output. It double-reads positions and open
orders around the account, contract, snapshot, and history reads. If those
broker observations differ, reconciliation remains typed but is marked
inconsistent with `BROKER_STATE_CHANGED`.

Reconciliation recognizes only a flat account, exactly one supported SPY debit
spread position, or exactly one supported open multileg day limit order. Unknown
positions, unmatched option exposure, unknown open orders, duplicate broker
records, and multiple pending entries fail closed by setting `consistent=false`
and returning bounded reason codes. Same-day entry count is the max of durable
control state and normalized same-day Alpaca option-entry orders observed no
later than capture start.

`DurableRiskControlStateV1` carries the same-day entry count plus daily and
competition breaker latches into capture. PR1 accepts this durable state as an
input; a later runtime integration is responsible for projecting it from the
ledger. Malformed provider data, missing option quotes or metrics, stale quotes,
and unsafe timestamps return bounded capture reasons without raw API payloads or
credentials. Monetary account and quote values must parse as exact cents; PR1
does not round provider values into risk input.

## Fixed entry rules

The rule set is compiled into the engine and identified by `ruleVersion`. It is
not configurable through model output, environment variables, or caller-supplied
thresholds.

| Gate | V1 rule |
| --- | --- |
| Entry window | Application eligibility is true and evaluation precedes the retained deadline |
| Market freshness | Quotes and contract observations are not future-dated and are at most 60 seconds old; comparisons retain RFC 3339 nanosecond precision |
| Snapshot identity | Contract snapshot slot must equal the application trade window slot; the slot and observation time identify one immutable market snapshot |
| Snapshot order | Intent evaluation must equal the contract snapshot observation time and lie inside that slot; both quote timestamps must be no later than that observation time |
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

Separate changes must project durable control state from the ledger, invoke the
engine from the worker, persist versioned risk events and breaker transitions,
and recheck time-sensitive gates immediately before submission. Broker
execution, position protection, and breaker reset behavior remain outside this
module.
