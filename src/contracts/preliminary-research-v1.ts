import { z } from "zod"

import {
  researchCandidateV1Schema,
  STRATEGY_VERSION,
} from "./research-decision-v1.js"

export const PRELIMINARY_RESEARCH_CONTRACT_VERSION = "1.0.0" as const
export const MARKET_OBSERVATION_TEMPORAL_CLASSES = [
  "LIVE",
  "DELAYED",
  "PRIOR_CLOSE",
] as const

const boundedText = z.string().trim().min(1).max(1_000)
const boundedClaim = z.string().trim().min(1).max(500)
const boundedIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const timestamp = z.iso.datetime({ offset: true, precision: 3 })

const preliminarySourcedFactSchema = z
  .object({
    claimId: boundedIdentifier,
    kind: z.literal("SOURCED_FACT"),
    claim: boundedClaim,
    provider: z.enum(["ALPACA", "FMP", "EXA"]),
    temporalClass: z.enum(MARKET_OBSERVATION_TEMPORAL_CLASSES),
    observedAt: timestamp,
    locator: z.string().trim().min(1).max(512).optional(),
  })
  .strict()

const preliminaryInferenceSchema = z
  .object({
    claimId: boundedIdentifier,
    kind: z.literal("INFERENCE"),
    claim: boundedClaim,
    basedOn: z.array(boundedIdentifier).min(1).max(16),
  })
  .strict()

export const preliminaryResearchV1Schema = z
  .object({
    contractVersion: z.literal(PRELIMINARY_RESEARCH_CONTRACT_VERSION),
    strategyVersion: z.literal(STRATEGY_VERSION),
    outcome: z.literal("PRELIMINARY_RESEARCH"),
    targetSessionDate: z.iso.date(),
    direction: z.enum(["BULLISH", "BEARISH", "UNDETERMINED"]),
    thesis: boundedText,
    candidate: researchCandidateV1Schema.optional(),
    invalidation: z.array(boundedClaim).min(1).max(8),
    evidence: z
      .array(
        z.discriminatedUnion("kind", [
          preliminarySourcedFactSchema,
          preliminaryInferenceSchema,
        ]),
      )
      .min(1)
      .max(16),
    requiresRefresh: z.literal(true),
  })
  .strict()
  .superRefine((research, refinement) => {
    if (
      research.direction === "UNDETERMINED" &&
      research.candidate !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "An undetermined direction cannot identify a candidate",
      })
    }
    if (research.candidate !== undefined && research.direction !== "UNDETERMINED") {
      const expectedStructure =
        research.direction === "BULLISH" ? "BULL_CALL_SPREAD" : "BEAR_PUT_SPREAD"
      if (research.candidate.structure !== expectedStructure) {
        refinement.addIssue({
          code: "custom",
          path: ["candidate", "structure"],
          message: "The preliminary candidate does not match its direction",
        })
      }
    }

    const claimKinds = new Map<string, "SOURCED_FACT" | "INFERENCE">()
    research.evidence.forEach((claim, index) => {
      if (claimKinds.has(claim.claimId)) {
        refinement.addIssue({
          code: "custom",
          path: ["evidence", index, "claimId"],
          message: "Preliminary claim identifiers must be unique",
        })
      } else {
        claimKinds.set(claim.claimId, claim.kind)
      }
    })

    research.evidence.forEach((claim, index) => {
      if (claim.kind !== "INFERENCE") return
      claim.basedOn.forEach((claimId, referenceIndex) => {
        if (claimKinds.get(claimId) !== "SOURCED_FACT") {
          refinement.addIssue({
            code: "custom",
            path: ["evidence", index, "basedOn", referenceIndex],
            message: "Preliminary inferences must reference sourced facts",
          })
        }
      })
    })
  })

export type PreliminaryResearchV1 = Readonly<
  z.infer<typeof preliminaryResearchV1Schema>
>
