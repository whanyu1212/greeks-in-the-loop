import { z } from "zod"

import {
  RESEARCH_SHORTLIST_LIMIT,
  type OptionUniverseSnapshotV2,
} from "../contracts/option-universe-v2.js"
import {
  OPTION_STRATEGIES,
  optionStrategySchema,
  type OptionStrategy,
} from "../options/strategy.js"
import { optionUnderlyingV1Schema } from "../shared/alpaca-option-identity.js"

const LEGACY_SYMBOL_SCREEN_VERSION = "1.0.0" as const
const LEGACY_SYMBOL_SCREEN_POLICY_VERSION = "1.0.0" as const
export const SYMBOL_SCREEN_VERSION = "2.0.0" as const
export const SYMBOL_SCREEN_POLICY_VERSION = "2.0.0" as const
export const SYMBOL_SCREEN_MIN_ABSOLUTE_MOVE_PERCENT = 0.5
export const SYMBOL_SCREEN_MIN_LIQUID_CONTRACTS = 4
export const SYMBOL_SCREEN_MIN_OPEN_INTEREST = 1_000
export const SYMBOL_SCREEN_MIN_OPEN_INTEREST_COVERAGE = 0.8

export const SYMBOL_SCREEN_REASON_CODES = [
  "OPTION_LIQUIDITY_UNAVAILABLE",
  "LIQUID_CONTRACT_COUNT_LOW",
  "OPEN_INTEREST_LOW",
  "OPEN_INTEREST_COVERAGE_LOW",
  "SESSION_MOVE_UNAVAILABLE",
  "SESSION_MOVE_BELOW_THRESHOLD",
  "DIRECTION_MISMATCH",
  "APPLICATION_SUPPORT_PENDING",
] as const
export type SymbolScreenReasonCode =
  (typeof SYMBOL_SCREEN_REASON_CODES)[number]

const symbolScreenReasonCodeSchema = z.enum(SYMBOL_SCREEN_REASON_CODES)

const symbolScreenEntrySchema = z
  .object({
    rank: z.number().int().positive().max(RESEARCH_SHORTLIST_LIMIT),
    underlying: optionUnderlyingV1Schema,
    actionability: z.enum(["ACTIONABLE", "WATCH", "REJECTED"]),
    direction: z.enum(["BULLISH", "BEARISH", "NEUTRAL"]),
    structure: z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]).optional(),
    reasonCodes: z.array(symbolScreenReasonCodeSchema).max(
      SYMBOL_SCREEN_REASON_CODES.length,
    ),
    evidence: z
      .object({
        activityRank: z.number().int().positive().max(100).optional(),
        sessionPercentChange: z.number().finite().optional(),
        liquidContractCount: z.number().int().nonnegative().optional(),
        totalOpenInterest: z.number().int().nonnegative().optional(),
        openInterestCoverage: z.number().finite().min(0).max(1).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((entry, refinement) => {
    const expectedStructure = entry.direction === "BULLISH"
      ? "BULL_CALL_SPREAD"
      : entry.direction === "BEARISH"
        ? "BEAR_PUT_SPREAD"
        : undefined
    if (
      entry.actionability === "ACTIONABLE" &&
      (expectedStructure === undefined ||
        entry.structure !== expectedStructure ||
        entry.reasonCodes.length > 0)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["structure"],
        message: "Actionable symbols require a directional debit spread",
      })
    }
    if (
      entry.actionability !== "ACTIONABLE" &&
      (entry.direction !== "NEUTRAL" ||
        entry.structure !== undefined ||
        entry.reasonCodes.length === 0)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["structure"],
        message: "Non-actionable symbols cannot advertise an eligible structure",
      })
    }
  })

export const symbolScreenResultV1Schema = z
  .object({
    screenVersion: z.literal(LEGACY_SYMBOL_SCREEN_VERSION),
    policyVersion: z.literal(LEGACY_SYMBOL_SCREEN_POLICY_VERSION),
    mode: z.literal("SHADOW"),
    evaluatedAt: z.iso.datetime({ offset: true, precision: 3 }),
    universeSnapshotId: z.string().regex(/^option-universe-v2-[a-f0-9]{64}$/u),
    results: z.array(symbolScreenEntrySchema).max(RESEARCH_SHORTLIST_LIMIT),
  })
  .strict()
  .superRefine((screen, refinement) => {
    if (
      new Set(screen.results.map(({ underlying }) => underlying)).size !==
        screen.results.length ||
      screen.results.some(({ rank }, index) => rank !== index + 1)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["results"],
        message: "Screen results must retain unique universe rank order",
      })
    }
  })

