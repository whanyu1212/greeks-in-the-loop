# Research Market Snapshots V1

## Status and scope

This document defines the normalized, application-owned market-data identity used
by deterministic SPY screening. Contract version `1.0.0` and normalization
version `1.0.0` define data only. `createAlpacaResearchSnapshotProvider` captures
that data without invoking the research agent. Trade-intent-eligible cycles now
use it as a non-authoritative audit sidecar under #66. The pure
`directional-debit-vertical-v1` strategy component consumes a validated snapshot
pair to calculate exact features and select the deterministic rank-one SPY
candidate; runtime authority remains unchanged until #67.

The contract contains no provider client, model output, account state, risk
result, runtime callback, credential, URL, page token, or raw provider payload.
It does not change any existing research, ledger, risk, dataset, or replay
artifact.

## Linked records

One decision capture produces two content-addressed records:

1. `UnderlyingSessionSnapshotV1` owns the strategy manifest, current Alpaca
   session, scheduled slot, capture times, completed underlying bars, and IEX
   quote.
2. `OptionUniverseSnapshotV1` contains the normalized complete SPY option
   universe and references the full underlying snapshot ID.

The option record does not duplicate the strategy manifest. Its link binds that
manifest, the session, and the underlying evidence transitively. Consumers must
call `validateResearchSnapshotPairV1` before using the records together.

## Canonical units

All values use bounded JSON-safe integers rather than financial floats:

| Value | Unit |
| --- | --- |
| Underlying OHLC, VWAP, bid, ask | microdollars per share |
| Option bid, ask, strike | cents per share |
| Delta, gamma, theta, vega, implied volatility | millionths of the provider unit |
| Volume and open interest | contracts |

Delta is bounded to `[-1_000_000, 1_000_000]`, and implied volatility must be
positive. Provider Greeks and implied volatility are rounded to the nearest
millionth with ties away from zero. Prices and counts must be exactly
representable in their canonical units; unsupported precision fails capture.

Every timestamp is canonical UTC with millisecond precision:
`YYYY-MM-DDTHH:mm:ss.sssZ`. Dates use `YYYY-MM-DD`.

## Underlying/session snapshot

The snapshot contains:

- the complete static strategy/component manifest admitted at construction;
- literal underlying `SPY`;
- the current Alpaca session's date, open, and close;
- exactly 50 preceding session dates in ascending order;
- scheduled slot, capture start, `observedAt`, and evaluation time;
- calendar, adjusted daily IEX-bar, regular-session minute IEX-bar, and latest
  IEX-quote provenance with application retrieval times;
- exactly one normalized adjusted daily bar per preceding session;
- every completed regular-session one-minute interval through `observedAt`,
  with each retained bar completed before its source response was retrieved;
- one fresh current-session SPY quote; and
- explicit complete pagination and count evidence.

The contract validates weekday calendar ordering, exact bar topology, unique
records, daily-bar timestamps bound to their declared sessions, positive
OHLC/VWAP/volume, OHLC relationships, source times inside the capture window,
and quote freshness. Provider observation timestamps may not follow the
application retrieval time of the response that supplied them. The contract
cannot derive exchange holidays by itself; the provider obtains the complete
ordered session list from the Alpaca calendar and fails capture when that
evidence is incomplete. Initial freshness
is measured against `observedAt`,
the application timestamp captured after the final snapshot-forming response.
Later approval must recheck freshness independently.

The contract records normalized evidence only. It does not calculate SMA20,
SMA50, session VWAP, midpoint, regime, or direction. The symbol-neutral feature
calculator performs that arithmetic after snapshot-pair validation.

## Option-universe snapshot

The snapshot references the exact underlying snapshot ID and contains:

- literal underlying `SPY` and the linked session date;
- the linked capture times;
- a fixed 14-through-30 calendar-day active-contract scope for calls and puts;
- Alpaca contract and indicative option-snapshot provenance;
- terminal-pagination and exact coverage evidence; and
- contracts sorted strictly by compact Alpaca broker symbol.

Every contract contains normalized identity and metadata, an indicative quote,
scaled Greeks and implied volatility, current-session volume, and dated open
interest. Compact-symbol parsing, SPY authorization, expiration, option type,
and cent-denominated strike consistency are validated independently.

A complete snapshot may retain a non-tradable contract, a zero-bid quote with a
positive ask, an unsupported exercise style or multiplier, or metrics below
strategy eligibility thresholds. Those are valid observations for the pure
strategy component to reject. Snapshot construction rejects missing,
malformed, duplicate, cross-symbol, out-of-scope, stale, future-dated, or
incompletely covered records; it does not apply delta bands, liquidity
thresholds, quote-width limits, spread construction, or ranking.

Open interest must be dated no later than the session and, when linked with the
underlying calendar, must be from the current date or one of the two latest
completed sessions.

## Alpaca capture boundary

`createAlpacaResearchSnapshotProvider` is a read-only SPY-only adapter. It uses
credential-free allowlisted Alpaca origins, explicit IEX and indicative feeds,
bounded retries and request timeouts, terminal pagination evidence, and exact
symbol-set joins. Missing, empty, repeated, over-limit, stale, future-dated, or
cross-symbol responses fail closed with bounded reason codes. Caller
cancellation escapes without recording a misleading capture failure. Raw
provider payloads and credentials never cross the adapter boundary.

The provider returns a validated snapshot pair but does not persist it or invoke
screening. The #66 composition root passes that pair to deterministic screening
and persists only bounded identity, latency, result, and rejection-funnel
diagnostics after the authoritative cycle terminal. Snapshot bodies remain
ephemeral.

## Content identity

Each ID is the full lowercase SHA-256 digest of canonical JSON containing a
domain separator and every field except `snapshotId`:

```text
SHA256(canonical_json({ domain, content_without_snapshot_id }))
```

Object keys are canonicalized recursively. Builders reject duplicates before
sorting and sort session dates, bars, requested symbols, and contracts by their
stable identity keys. They never silently deduplicate. Consequently, provider
response ordering cannot change normalized bytes or IDs, while any retained
value, timestamp, provenance field, manifest field, completeness fact, or linked
snapshot ID changes the digest.

## Decoder and builder boundary

Persisted V1 schemas decode their embedded manifest structure and verify content
IDs without importing mutable current registry state. This preserves historical
meaning.

`buildUnderlyingSessionSnapshotV1` and `buildOptionUniverseSnapshotV1` are pure,
I/O-free current-runtime constructors. New construction requires the exact
current manifest, canonicalizes inputs, returns bounded ordered reasons,
verifies the persisted schema, and recursively freezes successful output. Pair validation remains
decode-only for historical artifacts; current screening separately rejects any
embedded manifest that is not compatible with the runtime registry.

Malformed input returns `INPUT_INVALID`. Other bounded failures distinguish
manifest, underlying, duplicate, completeness, identity, future/stale
observation, and final snapshot validity. Raw Zod messages and rejected provider
values never cross this boundary.

## Explicit non-goals

The snapshot contract and builders do not implement:

- Alpaca requests, pagination loops, retries, timeouts, or credentials;
- runtime authority, research-agent inputs, snapshot-body persistence, or research artifacts;
- signal features, contract eligibility, candidate IDs, spreads, or ranking;
- risk evaluation, intent derivation, exact-leg confirmation, or execution;
- replay migration; or
- QQQ, IWM, stocks, or another strategy family.
