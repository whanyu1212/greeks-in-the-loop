import {
  backtestDatasetDefinitionV1Schema,
  backtestDatasetManifestV1Schema,
  backtestDatasetRecordV1Schema,
  expectedBacktestPartitionKeys as expectedBacktestPartitionKeysV1,
  type BacktestDatasetDefinitionV1,
  type BacktestDatasetManifestV1,
  type BacktestDatasetRecordV1,
} from "./dataset-v1.js"
import {
  BACKTEST_DATASET_DEFINITION_V2_VERSION,
  backtestDatasetDefinitionV2Schema,
  backtestDatasetManifestV2Schema,
  expectedBacktestPartitionKeysV2,
  parseBacktestDatasetRecordV2,
  type BacktestDatasetDefinitionV2,
  type BacktestDatasetManifestV2,
  type BacktestDatasetRecordV2,
} from "./dataset-v2.js"

export type BacktestDatasetDefinition =
  | BacktestDatasetDefinitionV1
  | BacktestDatasetDefinitionV2

export type BacktestDatasetManifest =
  | BacktestDatasetManifestV1
  | BacktestDatasetManifestV2

export type BacktestDatasetRecord =
  | BacktestDatasetRecordV1
  | BacktestDatasetRecordV2

export type MarketSessionRecord = Extract<
  BacktestDatasetRecord,
  { recordType: "MARKET_SESSION" }
>
export type UnderlyingBarRecord = Extract<
  BacktestDatasetRecord,
  { recordType: "UNDERLYING_BAR" }
>
export type OptionContractRecord = Extract<
  BacktestDatasetRecord,
  { recordType: "OPTION_CONTRACT" }
>
export type OptionBarRecord = Extract<
  BacktestDatasetRecord,
  { recordType: "OPTION_BAR" }
>
export type OptionTradeRecord = Extract<
  BacktestDatasetRecord,
  { recordType: "OPTION_TRADE" }
>

export const isBacktestDatasetDefinitionV2 = (
  definition: BacktestDatasetDefinition,
): definition is BacktestDatasetDefinitionV2 =>
  "definitionVersion" in definition

export function decodeBacktestDatasetDefinition(
  input: unknown,
): BacktestDatasetDefinition {
  if (
    input !== null &&
    typeof input === "object" &&
    "definitionVersion" in input
  ) {
    const version = (input as { definitionVersion?: unknown }).definitionVersion
    if (version !== BACKTEST_DATASET_DEFINITION_V2_VERSION) {
      throw new Error("Backtest dataset definition version is unsupported")
    }
    return backtestDatasetDefinitionV2Schema.parse(input)
  }
  return backtestDatasetDefinitionV1Schema.parse(input)
}

export function decodeBacktestDatasetManifest(
  input: unknown,
): BacktestDatasetManifest {
  if (
    input !== null &&
    typeof input === "object" &&
    "definition" in input &&
    (input as { definition?: unknown }).definition !== null &&
    typeof (input as { definition?: unknown }).definition === "object" &&
    "definitionVersion" in
      ((input as { definition: object }).definition)
  ) {
    return backtestDatasetManifestV2Schema.parse(input)
  }
  return backtestDatasetManifestV1Schema.parse(input)
}

export const expectedBacktestPartitionKeys = (
  definition: BacktestDatasetDefinition,
) =>
  isBacktestDatasetDefinitionV2(definition)
    ? expectedBacktestPartitionKeysV2(definition)
    : expectedBacktestPartitionKeysV1(definition)

export function parseBacktestDatasetRecord(
  definition: BacktestDatasetDefinition,
  input: unknown,
): BacktestDatasetRecord {
  return isBacktestDatasetDefinitionV2(definition)
    ? parseBacktestDatasetRecordV2(definition, input)
    : backtestDatasetRecordV1Schema.parse(input)
}

export const backtestRecordKey = (record: BacktestDatasetRecord): string => {
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
