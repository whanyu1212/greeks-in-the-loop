import { z } from "zod"

import { optionUnderlyingV1Schema } from "../../shared/alpaca-option-identity.js"

export const FORWARD_COLLECTION_SCHEMA_VERSION = "1.0.0" as const
export const FORWARD_COLLECTION_CONFIG_VERSION = "1.0.0" as const
export const DEFAULT_FORWARD_COLLECTION_SYMBOLS = Object.freeze([
  "SPY",
  "QQQ",
  "SLV",
  "GLD",
  "IWM",
  "MU",
  "TSLA",
  "META",
] as const)

const positiveInteger = z.number().int().positive().safe()
const nonnegativeInteger = z.number().int().nonnegative().safe()
const date = z.iso.date()
const timestamp = z.iso.datetime({ offset: true, precision: 3 })

export const forwardCollectionConfigV1Schema = z
  .object({
    configVersion: z.literal(FORWARD_COLLECTION_CONFIG_VERSION),
    databasePath: z.string().trim().min(1).max(1_024),
    symbols: z.array(optionUnderlyingV1Schema).min(1).max(32),
    feed: z.enum(["indicative", "opra"]),
    stockFeed: z.enum(["iex", "sip"]),
    minDte: z.number().int().min(0).max(365),
    maxDte: z.number().int().min(0).max(365),
    minMoneyness: z.number().finite().positive().max(2),
    maxMoneyness: z.number().finite().positive().max(3),
    pollSeconds: positiveInteger.max(3_600),
    contractRefreshMinutes: positiveInteger.max(1_440),
    snapshotBatchSize: positiveInteger.max(1_000),
    requestTimeoutMilliseconds: positiveInteger.max(120_000),
    freshQuoteMilliseconds: positiveInteger.max(3_600_000),
    researchArtifactRoot: z.string().trim().min(1).max(1_024),
  })
  .strict()
  .superRefine((config, refinement) => {
    if (new Set(config.symbols).size !== config.symbols.length) {
      refinement.addIssue({
        code: "custom",
        path: ["symbols"],
        message: "symbols must be unique",
      })
    }
    if (config.minDte > config.maxDte) {
      refinement.addIssue({
        code: "custom",
        path: ["maxDte"],
        message: "maxDte must be on or after minDte",
      })
    }
    if (config.minMoneyness > config.maxMoneyness) {
      refinement.addIssue({
        code: "custom",
        path: ["maxMoneyness"],
        message: "maxMoneyness must be at least minMoneyness",
      })
    }
  })

export type ForwardCollectionConfigV1 = Readonly<
  z.infer<typeof forwardCollectionConfigV1Schema>
>

export const collectedOptionContractV1Schema = z
  .object({
    providerContractId: z.string().trim().min(1).max(160),
    optionSymbol: z.string().trim().min(1).max(64),
    underlying: optionUnderlyingV1Schema,
    right: z.enum(["CALL", "PUT"]),
    strikeThousandthsPerShare: positiveInteger,
    expirationDate: date,
    multiplier: positiveInteger,
    style: z.enum(["AMERICAN", "EUROPEAN", "UNKNOWN"]),
    status: z.string().trim().min(1).max(32),
    tradable: z.boolean(),
    openInterest: nonnegativeInteger.optional(),
    openInterestDate: date.optional(),
  })
  .strict()

export type CollectedOptionContractV1 = Readonly<
  z.infer<typeof collectedOptionContractV1Schema>
>

export const collectedOptionQuoteV1Schema = z
  .object({
    optionSymbol: z.string().trim().min(1).max(64),
    providerTimestamp: timestamp.optional(),
    bidHalfCents: nonnegativeInteger.optional(),
    askHalfCents: nonnegativeInteger.optional(),
    bidSize: nonnegativeInteger.optional(),
    askSize: nonnegativeInteger.optional(),
    bidExchange: z.string().trim().min(1).max(16).optional(),
    askExchange: z.string().trim().min(1).max(16).optional(),
    conditions: z.array(z.string().trim().min(1).max(32)).max(32),
    parseStatus: z.enum([
      "PARSED",
      "MISSING",
      "INVALID_PRICE",
      "INVALID_TIMESTAMP",
    ]),
  })
  .strict()

export type CollectedOptionQuoteV1 = Readonly<
  z.infer<typeof collectedOptionQuoteV1Schema>
>

export type CollectedUnderlyingSpotV1 = Readonly<{
  symbol: string
  priceHalfCents: number
  providerTimestamp?: string
}>

export type CollectionSessionV1 = Readonly<{
  date: string
  open: string
  close: string
}>

export type QuoteQualityV1 =
  | "FRESH"
  | "STALE"
  | "OUTSIDE_SESSION"
  | "MISSING"
  | "INVALID_PRICE"
  | "INVALID_TIMESTAMP"
  | "FUTURE_TIMESTAMP"
