# Trade Intent Contract v1

| Field | Value |
| --- | --- |
| Intent version | 1.0.0 |
| Decision version | 1.0.0 |
| Strategy version | 1.0.0 |
| Status | Runtime integrated; risk evaluation pending |
| Tracking issue | [#6](https://github.com/whanyu1212/greeks-in-the-loop/issues/6) |
| Research contract | [`research-decision-v1.md`](research-decision-v1.md) |
| Strategy specification | [`strategy-v1.md`](strategy-v1.md) |

## Purpose

`TradeIntentV1` is the deterministic, non-executable output of a validated `PROPOSE_TRADE` research decision plus fresh application-owned quotes for the exact proposed option legs.

It means:

> The proposed candidate has a stable identity and exact derived economics suitable for deterministic risk evaluation.

It does not mean:

- the trade is approved;
- the account is eligible;
- buying power is sufficient;
- portfolio limits pass;
- an order exists;
- the system has permission to submit an order.

Issue #10 owns deterministic risk evaluation. Broker-ready order construction and mutation remain outside this contract.

## Ownership Boundary

### Agent-authored inputs

The validated `ResearchDecisionV1` supplies:

- direction;
- supported spread structure;
- expiration;
- exact long and short OCC symbols;
- thesis and invalidation context through the associated decision;
- a sourced fact referencing `alpaca-proposal-quotes-v1`.

The model cannot author any intent field directly.

### Application-owned inputs

The read-only quote adapter supplies:

- exact requested OCC symbols;
- indicative bid and ask prices;
- provider timestamps;
- application evaluation time;
- bounded freshness metadata.

### Deterministically derived

Application code derives:

- entry limit;
- spread width;
- maximum loss;
- maximum profit;
- stop-loss mark;
- profit-target mark.

## Contract Shape

```ts
type TradeIntentV1 = {
  contractVersion: "1.0.0"
  decisionContractVersion: "1.0.0"
  strategyVersion: "1.1.0"

  direction: "BULLISH" | "BEARISH"
  structure: "BULL_CALL_SPREAD" | "BEAR_PUT_SPREAD"
  expiration: string
  longContractSymbol: string
  shortContractSymbol: string

  quoteSnapshotRef: string
  evaluatedAt: string
  longQuote: ConfirmedOptionQuoteV1
  shortQuote: ConfirmedOptionQuoteV1

  entryLimitCentsPerShare: number
  widthCentsPerShare: number
  maxLossCentsPerContract: number
  maxProfitCentsPerContract: number
  stopLossMarkHalfCentsPerShare: number
  profitTargetMarkHalfCentsPerShare: number
}
```

All numeric fields are positive safe integers. Unknown fields are rejected.

## Field Purposes

| Field | Owner | Operational purpose |
| --- | --- | --- |
| `contractVersion` | Application | Selects the exact intent decoder and semantics. |
| `decisionContractVersion` | Application | Identifies the validated upstream decision contract. |
| `strategyVersion` | Application | Pins the formulas and strategy rules used for derivation. |
| `direction` | Validated decision | Preserves the proposed directional thesis for risk evaluation and audit. |
| `structure` | Validated decision | Restricts the candidate to the supported defined-risk spread family. |
| `expiration` | Validated decision | Identifies contract maturity and supports later DTE gates. |
| `longContractSymbol` | Validated decision | Identifies the exact proposed long leg. |
| `shortContractSymbol` | Validated decision | Identifies the exact proposed short leg. |
| `quoteSnapshotRef` | Application | Links the intent to the application-owned quote confirmation. |
| `evaluatedAt` | Application | Establishes the instant used for quote freshness validation. |
| `longQuote` | Application | Retains exact authoritative inputs used for the long-leg midpoint. |
| `shortQuote` | Application | Retains exact authoritative inputs used for the short-leg midpoint. |
| `entryLimitCentsPerShare` | Derived code | Provides the strategy-defined upward-cent-rounded debit. |
| `widthCentsPerShare` | Derived code | Provides exact spread width for payoff and risk gates. |
| `maxLossCentsPerContract` | Derived code | Provides defined risk for one 100-share option contract. |
| `maxProfitCentsPerContract` | Derived code | Provides maximum payoff for one contract. |
| `stopLossMarkHalfCentsPerShare` | Derived code | Preserves the 50% entry-debit stop threshold exactly. |
| `profitTargetMarkHalfCentsPerShare` | Derived code | Preserves the 50% maximum-profit target exactly. |

## Confirmed Quote Shape

```ts
type ConfirmedOptionQuoteV1 = {
  contractSymbol: string
  feed: "INDICATIVE"
  bidCentsPerShare: number
  askCentsPerShare: number
  providerTimestamp: string
}
```

A quote is accepted only when:

- it belongs to one of the two exact requested SPY OCC symbols;
- its feed is explicitly recorded as `INDICATIVE`;
- bid and ask are representable in exact cents;
- bid is positive;
- ask is greater than bid;
- the provider timestamp is valid RFC 3339;
- the timestamp is not later than `evaluatedAt`;
- the quote is no more than 60 seconds old at `evaluatedAt`.

Both symbols are requested in one Alpaca options-snapshot call with the indicative feed. Provider response order is irrelevant because snapshots are matched by exact symbol. Production requests reject redirects and can send credentials only to the credential-free `https://data.alpaca.markets` origin.

## Exact Arithmetic

Quote prices and strikes use integer cents per share.

For each leg:

```text
midpoint_numerator_cents = bid_cents + ask_cents
```

This numerator represents twice the midpoint in cents. Therefore:

```text
net_midpoint_half_cents =
  long_midpoint_numerator_cents -
  short_midpoint_numerator_cents

entry_limit_cents =
  ceil(net_midpoint_half_cents / 2)

width_cents =
  abs(long_strike_cents - short_strike_cents)

max_loss_cents_per_contract =
  entry_limit_cents * 100

max_profit_cents_per_contract =
  (width_cents - entry_limit_cents) * 100
```

Derivation fails closed when:

- quote symbols do not match the proposal;
- a strike has unsupported sub-cent precision;
- the net debit is not positive;
- entry limit is greater than or equal to width;
- any arithmetic result is not a safe integer.

The 60%-of-width, $500 maximum-loss, account, buying-power, exposure, and drawdown gates are evaluated by Issue #10. Their values are derived here, but this contract does not claim approval.

## Exit Threshold Units

The strategy thresholds can land on a half-cent boundary. They are stored as integer half-cents per share:

```text
stop_loss_mark_half_cents =
  entry_limit_cents

profit_target_mark_half_cents =
  entry_limit_cents + width_cents
```

These equal:

```text
stop_loss_mark =
  0.50 * entry_limit

profit_target_mark =
  entry_limit + 0.50 * (width - entry_limit)
```

No rounding is introduced.

## Runtime Outcomes

Each completed processing attempt records exactly one outcome:

### `VALIDATED_NO_ACTION`

The agent intentionally returned a valid minimal `NO_ACTION`. No quote request or intent derivation occurs.

### `DECISION_REJECTED`

The response was malformed, schema-invalid, stale, unsupported, or referenced unknown evidence. The outcome contains bounded issue codes and paths, never the raw rejected response.

### `INTENT_DERIVATION_REJECTED`

The decision passed its structural gate, but trusted quotes could not be confirmed or exact intent derivation failed. The outcome contains bounded reasons and is not rewritten as `NO_ACTION`.

### `INTENT_DERIVED`

The decision passed validation and application code produced a `TradeIntentV1`. The intent remains pre-risk and non-executable.

The ledger-backed sink is awaited before cycle completion and atomically records the normalized decision, evidence reference, intent result, and terminal outcome. Agent responses larger than 64 KiB in UTF-8 are rejected before JSON parsing and are never retained in an outcome.

## Evidence Reference

During PR2, a proposal must reference:

```text
alpaca-proposal-quotes-v1
```

Application code binds this alias only to the fresh quote confirmation for the exact proposed legs. Other proposal snapshot references fail closed.

A minimal `NO_ACTION` omits optional evidence in this phase. Broader application-owned evidence registration belongs to the dedicated research-agent and ledger work in Issues #5 and #13.

## Explicitly Excluded Fields

`TradeIntentV1` rejects or omits:

- account state;
- buying power;
- projected buying power;
- quantity;
- approval state;
- risk decision;
- order type;
- time in force;
- client order ID;
- broker payload;
- submission deadline;
- permission to trade.

These omissions prevent downstream code from confusing deterministic proposal economics with authorization or execution.

## Downstream Boundaries

- **Issue #5:** dedicated agent, research checklist, source precedence, and permissions.
- **Issue #13:** normalized snapshot references, decisions, intents, outcomes, restart state, and correlation IDs.
- **Issue #10:** account and portfolio risk gates, approval, and rejection.
- **Execution work:** broker-ready order construction, submission, and reconciliation.
