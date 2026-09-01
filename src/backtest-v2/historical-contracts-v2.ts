import { z } from "zod"

import {
  GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1,
  goldenTechOptionsSymbolSetV1,
} from "./golden-universe-v1.js"

const identifier = z.string().trim().min(1).max(160)
const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const date = z.iso.date()
const symbol = z.string().trim().regex(/^[A-Z][A-Z0-9.]{0,9}$/)
const positiveInteger = z.number().int().positive().safe()
const nonnegativeInteger = z.number().int().nonnegative().safe()

const validateSymbol = (value: string, context: z.RefinementCtx, path: PropertyKey[]) => {
  if (!goldenTechOptionsSymbolSetV1.has(value)) {
    context.addIssue({
      code: "custom",
      path,
      message: `${value} is outside ${GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1}`,
    })
  }
}

export const historicalSourceV2Schema = z
  .object({
    sourceVersion: z.literal("2.0.0"),
    datasetId: identifier,
    universeId: z.literal(GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1),
    evidenceTier: z.enum([
      "TEST_FIXTURE_REPLAY",
      "ONE_MINUTE_QUOTE_SNAPSHOT_REPLAY",
      "EXACT_CHAIN_REPLAY",
    ]),
    provider: identifier,
    feed: identifier,
    timezone: z.literal("America/New_York"),
    requestedStartDate: date,
    requestedEndDate: date,
    sessions: z
      .array(
        z
          .object({
            sessionDate: date,
            openAt: timestamp,
            closeAt: timestamp,
          })
          .strict(),
      )
      .min(1)
      .max(5_000),
    underlyingBars: z
      .array(
        z
          .object({
            barId: identifier,
            symbol,
            observedAt: timestamp,
            availableAt: timestamp,
            closeHalfCents: positiveInteger,
          })
          .strict(),
      )
      .min(1)
      .max(1_000_000),
    contracts: z
      .array(
        z
          .object({
            contractId: identifier,
            optionSymbol: identifier,
            underlying: symbol,
            right: z.enum(["CALL", "PUT"]),
            strikeHalfCents: positiveInteger,
            expirationDate: date,
            multiplier: z.literal(100),
            listedAt: timestamp,
            delistedAt: timestamp.optional(),
          })
          .strict(),
      )
      .min(2)
      .max(1_000_000),
    quotes: z
      .array(
        z
          .object({
            quoteId: identifier,
            contractId: identifier,
            observedAt: timestamp,
            availableAt: timestamp,
            bidHalfCents: positiveInteger,
            askHalfCents: positiveInteger,
            bidSize: nonnegativeInteger,
            askSize: nonnegativeInteger,
            sourceSequence: nonnegativeInteger,
          })
          .strict(),
      )
      .min(2)
      .max(5_000_000),
  })
  .strict()
  .superRefine((source, context) => {
    if (source.requestedStartDate > source.requestedEndDate) {
      context.addIssue({ code: "custom", path: ["requestedEndDate"], message: "requested date range is reversed" })
    }
    const contractIds = new Set<string>()
    for (const [index, contract] of source.contracts.entries()) {
      validateSymbol(contract.underlying, context, ["contracts", index, "underlying"])
      if (contractIds.has(contract.contractId)) {
        context.addIssue({ code: "custom", path: ["contracts", index, "contractId"], message: "duplicate contractId" })
      }
      contractIds.add(contract.contractId)
      if (contract.delistedAt !== undefined && contract.delistedAt <= contract.listedAt) {
        context.addIssue({ code: "custom", path: ["contracts", index, "delistedAt"], message: "delistedAt must be after listedAt" })
      }
    }
    const barIds = new Set<string>()
    for (const [index, bar] of source.underlyingBars.entries()) {
      validateSymbol(bar.symbol, context, ["underlyingBars", index, "symbol"])
      if (barIds.has(bar.barId)) context.addIssue({ code: "custom", path: ["underlyingBars", index, "barId"], message: "duplicate barId" })
      barIds.add(bar.barId)
      if (bar.availableAt < bar.observedAt) context.addIssue({ code: "custom", path: ["underlyingBars", index, "availableAt"], message: "availableAt precedes observedAt" })
    }
    const quoteIds = new Set<string>()
    for (const [index, quote] of source.quotes.entries()) {
      if (quoteIds.has(quote.quoteId)) context.addIssue({ code: "custom", path: ["quotes", index, "quoteId"], message: "duplicate quoteId" })
      quoteIds.add(quote.quoteId)
      if (!contractIds.has(quote.contractId)) context.addIssue({ code: "custom", path: ["quotes", index, "contractId"], message: "unknown contractId" })
      if (quote.availableAt < quote.observedAt) context.addIssue({ code: "custom", path: ["quotes", index, "availableAt"], message: "availableAt precedes observedAt" })
      if (quote.bidHalfCents >= quote.askHalfCents) context.addIssue({ code: "custom", path: ["quotes", index], message: "quote must satisfy 0 < bid < ask" })
    }
  })

