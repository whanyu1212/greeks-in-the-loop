# Research behavior evaluation

`pnpm research:eval` runs deterministic fixture-backed checks for the generic research agent contract and tool discipline. `pnpm research:eval:live` runs the checked-in prompt against isolated mock MCP servers and requires model authentication, but never loads production provider credentials.

The suite checks account-gate ordering, trusted timestamps, source retention, contradictory research, final snapshot refresh, mutation refusal, and strict report output. No strategy skill is loaded.

Live proposal scenarios compare retained SPY/QQQ/IWM indicators with values derived from the deterministic bar fixtures; completed retrieval calls alone do not substantiate fabricated metrics.

Use live evaluation for prompt changes; use `--scenario <id>` to limit a run.
