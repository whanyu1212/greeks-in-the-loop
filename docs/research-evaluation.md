# Offline research evaluation

`pnpm research:evaluate` evaluates one completed `ResearchRunV1` reconstructed
from the authoritative SQLite ledger. It performs no network requests, does not
write evaluation state, and cannot authorize or mutate a trade. Because its
result depends only on the retained run, evaluating the same ledger state twice
produces byte-identical JSON.

The command selects the latest completed cycle by default. Pass `--cycle` to
select another completed cycle and `--ledger` to select a different database:

```bash
pnpm research:evaluate
pnpm research:evaluate -- --cycle <cycle-id>
pnpm research:evaluate -- --ledger .state/research-anytime.sqlite --cycle <cycle-id>
```

An evaluation dimension has status `PASS`, `FAIL`, or `NOT_APPLICABLE` and a
sorted list of bounded issue codes. A failed dimension is a successful
evaluation result, so it is printed normally. The command exits unsuccessfully
only when it cannot load and project a completed run.

## Dimensions

| Dimension | Deterministic checks |
| --- | --- |
| Contract compliance | Reuses the existing report, decision, preliminary-research, eligibility, and intent schemas; checks that the report, retained record, and terminal outcome agree. An anytime dry run must retain its mode marker, remain trade-ineligible, have no trade window, and use the research-only reason. |
| Temporal integrity | Checks the cycle time range and ensures report, source-retrieval, snapshot-retrieval, and intent-evaluation timestamps remain inside it where applicable. |
| Grounding | Checks inference-to-sourced-fact links and decision snapshot references. |
| Candidate identity | Checks candidate agreement across the report result, retained decision or preliminary result, report diagnostics, and derived intent. |
| Fail-closed behavior | Detects intent derivation from an ineligible cycle or without a validated proposal. |

Healthy `DRY_RUN_ANYTIME` preliminary-research and no-action outcomes are valid
evaluation inputs. Any derived intent remains a fail-closed violation.

The result also reports counts for sourced facts, inferences, grounded
inferences, snapshot references, and retained Exa and FMP sources. It carries
the cycle and terminal event identifiers plus the run, report, contract, and
strategy versions already present in the artifact. There is deliberately no
weighted aggregate score: weights require a calibrated dataset and would hide
which safety or quality dimension changed.

## Privacy and storage

Evaluation output contains only identifiers, retained version labels, bounded
issue codes, statuses, and counts. It excludes thesis and evidence prose,
citations and URLs, option symbols, provider payloads, credentials, and hidden
reasoning. Results are not stored because they are deterministic and can be
recomputed from SQLite; this avoids creating a second source of truth.

Model, prompt, and skill revisions are not yet retained in `ResearchRunV1`, so
this evaluator does not invent labels for historical runs. LLM-as-judge
scoring, variant comparison, AX publication, human annotations, and detailed
OpenCode event adaptation remain separate increments.