const replaySelectionSchema = z.object({
  startDate: date,
  endDate: date,
  timezone: z.literal("America/New_York"),
  symbols: z.array(symbol).min(1).max(48),
}).strict()

export const historicalReplayExperimentV2Schema = z
  .object({
    backtestVersion: z.literal("2.0.0"),
    experimentId: identifier,
    capability: z.literal("HISTORICAL_CHAIN_REPLAY"),
    databasePath: z.string().trim().min(1).max(1_024),
    datasetId: identifier,
    universeId: z.literal(GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1),
    replaySelection: replaySelectionSchema,
    signals: z.array(z.object({
      decisionId: identifier,
      decisionAt: timestamp,
      symbol,
      direction: z.enum(["BULLISH", "BEARISH"]),
      exitAt: timestamp,
    }).strict()).min(1).max(10_000),
    selector: z.object({
      minDte: z.number().int().min(0).max(365),
      maxDte: z.number().int().min(0).max(365),
      minWidthHalfCents: positiveInteger,
      maxWidthHalfCents: positiveInteger,
      maxQuoteAgeMilliseconds: positiveInteger,
    }).strict(),
    execution: z.object({
      latencyMilliseconds: z.number().int().positive().max(60_000),
      slippageHalfCentsPerLeg: nonnegativeInteger,
      commissionCentsPerContract: nonnegativeInteger,
      missingQuote: z.literal("INCOMPLETE_RUN"),
    }).strict(),
    exitPolicy: z.object({
      profitTargetBps: z.number().int().positive().max(100_000),
      stopLossBps: z.number().int().positive().max(10_000),
      expirationGuardDte: z.number().int().min(0).max(30),
      priority: z.tuple([
        z.literal("EXPIRATION_GUARD"),
        z.literal("STOP_LOSS"),
        z.literal("PROFIT_TARGET"),
        z.literal("MAX_HOLD"),
      ]),
    }).strict(),
    portfolio: z.object({
      initialCapitalCents: positiveInteger,
      quantity: z.literal(1),
      maxConcurrentPositions: z.literal(1),
      endOfTest: z.literal("LIQUIDATE_AT_END"),
    }).strict(),
  })
  .strict()
  .superRefine((experiment, context) => {
    if (experiment.replaySelection.startDate > experiment.replaySelection.endDate) context.addIssue({ code: "custom", path: ["replaySelection", "endDate"], message: "endDate precedes startDate" })
    if (experiment.selector.minDte > experiment.selector.maxDte) context.addIssue({ code: "custom", path: ["selector", "maxDte"], message: "maxDte is below minDte" })
    if (experiment.selector.minWidthHalfCents > experiment.selector.maxWidthHalfCents) context.addIssue({ code: "custom", path: ["selector", "maxWidthHalfCents"], message: "max width is below min width" })
    const selected = new Set(experiment.replaySelection.symbols)
    experiment.replaySelection.symbols.forEach((value, index) => validateSymbol(value, context, ["replaySelection", "symbols", index]))
    experiment.signals.forEach((signal, index) => {
      validateSymbol(signal.symbol, context, ["signals", index, "symbol"])
      if (!selected.has(signal.symbol)) context.addIssue({ code: "custom", path: ["signals", index, "symbol"], message: "signal symbol is not selected" })
      if (signal.exitAt <= signal.decisionAt) context.addIssue({ code: "custom", path: ["signals", index, "exitAt"], message: "exitAt must be after decisionAt" })
    })
  })

export type HistoricalSourceV2 = z.infer<typeof historicalSourceV2Schema>
export type HistoricalReplayExperimentV2 = z.infer<typeof historicalReplayExperimentV2Schema>
