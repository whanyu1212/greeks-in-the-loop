import type Database from "better-sqlite3"

export type HistoricalOptionQuoteV2 = Readonly<{
  quoteId: string
  contractId: string
  optionSymbol: string
  underlying: string
  right: "CALL" | "PUT"
  strikeHalfCents: number
  expirationDate: string
  multiplier: 100
  observedAt: string
  availableAt: string
  bidHalfCents: number
  askHalfCents: number
}>

export type ReconstructedSpreadV2 = Readonly<{
  structure: "BULL_CALL_SPREAD" | "BEAR_PUT_SPREAD"
  underlying: string
  decisionAt: string
  spotHalfCents: number
  expirationDate: string
  dte: number
  longLeg: HistoricalOptionQuoteV2
  shortLeg: HistoricalOptionQuoteV2
  widthHalfCents: number
  naturalDebitHalfCents: number
  chainContractCount: number
}>

type QuoteRow = {
  quote_id: string
  contract_id: string
  option_symbol: string
  underlying: string
  option_right: "CALL" | "PUT"
  strike_half_cents: number
  expiration_date: string
  multiplier: 100
  observed_at: string
  available_at: string
  bid_half_cents: number
  ask_half_cents: number
}

const daysBetween = (left: string, right: string) =>
  Math.round((Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`)) / 86_400_000)

const latestUnderlyingPrice = (
  database: Database.Database,
  datasetId: string,
  symbol: string,
  cutoff: string,
) => {
  const row = database.prepare(`
    SELECT close_half_cents FROM underlying_bars
    WHERE dataset_id = ? AND symbol = ? AND available_at <= ?
    ORDER BY available_at DESC, observed_at DESC, bar_id DESC LIMIT 1
  `).get(datasetId, symbol, cutoff) as { close_half_cents: number } | undefined
  if (row === undefined) throw new Error(`No causal underlying bar for ${symbol} at ${cutoff}`)
  return row.close_half_cents
}

const latestChainQuotes = (
  database: Database.Database,
  datasetId: string,
  symbol: string,
  right: "CALL" | "PUT",
  cutoff: string,
  maxQuoteAgeMilliseconds: number,
): HistoricalOptionQuoteV2[] => {
  const rows = database.prepare(`
    SELECT q.quote_id, q.contract_id, c.option_symbol, c.underlying,
           c.option_right, c.strike_half_cents, c.expiration_date, c.multiplier,
           q.observed_at, q.available_at, q.bid_half_cents, q.ask_half_cents
    FROM option_contracts c
    JOIN option_quotes q
      ON q.dataset_id = c.dataset_id AND q.contract_id = c.contract_id
    WHERE c.dataset_id = ? AND c.underlying = ? AND c.option_right = ?
      AND c.listed_at <= ? AND (c.delisted_at IS NULL OR c.delisted_at > ?)
      AND q.available_at <= ?
      AND q.quote_id = (
        SELECT q2.quote_id FROM option_quotes q2
        WHERE q2.dataset_id = q.dataset_id AND q2.contract_id = q.contract_id
          AND q2.available_at <= ?
        ORDER BY q2.available_at DESC, q2.observed_at DESC,
                 q2.source_sequence DESC, q2.quote_id DESC LIMIT 1
      )
    ORDER BY c.expiration_date, c.strike_half_cents, c.contract_id
  `).all(datasetId, symbol, right, cutoff, cutoff, cutoff, cutoff) as QuoteRow[]

  const cutoffMs = Date.parse(cutoff)
  return rows
    .filter((row) => cutoffMs - Date.parse(row.observed_at) <= maxQuoteAgeMilliseconds)
    .map((row) => ({
      quoteId: row.quote_id,
      contractId: row.contract_id,
      optionSymbol: row.option_symbol,
      underlying: row.underlying,
      right: row.option_right,
      strikeHalfCents: row.strike_half_cents,
      expirationDate: row.expiration_date,
      multiplier: row.multiplier,
      observedAt: row.observed_at,
      availableAt: row.available_at,
      bidHalfCents: row.bid_half_cents,
      askHalfCents: row.ask_half_cents,
    }))
}

export const reconstructDebitSpreadV2 = (
  database: Database.Database,
  input: Readonly<{
    datasetId: string
    symbol: string
    direction: "BULLISH" | "BEARISH"
    cutoff: string
    minDte: number
    maxDte: number
    minWidthHalfCents: number
    maxWidthHalfCents: number
    maxQuoteAgeMilliseconds: number
  }>,
): ReconstructedSpreadV2 | undefined => {
  const spotHalfCents = latestUnderlyingPrice(database, input.datasetId, input.symbol, input.cutoff)
  const right = input.direction === "BULLISH" ? "CALL" : "PUT"
  const structure = input.direction === "BULLISH" ? "BULL_CALL_SPREAD" : "BEAR_PUT_SPREAD"
  const sessionDate = input.cutoff.slice(0, 10)
  const chain = latestChainQuotes(database, input.datasetId, input.symbol, right, input.cutoff, input.maxQuoteAgeMilliseconds)
  const candidates: ReconstructedSpreadV2[] = []
  for (const longLeg of chain) {
    const dte = daysBetween(sessionDate, longLeg.expirationDate)
    if (dte < input.minDte || dte > input.maxDte) continue
    for (const shortLeg of chain) {
      if (shortLeg.contractId === longLeg.contractId || shortLeg.expirationDate !== longLeg.expirationDate) continue
      const validOrder = input.direction === "BULLISH"
        ? longLeg.strikeHalfCents < shortLeg.strikeHalfCents
        : longLeg.strikeHalfCents > shortLeg.strikeHalfCents
      if (!validOrder) continue
      const widthHalfCents = Math.abs(shortLeg.strikeHalfCents - longLeg.strikeHalfCents)
      if (widthHalfCents < input.minWidthHalfCents || widthHalfCents > input.maxWidthHalfCents) continue
      const naturalDebitHalfCents = longLeg.askHalfCents - shortLeg.bidHalfCents
      if (naturalDebitHalfCents <= 0 || naturalDebitHalfCents >= widthHalfCents) continue
      candidates.push({
        structure,
        underlying: input.symbol,
        decisionAt: input.cutoff,
        spotHalfCents,
        expirationDate: longLeg.expirationDate,
        dte,
        longLeg,
        shortLeg,
        widthHalfCents,
        naturalDebitHalfCents,
        chainContractCount: chain.length,
      })
    }
  }
  return candidates.toSorted((left, rightCandidate) => {
    const leftDistance = Math.abs(left.longLeg.strikeHalfCents - spotHalfCents)
    const rightDistance = Math.abs(rightCandidate.longLeg.strikeHalfCents - spotHalfCents)
    return leftDistance - rightDistance ||
      left.widthHalfCents - rightCandidate.widthHalfCents ||
      left.expirationDate.localeCompare(rightCandidate.expirationDate) ||
      left.longLeg.contractId.localeCompare(rightCandidate.longLeg.contractId) ||
      left.shortLeg.contractId.localeCompare(rightCandidate.shortLeg.contractId)
  })[0]
}

export const quotesForSpreadAtV2 = (
  database: Database.Database,
  datasetId: string,
  spread: ReconstructedSpreadV2,
  cutoff: string,
  maxQuoteAgeMilliseconds: number,
) => {
  const chain = latestChainQuotes(database, datasetId, spread.underlying, spread.longLeg.right, cutoff, maxQuoteAgeMilliseconds)
  const byId = new Map(chain.map((quote) => [quote.contractId, quote]))
  const longLeg = byId.get(spread.longLeg.contractId)
  const shortLeg = byId.get(spread.shortLeg.contractId)
  return longLeg === undefined || shortLeg === undefined ? undefined : { longLeg, shortLeg }
}
