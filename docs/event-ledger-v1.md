# Event Ledger V3

The SQLite ledger is append-only and records research lifecycle, evidence references, validated results, derived intents, shadow-risk decisions, application-verified spread Greeks when risk input is valid, breaker transitions, and terminal outcomes.

Event payloads are strict and bounded. SQL migrations enforce lifecycle ordering and tamper-evident event chaining. Screening-audit events are no longer produced.

New events use `eventVersion: "3.0.0"`. Historical V1 rows remain readable by the ledger decoder but are ignored by current context projection and cannot be appended or exported as V5 research-run artifacts. Existing V2 ledgers require a fresh ledger.

Dry runs use a separate ledger. Agent-authored raw responses and provider credentials are never ledger payloads.
