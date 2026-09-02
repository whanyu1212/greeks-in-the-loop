import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import Database from "better-sqlite3"

import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import type { HistoricalSourceV2 } from "./historical-contracts-v2.js"

const HISTORICAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_metadata (
  schema_name TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO schema_metadata VALUES ('backtest_v2_historical', '1.0.0');

CREATE TABLE IF NOT EXISTS datasets (
  dataset_id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL UNIQUE,
  universe_id TEXT NOT NULL,
  evidence_tier TEXT NOT NULL,
  provider TEXT NOT NULL,
  feed TEXT NOT NULL,
  timezone TEXT NOT NULL,
  requested_start_date TEXT NOT NULL,
  requested_end_date TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETE'))
) STRICT;

CREATE TABLE IF NOT EXISTS dataset_partitions (
  dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id),
  partition_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  session_date TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  content_hash TEXT NOT NULL,
  PRIMARY KEY (dataset_id, partition_type, symbol, session_date)
) STRICT;

CREATE TABLE IF NOT EXISTS dataset_symbols (
  dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id),
  symbol TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  contract_count INTEGER NOT NULL CHECK (contract_count >= 0),
  quote_count INTEGER NOT NULL CHECK (quote_count >= 0),
  PRIMARY KEY (dataset_id, symbol)
) STRICT;

CREATE TABLE IF NOT EXISTS market_sessions (
  dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id),
  session_date TEXT NOT NULL,
  open_at TEXT NOT NULL,
  close_at TEXT NOT NULL,
  PRIMARY KEY (dataset_id, session_date)
) STRICT;

CREATE TABLE IF NOT EXISTS underlying_bars (
  dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id),
  bar_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  close_half_cents INTEGER NOT NULL CHECK (close_half_cents > 0),
  PRIMARY KEY (dataset_id, bar_id)
) STRICT;
CREATE INDEX IF NOT EXISTS underlying_bars_lookup
  ON underlying_bars(dataset_id, symbol, available_at DESC, observed_at DESC);

CREATE TABLE IF NOT EXISTS option_contracts (
  dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id),
  contract_id TEXT NOT NULL,
  option_symbol TEXT NOT NULL,
  underlying TEXT NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('CALL', 'PUT')),
  strike_half_cents INTEGER NOT NULL CHECK (strike_half_cents > 0),
  expiration_date TEXT NOT NULL,
  multiplier INTEGER NOT NULL CHECK (multiplier = 100),
  listed_at TEXT NOT NULL,
  delisted_at TEXT,
  PRIMARY KEY (dataset_id, contract_id),
  UNIQUE (dataset_id, option_symbol)
) STRICT;
CREATE INDEX IF NOT EXISTS option_contracts_chain
  ON option_contracts(dataset_id, underlying, option_right, expiration_date, strike_half_cents);

CREATE TABLE IF NOT EXISTS option_quotes (
  dataset_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  bid_half_cents INTEGER NOT NULL CHECK (bid_half_cents > 0),
  ask_half_cents INTEGER NOT NULL CHECK (ask_half_cents > bid_half_cents),
  bid_size INTEGER NOT NULL CHECK (bid_size >= 0),
  ask_size INTEGER NOT NULL CHECK (ask_size >= 0),
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 0),
  PRIMARY KEY (dataset_id, quote_id),
  FOREIGN KEY (dataset_id, contract_id)
    REFERENCES option_contracts(dataset_id, contract_id)
) STRICT;
CREATE INDEX IF NOT EXISTS option_quotes_lookup
  ON option_quotes(dataset_id, contract_id, available_at DESC, observed_at DESC, source_sequence DESC);
`

export type HistoricalDatasetManifestV2 = Readonly<{
  datasetVersion: "2.0.0"
  datasetId: string
  sourceHash: string
  universeId: string
  evidenceTier: string
  provider: string
  feed: string
  timezone: string
  requestedStartDate: string
  requestedEndDate: string
  databasePath: string
  coveredSymbols: readonly string[]
  counts: Readonly<{
    sessions: number
    underlyingBars: number
    contracts: number
    quotes: number
    partitions: number
  }>
}>

const configureWriter = (database: Database.Database) => {
  database.pragma("foreign_keys = ON")
  database.pragma("journal_mode = WAL")
  database.pragma("synchronous = FULL")
  database.pragma("busy_timeout = 5000")
  database.exec(HISTORICAL_SCHEMA)
}

const countRows = (database: Database.Database, table: string, datasetId: string) =>
  (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE dataset_id = ?`).get(datasetId) as { count: number }).count

