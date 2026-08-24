## Summary

Describe what changed and the user-visible or system behavior it enables.

## Motivation

Link the issue or explain the problem this change solves.

## Validation

List the commands, tests, backtests, or paper-trading checks performed.

```text
pnpm typecheck
pnpm test
pnpm build
```

## Trading And Risk Impact

Describe any effect on signals, position sizing, orders, positions, drawdown controls, credentials, or unattended execution. Write `None` when the change has no trading impact.

## Checklist

- [ ] The change is focused and does not include unrelated work.
- [ ] Tests cover new behavior or the absence of tests is explained.
- [ ] Typecheck, tests, and build pass locally.
- [ ] No credentials, account identifiers, or sensitive market data are committed.
- [ ] New environment variables are documented in `.env.example`.
- [ ] Trading mutations remain behind deterministic validation and risk gates.
- [ ] Broker-facing behavior was tested only with an Alpaca paper account.
- [ ] Documentation was updated when behavior or operation changed.
