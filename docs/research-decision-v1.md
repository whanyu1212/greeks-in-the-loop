# Research Decision Contract v1

| Field | Value |
| --- | --- |
| Contract version | 1.0.0 |
| Strategy version | 1.0.0 |
| Status | Contract layer implemented; runtime integration pending |
| Tracking issue | [#6](https://github.com/whanyu1212/greeks-in-the-loop/issues/6) |
| Strategy specification | [`strategy-v1.md`](strategy-v1.md) |

## Purpose

`ResearchDecision` is the single structured boundary between untrusted agent output and deterministic application code. It describes either:

- a safe `NO_ACTION` conclusion, or
- a `PROPOSE_TRADE` research conclusion identifying a candidate SPY debit spread.

The contract constrains the final handoff, not the agent's internal research process. Passing this contract means only that the output is structurally valid and its evidence references are known and fresh. It is not risk approval, permission to trade, or proof that the candidate remains eligible.

## Ownership Boundary

### Agent-authored

The agent may provide:

- the contract and strategy versions
- the outcome
- strategy-aligned `NO_ACTION` reason codes
- a bounded thesis
- a supported direction and candidate structure
- candidate expiration, leg symbols, and strikes
- bounded invalidation statements
- sourced claims and explicitly labeled inferences

### Application-owned

Deterministic application code owns:

- cycle, decision, and correlation identifiers
- scheduled slots and receipt timestamps
- raw provider snapshots
- provider identity, retrieval time, and freshness deadlines
- authoritative account and market state
- contract eligibility and candidate ranking
- quotes and exact decimal pricing
- debit, width, maximum loss, and maximum profit
- buying-power and circuit-breaker checks
- exits, quantity, order type, time in force, and order parameters
- `TradeIntent` derivation, risk approval, and execution

Application-owned values must not be accepted from the model as authoritative data.

## Root Outcomes

The root contract is a discriminated union on `outcome`.

### `NO_ACTION`

A minimal valid result requires only:

| Field | Purpose |
| --- | --- |
| `contractVersion` | Selects the compatible parser and validation rules. |
| `strategyVersion` | Ties the conclusion to the frozen strategy rules. |
| `outcome` | Selects the safe no-action branch. |
| `reasonCodes` | Records one or more machine-readable strategy reasons. |

`evidence` is optional and defaults to an empty list. Extra commentary is discarded so malformed optional prose cannot invalidate an otherwise safe `NO_ACTION`.

Example:

```json
{
  "contractVersion": "1.0.0",
  "strategyVersion": "1.0.0",
  "outcome": "NO_ACTION",
  "reasonCodes": ["SIGNAL_NOT_ACTIONABLE"]
}
```

Supported reason codes map to the explicit no-action categories in the strategy specification:

| Code | Strategy condition |
| --- | --- |
| `MARKET_WINDOW_INELIGIBLE` | The market, session, slot, or entry window is ineligible. |
| `ACCOUNT_STATE_INELIGIBLE` | Required account state is unavailable, restricted, or inconsistent. |
| `POSITION_OR_RISK_LIMIT_ACTIVE` | A position, pending entry, same-day entry, or circuit breaker blocks entry. |
| `INSUFFICIENT_UNDERLYING_DATA` | Required daily or session bars are insufficient. |
| `REQUIRED_ALPACA_DATA_INVALID` | Required Alpaca evidence is unavailable, malformed, missing, or stale. |
| `SIGNAL_NOT_ACTIONABLE` | The regime is neutral or the intraday trigger disagrees with it. |
| `NO_ELIGIBLE_SPREAD` | No complete spread passes all eligibility rules. |
| `CANDIDATE_CHANGED` | Refreshed evidence changes the selected candidate. |
| `EXACT_RISK_INPUTS_UNAVAILABLE` | Exact maximum loss or buying-power reserve cannot be determined. |
| `CONTRACT_UNREPRESENTABLE` | The conclusion cannot be represented as a supported proposal. |

### `PROPOSE_TRADE`

A proposal identifies the research candidate that deterministic code must independently validate.

| Field | Purpose |
| --- | --- |
| `contractVersion` | Selects the compatible parser and validation rules. |
| `strategyVersion` | Ties the proposal to the frozen strategy rules. |
| `outcome` | Selects the proposed-trade branch. |
| `direction` | Constrains the proposal to `BULLISH` or `BEARISH`. |
| `thesis` | Records the bounded research conclusion. |
| `candidate` | Identifies the exact supported spread for deterministic comparison. |
| `invalidation` | States bounded conditions that invalidate the research conclusion. |
| `evidence` | Connects the conclusion to sourced facts and labeled inference. |

Example:

```json
{
  "contractVersion": "1.0.0",
  "strategyVersion": "1.0.0",
  "outcome": "PROPOSE_TRADE",
  "direction": "BULLISH",
  "thesis": "Daily and intraday direction agree.",
  "candidate": {
    "underlying": "SPY",
    "structure": "BULL_CALL_SPREAD",
    "expiration": "2026-09-18",
    "longLeg": {
      "contractSymbol": "SPY260918C00650000",
      "strike": 650
    },
    "shortLeg": {
      "contractSymbol": "SPY260918C00655000",
      "strike": 655
    }
  },
  "invalidation": [
    "Reject if refreshed evidence changes the selected candidate."
  ],
  "evidence": [
    {
      "claimId": "fact-1",
      "kind": "SOURCED_FACT",
      "claim": "The selected contracts were present in the option-chain snapshot.",
      "snapshotRef": "alpaca-market-1",
      "locator": "contracts[0:2]"
    },
    {
      "claimId": "inference-1",
      "kind": "INFERENCE",
      "claim": "The sourced fact supports continued evaluation of this candidate.",
      "basedOn": ["fact-1"]
    }
  ]
}
```

Proposal validation enforces:

- the underlying is `SPY`
- bullish direction uses a bull call spread
- bearish direction uses a bear put spread
- a bull-call long strike is lower than its short strike
- a bear-put long strike is higher than its short strike
- expiration and each leg identifier are present
- each OCC contract symbol matches SPY, the candidate expiration, option type, and stated strike
- the long and short legs identify different contracts
- at least one sourced fact supports the proposal
- unknown proposal and candidate fields are rejected

## Evidence Model

Evidence is a discriminated union.

### Sourced fact

A sourced fact contains:

- a decision-local unique `claimId`
- `kind: "SOURCED_FACT"`
- bounded claim text
- a stable `snapshotRef`
- an optional bounded locator within the snapshot

The model references but does not reproduce the raw provider response.

### Inference

An inference contains:

- a decision-local unique `claimId`
- `kind: "INFERENCE"`
- bounded inference text
- one or more `basedOn` claim IDs

Every `basedOn` reference must resolve to a sourced fact in the same decision. Inference chains are not accepted; an inference cannot use another inference as its basis.

## Trusted Snapshot Context

The public validator receives application-owned context separately from the model output:

```ts
type ResearchDecisionValidationContext = {
  evaluatedAt: string
  snapshots: Readonly<
    Record<
      string,
      {
        provider: "ALPACA" | "FMP" | "EXA"
        source: string
        retrievedAt: string
        freshUntil: string
      }
    >
  >
}
```

Snapshot construction is responsible for calculating `freshUntil` from the applicable provider and strategy rules. The contract validator does not duplicate those thresholds.

For every sourced fact, validation rejects:

- an unknown snapshot reference
- a snapshot retrieved after `evaluatedAt`
- snapshot metadata whose `freshUntil` precedes `retrievedAt`
- a snapshot whose `freshUntil` is before `evaluatedAt`

A snapshot is valid through the exact `freshUntil` instant. FMP and Exa snapshots may support context, but they do not become authoritative execution-price sources.

The context is a validation interface only. Durable snapshot persistence is deferred to the event-ledger work in issue #13.

## Model-Excluded Fields

A proposal must not include execution or authoritative risk fields, including:

- `entryLimit`
- `maxLoss`
- `maxProfit`
- `buyingPowerImpact`
- `exits`
- `quantity`
- `orderType`
- time in force
- client order IDs
- broker order parameters

The proposal schema is strict, so unknown root, candidate, leg, and evidence fields fail validation. This prevents model-supplied values from being silently retained and later mistaken for deterministic results.

## Fail-Closed Validation

Use `validateResearchDecisionV1(input, context)` for untrusted output.

The function returns a success/failure union and does not throw for invalid model output:

```ts
type ResearchDecisionValidationResult =
  | { success: true; data: ResearchDecisionV1 }
  | {
      success: false
      issues: readonly {
        code: ResearchDecisionValidationIssueCode
        path: readonly (string | number)[]
      }[]
    }
```

Failures expose only bounded issue codes and field paths. They do not include the original untrusted payload or provider content.

Issue codes are:

- `SCHEMA_INVALID`
- `CONTEXT_INVALID`
- `DUPLICATE_CLAIM_ID`
- `UNKNOWN_SNAPSHOT`
- `SNAPSHOT_FROM_FUTURE`
- `STALE_SNAPSHOT`
- `UNKNOWN_INFERENCE_REFERENCE`
- `INFERENCE_REFERENCE_NOT_FACT`

Invalid, incomplete, stale, or unsupported output must not reach strategy derivation, risk evaluation, or execution.

## Compatibility And Versioning

`contractVersion` and `strategyVersion` are independent:

- `contractVersion` changes when the shape or validation semantics of the handoff change.
- `strategyVersion` follows the versioning rules in [`strategy-v1.md`](strategy-v1.md).

Consumers must select a validator by exact contract version. Unsupported versions fail closed rather than being coerced.

The current contract does not define `TradeIntent`. Runtime integration and deterministic intent derivation remain separate work under issue #6.