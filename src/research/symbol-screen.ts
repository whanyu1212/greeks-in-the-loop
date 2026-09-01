import { z } from "zod"

import {
  RESEARCH_SHORTLIST_LIMIT,
  type OptionUniverseSnapshotV2,
} from "../contracts/option-universe-v2.js"
import { optionUnderlyingV1Schema } from "../shared/alpaca-option-identity.js"

export const SYMBOL_SCREEN_VERSION = "1.0.0" as const
export const SYMBOL_SCREEN_POLICY_VERSION = "1.0.0" as const
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
] as const

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
    screenVersion: z.literal(SYMBOL_SCREEN_VERSION),
    policyVersion: z.literal(SYMBOL_SCREEN_POLICY_VERSION),
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

/** Screens application-owned universe evidence without affecting proposal flow. */
export function screenOptionUniverseV1(
  universe: OptionUniverseSnapshotV2,
): SymbolScreenResultV1 {
  const results = universe.candidates.map((candidate) => {
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
    if (liquidityReasons.length > 0) {
      return {
        rank: candidate.rank,
        underlying: candidate.underlying,
        actionability: "REJECTED" as const,
        direction: "NEUTRAL" as const,
        reasonCodes: liquidityReasons,
        evidence,
      }
    }

    const move = candidate.sessionPercentChange
    if (move === undefined) {
      return {
        rank: candidate.rank,
        underlying: candidate.underlying,
        actionability: "WATCH" as const,
        direction: "NEUTRAL" as const,
        reasonCodes: ["SESSION_MOVE_UNAVAILABLE" as const],
        evidence,
      }
    }
    if (Math.abs(move) < SYMBOL_SCREEN_MIN_ABSOLUTE_MOVE_PERCENT) {
      return {
        rank: candidate.rank,
        underlying: candidate.underlying,
        actionability: "WATCH" as const,
        direction: "NEUTRAL" as const,
        reasonCodes: ["SESSION_MOVE_BELOW_THRESHOLD" as const],
        evidence,
      }
    }
    const bullish = move > 0
    return {
      rank: candidate.rank,
      underlying: candidate.underlying,
      actionability: "ACTIONABLE" as const,
      direction: bullish ? "BULLISH" as const : "BEARISH" as const,
      structure: bullish ? "BULL_CALL_SPREAD" as const : "BEAR_PUT_SPREAD" as const,
      reasonCodes: [],
      evidence,
    }
  })

  return symbolScreenResultV1Schema.parse({
    screenVersion: SYMBOL_SCREEN_VERSION,
    policyVersion: SYMBOL_SCREEN_POLICY_VERSION,
    mode: "SHADOW",
    evaluatedAt: universe.generatedAt,
    universeSnapshotId: universe.snapshotId,
    results,
  })
}
