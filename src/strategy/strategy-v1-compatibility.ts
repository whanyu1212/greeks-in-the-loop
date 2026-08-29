import {
  LEGACY_STRATEGY_VERSION,
  SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
  STRATEGY_VERSION,
  type StrategyVersion,
} from "./strategy-identity.js"

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

const legacyTradeIntentTiming = Object.freeze({
  startGraceMs: 2 * 60 * 1_000,
  windowDurationMs: 5 * 60 * 1_000,
})
const currentTradeIntentTiming = Object.freeze({
  startGraceMs: 5 * 60 * 1_000,
  windowDurationMs: 10 * 60 * 1_000,
})

const legacyCompatibility = Object.freeze({
  strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
  strategyVersion: LEGACY_STRATEGY_VERSION,
  availability: "DECODE_ONLY",
  tradeIntentTiming: legacyTradeIntentTiming,
  researchProvenance: "NOT_RECORDED",
} as const satisfies StrategyVersionCompatibility)
const currentCompatibility = Object.freeze({
  strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
  strategyVersion: STRATEGY_VERSION,
  availability: "RUNTIME_AND_DECODE",
  tradeIntentTiming: currentTradeIntentTiming,
  researchProvenance: "VERSIONED_INVOCATION",
} as const satisfies StrategyVersionCompatibility)

/** Frozen compatibility facts used to interpret persisted V1 strategy versions. */
export const V1_STRATEGY_COMPATIBILITY_BY_VERSION = Object.freeze({
  [LEGACY_STRATEGY_VERSION]: legacyCompatibility,
  [STRATEGY_VERSION]: currentCompatibility,
} as const satisfies Record<StrategyVersion, StrategyVersionCompatibility>)

export type V1StrategyCompatibilityResult =
  | Readonly<{
      success: true
      compatibility: StrategyVersionCompatibility
    }>
  | Readonly<{
      success: false
      reason: "STRATEGY_REFERENCE_INVALID" | "UNKNOWN_STRATEGY_VERSION"
    }>

/** Resolves the implicit sole strategy carried by historical V1 artifacts. */
export function resolveV1StrategyVersionCompatibility(
  strategyVersion: unknown,
): V1StrategyCompatibilityResult {
  if (typeof strategyVersion !== "string" || strategyVersion.length === 0) {
    return { success: false, reason: "STRATEGY_REFERENCE_INVALID" }
  }
  if (strategyVersion === LEGACY_STRATEGY_VERSION) {
    return { success: true, compatibility: legacyCompatibility }
  }
  if (strategyVersion === STRATEGY_VERSION) {
    return { success: true, compatibility: currentCompatibility }
  }
  return { success: false, reason: "UNKNOWN_STRATEGY_VERSION" }
}