export type SymbolScreenEntryV1 = Readonly<z.infer<typeof symbolScreenEntrySchema>>
export type SymbolScreenResultV1 = Readonly<
  Omit<z.infer<typeof symbolScreenResultV1Schema>, "results"> & {
    results: readonly SymbolScreenEntryV1[]
  }
>

const strategyAssessmentV2Schema = z
  .object({
    strategy: optionStrategySchema,
    actionability: z.enum(["ACTIONABLE", "WATCH", "REJECTED", "UNAVAILABLE"]),
    reasonCodes: z.array(symbolScreenReasonCodeSchema).min(0).max(
      SYMBOL_SCREEN_REASON_CODES.length,
    ),
  })
  .strict()
  .superRefine((assessment, refinement) => {
    if (
      assessment.actionability === "ACTIONABLE" &&
      assessment.reasonCodes.length > 0
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "Actionable strategies cannot retain rejection reasons",
      })
    }
    if (
      assessment.actionability !== "ACTIONABLE" &&
      assessment.reasonCodes.length === 0
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "Non-actionable strategies require a bounded reason",
      })
    }
  })

const symbolScreenEntryV2Schema = z
  .object({
    rank: z.number().int().positive().max(RESEARCH_SHORTLIST_LIMIT),
    underlying: optionUnderlyingV1Schema,
    evidence: z
      .object({
        activityRank: z.number().int().positive().max(100).optional(),
        sessionPercentChange: z.number().finite().optional(),
        liquidContractCount: z.number().int().nonnegative().optional(),
        totalOpenInterest: z.number().int().nonnegative().optional(),
        openInterestCoverage: z.number().finite().min(0).max(1).optional(),
      })
      .strict(),
    strategies: z.array(strategyAssessmentV2Schema).length(
      OPTION_STRATEGIES.length,
    ),
  })
  .strict()
  .superRefine((entry, refinement) => {
    if (
      entry.strategies.some(
        ({ strategy }, index) => strategy !== OPTION_STRATEGIES[index],
      )
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["strategies"],
        message: "Strategy assessments must follow the complete catalog order",
      })
    }
  })

export const symbolScreenResultV2Schema = z
  .object({
    screenVersion: z.literal(SYMBOL_SCREEN_VERSION),
    policyVersion: z.literal(SYMBOL_SCREEN_POLICY_VERSION),
    mode: z.literal("SHADOW"),
    evaluatedAt: z.iso.datetime({ offset: true, precision: 3 }),
    universeSnapshotId: z.string().regex(/^option-universe-v2-[a-f0-9]{64}$/u),
    symbols: z.array(symbolScreenEntryV2Schema).max(RESEARCH_SHORTLIST_LIMIT),
  })
  .strict()
  .superRefine((screen, refinement) => {
    if (
      new Set(screen.symbols.map(({ underlying }) => underlying)).size !==
        screen.symbols.length ||
      screen.symbols.some(({ rank }, index) => rank !== index + 1)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["symbols"],
        message: "Screen symbols must retain unique universe rank order",
      })
    }
  })

export type SymbolStrategyAssessmentV2 = Readonly<
  z.infer<typeof strategyAssessmentV2Schema>
>
export type SymbolScreenEntryV2 = Readonly<
  Omit<z.infer<typeof symbolScreenEntryV2Schema>, "strategies"> & {
    strategies: readonly SymbolStrategyAssessmentV2[]
  }
>
export type SymbolScreenResultV2 = Readonly<
  Omit<z.infer<typeof symbolScreenResultV2Schema>, "symbols"> & {
    symbols: readonly SymbolScreenEntryV2[]
  }
>

/** Builds the lookup view without creating a second persisted source of truth. */
export function indexSymbolStrategyScreenV2(
  screen: SymbolScreenResultV2,
): ReadonlyMap<string, ReadonlyMap<OptionStrategy, SymbolStrategyAssessmentV2>> {
  return new Map(screen.symbols.map((symbol) => [
    symbol.underlying,
    new Map(symbol.strategies.map((assessment) => [
      assessment.strategy,
      assessment,
    ])),
  ]))
}

