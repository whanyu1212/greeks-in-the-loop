import { z } from "zod"

import {
  BACKTEST_DATASET_VERSION,
  BACKTEST_NORMALIZATION_VERSION,
} from "../backtest/dataset-v1.js"
import {
  BACKTEST_EXECUTION_MODEL_VERSION,
  BACKTEST_REPLAY_VERSION,
} from "../backtest/replay-v1.js"
import { RESEARCH_DECISION_CONTRACT_VERSION } from "../contracts/research-decision-v1.js"
import { RESEARCH_REPORT_VERSION } from "../contracts/research-report-v2.js"
import { TRADE_INTENT_CONTRACT_VERSION } from "../contracts/trade-intent-v1.js"
import {
  RESEARCH_AGENT_NAME,
  RESEARCH_PROMPT_VERSION,
  RESEARCH_SKILL_NAME,
  RESEARCH_SKILL_VERSION,
} from "../research/research-agent.js"
import {
  RISK_EVALUATION_VERSION,
  RISK_RULE_VERSION,
} from "../risk/risk-evaluation-v1.js"
import {
  TRADE_INTENT_START_GRACE_MS,
  TRADE_INTENT_WINDOW_DURATION_MS,
} from "../scheduling/research-eligibility.js"
import { SPY_OPTION_UNIVERSE_POLICY_VERSION } from "../shared/alpaca-option-identity.js"
import {
  LEGACY_STRATEGY_VERSION,
  RUNTIME_STRATEGY_VERSIONS,
  SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
  STRATEGY_VERSION,
  SUPPORTED_STRATEGY_VERSIONS,
  type StrategyVersion,
} from "./strategy-identity.js"

export const STRATEGY_COMPONENT_MANIFEST_VERSION = "1.0.0" as const

const componentIdentitySchema = z
  .object({
    componentId: z.string().min(1).max(128),
    componentVersion: z.string().min(1).max(32),
  })
  .strict()

export const strategyComponentManifestV1Schema = z
  .object({
    manifestVersion: z.literal(STRATEGY_COMPONENT_MANIFEST_VERSION),
    strategyId: z.literal(SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID),
    strategyVersion: z.literal(STRATEGY_VERSION),
    underlying: z.literal("SPY"),
    components: z
      .object({
        universePolicy: componentIdentitySchema.extend({
          componentId: z.literal("validateSpyOptionUniverseV1"),
          componentVersion: z.literal(SPY_OPTION_UNIVERSE_POLICY_VERSION),
        }),
        featureCalculation: componentIdentitySchema.extend({
          componentId: z.literal(RESEARCH_SKILL_NAME),
          componentVersion: z.literal(RESEARCH_SKILL_VERSION),
          authority: z.literal("RESEARCH_SKILL_POLICY"),
        }),
        candidateGenerationRanking: componentIdentitySchema.extend({
          componentId: z.literal(RESEARCH_SKILL_NAME),
          componentVersion: z.literal(RESEARCH_SKILL_VERSION),
          authority: z.literal("RESEARCH_SKILL_POLICY"),
        }),
        intentDerivation: componentIdentitySchema.extend({
          componentId: z.literal("deriveTradeIntentV1"),
          componentVersion: z.literal(TRADE_INTENT_CONTRACT_VERSION),
        }),
        riskRule: componentIdentitySchema.extend({
          componentId: z.literal("evaluateTradeIntentRiskV1"),
          componentVersion: z.literal(RISK_RULE_VERSION),
          evaluationVersion: z.literal(RISK_EVALUATION_VERSION),
        }),
        exitPolicy: componentIdentitySchema.extend({
          componentId: z.literal("runBacktestReplayV1"),
          componentVersion: z.literal(BACKTEST_REPLAY_VERSION),
          availability: z.literal("REPLAY_ONLY"),
        }),
      })
      .strict(),
    researchPlanCompatibility: z
      .object({
        kind: z.literal("LEGACY_RESEARCH_INVOCATION_V1"),
        invocationVersion: z.literal("1.1.0"),
        agentName: z.literal(RESEARCH_AGENT_NAME),
        promptVersion: z.literal(RESEARCH_PROMPT_VERSION),
        skillName: z.literal(RESEARCH_SKILL_NAME),
        skillVersion: z.literal(RESEARCH_SKILL_VERSION),
        decisionContractVersion: z.literal(
          RESEARCH_DECISION_CONTRACT_VERSION,
        ),
        reportVersion: z.literal(RESEARCH_REPORT_VERSION),
      })
      .strict(),
    replayCompatibility: z
      .object({
        kind: z.literal("BACKTEST_REPLAY_V1"),
        replayVersion: z.literal(BACKTEST_REPLAY_VERSION),
        executionModelVersion: z.literal(BACKTEST_EXECUTION_MODEL_VERSION),
        datasetVersion: z.literal(BACKTEST_DATASET_VERSION),
        normalizationVersion: z.literal(BACKTEST_NORMALIZATION_VERSION),
      })
      .strict(),
  })
  .strict()

