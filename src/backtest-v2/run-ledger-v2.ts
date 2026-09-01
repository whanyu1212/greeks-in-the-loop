import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import Database from "better-sqlite3"

import { canonicalJson, canonicalJsonSha256 } from "../shared/canonical-json.js"

const RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS backtest_runs (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  experiment_hash TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  dataset_hash TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETE', 'INCOMPLETE', 'FAILED')),
  initial_equity_cents INTEGER NOT NULL,
  ending_equity_cents INTEGER,
  net_pnl_cents INTEGER,
  terminal_event_hash TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS ledger_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES backtest_runs(run_id),
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  causation_event_id TEXT,
  payload_json TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE
) STRICT;
CREATE INDEX IF NOT EXISTS ledger_events_run ON ledger_events(run_id, sequence);

CREATE TABLE IF NOT EXISTS fills (
  fill_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES backtest_runs(run_id),
  decision_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('OPEN', 'CLOSE')),
  occurred_at TEXT NOT NULL,
  long_contract_id TEXT NOT NULL,
  short_contract_id TEXT NOT NULL,
  long_price_half_cents INTEGER NOT NULL,
  short_price_half_cents INTEGER NOT NULL,
  net_price_half_cents INTEGER NOT NULL,
  gross_cash_flow_cents INTEGER NOT NULL,
  fees_cents INTEGER NOT NULL,
  net_cash_flow_cents INTEGER NOT NULL,
  long_quote_id TEXT NOT NULL,
  short_quote_id TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS positions (
  position_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES backtest_runs(run_id),
  decision_id TEXT NOT NULL,
  underlying TEXT NOT NULL,
  structure TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  entry_debit_cents INTEGER NOT NULL,
  entry_fees_cents INTEGER NOT NULL,
  exit_credit_cents INTEGER NOT NULL,
  exit_fees_cents INTEGER NOT NULL,
  realized_pnl_cents INTEGER NOT NULL,
  exit_reason TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  run_id TEXT NOT NULL REFERENCES backtest_runs(run_id),
  occurred_at TEXT NOT NULL,
  cash_cents INTEGER NOT NULL,
  realized_pnl_cents INTEGER NOT NULL,
  unrealized_pnl_cents INTEGER NOT NULL,
  liquidation_value_cents INTEGER NOT NULL,
  equity_cents INTEGER NOT NULL,
  PRIMARY KEY (run_id, occurred_at)
) STRICT;

CREATE TABLE IF NOT EXISTS backtest_metrics (
  run_id TEXT NOT NULL REFERENCES backtest_runs(run_id),
  metric_name TEXT NOT NULL,
  metric_value_integer INTEGER,
  metric_value_text TEXT,
  PRIMARY KEY (run_id, metric_name)
) STRICT;

