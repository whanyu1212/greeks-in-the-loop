# Event Ledger V2

The SQLite ledger is append-only and records research lifecycle, evidence references, validated results, derived intents, shadow-risk decisions, breaker transitions, and terminal outcomes.

Event payloads are strict and bounded. SQL migrations enforce lifecycle ordering and tamper-evident event chaining. Screening-audit events are no longer produced.

New events use `eventVersion: "2.0.0"`. Historical V1 rows remain readable but cannot be appended or exported as V3 research-run artifacts.

Dry runs use a separate ledger. Agent-authored raw responses and provider credentials are never ledger payloads.
