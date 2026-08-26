# Research Event Ledger V1

| Field | Value |
| --- | --- |
| Envelope version | `1.0.0` |
| Storage adapter | SQLite through `better-sqlite3` |
| Ownership model | One worker process, one writable connection |
| Runtime integration | Research worker startup, cycles, and restart recovery |

## Purpose

The ledger is the durable audit boundary for the existing research-to-intent flow. It stores validated, versioned events needed for restart recovery and later bounded context reconstruction.

The running worker opens and migrates the ledger before OpenCode starts, records every session and cycle, reconstructs incomplete work after restart, and closes the ledger after runtime shutdown.

## Event envelope

Every event contains:

- `eventId`: unique immutable event identity;
- `eventVersion`: envelope version;
- `eventType`: registered research event type;
- `occurredAt`: canonical domain occurrence timestamp;
- `correlationId`: identifier connecting the complete research trail;
- optional `causationEventId`: direct causal predecessor;
- optional `cycleId`: stable research-cycle identity;
- optional `sessionId`: OpenCode session identity;
- a strict, versioned payload.

SQLite assigns:

- `sequence`: total append order;
- `recordedAt`: ledger commit timestamp.

The event vocabulary is intentionally limited to domains already implemented. Future risk, execution, fill, position, reconciliation, and breaker events belong to their owning issues.

## Ordering and atomicity

Events are returned in ascending `sequence` order by default. Queries can request descending order for bounded recent-history projections.

`appendBatch` validates the complete batch before opening a transaction. The transaction commits every event or none. A duplicate event ID, invalid causal reference, unsafe payload, schema failure, or SQLite error rolls back the batch.

Each serialized event payload is limited to 64 KiB. Event-specific arrays and strings have tighter schema bounds where appropriate.

Causal events must appear before their dependents in the same batch or already exist in the ledger.

Each research cycle has one start and at most one completion or interruption event. Database constraints reject cycle identity drift, cross-cycle causation, duplicate terminals, and events appended after a terminal. Normal result events and completion are committed in one atomic batch.

## Append-only guarantee

The public store interface exposes append and query operations only.

SQLite triggers reject direct `UPDATE` and `DELETE` statements against `ledger_events`. This provides application-level append-only history and defense in depth against accidental SQL mutation.

This is not cryptographic tamper evidence. A filesystem administrator can replace the database file. Hash chaining or external checkpoint anchoring requires a later threat-model decision.

## Migrations

Migrations have unique ascending identifiers and SHA-256 checksums.

The runner:

1. creates the migration registry when absent;
2. verifies the checksum of every applied migration and rejects unknown or divergent applied history;
3. applies pending migrations in an immediate transaction;
4. records each migration only after its SQL succeeds;
5. safely re-runs when the database is current.

Editing an applied migration causes startup failure. Schema changes require a new migration.

## Persistence safety

The ledger rejects:

- API keys, secrets, passwords, tokens, cookies, and authorization fields;
- bare values matching application-supplied Alpaca, FMP, or Exa credentials;
- environment or request-header containers;
- credential-bearing URL user information;
- secret-like URL query or fragment parameters;
- `undefined`, bigint, functions, symbols, non-finite numbers, cyclic values, excessive nesting, dates, and other prototype-bearing objects.

The SQLite adapter requires the application to supply its known credential values when it is created. Unsafe raw payloads fail before schema normalization or append and are never partially committed. Errors expose only bounded structural path placeholders and never include rejected values or untrusted property names.

Raw model responses, full OpenCode transcripts, complete MCP/provider responses, hidden reasoning, credentials, and secret-bearing URLs are outside the ledger contract.

## Queries

The database-neutral store supports:

- exact event-ID lookup;
- correlation, cycle, and session filtering;
- event-type filtering;
- ascending or descending sequence pagination with exclusive before/after cursors;
- required bounded limits.

Queries use prepared parameters. No arbitrary SQL is exposed through the store interface.

## SQLite operating constraints

SQLite is appropriate while:

- one supervised worker owns the writable database connection;
- event volume is low and append-oriented;
- transactions are short;
- the database resides on a supported local filesystem;
- other components do not open independent writable connections.

The adapter enables:

- foreign keys;
- WAL journaling;
- `synchronous = FULL`;
- a bounded busy timeout.

The database file and its WAL state must be backed up together.

## PostgreSQL migration triggers

Add a PostgreSQL adapter when any of these becomes true:

- research, risk, execution, or protection run as separate writable services;
- multiple processes need concurrent writes;
- active/passive failover spans machines;
- the database must reside on a network filesystem;
- remote operator queries should not share the worker process;
- measurable write contention appears.

Domain code must depend only on `LedgerStore`, so event schemas and reconstruction logic remain portable.

## Runtime lifecycle

The worker creates a fresh OpenCode session for every cycle, then generates one stable `cycleId` and `correlationId` before the prompt. It appends `OPENCODE_SESSION_STARTED` and `RESEARCH_CYCLE_STARTED` before model work begins. Evidence references, validated or rejected decisions, derived or rejected intents, and `RESEARCH_CYCLE_COMPLETED` are then appended as one causally ordered atomic batch.

Timeout, explicit cancellation, unexpected runtime failure, process shutdown, and startup recovery produce `RESEARCH_CYCLE_INTERRUPTED`. A cycle-scoped recorder arbitrates completion and interruption in memory, while database constraints provide the durable exactly-one-terminal backstop. Ledger persistence failures are fatal and are never relabeled as ordinary cycle interruptions.

On startup, the worker scans lifecycle events in bounded pages. Every start without a completion or interruption receives a `PROCESS_RESTART` interruption using its original cycle, correlation, session, and start-event causation identity. Recovery is idempotent.

## Bounded agent context

The worker projects at most 500 recent ledger events into a maximum 32 KiB context containing recent outcomes, the latest validated candidate and direction, recurring bounded rejection codes, normalized evidence references, recent interruptions, and required refresh markers. Projection metadata identifies truncation and the next durable cycle number.

The projection excludes thesis and evidence prose, invalidation prose, raw model responses, complete provider payloads, transcripts, credentials, and hidden reasoning. Every prompt labels projected state as historical planning context and requires current account, market, quote, and freshness facts to be refreshed. OpenCode session memory is not authoritative.

The SQLite adapter and SQL remain outside research-domain code; lifecycle and projection modules depend only on `LedgerStore`.
