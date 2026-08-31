# Research Screening Audit V1

## Scope

`ResearchScreeningAuditV1` is the bounded, non-authoritative contract for issue
#66. It records application-owned SPY capture and deterministic screening,
projects the existing agent result without retaining new model prose or
financial values, and classifies only comparisons supported by retained input
identity.

The runtime starts application capture beside the legacy agent only when the
cycle is trade-intent eligible and has a real scheduled slot. The authoritative
research completion or interruption commits first; one bounded
`RESEARCH_SCREENING_AUDIT_RECORDED` event is then appended as an observational
child of that terminal. Audit construction or persistence failures are logged
without changing the terminal, scheduler backoff, or research-loop breaker.

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
once per nonzero reason in the canonical reason order. When candidates exist,
diagnostics retain the screener's rank-one candidate ID and the application
result must match it. This prevents provider response order, serialized
candidate substitution, and traversal-time winner changes from changing the
funnel.
Capture failures are outside the strategy engine and use their own bounded,
unique, canonically ordered application-audit reasons.

The diagnostics do not retain quotes, Greeks, feature values, provider payloads,
or errors. Candidate IDs, component versions, thresholds, financial arithmetic,
and total ranking are unchanged.

## Trusted input identity

Application input identity contains both content-addressed snapshot IDs, the
evaluation time, contract count, and a Merkle membership commitment over the
canonical contract-symbol list. A selected result retains logarithmic-size
proofs that both leg symbols belong to that commitment. Only application code
may supply this identity.

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
invocation version. `OBSERVATION` evidence requires `observedAt <= asOf`;
`EXTERNAL` evidence requires `observedAt <= retrievedAt <= asOf`. No-action
reasons are unique and canonically ordered.
Model-identity-drift records retain that invocation version, name the registered
expected provider or model, and require a different observed value.

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

## Runtime authority boundary

The application snapshot and screening result never enter the agent prompt,
proposal validation, trade-intent derivation, shadow-risk evaluation, or terminal
record. Snapshot bodies and provider payloads are not persisted. Live legacy
reports do not receive trusted application input identity or identical-input
checks, so independently captured observations cannot be mislabeled as an
algorithm mismatch.

Audit capture uses an independent abort signal bounded by the existing cycle
timeout. Early authoritative failures cancel unfinished capture; provider,
screening, projection, and audit-append failures remain non-authoritative.
Application-audit failures are therefore visible in retained diagnostics but do
not engage the production research-loop breaker. Existing agent invocation and
model-identity failures retain their existing breaker behavior.

## Non-goals

V1 does not provide aggregate reports, threshold tuning, profitability evidence,
authority promotion, replay migration, an audit-specific breaker, or a forward
shadow window.
