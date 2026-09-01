import { z } from "zod"

import {
  ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
  alpacaOptionEntryLegV2Schema,
  alpacaOptionEntryPlanV2Schema,
} from "../options/alpaca-capabilities.js"
import {
  OPTION_STRATEGY_CATALOG,
  optionStrategySchema,
} from "../options/strategy.js"
import { optionUnderlyingV1Schema } from "../shared/alpaca-option-identity.js"
import {
  agentReportedEvidenceSchema,
  type ResearchDecisionValidationContext,
  type ResearchDecisionValidationIssue,
  NO_ACTION_REASON_CODES,
  proposalEvidenceClaimV3Schema,
  proposalQuoteSnapshotRef,
  researchDecisionSchemaIssuePath,
  researchDecisionValidationContextSchema,
  TRADE_PROPOSAL_LIMIT,
} from "./research-decision-v3.js"
import { safeSchemaDiagnostics } from "../shared/schema-diagnostics.js"

export const RESEARCH_DECISION_V4_CONTRACT_VERSION = "4.0.0" as const

const boundedText = z.string().trim().min(1).max(2_000)

export const researchCandidateV4Schema = z
  .object({
    underlying: optionUnderlyingV1Schema,
    strategy: optionStrategySchema,
    legs: z.array(alpacaOptionEntryLegV2Schema).min(1).max(4),
  })
  .strict()
  .superRefine((candidate, refinement) => {
    const plan = alpacaOptionEntryPlanV2Schema.safeParse({
      capabilityVersion: ALPACA_OPTION_ORDER_CAPABILITY_VERSION,
      ...candidate,
    })
    if (!plan.success) {
      refinement.addIssue({
        code: "custom",
        path: ["legs"],
        message: "Candidate legs do not match the declared Alpaca strategy",
      })
    }
  })

export const noActionDecisionV4Schema = z
  .object({
    contractVersion: z.literal(RESEARCH_DECISION_V4_CONTRACT_VERSION),
    outcome: z.literal("NO_ACTION"),
    reasonCodes: z
      .array(z.enum(NO_ACTION_REASON_CODES))
      .min(1)
      .max(NO_ACTION_REASON_CODES.length),
    evidence: agentReportedEvidenceSchema,
  })
  .strip()

export const tradeProposalV4Schema = z
  .object({
    priority: z.number().int().min(1).max(TRADE_PROPOSAL_LIMIT),
    direction: z.enum(["BULLISH", "BEARISH", "NEUTRAL", "VOLATILITY"]),
    thesis: boundedText,
    candidate: researchCandidateV4Schema,
    invalidation: z.array(boundedText).min(1).max(16),
    evidence: z.array(proposalEvidenceClaimV3Schema).min(1).max(64),
  })
  .strict()
  .superRefine((proposal, refinement) => {
    if (OPTION_STRATEGY_CATALOG[proposal.candidate.strategy].outlook !== proposal.direction) {
      refinement.addIssue({
        code: "custom",
        path: ["direction"],
        message: "Proposal direction must match the strategy outlook",
      })
    }
    if (!proposal.evidence.some(({ kind }) => kind === "SOURCED_FACT")) {
      refinement.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A trade proposal requires at least one sourced fact",
      })
    }
    const expectedSnapshotRef = proposalQuoteSnapshotRef(
      proposal.candidate.underlying,
    )
    proposal.evidence.forEach((claim, index) => {
      if (claim.kind === "SOURCED_FACT" && claim.snapshotRef !== expectedSnapshotRef) {
        refinement.addIssue({
          code: "custom",
          path: ["evidence", index, "snapshotRef"],
          message: "Proposal facts must use the candidate quote snapshot",
        })
      }
    })
  })

export const proposedPortfolioDecisionV4Schema = z
  .object({
    contractVersion: z.literal(RESEARCH_DECISION_V4_CONTRACT_VERSION),
    outcome: z.literal("PROPOSE_TRADES"),
    proposals: z.array(tradeProposalV4Schema).min(1).max(TRADE_PROPOSAL_LIMIT),
  })
  .strict()
  .superRefine((decision, refinement) => {
    const underlyings = new Set(
      decision.proposals.map(({ candidate }) => candidate.underlying),
    )
    if (underlyings.size !== decision.proposals.length) {
      refinement.addIssue({
        code: "custom",
        path: ["proposals"],
        message: "Portfolio proposals must use distinct underlyings",
      })
    }
    decision.proposals.forEach((proposal, index) => {
      if (proposal.priority !== index + 1) {
        refinement.addIssue({
          code: "custom",
          path: ["proposals", index, "priority"],
          message: "Portfolio proposals must use contiguous priority order",
        })
      }
    })
  })

