import { z } from "zod"

import {
  alpacaOptionStrikeCents,
  parseAlpacaOptionSymbol,
} from "../shared/alpaca-option-identity.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import {
  RISK_EVALUATION_VERSION,
  RISK_RULE_VERSION,
} from "../risk/risk-evaluation-v1.js"
import {
  DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
  DEBIT_VERTICAL_CANDIDATE_VERSION,
  DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
  DIRECTIONAL_TREND_FEATURE_VERSION,
} from "../strategy/directional-debit-vertical-v1.js"
import {
  researchSnapshotStrategyManifestV1Schema,
  type ResearchSnapshotStrategyManifestV1,
} from "../contracts/research-market-snapshot-v1.js"
import {
  BACKTEST_REPLAY_VERSION,
} from "./replay-identity.js"
import {
  backtestDatasetPartitionV1Schema,
  backtestDateSchema,
  backtestOptionBarStructuralSchema,
  backtestOptionContractStructuralSchema,
  backtestOptionSymbolChunks,
  backtestOptionChunkId,
  backtestOptionTradeStructuralSchema,
  backtestSha256Schema,
  backtestTimestampSchema,
  backtestUnderlyingBarStructuralSchema,
  backtestUnderlyingSymbolSchema,
} from "./dataset-v1.js"

export const BACKTEST_DATASET_DEFINITION_V2_VERSION = "2.0.0" as const

const optionHistoricalFeed = z.literal("ALPACA_ACCOUNT_DEFAULT")
const componentIdentitySchema = z
  .object({
    componentId: z.string().min(1).max(128),
    componentVersion: z.string().min(1).max(32),
  })
  .strict()
const replayComponentsSchema = z
  .object({
    featureCalculation: componentIdentitySchema,
    candidateGenerationRanking: componentIdentitySchema,
    riskRule: componentIdentitySchema.extend({
      evaluationVersion: z.string().min(1).max(32),
    }),
    exitPolicy: componentIdentitySchema,
  })
  .strict()
const optionSymbolArray = z
  .array(z.string())
  .max(10_000)
  .superRefine((symbols, refinement) => {
    for (let index = 0; index < symbols.length; index += 1) {
      const symbol = symbols[index]!
      const parsed = parseAlpacaOptionSymbol(symbol)
      if (!parsed.success) {
        refinement.addIssue({
          code: "custom",
          path: [index],
          message: "Dataset option symbol is invalid",
        })
      }
      if (index > 0 && symbols[index - 1]! >= symbol) {
        refinement.addIssue({
          code: "custom",
          path: [index],
          message: "Dataset option symbols must be unique and sorted",
        })
      }
    }
  })

const definitionContentSchema = z
  .object({
    definitionVersion: z.literal(BACKTEST_DATASET_DEFINITION_V2_VERSION),
    datasetVersion: z.string().min(1).max(32),
    normalizationVersion: z.string().min(1).max(32),
    strategyManifest: researchSnapshotStrategyManifestV1Schema,
    replayComponents: replayComponentsSchema,
    symbol: backtestUnderlyingSymbolSchema,
    fromDate: backtestDateSchema,
    toDate: backtestDateSchema,
    optionHistoricalFeed,
    optionSymbols: optionSymbolArray,
    requestStartedAt: backtestTimestampSchema,
  })
  .strict()
  .superRefine((definition, refinement) => {
    if (definition.fromDate > definition.toDate) {
      refinement.addIssue({
        code: "custom",
        path: ["toDate"],
        message: "Dataset end date cannot precede its start date",
      })
    }
    if (
      definition.symbol !== definition.strategyManifest.underlying ||
      definition.datasetVersion !==
        definition.strategyManifest.replayCompatibility.datasetVersion ||
      definition.normalizationVersion !==
        definition.strategyManifest.replayCompatibility.normalizationVersion
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["strategyManifest"],
        message: "Dataset identity does not match the strategy manifest",
      })
    }
    definition.optionSymbols.forEach((symbol, index) => {
      const parsed = parseAlpacaOptionSymbol(symbol)
      if (parsed.success && parsed.identity.root !== definition.symbol) {
        refinement.addIssue({
          code: "custom",
          path: ["optionSymbols", index],
          message: "Dataset option symbol does not match the underlying",
        })
      }
    })
  })

export type BacktestDatasetDefinitionV2Content = Readonly<
  z.infer<typeof definitionContentSchema>
>

const acquisitionIdentity = (
  content: BacktestDatasetDefinitionV2Content,
) => ({
  definitionVersion: content.definitionVersion,
  datasetVersion: content.datasetVersion,
  normalizationVersion: content.normalizationVersion,
  strategyManifest: content.strategyManifest,
  replayComponents: content.replayComponents,
  symbol: content.symbol,
  fromDate: content.fromDate,
  toDate: content.toDate,
  optionHistoricalFeed: content.optionHistoricalFeed,
  optionSymbols: content.optionSymbols,
})

export const computeBacktestDatasetIdV2 = (
  content: BacktestDatasetDefinitionV2Content,
) =>
  canonicalJsonSha256({
    domain: "backtest-dataset-definition-v2",
    acquisition: acquisitionIdentity(content),
  })

export const backtestDatasetDefinitionV2Schema = definitionContentSchema
  .extend({ datasetId: backtestSha256Schema })
  .strict()
  .superRefine((definition, refinement) => {
    const { datasetId: _datasetId, ...content } = definition
    if (definition.datasetId !== computeBacktestDatasetIdV2(content)) {
      refinement.addIssue({
        code: "custom",
        path: ["datasetId"],
        message: "Dataset ID does not match immutable acquisition identity",
      })
    }
  })

