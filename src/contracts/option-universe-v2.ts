import { z } from "zod"

import { optionUnderlyingV1Schema } from "../shared/alpaca-option-identity.js"

export const OPTION_UNIVERSE_POLICY_VERSION = "5.0.0" as const
export const OPTION_UNIVERSE_SNAPSHOT_VERSION = "2.0.0" as const
export const DISCOVERY_POOL_LIMIT = 100
export const RESEARCH_SHORTLIST_LIMIT = 8

const positiveRank = z.number().int().positive()

export const optionUniverseLiquidityV1Schema = z
  .object({
    expirationCount: z.number().int().positive(),
    viableSeriesCount: z.number().int().positive(),
    liquidSeriesCount: z.number().int().positive(),
    contractCount: z.number().int().positive(),
    liquidContractCount: z.number().int().min(2),
    totalOpenInterest: z.number().int().nonnegative(),
    openInterestCoverage: z.number().finite().min(0).max(1),
  })
  .strict()

export const optionUniverseCandidateV2Schema = z
  .object({
    rank: positiveRank.max(RESEARCH_SHORTLIST_LIMIT),
    underlying: optionUnderlyingV1Schema,
    activityRank: positiveRank.max(100).optional(),
    sessionPercentChange: z.number().finite().min(-100).max(10_000).optional(),
    /** Application-computed chain evidence used before the shortlist is chosen. */
    optionLiquidity: optionUniverseLiquidityV1Schema.optional(),
  })
  .strict()

export const optionUniverseSnapshotV2Schema = z
  .object({
    snapshotVersion: z.literal(OPTION_UNIVERSE_SNAPSHOT_VERSION),
    policyVersion: z.literal(OPTION_UNIVERSE_POLICY_VERSION),
    snapshotId: z.string().regex(/^option-universe-v2-[a-f0-9]{64}$/u),
    generatedAt: z.iso.datetime({ offset: true, precision: 3 }),
    sessionDate: z.iso.date(),
    source: z.literal("ALPACA_OPTIONS_SCREENERS"),
    candidates: z.array(optionUniverseCandidateV2Schema).max(RESEARCH_SHORTLIST_LIMIT),
  })
  .strict()
  .superRefine((snapshot, refinement) => {
    const symbols = new Set(snapshot.candidates.map(({ underlying }) => underlying))
    if (symbols.size !== snapshot.candidates.length) {
      refinement.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Option-universe candidates must be unique",
      })
    }
    snapshot.candidates.forEach((candidate, index) => {
      if (candidate.rank !== index + 1) {
        refinement.addIssue({
          code: "custom",
          path: ["candidates", index, "rank"],
          message: "Option-universe candidates must be rank ordered",
        })
      }
    })
  })

export type OptionUniverseCandidateV2 = Readonly<
  z.infer<typeof optionUniverseCandidateV2Schema>
>
export type OptionUniverseSnapshotV2 = Readonly<
  Omit<z.infer<typeof optionUniverseSnapshotV2Schema>, "candidates"> & {
    candidates: readonly OptionUniverseCandidateV2[]
  }
>
