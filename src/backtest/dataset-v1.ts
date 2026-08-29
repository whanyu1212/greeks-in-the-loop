import { z } from "zod"

import { spyAlpacaOptionSymbolV1Schema } from "../shared/alpaca-option-identity.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"

export const BACKTEST_DATASET_VERSION = "1.0.0" as const
export const BACKTEST_NORMALIZATION_VERSION = "1.0.0" as const

const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const date = z.iso.date()
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positiveSafeInteger = safeInteger.positive()
const optionSymbol = spyAlpacaOptionSymbolV1Schema
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)

export const backtestDatasetDefinitionV1Schema = z
  .object({
    datasetVersion: z.literal(BACKTEST_DATASET_VERSION),
    normalizationVersion: z.literal(BACKTEST_NORMALIZATION_VERSION),
    datasetId: identifier,
    symbol: z.literal("SPY"),
    fromDate: date,
    toDate: date,
    optionHistoricalFeed: z.literal("ALPACA_ACCOUNT_DEFAULT"),
    optionSymbols: z
      .array(optionSymbol)
      .max(10_000)
      .refine(
        (symbols) =>
          symbols.every(
            (symbol, index) => index === 0 || symbols[index - 1]! < symbol,
          ),
        "Dataset option symbols must be unique and sorted",
      ),
    requestStartedAt: timestamp,
  })
  .strict()
  .refine(({ fromDate, toDate }) => fromDate <= toDate, {
    path: ["toDate"],
    message: "Dataset end date cannot precede its start date",
  })

export type BacktestDatasetDefinitionV1 = Readonly<
  z.infer<typeof backtestDatasetDefinitionV1Schema>
>

export const backtestOptionSymbolChunks = (
  symbols: readonly string[],
): readonly (readonly string[])[] => {
  const chunks: string[][] = []
  for (let index = 0; index < symbols.length; index += 100) {
    chunks.push(symbols.slice(index, index + 100))
  }
  return chunks
}

export const backtestOptionChunkId = (symbols: readonly string[]) =>
  canonicalJsonSha256(symbols).slice(0, 16)

export const expectedBacktestPartitionKeys = (
  definition: BacktestDatasetDefinitionV1,
) => [
  "calendar",
  "spy-daily",
  "spy-minute",
  "contracts-active",
  "contracts-inactive",
  ...backtestOptionSymbolChunks(definition.optionSymbols).flatMap((symbols) => {
    const chunkId = backtestOptionChunkId(symbols)
    return [
      `option-bars-1day-${chunkId}`,
      `option-bars-1minute-${chunkId}`,
      `option-trades-${chunkId}`,
    ]
  }),
]

export const BACKTEST_PARTITION_KINDS = [
  "MARKET_CALENDAR",
  "UNDERLYING_DAILY_BARS",
  "UNDERLYING_MINUTE_BARS",
  "OPTION_CONTRACTS",
  "OPTION_BARS",
  "OPTION_TRADES",
] as const

export type BacktestPartitionKind = (typeof BACKTEST_PARTITION_KINDS)[number]

export const backtestPartitionRequestV1Schema = z
  .object({
    endpoint: z.string().min(1).max(256),
    parameters: z.record(
      z.string().min(1).max(64),
      z.union([
        z.string().max(4_096),
        z.array(z.string().min(1).max(64)).max(1_000),
      ]),
    ),
  })
  .strict()

export type BacktestPartitionRequestV1 = Readonly<
  z.infer<typeof backtestPartitionRequestV1Schema>
>

export const backtestDatasetPartitionV1Schema = z
  .object({
    partitionKey: identifier,
    kind: z.enum(BACKTEST_PARTITION_KINDS),
    request: backtestPartitionRequestV1Schema,
    status: z.enum(["IN_PROGRESS", "COMPLETE"]),
    pageCount: safeInteger,
    rowCount: safeInteger,
    nextPageToken: z.string().min(1).max(4_096).optional(),
    checksum: sha256.optional(),
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((partition, refinement) => {
    if (
      partition.status === "COMPLETE" &&
      (partition.checksum === undefined || partition.nextPageToken !== undefined)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["checksum"],
        message: "Completed partitions require a checksum and no page token",
      })
    }
    if (partition.status === "IN_PROGRESS" && partition.checksum !== undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["checksum"],
        message: "Incomplete partitions cannot have a checksum",
      })
    }
  })

export type BacktestDatasetPartitionV1 = Readonly<
  z.infer<typeof backtestDatasetPartitionV1Schema>
>

