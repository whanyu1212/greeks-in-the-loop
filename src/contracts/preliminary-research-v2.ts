import { z } from "zod"

import {
  agentReportedEvidenceSchema,
  researchCandidateV2Schema,
} from "./research-decision-v2.js"

export const PRELIMINARY_RESEARCH_CONTRACT_VERSION = "2.0.0" as const
const boundedText = z.string().trim().min(1).max(1_000)
const boundedClaim = z.string().trim().min(1).max(500)

export const preliminaryResearchV2Schema = z
  .object({
    contractVersion: z.literal(PRELIMINARY_RESEARCH_CONTRACT_VERSION),
    outcome: z.literal("PRELIMINARY_RESEARCH"),
    targetSessionDate: z.iso.date(),
    direction: z.enum(["BULLISH", "BEARISH", "UNDETERMINED"]),
    thesis: boundedText,
    candidate: researchCandidateV2Schema.optional(),
    invalidation: z.array(boundedClaim).min(1).max(8),
    evidence: agentReportedEvidenceSchema,
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
  })

export type PreliminaryResearchV2 = Readonly<
  z.infer<typeof preliminaryResearchV2Schema>
>