/** Locates the application-owned screen reason a proposal is not actionable. */
export function strategyActionabilityIssuePathV2(
  screen: SymbolScreenResultV2,
  underlying: string,
  strategy: OptionStrategy,
): readonly (string | number)[] | undefined {
  const symbolIndex = screen.symbols.findIndex(
    (entry) => entry.underlying === underlying,
  )
  if (symbolIndex < 0) return ["symbolScreen", "symbols"]
  const strategyIndex = screen.symbols[symbolIndex]!.strategies.findIndex(
    (assessment) => assessment.strategy === strategy,
  )
  const assessment = screen.symbols[symbolIndex]!.strategies[strategyIndex]
  return assessment?.actionability === "ACTIONABLE"
    ? undefined
    : strategyIndex < 0
      ? ["symbolScreen", "symbols", symbolIndex, "strategies"]
      : [
          "symbolScreen",
          "symbols",
          symbolIndex,
          "strategies",
          strategyIndex,
          "actionability",
        ]
}

const CURRENT_SCREEN_STRATEGIES = new Set<OptionStrategy>([
  "BULL_CALL_SPREAD",
  "BEAR_PUT_SPREAD",
])

const pendingAssessment = (strategy: OptionStrategy) => ({
  strategy,
  actionability: "UNAVAILABLE" as const,
  reasonCodes: ["APPLICATION_SUPPORT_PENDING" as const],
})

const assessedStrategy = (
  strategy: OptionStrategy,
  liquidityReasons: readonly SymbolScreenReasonCode[],
  move: number | undefined,
): SymbolStrategyAssessmentV2 => {
  if (!CURRENT_SCREEN_STRATEGIES.has(strategy)) return pendingAssessment(strategy)
  if (liquidityReasons.length > 0) {
    return { strategy, actionability: "REJECTED", reasonCodes: [...liquidityReasons] }
  }
  if (move === undefined) {
    return {
      strategy,
      actionability: "WATCH",
      reasonCodes: ["SESSION_MOVE_UNAVAILABLE"],
    }
  }
  if (Math.abs(move) < SYMBOL_SCREEN_MIN_ABSOLUTE_MOVE_PERCENT) {
    return {
      strategy,
      actionability: "WATCH",
      reasonCodes: ["SESSION_MOVE_BELOW_THRESHOLD"],
    }
  }
  const matchesDirection = move > 0
    ? strategy === "BULL_CALL_SPREAD"
    : strategy === "BEAR_PUT_SPREAD"
  return matchesDirection
    ? { strategy, actionability: "ACTIONABLE", reasonCodes: [] }
    : { strategy, actionability: "REJECTED", reasonCodes: ["DIRECTION_MISMATCH"] }
}

/** Screens application-owned universe evidence without affecting proposal flow. */
export function screenOptionUniverseV2(
  universe: OptionUniverseSnapshotV2,
): SymbolScreenResultV2 {
  const symbols = universe.candidates.map((candidate) => {
    const liquidity = candidate.optionLiquidity
    const evidence = {
      ...(candidate.activityRank === undefined
        ? {}
        : { activityRank: candidate.activityRank }),
      ...(candidate.sessionPercentChange === undefined
        ? {}
        : { sessionPercentChange: candidate.sessionPercentChange }),
      ...(liquidity === undefined
        ? {}
        : {
            liquidContractCount: liquidity.liquidContractCount,
            totalOpenInterest: liquidity.totalOpenInterest,
            openInterestCoverage: liquidity.openInterestCoverage,
          }),
    }
    const liquidityReasons = liquidity === undefined
      ? ["OPTION_LIQUIDITY_UNAVAILABLE" as const]
      : [
          ...(liquidity.liquidContractCount <
            SYMBOL_SCREEN_MIN_LIQUID_CONTRACTS
            ? ["LIQUID_CONTRACT_COUNT_LOW" as const]
            : []),
          ...(liquidity.totalOpenInterest < SYMBOL_SCREEN_MIN_OPEN_INTEREST
            ? ["OPEN_INTEREST_LOW" as const]
            : []),
          ...(liquidity.openInterestCoverage <
            SYMBOL_SCREEN_MIN_OPEN_INTEREST_COVERAGE
            ? ["OPEN_INTEREST_COVERAGE_LOW" as const]
            : []),
        ]
    return {
      rank: candidate.rank,
      underlying: candidate.underlying,
      evidence,
      strategies: OPTION_STRATEGIES.map((strategy) =>
        assessedStrategy(
          strategy,
          liquidityReasons,
          candidate.sessionPercentChange,
        )
      ),
    }
  })

  return symbolScreenResultV2Schema.parse({
    screenVersion: SYMBOL_SCREEN_VERSION,
    policyVersion: SYMBOL_SCREEN_POLICY_VERSION,
    mode: "SHADOW",
    evaluatedAt: universe.generatedAt,
    universeSnapshotId: universe.snapshotId,
    symbols,
  })
}