export type BacktestDatasetDefinitionV2 = Readonly<
  z.infer<typeof backtestDatasetDefinitionV2Schema>
>

export type CreateBacktestDatasetDefinitionV2Input = Readonly<{
  strategyManifest: ResearchSnapshotStrategyManifestV1
  fromDate: string
  toDate: string
  optionSymbols: readonly string[]
  requestStartedAt: string
}>

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
  return Object.freeze(value)
}

export function createBacktestDatasetDefinitionV2({
  strategyManifest,
  fromDate,
  toDate,
  optionSymbols,
  requestStartedAt,
}: CreateBacktestDatasetDefinitionV2Input): BacktestDatasetDefinitionV2 {
  const content = definitionContentSchema.parse({
    definitionVersion: BACKTEST_DATASET_DEFINITION_V2_VERSION,
    datasetVersion: strategyManifest.replayCompatibility.datasetVersion,
    normalizationVersion:
      strategyManifest.replayCompatibility.normalizationVersion,
    strategyManifest,
    replayComponents: {
      featureCalculation: {
        componentId: DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
        componentVersion: DIRECTIONAL_TREND_FEATURE_VERSION,
      },
      candidateGenerationRanking: {
        componentId: DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
        componentVersion: DEBIT_VERTICAL_CANDIDATE_VERSION,
      },
      riskRule: {
        componentId: "evaluateTradeIntentRiskV1",
        componentVersion: RISK_RULE_VERSION,
        evaluationVersion: RISK_EVALUATION_VERSION,
      },
      exitPolicy: {
        componentId: "runBacktestReplayV1",
        componentVersion: BACKTEST_REPLAY_VERSION,
      },
    },
    symbol: strategyManifest.underlying,
    fromDate,
    toDate,
    optionHistoricalFeed: "ALPACA_ACCOUNT_DEFAULT",
    optionSymbols: [...new Set(optionSymbols)].sort(),
    requestStartedAt,
  })
  return deepFreeze(
    backtestDatasetDefinitionV2Schema.parse({
      ...content,
      datasetId: computeBacktestDatasetIdV2(content),
    }),
  )
}

export const expectedBacktestPartitionKeysV2 = (
  definition: BacktestDatasetDefinitionV2,
) => [
  "calendar",
  "underlying-daily",
  "underlying-minute",
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

export const backtestDatasetRecordV2Schema = z.discriminatedUnion(
  "recordType",
  [
    z
      .object({
        recordType: z.literal("MARKET_SESSION"),
        date: backtestDateSchema,
        open: backtestTimestampSchema,
        close: backtestTimestampSchema,
      })
      .strict()
      .refine(
        ({ open, close }) => Date.parse(open) < Date.parse(close),
        {
          path: ["close"],
          message: "Market session close must follow its open",
        },
      ),
    backtestUnderlyingBarStructuralSchema,
    backtestOptionContractStructuralSchema,
    backtestOptionBarStructuralSchema,
    backtestOptionTradeStructuralSchema,
  ],
)

export type BacktestDatasetRecordV2 = Readonly<
  z.infer<typeof backtestDatasetRecordV2Schema>
>

const sortedIncludes = (
  values: readonly string[],
  target: string,
): boolean => {
  let low = 0
  let high = values.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const value = values[middle]!
    if (value === target) return true
    if (value < target) low = middle + 1
    else high = middle - 1
  }
  return false
}

export function parseBacktestDatasetRecordV2(
  definition: BacktestDatasetDefinitionV2,
  input: unknown,
): BacktestDatasetRecordV2 {
  const record = backtestDatasetRecordV2Schema.parse(input)
  if (
    record.recordType === "UNDERLYING_BAR" &&
    record.symbol !== definition.symbol
  ) {
    throw new Error("Backtest underlying record does not match the dataset")
  }
  if (
    record.recordType === "OPTION_CONTRACT" ||
    record.recordType === "OPTION_BAR" ||
    record.recordType === "OPTION_TRADE"
  ) {
    const parsed = parseAlpacaOptionSymbol(record.contractSymbol)
    if (!parsed.success || parsed.identity.root !== definition.symbol) {
      throw new Error("Backtest option record does not match the dataset")
    }
    if (
      (record.recordType === "OPTION_BAR" ||
        record.recordType === "OPTION_TRADE") &&
      !sortedIncludes(definition.optionSymbols, record.contractSymbol)
    ) {
      throw new Error("Backtest option record is outside the retained scope")
    }
    if (record.recordType === "OPTION_CONTRACT") {
      const strike = alpacaOptionStrikeCents(parsed.identity)
      if (
        !strike.success ||
        parsed.identity.expiration !== record.expirationDate ||
        (parsed.identity.optionType === "C" ? "CALL" : "PUT") !==
          record.optionType ||
        strike.strikeCentsPerShare !== record.strikeCentsPerShare
      ) {
        throw new Error("Backtest option contract identity is inconsistent")
      }
    }
  }
  return record
}

export const backtestDatasetManifestV2Schema = z
  .object({
    definition: backtestDatasetDefinitionV2Schema,
    partitions: z.array(backtestDatasetPartitionV1Schema),
    complete: z.boolean(),
    checksum: backtestSha256Schema,
    limitations: z.array(z.string().min(1).max(512)).max(32),
  })
  .strict()

export type BacktestDatasetManifestV2 = Readonly<
  z.infer<typeof backtestDatasetManifestV2Schema>
>