CREATE TRIGGER IF NOT EXISTS ledger_events_no_update BEFORE UPDATE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'ledger_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_events_no_delete BEFORE DELETE ON ledger_events
BEGIN SELECT RAISE(ABORT, 'ledger_events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS fills_no_update BEFORE UPDATE ON fills
BEGIN SELECT RAISE(ABORT, 'fills are immutable'); END;
CREATE TRIGGER IF NOT EXISTS fills_no_delete BEFORE DELETE ON fills
BEGIN SELECT RAISE(ABORT, 'fills are immutable'); END;
`

export type StoredFillV2 = Readonly<{
  fillId: string
  decisionId: string
  purpose: "OPEN" | "CLOSE"
  occurredAt: string
  longContractId: string
  shortContractId: string
  longPriceHalfCents: number
  shortPriceHalfCents: number
  netPriceHalfCents: number
  grossCashFlowCents: number
  feesCents: number
  netCashFlowCents: number
  longQuoteId: string
  shortQuoteId: string
}>

export const createBacktestRunLedgerV2 = (input: Readonly<{
  path: string
  runId: string
  experimentId: string
  experimentHash: string
  datasetId: string
  datasetHash: string
  initialEquityCents: number
}>) => {
  mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 })
  const database = new Database(input.path)
  database.pragma("foreign_keys = ON")
  database.pragma("journal_mode = WAL")
  database.pragma("synchronous = FULL")
  database.exec(RUN_SCHEMA)
  database.prepare("INSERT INTO backtest_runs VALUES (?, ?, ?, ?, ?, '2.0.0-mvp', 'RUNNING', ?, NULL, NULL, NULL)").run(
    input.runId, input.experimentId, input.experimentHash, input.datasetId,
    input.datasetHash, input.initialEquityCents,
  )
  let previousEventHash: string | null = null

  const appendEvent = (eventType: string, occurredAt: string, payload: unknown, causationEventId?: string) => {
    const sequence = (database.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM ledger_events").get() as { next: number }).next
    const eventId = canonicalJsonSha256({ runId: input.runId, sequence, eventType, payload })
    const envelope = { sequence, eventId, runId: input.runId, eventType, occurredAt, causationEventId: causationEventId ?? null, payload, previousEventHash }
    const eventHash = canonicalJsonSha256(envelope)
    database.prepare("INSERT INTO ledger_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      sequence, eventId, input.runId, eventType, occurredAt,
      causationEventId ?? null, canonicalJson(payload), previousEventHash, eventHash,
    )
    previousEventHash = eventHash
    return eventId
  }

  return {
    appendEvent,
    insertFill(fill: StoredFillV2) {
      database.prepare("INSERT INTO fills VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        fill.fillId, input.runId, fill.decisionId, fill.purpose, fill.occurredAt,
        fill.longContractId, fill.shortContractId, fill.longPriceHalfCents,
        fill.shortPriceHalfCents, fill.netPriceHalfCents, fill.grossCashFlowCents,
        fill.feesCents, fill.netCashFlowCents, fill.longQuoteId, fill.shortQuoteId,
      )
    },
    insertPosition(position: Readonly<{
      positionId: string
      decisionId: string
      underlying: string
      structure: string
      openedAt: string
      closedAt: string
      entryDebitCents: number
      entryFeesCents: number
      exitCreditCents: number
      exitFeesCents: number
      realizedPnlCents: number
      exitReason: string
    }>) {
      database.prepare("INSERT INTO positions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        position.positionId, input.runId, position.decisionId, position.underlying,
        position.structure, position.openedAt, position.closedAt,
        position.entryDebitCents, position.entryFeesCents,
        position.exitCreditCents, position.exitFeesCents,
        position.realizedPnlCents, position.exitReason,
      )
    },
    insertSnapshot(snapshot: Readonly<{
      occurredAt: string
      cashCents: number
      realizedPnlCents: number
      unrealizedPnlCents: number
      liquidationValueCents: number
      equityCents: number
    }>) {
      database.prepare("INSERT INTO portfolio_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        input.runId, snapshot.occurredAt, snapshot.cashCents,
        snapshot.realizedPnlCents, snapshot.unrealizedPnlCents,
        snapshot.liquidationValueCents, snapshot.equityCents,
      )
    },
    insertMetric(name: string, integerValue: number | null, textValue: string | null = null) {
      database.prepare("INSERT INTO backtest_metrics VALUES (?, ?, ?, ?)").run(input.runId, name, integerValue, textValue)
    },
    complete(status: "COMPLETE" | "INCOMPLETE" | "FAILED", endingEquityCents: number, netPnlCents: number, occurredAt: string) {
      const terminalEventId = appendEvent("RUN_TERMINAL", occurredAt, { status, endingEquityCents, netPnlCents })
      database.prepare("UPDATE backtest_runs SET status = ?, ending_equity_cents = ?, net_pnl_cents = ?, terminal_event_hash = ? WHERE run_id = ?").run(
        status, endingEquityCents, netPnlCents, previousEventHash, input.runId,
      )
      return terminalEventId
    },
    close() { database.close() },
  }
}
