import { z } from "zod"

export const STRATEGY_IDS = ["spy-directional-debit-vertical"] as const
export type StrategyId = (typeof STRATEGY_IDS)[number]

export const SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID =
  STRATEGY_IDS[0]

export const LEGACY_STRATEGY_VERSION = "1.0.0" as const
export const STRATEGY_VERSION = "1.1.0" as const

/** Versions retained by frozen V1 decoders. This is not a runtime allowlist. */
export const SUPPORTED_STRATEGY_VERSIONS = [
  LEGACY_STRATEGY_VERSION,
  STRATEGY_VERSION,
] as const
export type StrategyVersion = (typeof SUPPORTED_STRATEGY_VERSIONS)[number]

/** Versions that may produce new runtime decisions. */
export const RUNTIME_STRATEGY_VERSIONS = [STRATEGY_VERSION] as const
export type RuntimeStrategyVersion =
  (typeof RUNTIME_STRATEGY_VERSIONS)[number]

export const strategyVersionSchema = z.enum(SUPPORTED_STRATEGY_VERSIONS)
