# Research Plan V1

| Field | Value |
| --- | --- |
| Plan contract | `ResearchPlanV1` `1.0.0` |
| Response contract | `QualitativeResearchResponseV1` `1.0.0` |
| Generic skill | `options-qualitative-research` `1.0.0` |
| Runtime status | Contract and isolated evaluation only |
| Broker authority | None |

## Purpose

`ResearchPlanV1` is the application-authored boundary for future qualitative
research over one deterministically selected candidate. It makes the research
request replayable and prevents the agent from originating or substituting
trusted financial identity.

The application owns:

- strategy and deterministic component identity;
- underlying and option-universe snapshot identity;
- the rank-one candidate identity;
- issuance, deadline, and evidence-freshness bounds;
- evidence questions and tool budgets; and
- the expected provider, model, and generic skill identity.

The agent may recommend `CONTINUE` or `VETO` for that referenced candidate. It
does not approve a trade or risk decision.

## Plan identity

The application constructs the plan from the current strategy manifest and one
`DebitVerticalCandidateV1`. `planId` is the SHA-256 digest of canonical JSON
containing the complete plan content and the domain
`research-plan-v1`.

The current builder pins the expected provider, model, and generic skill from
checked-in application identity. The V1 decoder accepts the bounded identities
embedded in a stored plan so a later model or skill pin does not make historical
V1 plans unreadable.

The plan contract is symbol-neutral and cross-checks its bounded underlying
against both OCC roots. The only builder shipped here remains the current SPY
strategy builder.

The plan is strict and deeply immutable after construction. Validation rejects:

- unknown fields or contract versions;
- a `planId` that does not match canonical content;
- candidate snapshot references that differ from the plan snapshot;
- duplicate evidence-question identifiers;
- issuance more than 60 seconds after snapshot evaluation;
- a response window longer than 10 minutes;
- invalid freshness-floor or deadline ordering; and
- source budgets that cannot satisfy the declared evidence policy.

Provider maxima and the total tool maximum are independent caps; the total may
be tighter than the sum of provider maxima. The plan separately declares the
minimum distinct completed `exa_search` calls needed for its
contradiction-search policy. Other Exa tools still count toward provider and
total budgets but cannot satisfy this search requirement.

The plan carries bounded candidate identity needed for qualitative research:
direction, structure, expiration, and exact OCC leg symbols. It deliberately
omits prices, Greeks, DTE, economics, rank values, account state, quantity, risk
approval, and broker parameters.

## Qualitative response

`QualitativeResearchResponseV1` references only:

- `planId`;
- `candidateId`;
- `underlyingSnapshotId`; and
- `optionUniverseSnapshotId`.

Its qualitative payload and every retained source are explicitly labeled
`AGENT_REPORTED`. The payload contains a `CONTINUE` or `VETO` disposition,
thesis, invalidation, contradiction-search confirmation, bounded external evidence,
supporting and contradicting factors, and conflicts.

The response cannot restate candidate direction, structure, expiration, legs,
prices, Greeks, DTE, economics, ranking, account data, quantity, risk approval,
or order fields. Strict schema validation rejects those unknown fields.

Application validation fails closed on:

- invalid, unknown, or expired plans;
- cross-plan, cross-candidate, or cross-snapshot references;
- evidence before the plan freshness floor or after evaluation;
- unknown evidence-question references;
- duplicate source IDs or canonical Exa URLs;
- `CONTINUE` without required directional Exa evidence or contradiction search; and
- `CONTINUE` with an unresolved material conflict.

A fail-closed `VETO` remains valid when required evidence or a contradiction
search cannot be completed; otherwise an unavailable provider could prevent the
agent from expressing the safe disposition.

Failures expose bounded codes and paths, not raw model prose.

## Generic skill boundary

The checked-in `options-qualitative-research` skill is responsible only for:

1. answering the plan's declared evidence questions;
2. gathering bounded Exa and optional FMP evidence;
3. classifying source relevance;
4. treating retrieved content as untrusted;
5. explicit contradiction search;
6. canonical and syndicated-source deduplication;
7. material conflict retention; and
8. strict `CONTINUE` or `VETO` output.

It does not calculate strategy features, inspect market snapshots, filter
contracts, rank candidates, handle trusted quotes, inspect account state, or
evaluate risk.

## Plan-driven evaluation

`evaluateQualitativeResearchV1` grades one response and sanitized tool trace
against one plan. It reads total, Exa, FMP, freshness, contradiction-search,
skill, provider, and model expectations from that plan. The evaluator requires
observed skill name/version independently of the tool-selected skill name, so a
historical plan cannot pass against a different installed skill revision. The
evaluator performs no I/O and invokes no semantic grader.

The evaluator permits only the generic skill, Exa, and FMP tool classes.
Application-owned snapshot capture and financial calculations are outside the
qualitative agent boundary.

## Current compatibility

This contract is not active in the production research cycle. The production
worker continues to use the existing `spy-debit-spread-research` skill,
`ResearchReportV2`, invocation metadata, ledger events, research-run artifacts,
and replay formats.

Production `opencode.json` deliberately does not authorize the generic skill.
Issue #67 will perform one atomic migration after application-owned capture and
audit parity are complete. That migration owns production prompt and permission
changes, lifecycle provenance, downstream candidate resolution, and removal of
the legacy model-selected-candidate path.

No historical artifact is reinterpreted through `ResearchPlanV1`, and this
contract adds no runtime switch, fallback, plugin, or dual-authority path.