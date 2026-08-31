# Dry-run research

```bash
pnpm agent:once -- --dry-run
pnpm agent:once -- --dry-run --session 2026-08-28
```

Dry runs always use an isolated ledger and cannot target the configured production ledger.

For the current New York trading date, dry run creates a synthetic processing window so a valid proposal can reach deterministic shadow risk outside the normal entry schedule. For an older or latest-completed session, it is research-only and may retain `PreliminaryResearchV2`; it cannot derive a trade intent.

Dry run changes scheduling only. Data validity, freshness, account checks, contract validation, permissions, and risk rules remain identical.