export const researchDecisionV4Schema = z.discriminatedUnion("outcome", [
  noActionDecisionV4Schema,
  proposedPortfolioDecisionV4Schema,
])

export type ResearchDecisionV4 = z.infer<typeof researchDecisionV4Schema>
export type NoActionDecisionV4 = z.infer<typeof noActionDecisionV4Schema>
export type TradeProposalV4 = z.infer<typeof tradeProposalV4Schema>
export type ProposedPortfolioDecisionV4 = z.infer<
  typeof proposedPortfolioDecisionV4Schema
>

export type ResearchDecisionValidationResultV4 =
  | Readonly<{ success: true; data: ResearchDecisionV4 }>
  | Readonly<{
      success: false
      issues: readonly ResearchDecisionValidationIssue[]
    }>

/** Validates V4 proposal evidence against application-owned snapshot metadata. */
export function validateResearchDecisionV4(
  input: unknown,
  context: ResearchDecisionValidationContext,
): ResearchDecisionValidationResultV4 {
  const parsedContext = researchDecisionValidationContextSchema.safeParse(context)
  if (!parsedContext.success) {
    return {
      success: false,
      issues: parsedContext.error.issues.map(({ path }) => ({
        code: "CONTEXT_INVALID",
        path: researchDecisionSchemaIssuePath(path),
      })),
    }
  }
  const parsedDecision = researchDecisionV4Schema.safeParse(input)
  if (!parsedDecision.success) {
    return {
      success: false,
      issues: safeSchemaDiagnostics(parsedDecision.error.issues, input),
    }
  }
  if (parsedDecision.data.outcome === "NO_ACTION") {
    return { success: true, data: parsedDecision.data }
  }

  const issues: ResearchDecisionValidationIssue[] = []
  const evaluatedAt = Date.parse(parsedContext.data.evaluatedAt)
  parsedDecision.data.proposals.forEach((proposal, proposalIndex) => {
    const claims = new Map<string, "SOURCED_FACT" | "INFERENCE">()
    const evidencePath = ["proposals", proposalIndex, "evidence"] as const
    proposal.evidence.forEach((evidence, index) => {
      if (claims.has(evidence.claimId)) {
        issues.push({
          code: "DUPLICATE_CLAIM_ID",
          path: [...evidencePath, index, "claimId"],
        })
      } else claims.set(evidence.claimId, evidence.kind)
    })
    proposal.evidence.forEach((evidence, index) => {
      if (evidence.kind === "INFERENCE") {
        evidence.basedOn.forEach((claimId, referenceIndex) => {
          const kind = claims.get(claimId)
          if (kind === undefined) {
            issues.push({
              code: "UNKNOWN_INFERENCE_REFERENCE",
              path: [...evidencePath, index, "basedOn", referenceIndex],
            })
          } else if (kind !== "SOURCED_FACT") {
            issues.push({
              code: "INFERENCE_REFERENCE_NOT_FACT",
              path: [...evidencePath, index, "basedOn", referenceIndex],
            })
          }
        })
        return
      }
      const snapshot = Object.hasOwn(
          parsedContext.data.snapshots,
          evidence.snapshotRef,
        )
        ? parsedContext.data.snapshots[evidence.snapshotRef]
        : undefined
      if (snapshot === undefined) {
        issues.push({
          code: "UNKNOWN_SNAPSHOT",
          path: [...evidencePath, index, "snapshotRef"],
        })
      } else {
        if (Date.parse(snapshot.retrievedAt) > evaluatedAt) {
          issues.push({
            code: "SNAPSHOT_FROM_FUTURE",
            path: [...evidencePath, index, "snapshotRef"],
          })
        }
        if (Date.parse(snapshot.freshUntil) < evaluatedAt) {
          issues.push({
            code: "STALE_SNAPSHOT",
            path: [...evidencePath, index, "snapshotRef"],
          })
        }
      }
    })
  })
  return issues.length === 0
    ? { success: true, data: parsedDecision.data }
    : { success: false, issues }
}
