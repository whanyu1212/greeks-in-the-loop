# SPY Directional Debit Spreads

| Field | Value |
| --- | --- |
| Version | 1.1.0 |
| Status | Frozen for implementation |
| Effective date | 2026-08-25 |
| Account | Alpaca paper account with $100,000 initial equity |
| Market-data plan | Alpaca Basic (free tier) |
| Tracking issue | [#7](https://github.com/whanyu1212/greeks-in-the-loop/issues/7) |

## Purpose

This document is the authoritative strategy and risk specification for the
initial MVP. It defines machine-testable research, entry, exit, and `NO_ACTION`
rules. Later work may implement these rules but must not silently change them.

The strategy trades one directional SPY debit spread when daily trend and
intraday direction agree. It otherwise takes no action. It is designed for
paper evaluation with free-tier data and does not claim live executability.

## Scope

The only supported underlying is `SPY`.

The only supported entry structures are:

- Bull call spread: buy one call and sell one higher-strike call with the same
  expiration.
- Bear put spread: buy one put and sell one lower-strike put with the same
  expiration.

`NO_ACTION` is a valid and expected result. The strategy may have at most one
open spread, one pending entry, and one new entry per trading day.

## Time Conventions

- All market windows use `America/New_York`, including daylight-saving changes.
- Trading sessions come from the Alpaca market calendar.
- Decision slots occur at minute `00`, `15`, `30`, and `45` of each hour. A
  cycle may start during the first five minutes of its slot. Missed slots are
  skipped rather than replayed, cycles may not overlap, and approval must
  complete before ten minutes have elapsed from the slot. The remaining five
  minutes prevent overlap with the next decision slot.
- New entries are evaluated only on a regular trading day while the Alpaca
  clock reports the market open and
  `10:00 <= slot < min(15:00, session_close - 60 minutes)`.
- A trading-session age counts completed sessions from the Alpaca calendar.
- Days to expiration (DTE) is the number of calendar dates between the decision
  date and expiration date.

Each cycle records its scheduled slot and `observed_at`, captured immediately
after the last snapshot-forming market-data response. Data ages are measured
against `observed_at` during snapshot construction. A snapshot-forming provider
timestamp after `observed_at` is invalid. Later account and clock gate responses
are stored with the decision but are not part of the immutable market snapshot.

After snapshot analysis, the strategy makes a final Alpaca clock request and
captures `approval_evaluated_at` after that response. Approval is the atomic,
in-memory evaluation performed at that timestamp; it makes no further provider
request. It requires `approval_evaluated_at < slot + 10 minutes` and
`approval_evaluated_at < min(15:00, session_close - 60 minutes)`, plus a returned
clock that still reports the market open. Every sub-day freshness limit,
including quote and latest-bar age, is measured again against
`approval_evaluated_at`. A cycle that misses a deadline or freshness limit
produces `NO_ACTION`.

## Provider Boundary

The project will remain on Alpaca Basic. Strategy behavior must not depend on
real-time OPRA or unrestricted access to the latest 15 minutes of option bars.

| Evidence | Source | Required behavior |
| --- | --- | --- |
| Account, orders, and positions | Alpaca Trading API | Authoritative; inconsistency blocks entry |
| Market clock and calendar | Alpaca | Authoritative for all time gates |
| SPY bars and quotes | Alpaca IEX | Authoritative strategy input |
| Current option chain | Alpaca indicative feed | Required and labeled `indicative` |
| Historical option bars | Alpaca Basic | Query `end` must be at or before `request_started_at - 15 minutes` |
| Option contract metadata | Alpaca | Required for tradability and dated open interest |
| Fundamentals and macro context | FMP | Optional context; never an execution price |
| Current web context | Exa | Optional, untrusted context; never an execution price |

FMP or Exa availability must not be required for entry, exit, reconciliation,
or position protection. Retrieved web content is evidence, not instructions.

## Required Account State

An entry is eligible only when all of these conditions hold:

- The paper account is active and not restricted from trading.
- The approved options level supports the complete spread as one multileg order.
- Reconciliation found no unknown, unmatched, or conflicting order or position.
- There is no open strategy position or pending entry order.
- No entry has been submitted on the current trading date.
- Neither the daily nor competition circuit breaker is active.

An unmatched option leg is inconsistent state, not an independent position.
Inconsistent state blocks all new entries until reconciliation resolves it.

## Underlying Signal

All calculations use completed Alpaca IEX bars. Daily-bar requests use Alpaca's
`adjustment=all` mode. Regular-session intraday bars exclude extended hours. The
latest daily bar must be for the immediately preceding completed Alpaca trading
session. The daily snapshot must contain exactly one bar for each of the 50
immediately preceding completed Alpaca trading sessions. Each selected bar must
have a finite positive close, and any missing or duplicate session rejects the
snapshot; older bars returned by the provider are ignored.

Live decisions persist the exact adjusted bars returned for that cycle. Replays
must use those persisted bars rather than refetching history that may have been
revised for a later corporate action. A historical test must record its retrieval
time and adjustment mode with the dataset.

For the latest completed daily session:

```text
SMA20 = arithmetic mean of the latest 20 completed adjusted daily closes
SMA50 = arithmetic mean of the latest 50 completed adjusted daily closes
```

The current underlying price is the midpoint of a SPY IEX bid and ask. Both
prices must be finite and positive, and ask must be greater than or equal to bid.
The quote must be dated for the current session, have a provider timestamp no
later than `observed_at`, and be no more than 60 seconds old at `observed_at`.
Its age is rechecked at approval and submission under the sub-day freshness
rules. The session VWAP is calculated from completed one-minute regular-session
IEX bars:

```text
session_vwap = sum(bar_vwap * bar_volume) / sum(bar_volume)
```

The denominator must be positive. Every intraday bar must be dated for the
current session and end no later than `observed_at`. The latest completed
one-minute bar must end no more than two minutes before `observed_at`. The
expected set contains every regular-session one-minute interval whose start is
at or after `session_open` and whose end is at or before `observed_at`. The
snapshot must contain exactly one bar for every expected interval, with a finite
positive VWAP and positive volume; a missing or duplicate interval rejects the
snapshot. No partial daily bar or future observation may enter the signal.

The regimes and triggers are:

| Direction | Daily regime | Intraday trigger | Allowed structure |
| --- | --- | --- | --- |
| Bullish | `daily_close > SMA20 > SMA50` | `current_price > session_vwap` | Bull call spread |
| Bearish | `daily_close < SMA20 < SMA50` | `current_price < session_vwap` | Bear put spread |

Strict inequalities are intentional. Equality, mixed ordering, or a trigger
that disagrees with the daily regime produces `NO_ACTION`.

## Contract Eligibility

Both legs must pass every rule at the same decision timestamp:

- The contract is active, tradable, American-style, and has multiplier 100.
- DTE is from 14 through 30 calendar days, inclusive.
- Both legs have the same expiration and option type.
- Spread width is from $1 through $10, inclusive.
- The long-leg absolute delta is from 0.45 through 0.60, inclusive.
- The short-leg absolute delta is from 0.20 through 0.35, inclusive.
- Implied volatility, delta, gamma, theta, and vega are present and finite.
- Implied volatility is positive.
- Bid and ask are finite, bid is positive, and ask is greater than bid.
- Each option quote is dated for the current session, is no more than 60 seconds
  old at approval, and is not future-dated relative to `observed_at`.
- Each leg's absolute bid-ask width is at most $0.20.
- Each leg's bid-ask width divided by its midpoint is at most 0.10.
- Current daily volume is dated for the decision's trading date and is at least
  100 contracts per leg.
- Open interest is at least 500 contracts per leg.
- `open_interest_date` is not future-dated and is no older than two completed
  trading sessions. Its age is the number of Alpaca trading dates after the open
  interest date and before the decision date.

For calls, the long strike must be lower than the short strike. For puts, the
long strike must be higher than the short strike.

Missing, null, stale, crossed, or structurally invalid data rejects the candidate.
The model may not estimate a missing Greek, implied volatility, quote, volume, or
open-interest value.

## Decision Snapshot

All snapshot-forming market-data calls for a cycle form one immutable decision
snapshot identified by the scheduled slot and `observed_at`. The snapshot
contains the clock and calendar used to establish the slot, underlying bars and
quote, option chain, and contract metadata used by the decision. Reconciled
account state and final clock responses are separate timestamped gate evidence.

The versioned normalized identity for future application-owned screening is
defined in [`research-market-snapshots-v1.md`](research-market-snapshots-v1.md).
That contract defines data and canonical identity only; provider capture and
strategy calculation remain separate implementation stages.

Approval reruns every market-data eligibility gate, calculation, and ranking rule
against only that snapshot. It may not combine market fields from different
snapshots. Account eligibility and time gates use their separate, timestamped
reconciliation and clock evidence. Refreshing snapshot-forming market data,
including bars, underlying quotes, option quotes, or contract metadata, creates
a new snapshot and every strategy rule must run again. Final account
reconciliation and clock requests can reject an entry but do not recursively
trigger market-data reevaluation. The candidate changed when its direction, leg
symbols, entry limit, maximum loss, or eligibility result differs. A changed
candidate abandons the entry and produces `NO_ACTION` for that slot.

Immediately before order submission, the executor completes reconciliation and
a final Alpaca clock request, then captures `submission_evaluated_at` after both
responses. It atomically rechecks account eligibility, the returned clock,
the buying-power reserve using the final reconciled account snapshot, approval
deadlines, and every sub-day freshness limit against that timestamp. After those
checks, it captures `submitted_at` immediately before invoking the order API and
repeats the no-I/O deadline and freshness comparisons against `submitted_at`.
The API invocation follows in the same synchronous call path. Both timestamps
must be before `slot + 10 minutes` and
`min(15:00, session_close - 60 minutes)`. A failed check abandons the entry. If
satisfying a failed freshness check requires new market data, that market data
forms a new snapshot and triggers the complete reevaluation above.

## Entry Pricing And Selection

For each eligible leg:

```text
leg_midpoint = (bid + ask) / 2
net_midpoint = long_leg_midpoint - short_leg_midpoint
entry_limit = ceil(net_midpoint * 100) / 100
width = abs(long_strike - short_strike)
max_loss = entry_limit * 100
max_profit = (width - entry_limit) * 100
```

The candidate is valid only when:

- `0 < entry_limit < width`.
- `entry_limit <= 0.60 * width`.
- `max_loss <= $500`.
- Projected post-entry buying power is at least 50% of pre-entry buying power.

Pre-entry buying power is Alpaca's `buying_power` from the reconciled account
snapshot immediately preceding the gate evaluation. The reserve gate runs once
for approval and again with the final reconciliation snapshot immediately before
submission. Because the order is a one-contract debit spread, each projection is:

```text
projected_buying_power = pre_entry_buying_power - max_loss
```

All monetary inputs use exact decimal cents. The comparison is inclusive and
does not apply additional rounding.

The entry intent is for one spread at `entry_limit` as a single multileg limit
order with `time_in_force=day`. Market orders, legging, and paying above the
approved limit are forbidden.

The order's `entry_order_deadline` is
`min(slot + 10 minutes, 15:00, session_close - 60 minutes)`. Before submission,
persist the intent, deadline, unique `client_order_id`, and phase `PREPARED`.
Arm the local deadline timer, durably transition to `SUBMITTING`, then immediately
invoke the POST with that same ID in its payload and a five-second timeout.
Transition to `ACKNOWLEDGED` when Alpaca returns the broker order ID. These phase
changes are ordered writes: a `PREPARED` record proves no POST began. If the
deadline timer fires while the POST is still in flight without a broker ID, it
independently transitions the intent to `SUBMISSION_AMBIGUOUS` and starts lookup.
If the original POST later returns its broker ID at or after
`entry_order_deadline`, invoke cancellation within one second of receiving that
response and before any unrelated request.

All POST, timer, and lookup completions update lifecycle state atomically with
compare-and-set semantics. A broker ID returned by any source persists
`ACKNOWLEDGED` and takes precedence over every ID-less phase. A not-found, error,
or timeout result may transition to `SUBMISSION_AMBIGUOUS` only if the current
state still has no broker ID; it cannot overwrite or remove an acknowledged ID.
When competing completions first reveal an overdue ID, the cancellation path
runs immediately under the one-second rule.

Recovery runs before research or another entry. A recovered `PREPARED` intent is
always abandoned as `ABANDONED_NO_ORDER`, clears the pending-entry lock, and does
not consume the daily entry because its ordered phase proves no POST began. A
recovered `SUBMITTING` intent without a broker ID is looked up by
`client_order_id` with a five-second timeout and is never resubmitted. A found
order durably transitions to `ACKNOWLEDGED` with its broker ID. Not-found or
unavailable evidence transitions to `SUBMISSION_AMBIGUOUS`, blocks trading,
and retries lookup with a five-second timeout and no more than five seconds
between attempt starts. This cadence continues before and after the deadline and
requires operator resolution if Alpaca cannot establish an order or definitive
rejection.

A recovered `SUBMISSION_AMBIGUOUS` intent resumes that same bounded lookup loop
before research or any other entry work. Its persisted deadline remains active;
a found order transitions atomically to `ACKNOWLEDGED`, and if overdue, enters
the one-second cancellation path before any unrelated request.

The same rule applies without a restart: a POST timeout, transport error, or
response without a broker ID transitions immediately from `SUBMITTING` to
`SUBMISSION_AMBIGUOUS` and starts lookup without resubmitting. Its already-armed
deadline timer remains active. If that timer fires without a broker ID, lookup
continues; an order found after the deadline is canceled under the overdue rule
below.

A recovered `ACKNOWLEDGED` intent, including one produced by lookup, immediately
rearms its deadline timer and resumes reconciliation. If its deadline has passed,
it invokes cancellation under the overdue rule below before any unrelated call.
The allowed terminal phases are `FILLED_APPROVED`, `FILLED_LATE`,
`NO_FILL_TERMINAL`, `CONTAINED_FLAT`, and `ABANDONED_NO_ORDER`; each clears the
pending-entry lock, although a resulting position independently blocks entry.
Transitioning to `SUBMITTING` consumes the one-entry-per-day limit even when the
POST is rejected or an operator later proves no broker order exists. A definitive
HTTP rejection or operator-confirmed absence may transition directly to
`NO_FILL_TERMINAL` without a broker order record. Operator resolution of
`SUBMISSION_AMBIGUOUS` must therefore end in `ACKNOWLEDGED`,
`NO_FILL_TERMINAL`, or reconciliation state `BROKER_INCONSISTENCY` and never
restores that daily allowance.

If the order is not filled by the deadline and its broker ID is known to a
running executor, invoke cancellation within one second after the deadline. An
overdue order discovered by recovery or lookup is canceled within one second of
obtaining its ID. This one-second rule applies whenever an ID first becomes known
after the deadline, including through the original POST response, lookup, or
restart recovery. Capture `cancel_requested_at` immediately before every cancel
API invocation and apply a five-second timeout to each cancel attempt. A cancel
response, error, or timeout proceeds immediately to reconciliation; a timed-out
or failed attempt never blocks the later cancel retries. No unrelated provider
request may precede these actions. The pending-entry lock remains set throughout;
the strategy never intentionally carries an open entry beyond the deadline or
into another session.

A cancellation response alone does not resolve the order. After every cancel
request, the executor immediately reconciles the nested Alpaca order, positions,
and fill activities, using requests with five-second timeouts and retry starts no
more than five seconds apart while the order is nonterminal or those records
disagree. Whenever reconciliation finds an open cancelable remainder after the
deadline, another cancel attempt starts within one second and before the next
reconciliation request. Until a terminal broker status is confirmed, another
cancel attempt starts no more than ten seconds after the prior attempt settles,
regardless of its response and even if every intervening reconciliation request
fails or times out. Unavailable reconciliation never suppresses cancellation
retries. New entries remain blocked throughout.

Fill activities are authoritative for race ordering. `spread_filled_at` is the
latest Alpaca transaction timestamp among the minimum set of leg fills that
first completes all legs in the submitted ratios. A parent `filled_at` that
differs is retained as diagnostic evidence but does not change classification;
the activity timestamps remain authoritative. Position or parent-order evidence
without the required activities is provisional protection evidence but does not
finalize classification. `entry_order_deadline` is a UTC instant and equality is
late:

- A complete spread with `spread_filled_at < entry_order_deadline` is adopted as
  the strategy position in phase `FILLED_APPROVED`, even if evidence arrives
  after a cancel request. Broker fill ordering, not local request timestamps,
  resolves the race.
- A complete spread with `spread_filled_at >= entry_order_deadline` is immediately
  marked `late_fill`, adopted for position protection in phase `FILLED_LATE`, and
  may not be treated as an approved entry.
- A terminal no-fill status (`canceled`, `expired`, or `rejected`) with no fill
  activity and no resulting position produces phase `NO_FILL_TERMINAL`.
  `done_for_day` is not terminal and remains subject to cancellation and
  reconciliation.
- Fill outcome and reconciliation health are independent: a
  `FILLED_APPROVED` or `FILLED_LATE` outcome is not revoked by later health
  evidence. A consistent, open, unfilled `ACKNOWLEDGED` order with no fill
  activity and no position remains healthy until its deadline; absent fill
  evidence is expected in that state. Once any fill activity, nonzero position,
  parent or nested-order status indicating any fill, or terminal parent state
  exists, incomplete, missing, partial, unmatched, or materially conflicting
  symbol, quantity, side, status, activity, order, or position evidence remains
  `RECONCILING` for up to 30 seconds after that first evidence. It becomes
  `BROKER_INCONSISTENCY` if still unresolved after that bound; a terminal broker
  record that already confirms partial or unmatched exposure escalates
  immediately. Diagnostic parent/activity timestamp differences are excluded.
  As the next action, cancel any open remainder, suspend all new automated
  orders, alert the operator with the order and exposure evidence, and reconcile
  on the cadence above. A complete matched spread discovered later is classified
  under the timestamp rules above. Any residual unmatched leg requires manual
  flattening; automated legging is forbidden.

After containment, a terminal parent order, no open remainder, and flat Alpaca
positions transition to `CONTAINED_FLAT`, clear the pending lock, and end
`BROKER_INCONSISTENCY`; historical fill activities remain audit evidence and do
not prevent this transition. The consumed daily entry is never restored.

Emergency operator liquidation of unmatched exposure is outside automated
strategy execution and is the sole exception to the multileg, limit-order, and
no-legging rules; the operator may use single-leg or market orders only to reduce
that inconsistent exposure.

Position protection starts from the first complete-spread evidence in the order,
activity, or position records; it does not wait for every source to converge. If
provisional evidence appears without `spread_filled_at`, start monitoring
immediately when the market is open, or within 60 seconds after the next Alpaca
session open when closed. Once `spread_filled_at` is known, evidence observed
within 60 seconds retains the first-monitor deadline of 60 seconds after the
fill. If it is already overdue, start the cycle immediately before any further
reconciliation request and record the overdue discovery. A late-fill flag is
latched as soon as `spread_filled_at >= entry_order_deadline` is known, including
during `BROKER_INCONSISTENCY` and before final adoption. It is never set when
`spread_filled_at < entry_order_deadline`.

When multiple candidates qualify, select the lexicographically smallest tuple:

```text
(
  abs(DTE - 21),
  abs(abs(long_delta) - 0.50) + abs(abs(short_delta) - 0.30),
  width,
  expiration_date,
  long_contract_symbol,
  short_contract_symbol
)
```

This ordering is the sole candidate tie-breaker. When all entry gates pass, the
selected candidate is the required trade intent. The model may return
`NO_ACTION` only for an explicit condition in this specification and may not
substitute a lower-ranked spread.

## Position Valuation

Exit triggers use a fresh indicative midpoint for each leg:

```text
spread_mark = long_leg_midpoint - short_leg_midpoint
```

While a position is open and the market is open, position-monitor cycles start
no more than 60 seconds apart. The first cycle starts within 60 seconds of an
opening fill when the market is open, or within 60 seconds after the Alpaca
market calendar's official `session_open` when a position was carried into the
session. The cycle starts on the calendar deadline even when an Alpaca clock
request fails.

Each cycle captures `monitor_started_at` immediately before launching option
quotes, an Alpaca clock request, and any needed trend request in parallel. Option
quote and trend attempts must settle by response, provider error, or timeout
within 30 seconds. The clock attempt has a five-second timeout and records
`clock_observed_at` when it settles. Each branch records its result independently,
so a slow branch cannot extend another branch's deadline.

Capture `monitor_evaluated_at` immediately after the option-quote attempts
settle, without waiting for clock or trend results. Each quote must be dated for
the current session, have a provider timestamp no later than
`monitor_evaluated_at`, and be no more than 60 seconds old at
`monitor_evaluated_at`. Bid and ask must also satisfy the entry validity and
spread-width rules. The spread mark and all mark-based exit checks use only
quotes from that monitor cycle. Any failed or over-time quote attempt makes the
mark invalid for that cycle. A failed clock check records degraded market-state
evidence.

After every branch has settled or reached its deadline, capture
`cycle_decided_at`; this decision barrier is no more than 30 seconds after
`monitor_started_at`. A cycle is open-market eligible when `monitor_started_at`
is within the Alpaca calendar's regular session and one of these conditions
holds: the clock reports `is_open=true`; the clock attempt fails, in which case
the calendar is the degraded fallback; or an `is_open=false` response is observed
at or after `session_close` and therefore describes the post-close state rather
than the state at `monitor_started_at`. An `is_open=false` response observed
before `session_close` makes the cycle ineligible and is authoritative over the
calendar.

Each branch records its signal and observation timestamp when it settles. Signal
validity, including quote freshness, is fixed at that timestamp; the explicitly
bounded wait for the decision barrier does not invalidate an already valid
signal. At the barrier, evaluate every available signal, apply the priority table
below once, and latch exactly one highest-priority reason. Thus a lower-priority
trend timeout cannot suppress a valid mark-based signal, including when a cycle
starts shortly before the scheduled close. A cycle that was not open-market
eligible does not latch an exit and treats the stale-data timer as closed-market
time.

Mark-based exit conditions are `unknown`, not false, while a valid mark is
unavailable. The stale-data timer begins at `monitor_started_at` for the first
cycle with an invalid mark, so request latency counts toward the five-minute
threshold. When a valid mark returns, first measure the completed unavailable
interval through `monitor_evaluated_at`. If it reached five minutes, stale-data
protection remains a true signal for the decision barrier and is latched before
the timer can clear; only a shorter recovered interval clears immediately. For a
cycle that crosses `session_close`, elapsed stale time is clamped at
`session_close`; if five minutes accrued before the close, stale-data protection
is a true signal for that cycle, otherwise the timer is cleared before state is
persisted. FMP prices, web sources, last trades, and underlying prices must never
value the spread.

Indicative marks and Alpaca paper fills are simulation evidence. They are not
evidence that the same order would execute at that price in a live OPRA market.

For trend invalidation, the first monitor cycle of each trading session requests
at least 20 completed SPY IEX daily bars with `adjustment=all` and an `end` date
equal to the Alpaca session immediately preceding the cycle's session date. It
starts this request at `monitor_started_at`, applies the 30-second deadline, and
records `trend_observed_at` when that attempt settles. Trend completion never
delays option-mark calculation; all available signals meet only at the bounded
decision barrier. A valid trend snapshot requires finite positive closes, the
latest bar dated for that required preceding session, and no bar timestamp after
`trend_observed_at`. The 20 selected bars must map one-to-one, with no missing or
duplicate date, to the 20 immediately preceding completed Alpaca trading
sessions ending on that required session; older returned bars are ignored. It
calculates the latest completed daily close and SMA20, persists the bars and
result, and reuses that immutable snapshot for the rest of the current session
because no newer eligible bar can complete intraday.

If the trend request fails or returns invalid data, trend invalidation is
`unknown` for that cycle and does not block any other exit. The monitor retries
the request on each later cycle until it obtains a valid snapshot; it never
reuses the prior session's trend snapshot for the current session.

## Exit Rules

The position monitor evaluates exits independently of the research model. It
persists the time at which a valid spread mark first becomes unavailable during
an open market and clears that time after a valid mark returns or the market
closes. Closed-market time never counts toward the threshold; if the first mark
after the next open is invalid, a new timer starts then. An exit becomes required
when the first applicable condition is true:

For every monitor cycle, `monitor_date` is the `America/New_York` calendar date
at `cycle_decided_at`. Exit DTE is recalculated as the number of calendar
dates from `monitor_date` to the contract expiration date. The holding-session
index is the count of Alpaca trading dates from the entry date through
`monitor_date`, inclusive, so the entry session is index 1.

| Priority | Exit | Machine-testable trigger |
| --- | --- | --- |
| 0 | Late-fill protection | Complete-spread exposure has `spread_filled_at >= entry_order_deadline`; mark `late_fill` and persist the flag until flat even before reconciliation converges |
| 1 | Expiration protection | Exit DTE is less than 3 while the market is open, or exit DTE is 3 and `cycle_decided_at >= session_close - 60 minutes` |
| 2 | Stale-data protection | No valid spread mark for five continuous minutes while the market is open |
| 3 | Stop loss | A valid mark exists and `spread_mark <= 0.50 * entry_limit` |
| 4 | Profit target | A valid mark exists and `spread_mark >= entry_limit + 0.50 * (width - entry_limit)` |
| 5 | Trend invalidation | Bullish: completed daily close `<= SMA20`; bearish: completed daily close `>= SMA20` |
| 6 | Maximum holding period | Holding-session index is greater than 5 while the market is open, or index is 5 and `cycle_decided_at >= session_close - 30 minutes` |

The highest-priority true condition supplies the recorded exit reason. An
unknown mark-based condition does not block a true mark-independent condition.
Once any exit becomes required, that requirement remains latched until the
position is flat. Exit execution, including stale-quote limit selection, will be
specified separately, but it must use a single multileg limit order. The
strategy never adds contracts, averages down, rolls, or converts a spread into
unmatched legs.

Circuit breakers block entries but do not suppress or replace these protective
exit rules.

## Risk Budget And Circuit Breakers

| Limit | Threshold |
| --- | --- |
| Initial paper equity | $100,000 |
| Maximum loss per spread | $500 |
| Maximum strategy positions | 1 |
| Maximum pending entries | 1 |
| Maximum new entries per trading day | 1 |
| Minimum post-entry buying-power reserve | 50% of pre-entry buying power |
| Daily circuit breaker | Current equity at or below Alpaca `last_equity - $1,500` |
| Competition circuit breaker | Current equity at or below $92,500 |

Equity includes realized and unrealized P&L. A circuit breaker activates at the
threshold, persists in the durable ledger, and blocks new entries. Activation
does not imply immediate liquidation; open positions continue under the exit
rules above.

The daily breaker remains active through the current trading date. Before the
next regular session it resets only after reconciliation confirms consistent
account state and the competition breaker is inactive. The competition breaker
never resets automatically during strategy version 1; operator action may close
positions but may not re-enable entries under this version.

## Explicit `NO_ACTION` Conditions

The decision must be `NO_ACTION` when any of these conditions holds:

- The market is closed, the date is not a regular trading session, the slot was
  missed, or the slot is outside the entry window.
- Required account state is unavailable, restricted, or inconsistent.
- A position, pending entry, prior same-day entry, or circuit breaker exists.
- Fewer than 50 completed daily bars or no usable session bars are available.
- A required Alpaca response is unavailable, malformed, missing, or stale.
- The daily regime is neutral or the intraday trigger disagrees with it.
- No complete spread passes every contract, liquidity, pricing, and risk rule.
- The selected candidate changes before approval because refreshed evidence no
  longer matches the decision snapshot.
- Maximum loss or projected buying-power reserve cannot be calculated exactly.
- The output cannot be represented by the current versioned decision contract.

Optional FMP or Exa failure alone is not a `NO_ACTION` condition because neither
provider is a required strategy input.

## Unsupported Behavior

Strategy version 1 does not support:

- Underlyings other than SPY.
- Zero-DTE or contracts outside the specified DTE window.
- Naked options, credit spreads, ratio spreads, calendars, iron condors, or any
  undefined-risk structure.
- More than one spread unit, a quantity greater than one per leg, more than one
  position, more than one pending entry, or more than one daily entry.
- Market orders, legging, discretionary price chasing, rolling, or averaging down.
- Model overrides of candidate ranking, risk rejection, circuit breakers, or exits.
- Using FMP, Exa, last trades, or generated estimates as executable option prices.
- Claims about live profitability or executability from indicative data and
  simulated paper fills.

## Evaluation Requirements

Historical option-bar acquisition records `request_started_at` immediately
before the request and requires
`end <= request_started_at - 15 minutes`. Full-fidelity contract selection also
requires forward-captured chain snapshots because historical bars alone do not
reproduce point-in-time Greeks, implied volatility, quotes, and dated open
interest.

Every observation cycle should eventually persist:

- Retrieval and market timestamps, provider, feed, and symbol.
- The underlying bars, quote, calculated averages, VWAP, regime, and trigger.
- All considered contract fields and rejection reasons.
- Candidate ranking, pricing inputs, risk calculations, and final decision.
- Paper-order and fill evidence, clearly labeled as simulated.

Backtest and replay implementation belongs to issue
[#8](https://github.com/whanyu1212/greeks-in-the-loop/issues/8). It must not
claim a full strategy backtest when required point-in-time chain evidence is
absent.

## Falsifiable Assumptions

The following are hypotheses to test, not established facts:

- Alpaca IEX bars preserve enough SPY trend information for the signal.
- Indicative quotes are stable enough for comparative paper evaluation.
- The DTE, delta, spread-width, and liquidity filters produce sufficient samples.
- Midpoint paper fills are a useful simulation assumption after modeled slippage.
- The profit target, stop, trend invalidation, and holding period improve outcomes.
- A $500 maximum loss and the circuit breakers fit the competition objective.

Evidence may justify a later strategy version. It must not cause an unversioned
runtime threshold change.

## Versioning And Implementation Boundary

- Editorial clarifications that do not alter behavior increment the patch version.
- Threshold or rule changes increment the minor version.
- Changes to the underlying, strategy family, or risk model increment the major
  version.
- The strategy version must be stored with every future decision and risk result.

### Static strategy identity

The compile-time registry identifies this strategy as
`spy-directional-debit-vertical`. Version `1.1.0` is the only version permitted
to produce new runtime decisions; version `1.0.0` remains decode-only for
historical V1 artifacts. Registry entries are deeply immutable data and contain
no callbacks, environment-selected implementations, or model-selected plugins.

The current manifest continues to identify the checked-in research skill as the
runtime authority for feature calculation and candidate generation/ranking. The
pure `directional-debit-vertical-v1` component now calculates symbol-neutral
20/50-session trend features and deterministically selects the rank-one SPY
candidate from a validated application-owned snapshot pair. Replay shares its
feature and rank calculations, but production research does not consume its
selection until audit and authority-promotion work under #66 and #67 completes.

The manifest identifies exits as replay-only and runtime research-plan
compatibility as the existing versioned research invocation. `ResearchPlanV1`
is now defined as a strict candidate-reference contract for isolated
plan-driven evaluation, but it does not replace the manifest's legacy runtime
compatibility or authorize the generic skill in production. That atomic
migration belongs to #67. V1 ledger, research-run, dataset, intent, risk, and
replay schemas retain their
existing serialized shapes and decode from their embedded version fields without
consulting the current runtime manifest.

This PR freezes behavior only. Decision contracts are tracked by issue
[#6](https://github.com/whanyu1212/greeks-in-the-loop/issues/6), risk-engine
implementation by [#10](https://github.com/whanyu1212/greeks-in-the-loop/issues/10),
execution and reconciliation by
[#14](https://github.com/whanyu1212/greeks-in-the-loop/issues/14), and independent
position protection by
[#11](https://github.com/whanyu1212/greeks-in-the-loop/issues/11).
