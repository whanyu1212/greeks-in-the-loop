# Event Ledger V1

The SQLite ledger is append-only and records research lifecycle, evidence references, validated results, derived intents, shadow-risk decisions, breaker transitions, and terminal outcomes.

Event payloads are strict and bounded. SQL migrations enforce lifecycle ordering and tamper-evident event chaining. Screening-audit events are no longer produced.

Dry runs use a separate ledger. Agent-authored raw responses and provider credentials are never ledger payloads.
