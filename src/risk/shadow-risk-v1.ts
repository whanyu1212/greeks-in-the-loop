import { z } from "zod"

import { tradeIntentV1Schema } from "../contracts/trade-intent-v1.js"
import { RISK_STATE_CAPTURE_FAILURE_CODES } from "./alpaca-risk-state-provider.js"
import {
  RISK_EVALUATION_VERSION,
  RISK_RULE_VERSION,
  riskEvaluationV1Schema,
} from "./risk-evaluation-v1.js"
import {
  DURABLE_RISK_CONTROL_STATE_VERSION,
  RISK_RECONCILIATION_REASON_CODES,
} from "./risk-state-v1.js"

export const SHADOW_RISK_DECISION_VERSION = "1.0.0" as const

const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const derivationReason = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/u)

export const shadowRiskStateProvenanceV1Schema = z
  .object({
    capturedAt: timestamp,
    accountObservedAt: timestamp,
    portfolioObservedAt: timestamp,
    contractsObservedAt: timestamp,
    quoteSnapshot: z
      .object({
        provider: z.literal("ALPACA"),
        source: z.string().trim().min(1).max(128),
        retrievedAt: timestamp,
        freshUntil: timestamp,
      })
      .strict(),
    reconciliationReasonCodes: z
      .array(z.enum(RISK_RECONCILIATION_REASON_CODES))
      .max(RISK_RECONCILIATION_REASON_CODES.length),
  })
  .strict()

const commonDecisionFields = {
  decisionVersion: z.literal(SHADOW_RISK_DECISION_VERSION),
  mode: z.literal("SHADOW"),
  evaluationVersion: z.literal(RISK_EVALUATION_VERSION),
  ruleVersion: z.literal(RISK_RULE_VERSION),
} as const

export const shadowRiskDecisionV1Schema = z.discriminatedUnion("stage", [
  z
    .object({
      ...commonDecisionFields,
      stage: z.literal("STATE_CAPTURE_FAILED"),
      outcome: z.literal("REJECTED"),
      evaluatedAt: z.null(),
      captureReasonCodes: z
        .array(z.enum(RISK_STATE_CAPTURE_FAILURE_CODES))
        .min(1)
        .max(RISK_STATE_CAPTURE_FAILURE_CODES.length),
    })
    .strict(),
  z
    .object({
      ...commonDecisionFields,
      stage: z.literal("INTENT_REFRESH_FAILED"),
      outcome: z.literal("REJECTED"),
      evaluatedAt: timestamp,
      derivationReasonCodes: z.array(derivationReason).min(1).max(64),
      stateProvenance: shadowRiskStateProvenanceV1Schema,
    })
    .strict(),
  z
    .object({
      ...commonDecisionFields,
      stage: z.literal("EVALUATED"),
      outcome: z.enum(["APPROVED", "REJECTED"]),
      evaluatedIntent: tradeIntentV1Schema,
      stateProvenance: shadowRiskStateProvenanceV1Schema,
      evaluation: riskEvaluationV1Schema,
    })
    .strict()
    .superRefine((decision, refinement) => {
      if (decision.outcome !== decision.evaluation.outcome) {
        refinement.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "Shadow outcome must match its risk evaluation",
        })
      }
      if (
        decision.evaluationVersion !== decision.evaluation.evaluationVersion ||
        decision.ruleVersion !== decision.evaluation.ruleVersion
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["evaluation"],
          message: "Shadow versions must match the risk evaluation",
        })
      }
    }),
])

export const riskBreakerTransitionV1Schema = z
  .object({
    stateVersion: z.literal(DURABLE_RISK_CONTROL_STATE_VERSION),
    tradingDate: z.iso.date(),
    observedAt: timestamp,
    breaker: z.enum(["DAILY", "COMPETITION"]),
  })
  .strict()

export type ShadowRiskStateProvenanceV1 = Readonly<
  z.infer<typeof shadowRiskStateProvenanceV1Schema>
>
export type ShadowRiskDecisionV1 = Readonly<
  z.infer<typeof shadowRiskDecisionV1Schema>
>
export type RiskBreakerTransitionV1 = Readonly<
  z.infer<typeof riskBreakerTransitionV1Schema>
>
export type ShadowRiskResultV1 = Readonly<{
  decision: ShadowRiskDecisionV1
  breakerTransitions: readonly RiskBreakerTransitionV1[]
}>