export type StrategyComponentManifestV1 = Readonly<
  z.infer<typeof strategyComponentManifestV1Schema>
>

export type StrategyVersionCompatibility = Readonly<{
  strategyId: typeof SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID
  strategyVersion: StrategyVersion
  availability: "DECODE_ONLY" | "RUNTIME_AND_DECODE"
  tradeIntentTiming: Readonly<{
    startGraceMs: number
    windowDurationMs: number
  }>
  researchProvenance: "NOT_RECORDED" | "VERSIONED_INVOCATION"
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

const currentManifest = deepFreeze(
  strategyComponentManifestV1Schema.parse({
    manifestVersion: STRATEGY_COMPONENT_MANIFEST_VERSION,
    strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    underlying: "SPY",
    components: {
      universePolicy: {
        componentId: "validateSpyOptionUniverseV1",
        componentVersion: SPY_OPTION_UNIVERSE_POLICY_VERSION,
      },
      featureCalculation: {
        componentId: RESEARCH_SKILL_NAME,
        componentVersion: RESEARCH_SKILL_VERSION,
        authority: "RESEARCH_SKILL_POLICY",
      },
      candidateGenerationRanking: {
        componentId: RESEARCH_SKILL_NAME,
        componentVersion: RESEARCH_SKILL_VERSION,
        authority: "RESEARCH_SKILL_POLICY",
      },
      intentDerivation: {
        componentId: "deriveTradeIntentV1",
        componentVersion: TRADE_INTENT_CONTRACT_VERSION,
      },
      riskRule: {
        componentId: "evaluateTradeIntentRiskV1",
        componentVersion: RISK_RULE_VERSION,
        evaluationVersion: RISK_EVALUATION_VERSION,
      },
      exitPolicy: {
        componentId: "runBacktestReplayV1",
        componentVersion: BACKTEST_REPLAY_VERSION,
        availability: "REPLAY_ONLY",
      },
    },
    researchPlanCompatibility: {
      kind: "LEGACY_RESEARCH_INVOCATION_V1",
      invocationVersion: "1.1.0",
      agentName: RESEARCH_AGENT_NAME,
      promptVersion: RESEARCH_PROMPT_VERSION,
      skillName: RESEARCH_SKILL_NAME,
      skillVersion: RESEARCH_SKILL_VERSION,
      decisionContractVersion: RESEARCH_DECISION_CONTRACT_VERSION,
      reportVersion: RESEARCH_REPORT_VERSION,
    },
    replayCompatibility: {
      kind: "BACKTEST_REPLAY_V1",
      replayVersion: BACKTEST_REPLAY_VERSION,
      executionModelVersion: BACKTEST_EXECUTION_MODEL_VERSION,
      datasetVersion: BACKTEST_DATASET_VERSION,
      normalizationVersion: BACKTEST_NORMALIZATION_VERSION,
    },
  }),
)

const compatibilityByVersion = deepFreeze({
  [LEGACY_STRATEGY_VERSION]: {
    strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
    strategyVersion: LEGACY_STRATEGY_VERSION,
    availability: "DECODE_ONLY",
    tradeIntentTiming: {
      startGraceMs: 2 * 60 * 1_000,
      windowDurationMs: 5 * 60 * 1_000,
    },
    researchProvenance: "NOT_RECORDED",
  },
  [STRATEGY_VERSION]: {
    strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    availability: "RUNTIME_AND_DECODE",
    tradeIntentTiming: {
      startGraceMs: TRADE_INTENT_START_GRACE_MS,
      windowDurationMs: TRADE_INTENT_WINDOW_DURATION_MS,
    },
    researchProvenance: "VERSIONED_INVOCATION",
  },
} as const satisfies Record<StrategyVersion, StrategyVersionCompatibility>)

/** One compile-time registry. It contains identity data and no executable hooks. */
export const STATIC_STRATEGY_REGISTRY = deepFreeze({
  [SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID]: {
    currentVersion: STRATEGY_VERSION,
    decodableVersions: SUPPORTED_STRATEGY_VERSIONS,
    runtimeVersions: RUNTIME_STRATEGY_VERSIONS,
    manifests: {
      [STRATEGY_VERSION]: currentManifest,
    },
    compatibilityByVersion,
  },
} as const)

export const CURRENT_STRATEGY_MANIFEST =
  STATIC_STRATEGY_REGISTRY[SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID]
    .manifests[STRATEGY_VERSION]

export const STRATEGY_RESOLUTION_FAILURE_CODES = [
  "STRATEGY_REFERENCE_INVALID",
  "UNKNOWN_STRATEGY_ID",
  "UNKNOWN_STRATEGY_VERSION",
  "STRATEGY_VERSION_NOT_RUNTIME_SUPPORTED",
  "COMPONENT_MANIFEST_INCOMPATIBLE",
] as const
export type StrategyResolutionFailureCode =
  (typeof STRATEGY_RESOLUTION_FAILURE_CODES)[number]

export type StrategyResolutionResult =
  | Readonly<{
      success: true
      manifest: StrategyComponentManifestV1
    }>
  | Readonly<{
      success: false
      reason: StrategyResolutionFailureCode
    }>

const strategyReferenceSchema = z
  .object({
    strategyId: z.string().min(1).max(128),
    strategyVersion: z.string().min(1).max(32),
  })
  .strict()
const strategyManifestHeaderSchema = strategyReferenceSchema.passthrough()

const unknownReferenceReason = (
  strategyId: string,
  strategyVersion: string,
): StrategyResolutionFailureCode | undefined => {
  if (strategyId !== SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID) {
    return "UNKNOWN_STRATEGY_ID"
  }
  if (!(SUPPORTED_STRATEGY_VERSIONS as readonly string[]).includes(
    strategyVersion,
  )) {
    return "UNKNOWN_STRATEGY_VERSION"
  }
  return undefined
}

export function resolveStrategyManifest(input: unknown): StrategyResolutionResult {
  const reference = strategyReferenceSchema.safeParse(input)
  if (!reference.success) {
    return { success: false, reason: "STRATEGY_REFERENCE_INVALID" }
  }
  const unknownReason = unknownReferenceReason(
    reference.data.strategyId,
    reference.data.strategyVersion,
  )
  if (unknownReason !== undefined) {
    return { success: false, reason: unknownReason }
  }
  if (reference.data.strategyVersion !== STRATEGY_VERSION) {
    return {
      success: false,
      reason: "STRATEGY_VERSION_NOT_RUNTIME_SUPPORTED",
    }
  }
  return { success: true, manifest: CURRENT_STRATEGY_MANIFEST }
}

export type StrategyCompatibilityResult =
  | Readonly<{
      success: true
      compatibility: StrategyVersionCompatibility
    }>
  | Readonly<{
      success: false
      reason: StrategyResolutionFailureCode
    }>

export function resolveStrategyVersionCompatibility(
  input: unknown,
): StrategyCompatibilityResult {
  const reference = strategyReferenceSchema.safeParse(input)
  if (!reference.success) {
    return { success: false, reason: "STRATEGY_REFERENCE_INVALID" }
  }
  const unknownReason = unknownReferenceReason(
    reference.data.strategyId,
    reference.data.strategyVersion,
  )
  if (unknownReason !== undefined) {
    return { success: false, reason: unknownReason }
  }
  const version = reference.data.strategyVersion as StrategyVersion
  return {
    success: true,
    compatibility: compatibilityByVersion[version],
  }
}

/** Resolves the implicit sole strategy carried by historical V1 artifacts. */
export function resolveV1StrategyVersionCompatibility(
  strategyVersion: unknown,
): StrategyCompatibilityResult {
  return resolveStrategyVersionCompatibility({
    strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
    strategyVersion,
  })
}

export function checkStrategyManifestCompatibility(
  input: unknown,
): StrategyResolutionResult {
  const header = strategyManifestHeaderSchema.safeParse(input)
  if (!header.success) {
    return { success: false, reason: "STRATEGY_REFERENCE_INVALID" }
  }
  const resolved = resolveStrategyManifest({
    strategyId: header.data.strategyId,
    strategyVersion: header.data.strategyVersion,
  })
  if (!resolved.success) return resolved
  if (!strategyComponentManifestV1Schema.safeParse(input).success) {
    return { success: false, reason: "COMPONENT_MANIFEST_INCOMPATIBLE" }
  }
  return resolved
}
