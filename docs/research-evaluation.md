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
| Contract compliance | Checks that the report result, the retained record, and the terminal outcome agree, that a successful outcome retains its report, and that the report's declared strategy and contract versions match what the invocation authorized. |
| Temporal integrity | Checks the cycle time range and ensures the report's own `asOf` and source-retrieval timestamps remain inside it, plus report and evidence freshness at intent evaluation and the retained preliminary session context. |
| Grounding | Checks inference-to-sourced-fact links and decision snapshot references. |
| Candidate identity | Checks candidate agreement across the report result, retained decision or preliminary result, report diagnostics, and derived intent. |
| Fail-closed behavior | Detects intent derivation from an ineligible cycle, without a validated proposal, outside the retained trade window, or with no retained eligibility context at all. |

Healthy `DRY_RUN_ANYTIME` preliminary-research and no-action outcomes are valid
evaluation inputs. Any derived intent remains a fail-closed violation.

## What the dimensions deliberately do not check

The graded checks are limited to failures the **research agent** can cause.
Checks that only application code could fail were removed in evaluation version
`1.1.0`: re-parsing contracts that `.strict()` schemas already reject at the
trust boundary, re-deriving app-computed eligibility windows, and comparing
app-generated invocation constants against themselves. None of them could fire
without a hand-edited ledger row.

A `PASS` therefore means the agent behaved, not that application-side
invariants were re-verified — those are enforced at the contract boundary and
by `evaluateTradeIntentRiskV1`, which re-fetches every financial input itself.
Because this changes what a result means, compare two evaluations only when
they report the same `evaluationVersion`.

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

New `ResearchRunV1` records retain bounded model, prompt, skill, strategy, and
contract provenance. Legacy `1.0.0` and `1.1.0` runs remain evaluable without
invented metadata; a `1.2.0` run fails contract compliance when this metadata is
missing or inconsistent. LLM-as-judge scoring, variant comparison, AX
publication, and human annotations remain separate increments.
