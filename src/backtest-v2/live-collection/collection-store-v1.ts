import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import Database from "better-sqlite3"

import { assertPersistenceSafe } from "../../event-ledger/persistence-safety.js"
import { canonicalJson, canonicalJsonSha256 } from "../../shared/canonical-json.js"
import type {
  CollectedOptionContractV1,
  CollectedOptionQuoteV1,
  CollectedUnderlyingSpotV1,
  CollectionSessionV1,
  ForwardCollectionConfigV1,
  QuoteQualityV1,
} from "./contracts-v1.js"
import { FORWARD_COLLECTION_SCHEMA_VERSION } from "./contracts-v1.js"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_metadata (
  schema_name TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL
) STRICT;
INSERT OR IGNORE INTO schema_metadata VALUES ('backtest_v2_forward_collection', '1.0.0');

CREATE TABLE IF NOT EXISTS collection_runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('BOOTSTRAP', 'ONCE', 'SESSION')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETE', 'FAILED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  session_date TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  failure_code TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS market_sessions (
  session_date TEXT PRIMARY KEY,
  open_at TEXT NOT NULL,
  close_at TEXT NOT NULL,
  retrieved_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS contract_bootstraps (
  bootstrap_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collection_runs(run_id),
  retrieved_at TEXT NOT NULL,
  expiration_start TEXT NOT NULL,
  expiration_end TEXT NOT NULL,
  requested_symbols_json TEXT NOT NULL,
  spot_count INTEGER NOT NULL CHECK (spot_count >= 0),
  provider_contract_count INTEGER NOT NULL CHECK (provider_contract_count >= 0),
  retained_contract_count INTEGER NOT NULL CHECK (retained_contract_count >= 0),
  content_hash TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS underlying_spot_observations (
  observation_id TEXT PRIMARY KEY,
  bootstrap_id TEXT NOT NULL REFERENCES contract_bootstraps(bootstrap_id),
  symbol TEXT NOT NULL,
  provider_timestamp TEXT,
  retrieved_at TEXT NOT NULL,
  price_half_cents INTEGER NOT NULL CHECK (price_half_cents > 0)
) STRICT;
CREATE INDEX IF NOT EXISTS underlying_spot_lookup
  ON underlying_spot_observations(symbol, retrieved_at DESC);

CREATE TABLE IF NOT EXISTS option_contracts (
  provider_contract_id TEXT PRIMARY KEY,
  option_symbol TEXT NOT NULL UNIQUE,
  underlying TEXT NOT NULL,
  option_right TEXT NOT NULL CHECK (option_right IN ('CALL', 'PUT')),
  strike_thousandths_per_share INTEGER NOT NULL CHECK (strike_thousandths_per_share > 0),
  expiration_date TEXT NOT NULL,
  multiplier INTEGER NOT NULL CHECK (multiplier > 0),
  style TEXT NOT NULL CHECK (style IN ('AMERICAN', 'EUROPEAN', 'UNKNOWN')),
  status TEXT NOT NULL,
  tradable INTEGER NOT NULL CHECK (tradable IN (0, 1)),
  open_interest INTEGER CHECK (open_interest >= 0),
  open_interest_date TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS option_contract_chain
  ON option_contracts(underlying, expiration_date, option_right, strike_thousandths_per_share);

CREATE TABLE IF NOT EXISTS contract_universe_membership (
  bootstrap_id TEXT NOT NULL REFERENCES contract_bootstraps(bootstrap_id),
  provider_contract_id TEXT NOT NULL REFERENCES option_contracts(provider_contract_id),
  spot_half_cents INTEGER NOT NULL CHECK (spot_half_cents > 0),
  moneyness REAL NOT NULL CHECK (moneyness > 0),
  PRIMARY KEY (bootstrap_id, provider_contract_id)
) STRICT;

CREATE TABLE IF NOT EXISTS quote_poll_attempts (
  poll_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collection_runs(run_id),
  bootstrap_id TEXT NOT NULL REFERENCES contract_bootstraps(bootstrap_id),
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  session_state TEXT NOT NULL CHECK (session_state IN ('PREMARKET', 'OPEN', 'AFTER_HOURS', 'NON_SESSION')),
  requested_contract_count INTEGER NOT NULL CHECK (requested_contract_count >= 0),
  received_contract_count INTEGER NOT NULL CHECK (received_contract_count >= 0),
  fresh_count INTEGER NOT NULL CHECK (fresh_count >= 0),
  stale_count INTEGER NOT NULL CHECK (stale_count >= 0),
  invalid_count INTEGER NOT NULL CHECK (invalid_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('COMPLETE', 'PARTIAL', 'FAILED')),
  failure_code TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS option_quote_observations (
  observation_id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL REFERENCES quote_poll_attempts(poll_id),
  provider_contract_id TEXT NOT NULL REFERENCES option_contracts(provider_contract_id),
  provider_timestamp TEXT,
  received_at TEXT NOT NULL,
  bid_half_cents INTEGER CHECK (bid_half_cents >= 0),
  ask_half_cents INTEGER CHECK (ask_half_cents >= 0),
  bid_size INTEGER CHECK (bid_size >= 0),
  ask_size INTEGER CHECK (ask_size >= 0),
  bid_exchange TEXT,
  ask_exchange TEXT,
  conditions_json TEXT NOT NULL,
  feed TEXT NOT NULL,
  quote_age_milliseconds INTEGER,
  quality TEXT NOT NULL CHECK (quality IN (
    'FRESH', 'STALE', 'OUTSIDE_SESSION', 'MISSING', 'INVALID_PRICE',
    'INVALID_TIMESTAMP', 'FUTURE_TIMESTAMP'
  ))
) STRICT;
CREATE INDEX IF NOT EXISTS option_quote_history
  ON option_quote_observations(provider_contract_id, received_at, provider_timestamp);

CREATE TABLE IF NOT EXISTS collection_quality_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES collection_runs(run_id),
  occurred_at TEXT NOT NULL,
  code TEXT NOT NULL,
  detail_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS research_artifacts (
  artifact_hash TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  run_version TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  session_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  outcome_status TEXT NOT NULL,
  artifact_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS research_artifacts_session
  ON research_artifacts(session_date, cycle_number);
`

export type CollectionModeV1 = "BOOTSTRAP" | "ONCE" | "SESSION"
export type SessionStateV1 = "PREMARKET" | "OPEN" | "AFTER_HOURS" | "NON_SESSION"

export type CollectionStoreV1 = Readonly<{
  databasePath: string
  startRun(mode: CollectionModeV1, sessionDate: string, config: ForwardCollectionConfigV1, startedAt: string): string
  completeRun(runId: string, status: "COMPLETE" | "FAILED", completedAt: string, failureCode?: string): void
  recordSession(session: CollectionSessionV1, retrievedAt: string): void
  recordBootstrap(input: Readonly<{
    runId: string
    retrievedAt: string
    expirationStart: string
    expirationEnd: string
    symbols: readonly string[]
    spots: readonly CollectedUnderlyingSpotV1[]
    providerContracts: readonly CollectedOptionContractV1[]
    retainedContracts: readonly CollectedOptionContractV1[]
  }>): string
  latestBootstrapContracts(symbols: readonly string[]): Readonly<{
    bootstrapId: string
    contracts: readonly CollectedOptionContractV1[]
  }> | undefined
  recordPoll(input: Readonly<{
    runId: string
    bootstrapId: string
    scheduledAt: string
    startedAt: string
    completedAt: string
    sessionState: SessionStateV1
    feed: string
    requestedContracts: readonly CollectedOptionContractV1[]
    quotes: readonly CollectedOptionQuoteV1[]
    freshQuoteMilliseconds: number
  }>): string
  recordFailedPoll(input: Readonly<{
    runId: string
    bootstrapId: string
    scheduledAt: string
    startedAt: string
    completedAt: string
    sessionState: SessionStateV1
    requestedContractCount: number
    failureCode: string
  }>): string
  importResearchArtifact(sourcePath: string, input: unknown, importedAt: string): boolean
  close(): void
}>

const boundedCode = (value: string) => value.trim().slice(0, 128) || "UNKNOWN"

const qualityFor = (
  quote: CollectedOptionQuoteV1,
  receivedAt: string,
  state: SessionStateV1,
  freshQuoteMilliseconds: number,
): Readonly<{ quality: QuoteQualityV1; age?: number }> => {
  if (quote.parseStatus !== "PARSED") return {
    quality: quote.parseStatus,
  }
  if (quote.providerTimestamp === undefined) return { quality: "INVALID_TIMESTAMP" }
  const age = Date.parse(receivedAt) - Date.parse(quote.providerTimestamp)
  if (!Number.isFinite(age)) return { quality: "INVALID_TIMESTAMP" }
  if (age < 0) return { quality: "FUTURE_TIMESTAMP", age }
  if (state !== "OPEN") return { quality: "OUTSIDE_SESSION", age }
  return { quality: age <= freshQuoteMilliseconds ? "FRESH" : "STALE", age }
}

const parseResearchArtifact = (input: unknown) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  const value = input as Record<string, unknown>
  const cycle = value.cycle
  const outcome = value.outcome
  if (
    typeof value.runVersion !== "string" ||
    typeof cycle !== "object" || cycle === null || Array.isArray(cycle) ||
    typeof outcome !== "object" || outcome === null || Array.isArray(outcome)
  ) return undefined
  const cycleValue = cycle as Record<string, unknown>
  const outcomeValue = outcome as Record<string, unknown>
  if (
    typeof cycleValue.cycleId !== "string" ||
    !Number.isSafeInteger(cycleValue.cycleNumber) ||
    typeof cycleValue.sessionDate !== "string" ||
    typeof cycleValue.startedAt !== "string" ||
    typeof cycleValue.completedAt !== "string" ||
    typeof outcomeValue.status !== "string"
  ) return undefined
  return {
    runVersion: value.runVersion,
    cycleId: cycleValue.cycleId,
    cycleNumber: cycleValue.cycleNumber as number,
    sessionDate: cycleValue.sessionDate,
    startedAt: cycleValue.startedAt,
    completedAt: cycleValue.completedAt,
    outcomeStatus: outcomeValue.status,
  }
}

export function createCollectionStoreV1(databasePath: string): CollectionStoreV1 {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  const database = new Database(databasePath)
  database.pragma("foreign_keys = ON")
  database.pragma("journal_mode = WAL")
  database.pragma("synchronous = FULL")
  database.pragma("busy_timeout = 5000")
  database.exec(SCHEMA)

  return {
    databasePath,
    startRun(mode, sessionDate, config, startedAt) {
      assertPersistenceSafe(config)
      const configHash = canonicalJsonSha256(config)
      const runId = canonicalJsonSha256({
        schemaVersion: FORWARD_COLLECTION_SCHEMA_VERSION,
        mode,
        sessionDate,
        configHash,
        startedAt,
      })
      database.prepare(`
        INSERT INTO collection_runs (
          run_id, mode, status, started_at, session_date, config_hash, config_json
        ) VALUES (?, ?, 'RUNNING', ?, ?, ?, ?)
      `).run(runId, mode, startedAt, sessionDate, configHash, canonicalJson(config))
      return runId
    },
    completeRun(runId, status, completedAt, failureCode) {
      database.prepare(`
        UPDATE collection_runs
        SET status = ?, completed_at = ?, failure_code = ?
        WHERE run_id = ? AND status = 'RUNNING'
      `).run(status, completedAt, failureCode === undefined ? null : boundedCode(failureCode), runId)
    },
    recordSession(session, retrievedAt) {
      database.prepare(`
        INSERT INTO market_sessions VALUES (?, ?, ?, ?)
        ON CONFLICT(session_date) DO UPDATE SET
          open_at = excluded.open_at,
          close_at = excluded.close_at,
          retrieved_at = excluded.retrieved_at
      `).run(session.date, session.open, session.close, retrievedAt)
    },
    recordBootstrap(input) {
      const spots = new Map(input.spots.map((spot) => [spot.symbol, spot]))
      const contentHash = canonicalJsonSha256({
        expirationStart: input.expirationStart,
        expirationEnd: input.expirationEnd,
        symbols: input.symbols,
        spots: input.spots,
        contracts: input.retainedContracts,
      })
      const bootstrapId = canonicalJsonSha256({
        runId: input.runId,
        retrievedAt: input.retrievedAt,
        contentHash,
      })
      database.transaction(() => {
        database.prepare(`
          INSERT INTO contract_bootstraps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          bootstrapId,
          input.runId,
          input.retrievedAt,
          input.expirationStart,
          input.expirationEnd,
          JSON.stringify(input.symbols),
          input.spots.length,
          input.providerContracts.length,
          input.retainedContracts.length,
          contentHash,
        )
        const insertSpot = database.prepare(`
          INSERT INTO underlying_spot_observations VALUES (?, ?, ?, ?, ?, ?)
        `)
        for (const spot of input.spots) {
          insertSpot.run(
            canonicalJsonSha256({ bootstrapId, symbol: spot.symbol }),
            bootstrapId,
            spot.symbol,
            spot.providerTimestamp ?? null,
            input.retrievedAt,
            spot.priceHalfCents,
          )
        }
        const upsertContract = database.prepare(`
          INSERT INTO option_contracts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider_contract_id) DO UPDATE SET
            option_symbol = excluded.option_symbol,
            status = excluded.status,
            tradable = excluded.tradable,
            open_interest = excluded.open_interest,
            open_interest_date = excluded.open_interest_date,
            last_seen_at = excluded.last_seen_at
        `)
        const insertMembership = database.prepare(`
          INSERT INTO contract_universe_membership VALUES (?, ?, ?, ?)
        `)
        for (const contract of input.retainedContracts) {
          const spot = spots.get(contract.underlying)
          if (spot === undefined) continue
          const strikeHalfCents = contract.strikeThousandthsPerShare / 5
          const moneyness = strikeHalfCents / spot.priceHalfCents
          upsertContract.run(
            contract.providerContractId,
            contract.optionSymbol,
            contract.underlying,
            contract.right,
            contract.strikeThousandthsPerShare,
            contract.expirationDate,
            contract.multiplier,
            contract.style,
            contract.status,
            contract.tradable ? 1 : 0,
            contract.openInterest ?? null,
            contract.openInterestDate ?? null,
            input.retrievedAt,
            input.retrievedAt,
          )
          insertMembership.run(
            bootstrapId,
            contract.providerContractId,
            spot.priceHalfCents,
            moneyness,
          )
        }
      }).immediate()
      return bootstrapId
    },
    latestBootstrapContracts(symbols) {
      const row = database.prepare(`
        SELECT bootstrap_id
        FROM contract_bootstraps
        ORDER BY retrieved_at DESC, bootstrap_id DESC
        LIMIT 1
      `).get() as { bootstrap_id: string } | undefined
      if (row === undefined) return undefined
      const placeholders = symbols.map(() => "?").join(", ")
      const records = database.prepare(`
        SELECT c.provider_contract_id, c.option_symbol, c.underlying,
               c.option_right, c.strike_thousandths_per_share,
               c.expiration_date, c.multiplier, c.style, c.status, c.tradable,
               c.open_interest, c.open_interest_date
        FROM contract_universe_membership m
        JOIN option_contracts c
          ON c.provider_contract_id = m.provider_contract_id
        WHERE m.bootstrap_id = ? AND c.underlying IN (${placeholders})
        ORDER BY c.underlying, c.expiration_date, c.option_right,
                 c.strike_thousandths_per_share, c.option_symbol
      `).all(row.bootstrap_id, ...symbols) as Array<Record<string, unknown>>
      const contracts = records.map((record) => ({
        providerContractId: record.provider_contract_id as string,
        optionSymbol: record.option_symbol as string,
        underlying: record.underlying as string,
        right: record.option_right as "CALL" | "PUT",
        strikeThousandthsPerShare: record.strike_thousandths_per_share as number,
        expirationDate: record.expiration_date as string,
        multiplier: record.multiplier as number,
        style: record.style as "AMERICAN" | "EUROPEAN" | "UNKNOWN",
        status: record.status as string,
        tradable: record.tradable === 1,
        ...(record.open_interest === null ? {} : { openInterest: record.open_interest as number }),
        ...(record.open_interest_date === null ? {} : { openInterestDate: record.open_interest_date as string }),
      }))
      return { bootstrapId: row.bootstrap_id, contracts }
    },
    recordPoll(input) {
      const quotes = new Map(input.quotes.map((quote) => [quote.optionSymbol, quote]))
      const pollId = canonicalJsonSha256({
        runId: input.runId,
        bootstrapId: input.bootstrapId,
        scheduledAt: input.scheduledAt,
      })
      const normalized = input.requestedContracts.map((contract) => {
        const quote = quotes.get(contract.optionSymbol) ?? {
          optionSymbol: contract.optionSymbol,
          conditions: [],
          parseStatus: "MISSING" as const,
        }
        return {
          contract,
          quote,
          ...qualityFor(
            quote,
            input.completedAt,
            input.sessionState,
            input.freshQuoteMilliseconds,
          ),
        }
      })
      const freshCount = normalized.filter(({ quality }) => quality === "FRESH").length
      const staleCount = normalized.filter(({ quality }) =>
        quality === "STALE" || quality === "OUTSIDE_SESSION"
      ).length
      const invalidCount = normalized.length - freshCount - staleCount
      database.transaction(() => {
        database.prepare(`
          INSERT INTO quote_poll_attempts VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
          )
        `).run(
          pollId,
          input.runId,
          input.bootstrapId,
          input.scheduledAt,
          input.startedAt,
          input.completedAt,
          input.sessionState,
          input.requestedContracts.length,
          input.quotes.length,
          freshCount,
          staleCount,
          invalidCount,
          invalidCount === 0 ? "COMPLETE" : "PARTIAL",
        )
        const insert = database.prepare(`
          INSERT INTO option_quote_observations VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `)
        for (const item of normalized) {
          insert.run(
            canonicalJsonSha256({ pollId, optionSymbol: item.contract.optionSymbol }),
            pollId,
            item.contract.providerContractId,
            item.quote.providerTimestamp ?? null,
            input.completedAt,
            item.quote.bidHalfCents ?? null,
            item.quote.askHalfCents ?? null,
            item.quote.bidSize ?? null,
            item.quote.askSize ?? null,
            item.quote.bidExchange ?? null,
            item.quote.askExchange ?? null,
            JSON.stringify(item.quote.conditions),
            input.feed,
            item.age ?? null,
            item.quality,
          )
        }
      }).immediate()
      return pollId
    },
    recordFailedPoll(input) {
      const pollId = canonicalJsonSha256({
        runId: input.runId,
        bootstrapId: input.bootstrapId,
        scheduledAt: input.scheduledAt,
      })
      database.prepare(`
        INSERT INTO quote_poll_attempts VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'FAILED', ?
        )
      `).run(
        pollId,
        input.runId,
        input.bootstrapId,
        input.scheduledAt,
        input.startedAt,
        input.completedAt,
        input.sessionState,
        input.requestedContractCount,
        boundedCode(input.failureCode),
      )
      return pollId
    },
    importResearchArtifact(sourcePath, input, importedAt) {
      const metadata = parseResearchArtifact(input)
      if (metadata === undefined) return false
      assertPersistenceSafe(input)
      const artifactHash = canonicalJsonSha256(input)
      const result = database.prepare(`
        INSERT OR IGNORE INTO research_artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifactHash,
        sourcePath,
        importedAt,
        metadata.runVersion,
        metadata.cycleId,
        metadata.cycleNumber,
        metadata.sessionDate,
        metadata.startedAt,
        metadata.completedAt,
        metadata.outcomeStatus,
        canonicalJson(input),
      )
      return result.changes === 1
    },
    close() {
      database.close()
    },
  }
}