const barFields = {
  timestamp: timestamp,
  openMicros: positiveSafeInteger,
  highMicros: positiveSafeInteger,
  lowMicros: positiveSafeInteger,
  closeMicros: positiveSafeInteger,
  volume: safeInteger,
  vwapMicros: positiveSafeInteger,
} as const

const marketSessionV1Schema = z
  .object({
    recordType: z.literal("MARKET_SESSION"),
    date,
    open: timestamp,
    close: timestamp,
  })
  .strict()
  .refine((session) => Date.parse(session.open) < Date.parse(session.close), {
    path: ["close"],
    message: "Market session close must follow its open",
  })

const underlyingBarV1Schema = z
  .object({
    recordType: z.literal("UNDERLYING_BAR"),
    symbol: z.literal("SPY"),
    timeframe: z.enum(["1DAY", "1MINUTE"]),
    ...barFields,
  })
  .strict()

const optionContractV1Schema = z
  .object({
    recordType: z.literal("OPTION_CONTRACT"),
    contractSymbol: optionSymbol,
    expirationDate: date,
    optionType: z.enum(["CALL", "PUT"]),
    strikeCentsPerShare: positiveSafeInteger,
    active: z.boolean(),
    tradable: z.boolean(),
    exerciseStyle: z.enum(["AMERICAN", "EUROPEAN", "UNKNOWN"]),
    multiplier: positiveSafeInteger,
    retrievedAt: timestamp,
    openInterest: safeInteger.optional(),
    openInterestDate: date.optional(),
  })
  .strict()
  .refine(
    ({ openInterest, openInterestDate }) =>
      (openInterest === undefined) === (openInterestDate === undefined),
    {
      path: ["openInterestDate"],
      message: "Open interest and its date must be retained together",
    },
  )

const optionBarV1Schema = z
  .object({
    recordType: z.literal("OPTION_BAR"),
    contractSymbol: optionSymbol,
    timeframe: z.enum(["1DAY", "1MINUTE"]),
    ...barFields,
    tradeCount: safeInteger,
  })
  .strict()

const optionTradeV1Schema = z
  .object({
    recordType: z.literal("OPTION_TRADE"),
    contractSymbol: optionSymbol,
    timestamp,
    priceMicros: positiveSafeInteger,
    size: positiveSafeInteger,
    tradeId: z.string().min(1).max(128).optional(),
    exchange: z.string().min(1).max(16).optional(),
    conditions: z.array(z.string().min(1).max(16)).max(32),
  })
  .strict()

export const backtestDatasetRecordV1Schema = z.discriminatedUnion("recordType", [
  marketSessionV1Schema,
  underlyingBarV1Schema,
  optionContractV1Schema,
  optionBarV1Schema,
  optionTradeV1Schema,
])

export type BacktestDatasetRecordV1 = Readonly<
  z.infer<typeof backtestDatasetRecordV1Schema>
>

export const backtestDatasetManifestV1Schema = z
  .object({
    definition: backtestDatasetDefinitionV1Schema,
    partitions: z.array(backtestDatasetPartitionV1Schema),
    complete: z.boolean(),
    checksum: sha256,
    limitations: z.array(z.string().min(1).max(512)).max(32),
  })
  .strict()

export type BacktestDatasetManifestV1 = Readonly<
  z.infer<typeof backtestDatasetManifestV1Schema>
>

export const backtestRecordKey = (record: BacktestDatasetRecordV1): string => {
  switch (record.recordType) {
    case "MARKET_SESSION":
      return record.date
    case "UNDERLYING_BAR":
      return `${record.symbol}:${record.timeframe}:${record.timestamp}`
    case "OPTION_CONTRACT":
      return record.contractSymbol
    case "OPTION_BAR":
      return `${record.contractSymbol}:${record.timeframe}:${record.timestamp}`
    case "OPTION_TRADE":
      return `${record.contractSymbol}:${record.timestamp}:${record.tradeId ?? `${record.priceMicros}:${record.size}:${record.exchange ?? ""}:${record.conditions.join(",")}`}`
  }
}

export type MarketSessionRecordV1 = Extract<
  BacktestDatasetRecordV1,
  { recordType: "MARKET_SESSION" }
>
export type UnderlyingBarRecordV1 = Extract<
  BacktestDatasetRecordV1,
  { recordType: "UNDERLYING_BAR" }
>
export type OptionContractRecordV1 = Extract<
  BacktestDatasetRecordV1,
  { recordType: "OPTION_CONTRACT" }
>
export type OptionBarRecordV1 = Extract<
  BacktestDatasetRecordV1,
  { recordType: "OPTION_BAR" }
>
export type OptionTradeRecordV1 = Extract<
  BacktestDatasetRecordV1,
  { recordType: "OPTION_TRADE" }
>
