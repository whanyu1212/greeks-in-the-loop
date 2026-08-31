# Offline research-run evaluation

`pnpm research:evaluate` reconstructs completed runs from the ledger and checks contract agreement, temporal integrity, grounding, candidate identity, and fail-closed behavior.

```bash
pnpm research:evaluate
pnpm research:evaluate -- --ledger .state/dry-run.sqlite
pnpm research:evaluate -- --cycle <cycle-id>
```

Evaluation is read-only and does not invoke the model or risk provider.
