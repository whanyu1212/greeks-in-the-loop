# Order Execution V1

The first path in this repository that mutates broker state. It turns a
durably recorded `APPROVED` shadow decision into one Alpaca paper multi-leg
order, and nothing else. Architecture plan section 6.A: deterministic code
submits, the model never does.

Execution is off unless `pnpm agent -- --execute` is passed, and `--execute`
is refused alongside `--dry-run`. The deployed container still runs
`agent:once -- --dry-run`, so the default remains non-executing.

## Where it sits

```text
... -> evaluateTradeIntentRiskV1
    -> RISK_SHADOW_DECISION_RECORDED   (durable approval)
    -> executeApprovedTradeV1          (only with --execute)
         -> ORDER_SUBMITTED            (durable, before the broker call)
         -> POST /v2/orders            (Alpaca paper, mleg limit)
         -> ORDER_FILLED | ORDER_REJECTED | (left open)
```

Three modules, one direction of dependency:

| Module | Role |
| --- | --- |
| `src/execution/order-submission-v1.ts` | Pure. Derives the Alpaca request body and the three ledger payloads from a `TradeIntentV4`. No I/O. |
| `src/execution/alpaca-order-submitter.ts` | The only broker-mutating client in the codebase. Submits and looks up by client order id. |
| `src/execution/trade-executor.ts` | Orders the ledger writes around the broker call, and reconciles at startup. |

## The order that is sent

`buildAlpacaMlegOrderRequestV1` is a total function of the approved intent, so
the exact request is reproducible from the ledger alone:

- `order_class: "mleg"`, `type: "limit"`, `time_in_force: "day"`, `qty: 1`;
- `limit_price` = the intent's net entry limit, integer cents rendered as a
  decimal string;
- one leg per intent leg, every leg opening (`buy_to_open` / `sell_to_open`).

Alpaca accepts or rejects an `mleg` order as a unit, so a partially recognized
request can never leave a naked short leg.

## Crash safety and idempotency

`ORDER_SUBMITTED` is appended **before** the broker is contacted. A crash
anywhere after that leaves a record that startup reconciliation resolves; the
ledger never holds an order the broker does not have, and never misses one it
does.

The cycle id is the single idempotency key, enforced in three places:

1. **Ledger** — a partial unique index on `cycle_id where event_type =
   'ORDER_SUBMITTED'`. A second submission for the cycle cannot be written, and
   the executor reads that failure as `ALREADY_SUBMITTED` rather than retrying.
2. **Broker** — the same id is the `client_order_id`. A failed or ambiguous
   POST is resolved by looking the id up rather than by assuming nothing was
   created.
3. **Risk** — SQLite migration `008` and PostgreSQL migration `003` make an
   `ORDER_SUBMITTED` whose causation event is not an `APPROVED`
   `RISK_SHADOW_DECISION_RECORDED` unrepresentable, and an `ORDER_FILLED` /
   `ORDER_REJECTED` with no matching submission likewise. An order that skipped
   the gate cannot exist in the ledger.

Order events are the only kinds besides the paper-trader result allowed to land
after a cycle terminal event, since execution runs after the cycle closes.

`reconcileOpenOrderRecordsV1` runs at startup before any new cycle. For every
submission without a terminal event it asks the broker what it holds:

| Broker state | Resolution |
| --- | --- |
| filled | append `ORDER_FILLED` |
| rejected / canceled / expired | append `ORDER_REJECTED` with that reason |
| still working | leave open, revisit next startup |
| unknown to the broker | append `ORDER_REJECTED` / `SUBMISSION_ABANDONED` |

It never resubmits. Unrecognized broker statuses are treated as open, so a
state this code does not know about resolves later instead of inventing a
terminal record.

## Paper-only

`https://paper-api.alpaca.markets` is the only allowed origin, and the live
origin is deliberately absent from the source so no configuration can reach it.
The endpoint is asserted when the submitter is constructed and again
immediately before submission (plan section 9). A custom host is accepted only
when a `fetch` implementation is injected, which is the test seam.

## Exposure hold

`hasHeldExecutedEntryV1` withholds trade-intent eligibility while a fill is
recorded in the ledger, so a cycle is not spent on a proposal the risk gate
would reject for exposure anyway. This is an optimisation, not a control: the
authoritative exposure check remains `evaluateTradeIntentRiskV1` over live
broker state.

## Validating it: `pnpm execute:mock`

```bash
pnpm execute:mock -- --long <OCC> --short <OCC> [--confirm]
```

Drives one real paper order without the agent. Quotes, the risk function, the
ledger, and the broker are real; only application-owned risk *state* (account,
portfolio, contract metadata, collateral, schedule window) is synthetic, so an
order stays unreachable unless `evaluateTradeIntentRiskV1` returns `APPROVED`.
Without `--confirm` it stops at the risk verdict. It refuses the production
ledger and any non-paper endpoint.

The synthetic context is typed against `riskEvaluationInputV2Schema`, so a
future change to the captured state shape fails `pnpm typecheck` here rather
than silently degrading the harness into a permanent `RISK_INPUT_INVALID`.

Verified 2026-09-01 against the live paper account: submit → `new` at the
broker with both legs opening at a 2.46 net debit → cancel → reconcile appended
`ORDER_REJECTED` / `ORDER_CANCELED`.

## Not in this version

Entry-order timeouts, profit-target, stop, time-based and regime-invalidation
exits (plan section 6.B), and the manual kill switch that blocks entries while
permitting exits (section 9). Until those land, a fill is held until it is
flattened manually.
