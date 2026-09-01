import Database from "better-sqlite3"

import { historicalSourceV2Schema } from "../historical-contracts-v2.js"
import {
  ingestHistoricalSourceV2,
  type HistoricalDatasetManifestV2,
} from "../historical-store-v2.js"
import { canonicalJsonSha256 } from "../../shared/canonical-json.js"

export type SealForwardCaptureOptionsV1 = Readonly<{
  captureDatabasePath: string
  historicalDatabasePath: string
  datasetId: string
  universeId: "golden-tech-options-v1"
  evidenceTier: "TEST_FIXTURE_REPLAY" | "ONE_MINUTE_QUOTE_SNAPSHOT_REPLAY"
  sessionDate: string
  startAt: string
  endAt: string
  symbols: readonly string[]
}>

type SessionRow = {
  session_date: string
  open_at: string
  close_at: string
}
type SpotRow = {
  symbol: string
  provider_timestamp: string | null
  retrieved_at: string
  price_half_cents: number
}
type ContractRow = {
  provider_contract_id: string
  option_symbol: string
  underlying: string
  option_right: "CALL" | "PUT"
  strike_thousandths_per_share: number
  expiration_date: string
  multiplier: number
  first_seen_at: string
}
type QuoteRow = {
  observation_id: string
  provider_contract_id: string
  provider_timestamp: string
  received_at: string
  bid_half_cents: number
  ask_half_cents: number
  bid_size: number | null
  ask_size: number | null
  feed: string
}

/**
 * Seals a closed forward-capture window into the immutable historical replay schema.
 * Only observations already classified FRESH are eligible.
 */
export function sealForwardCaptureV1(
  options: SealForwardCaptureOptionsV1,
): HistoricalDatasetManifestV2 {
  if (options.startAt >= options.endAt) throw new Error("Capture sealing window is reversed")
  if (options.symbols.length === 0 || new Set(options.symbols).size !== options.symbols.length) {
    throw new Error("Capture sealing symbols must be unique and non-empty")
  }
  const capture = new Database(options.captureDatabasePath, {
    readonly: true,
    fileMustExist: true,
  })
  capture.pragma("query_only = ON")
  try {
    const session = capture.prepare(`
      SELECT session_date, open_at, close_at
      FROM market_sessions
      WHERE session_date = ?
    `).get(options.sessionDate) as SessionRow | undefined
    if (session === undefined) throw new Error("Capture session is unavailable")
    if (options.startAt < session.open_at || options.endAt > session.close_at) {
      throw new Error("Capture sealing window is outside the market session")
    }

    const symbolPlaceholders = options.symbols.map(() => "?").join(", ")
    const spots = capture.prepare(`
      SELECT s.symbol, s.provider_timestamp, s.retrieved_at, s.price_half_cents
      FROM underlying_spot_observations s
      JOIN (
        SELECT symbol, MAX(retrieved_at) AS retrieved_at
        FROM underlying_spot_observations
        WHERE symbol IN (${symbolPlaceholders}) AND retrieved_at <= ?
        GROUP BY symbol
      ) latest ON latest.symbol = s.symbol AND latest.retrieved_at = s.retrieved_at
      ORDER BY s.symbol
    `).all(...options.symbols, options.startAt) as SpotRow[]
    const missingSpots = options.symbols.filter(
      (symbol) => !spots.some((spot) => spot.symbol === symbol),
    )
    if (missingSpots.length > 0) {
      throw new Error(`Capture has no causal underlying spot for: ${missingSpots.join(", ")}`)
    }

    const quotes = capture.prepare(`
      SELECT q.observation_id, q.provider_contract_id, q.provider_timestamp,
             q.received_at, q.bid_half_cents, q.ask_half_cents,
             q.bid_size, q.ask_size, q.feed
      FROM option_quote_observations q
      JOIN option_contracts c
        ON c.provider_contract_id = q.provider_contract_id
      WHERE c.underlying IN (${symbolPlaceholders})
        AND q.quality = 'FRESH'
        AND q.received_at >= ?
        AND q.received_at <= ?
      ORDER BY q.received_at, q.provider_timestamp, q.observation_id
    `).all(...options.symbols, options.startAt, options.endAt) as QuoteRow[]
    if (quotes.length < 2) throw new Error("Capture window has insufficient fresh option quotes")
    const feeds = new Set(quotes.map(({ feed }) => feed))
    if (feeds.size !== 1) throw new Error("Capture window mixes option feeds")

    const contractIds = [...new Set(quotes.map(({ provider_contract_id }) => provider_contract_id))]
    const contractPlaceholders = contractIds.map(() => "?").join(", ")
    const contracts = capture.prepare(`
      SELECT provider_contract_id, option_symbol, underlying, option_right,
             strike_thousandths_per_share, expiration_date, multiplier,
             first_seen_at
      FROM option_contracts
      WHERE provider_contract_id IN (${contractPlaceholders})
      ORDER BY underlying, expiration_date, option_right,
               strike_thousandths_per_share, option_symbol
    `).all(...contractIds) as ContractRow[]
    if (contracts.length < 2) throw new Error("Capture window has insufficient option contracts")
    if (contracts.some(({ first_seen_at }) => first_seen_at > options.startAt)) {
      throw new Error("Capture contains a contract first seen after the sealing start")
    }

    const source = historicalSourceV2Schema.parse({
      sourceVersion: "2.0.0",
      datasetId: options.datasetId,
      universeId: options.universeId,
      evidenceTier: options.evidenceTier,
      provider: options.evidenceTier === "TEST_FIXTURE_REPLAY"
        ? "FORWARD_CAPTURE_FIXTURE"
        : "ALPACA_FORWARD_CAPTURE",
      feed: [...feeds][0],
      timezone: "America/New_York",
      requestedStartDate: options.sessionDate,
      requestedEndDate: options.sessionDate,
      sessions: [{
        sessionDate: session.session_date,
        openAt: session.open_at,
        closeAt: session.close_at,
      }],
      underlyingBars: spots.map((spot) => ({
        barId: `capture-spot-${canonicalJsonSha256({
          datasetId: options.datasetId,
          symbol: spot.symbol,
          retrievedAt: spot.retrieved_at,
        })}`,
        symbol: spot.symbol,
        observedAt: spot.provider_timestamp ?? spot.retrieved_at,
        availableAt: spot.retrieved_at,
        closeHalfCents: spot.price_half_cents,
      })),
      contracts: contracts.map((contract) => ({
        contractId: contract.provider_contract_id,
        optionSymbol: contract.option_symbol,
        underlying: contract.underlying,
        right: contract.option_right,
        strikeHalfCents: contract.strike_thousandths_per_share / 5,
        expirationDate: contract.expiration_date,
        multiplier: contract.multiplier,
        listedAt: contract.first_seen_at,
      })),
      quotes: quotes.map((quote, index) => ({
        quoteId: quote.observation_id,
        contractId: quote.provider_contract_id,
        observedAt: quote.provider_timestamp,
        availableAt: quote.received_at,
        bidHalfCents: quote.bid_half_cents,
        askHalfCents: quote.ask_half_cents,
        bidSize: quote.bid_size ?? 0,
        askSize: quote.ask_size ?? 0,
        sourceSequence: index + 1,
      })),
    })
    return ingestHistoricalSourceV2(options.historicalDatabasePath, source)
  } finally {
    capture.close()
  }
}