export const readHistoricalDatasetManifest = (
  database: Database.Database,
  databasePath: string,
  datasetId: string,
): HistoricalDatasetManifestV2 => {
  const row = database.prepare(`
    SELECT dataset_id, source_hash, universe_id, evidence_tier, provider, feed,
           timezone, requested_start_date, requested_end_date
    FROM datasets WHERE dataset_id = ?
  `).get(datasetId) as {
    dataset_id: string
    source_hash: string
    universe_id: string
    evidence_tier: string
    provider: string
    feed: string
    timezone: string
    requested_start_date: string
    requested_end_date: string
  } | undefined
  if (row === undefined) throw new Error(`Historical dataset does not exist: ${datasetId}`)
  const coveredSymbols = (database.prepare(
    "SELECT symbol FROM dataset_symbols WHERE dataset_id = ? ORDER BY symbol",
  ).all(datasetId) as { symbol: string }[]).map(({ symbol }) => symbol)
  return {
    datasetVersion: "2.0.0",
    datasetId: row.dataset_id,
    sourceHash: row.source_hash,
    universeId: row.universe_id,
    evidenceTier: row.evidence_tier,
    provider: row.provider,
    feed: row.feed,
    timezone: row.timezone,
    requestedStartDate: row.requested_start_date,
    requestedEndDate: row.requested_end_date,
    databasePath,
    coveredSymbols,
    counts: {
      sessions: countRows(database, "market_sessions", datasetId),
      underlyingBars: countRows(database, "underlying_bars", datasetId),
      contracts: countRows(database, "option_contracts", datasetId),
      quotes: countRows(database, "option_quotes", datasetId),
      partitions: countRows(database, "dataset_partitions", datasetId),
    },
  }
}

export const ingestHistoricalSourceV2 = (
  databasePath: string,
  source: HistoricalSourceV2,
): HistoricalDatasetManifestV2 => {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const database = new Database(databasePath)
  try {
    configureWriter(database)
    const sourceHash = canonicalJsonSha256(source)
    const existing = database.prepare(
      "SELECT source_hash FROM datasets WHERE dataset_id = ?",
    ).get(source.datasetId) as { source_hash: string } | undefined
    if (existing !== undefined) {
      if (existing.source_hash !== sourceHash) {
        throw new Error(`Dataset ID ${source.datasetId} already exists with different content`)
      }
      return readHistoricalDatasetManifest(database, databasePath, source.datasetId)
    }

    const insert = database.transaction(() => {
      database.prepare(`
        INSERT INTO datasets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETE')
      `).run(
        source.datasetId,
        sourceHash,
        source.universeId,
        source.evidenceTier,
        source.provider,
        source.feed,
        source.timezone,
        source.requestedStartDate,
        source.requestedEndDate,
        new Date().toISOString(),
      )

      const insertSession = database.prepare("INSERT INTO market_sessions VALUES (?, ?, ?, ?)")
      for (const session of source.sessions) insertSession.run(source.datasetId, session.sessionDate, session.openAt, session.closeAt)

      const insertBar = database.prepare("INSERT INTO underlying_bars VALUES (?, ?, ?, ?, ?, ?)")
      for (const bar of source.underlyingBars) insertBar.run(source.datasetId, bar.barId, bar.symbol, bar.observedAt, bar.availableAt, bar.closeHalfCents)

      const insertContract = database.prepare("INSERT INTO option_contracts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      for (const contract of source.contracts) insertContract.run(
        source.datasetId, contract.contractId, contract.optionSymbol,
        contract.underlying, contract.right, contract.strikeHalfCents,
        contract.expirationDate, contract.multiplier, contract.listedAt,
        contract.delistedAt ?? null,
      )

      const insertQuote = database.prepare("INSERT INTO option_quotes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      for (const quote of source.quotes) insertQuote.run(
        source.datasetId, quote.quoteId, quote.contractId, quote.observedAt,
        quote.availableAt, quote.bidHalfCents, quote.askHalfCents,
        quote.bidSize, quote.askSize, quote.sourceSequence,
      )

      const symbols = [...new Set([
        ...source.underlyingBars.map(({ symbol }) => symbol),
        ...source.contracts.map(({ underlying }) => underlying),
      ])].toSorted()
      const insertSymbol = database.prepare("INSERT INTO dataset_symbols VALUES (?, ?, ?, ?, ?, ?)")
      const insertPartition = database.prepare("INSERT INTO dataset_partitions VALUES (?, ?, ?, ?, ?, ?)")
      for (const symbol of symbols) {
        const bars = source.underlyingBars.filter((bar) => bar.symbol === symbol)
        const contracts = source.contracts.filter((contract) => contract.underlying === symbol)
        const contractIds = new Set(contracts.map(({ contractId }) => contractId))
        const quotes = source.quotes.filter((quote) => contractIds.has(quote.contractId))
        const observations = [...bars.map(({ observedAt }) => observedAt), ...quotes.map(({ observedAt }) => observedAt)].toSorted()
        const first = observations[0]
        const last = observations.at(-1)
        if (first === undefined || last === undefined) throw new Error(`No observations for ${symbol}`)
        insertSymbol.run(source.datasetId, symbol, first, last, contracts.length, quotes.length)
        for (const session of source.sessions) {
          const prefix = session.sessionDate
          const sessionBars = bars.filter(({ observedAt }) => observedAt.startsWith(prefix))
          const sessionQuotes = quotes.filter(({ observedAt }) => observedAt.startsWith(prefix))
          for (const [partitionType, rows] of [["UNDERLYING_BAR", sessionBars], ["OPTION_QUOTE", sessionQuotes]] as const) {
            insertPartition.run(source.datasetId, partitionType, symbol, session.sessionDate, rows.length, canonicalJsonSha256(rows))
          }
        }
      }
    })
    insert.immediate()
    return readHistoricalDatasetManifest(database, databasePath, source.datasetId)
  } finally {
    database.close()
  }
}

export const openHistoricalDatabaseReadonly = (databasePath: string) => {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  database.pragma("foreign_keys = ON")
  database.pragma("query_only = ON")
  return database
}
