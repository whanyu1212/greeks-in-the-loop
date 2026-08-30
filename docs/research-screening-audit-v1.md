# Research Screening Audit V1

## Scope

`ResearchScreeningAuditV1` is the bounded, non-authoritative contract for issue
#66. It records application-owned SPY capture and deterministic screening,
projects the existing agent result without retaining new model prose or
financial values, and classifies only comparisons supported by retained input
identity.

This contract does not wire capture into runtime, add ledger events, change the
research result, or grant screening authority. Those remain separate changes.

## Deterministic screening diagnostics

`screenSpyDirectionalDebitVerticalWithAuditV1` returns the unchanged
`SpyDebitVerticalScreeningResultV1` plus versioned counts. The existing
`screenSpyDirectionalDebitVerticalV1` delegates to it and returns only the
unchanged result.

Diagnostics count the first failed predicate for each evaluation unit:

- compatibility, feature, and underlying freshness are one cycle-level unit;
- each option contract is evaluated once for each long/short role;
- each eligible long/short combination is one spread-pair unit; and
- every eligible candidate except rank one is counted as `NOT_RANK_ONE`.

Predicates retain their existing short-circuit order. Failure counts are emitted
once per nonzero reason in the canonical reason order. This prevents provider
response order and traversal-time winner changes from changing the funnel.
Capture failures are outside the strategy engine and use their own bounded,
unique, canonically ordered application-audit reasons.

The diagnostics do not retain quotes, Greeks, feature values, provider payloads,
or errors. Candidate IDs, component versions, thresholds, financial arithmetic,
and total ranking are unchanged.

## Trusted input identity

Application input identity contains both content-addressed snapshot IDs, the
evaluation time, contract count, and a membership digest over the canonical
contract-symbol list. Only application code may supply this identity.

`ResearchReportV2` cannot establish identical input. Model-stated times and
candidate identity are useful diagnostics, but model output cannot assert that
it consumed an application snapshot. The legacy path therefore normally
classifies as a different snapshot time or `COMPARISON_NOT_REPRESENTABLE`.

## Agent projection

The bounded projection retains:

- invocation version, provider ID, and model ID;
- report `asOf`, evidence identifiers, providers, and times;
- terminal class and bounded no-action reasons; and
- direction, structure, expiration, and exact leg symbols when a candidate is
  available.

Available projections must match the provider/model identity pinned by their
invocation version. Model-identity-drift records retain that invocation version,
name the registered expected provider or model, and require a different observed
value.

It excludes thesis, summaries, claims, URLs, locators, prices, strikes, Greeks,
liquidity values, and economics.

## Comparison precedence

Comparison uses this fail-closed order:

1. application capture unavailable;
2. application screening unavailable;
3. model identity drift;
4. agent result unavailable;
5. different snapshot time;
6. different trusted option membership;
7. missing or unequal trusted snapshot identity;
8. feature, filter, ranking, then candidate parity; and
9. identical-input match.

An unavailable earlier parity stage prevents classification of a later mismatch.
Identical-input checks are application-authored evidence; they are never derived
from untrusted model claims. Equal time and membership with unequal snapshot IDs
is not identical input and remains `COMPARISON_NOT_REPRESENTABLE`.

## Non-goals

V1 does not provide runtime scheduling, persistence, aggregate reports, breaker
behavior, threshold tuning, profitability evidence, authority promotion, replay
migration, or a forward shadow window.
