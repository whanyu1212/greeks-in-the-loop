# Research Behavior Evaluation

| Field | Value |
| --- | --- |
| Evaluation version | `1.0.0` |
| Prompt version | `1.4.0` |
| Skill version | `1.2.0` |
| Strategy version | `1.1.0` |
| Production credentials | Not used |

## Purpose

The behavior suite checks whether the research agent follows the checked-in
research procedure, not whether a prewritten JSON fixture satisfies a schema.
It complements contract, cycle, replay, risk, and offline run evaluation.

The deterministic grader evaluates five dimensions:

1. Contract compliance and bare-JSON output.
2. Expected decision and fail-closed reason.
3. Broker-authority and tool boundaries.
4. Tool order, early stopping, and call budgets.
5. External-source relevance, deduplication, and conflict retention.

## Deterministic CI

`pnpm research:eval` runs fixture-backed grader tests. It performs no network or
model calls and needs no credentials. These tests verify the grader, scenario
coverage, and expected policy failures.

The scenario matrix covers:

- early account-gate stopping;
- irrelevant but recent Exa context;
- canonical and syndicated duplicates;
- material source conflict;
- prompt injection in retrieved content;
- operator requests for broker mutation;
- one complete stale-snapshot rebuild;
- candidate changes after refresh;
- a bounded adversarial proposal; and
- weak evidence ending in `NO_ACTION`.

## Optional live-model evaluation

Run one scenario:

```bash
pnpm research:eval:live -- --scenario valid-adversarial-proposal
```

Run the complete suite:

```bash
pnpm research:eval:live -- --scenario all
```

The command starts OpenCode with a temporary isolated project and a deterministic
mock MCP server. The mock exposes only read-only Alpaca-shaped, FMP, Exa, and
`trusted_time` tools. It never loads production research-provider credentials.
The selected OpenCode model must already be authenticated.

Results are written privately under `workspace/research-evals/`, which is ignored
by Git. Each scenario records the bounded response, content-free invocation
summary, and deterministic evaluation. Live-model results are intentionally not
part of required CI because they incur cost and can vary across model versions.

## Interpreting failures

Safety failures—invalid contracts, forbidden tools, authority expansion, or
failure to stop after an authoritative gate—must be fixed before the prompt or
skill version is accepted. Quality failures should be reviewed against the mock
transcript before changing policy. Do not loosen a budget solely to make one
model pass; first determine whether pagination or required provider behavior
makes the budget unrealistic.

Generated evaluation output is diagnostic, not an authoritative research run
and is never written to the event ledger.
