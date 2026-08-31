import { z } from "zod"

import { researchDecisionV2Schema } from "../contracts/research-decision-v2.js"
import { preliminaryResearchV2Schema } from "../contracts/preliminary-research-v2.js"
import { tradeIntentV2Schema } from "../contracts/trade-intent-v2.js"
import { researchReportV3Schema } from "../contracts/research-report-v3.js"
import { researchEligibilityV1Schema } from "../scheduling/research-eligibility.js"
import {
  RESEARCH_MODEL_DRIFT_CODES,
  researchInvocationV1Schema,
  SUPPORTED_RESEARCH_INVOCATION_VERSIONS,
} from "../research/research-invocation-v1.js"
import { SCHEMA_VIOLATION_CATEGORIES } from "../shared/schema-diagnostics.js"
import {
  riskBreakerTransitionV1Schema,
  shadowRiskDecisionV1Schema,
} from "../risk/shadow-risk-v1.js"

export const LEDGER_EVENT_VERSION = "1.0.0" as const
export const RESEARCH_LOOP_BREAKER_STATE_VERSION = "1.0.0" as const
export const MAX_LEDGER_EVENT_PAYLOAD_BYTES = 64 * 1024

export const LEDGER_EVENT_TYPES = [
  "OPENCODE_SESSION_STARTED",
  "RESEARCH_CYCLE_STARTED",
  "EVIDENCE_SNAPSHOT_REFERENCED",
  "PRELIMINARY_RESEARCH_RECORDED",
  "RESEARCH_REPORT_RECORDED",
  "RESEARCH_DECISION_VALIDATED",
  "RESEARCH_DECISION_REJECTED",
  "TRADE_INTENT_DERIVED",
  "TRADE_INTENT_DERIVATION_REJECTED",
  "RESEARCH_CYCLE_COMPLETED",
  "RESEARCH_CYCLE_INTERRUPTED",
  "RESEARCH_INVOCATION_IDENTITY_REJECTED",
  "RESEARCH_LOOP_BREAKER_LATCHED",
  "RESEARCH_LOOP_BREAKER_RESET",
  "RISK_SHADOW_DECISION_RECORDED",
  "RISK_BREAKER_LATCHED",
] as const

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const boundedCode = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/u)
const issuePath = z.array(z.union([z.string().max(128), z.number().int().nonnegative()])).max(32)
const positiveSafeInteger = z.number().int().positive().safe()

const payloadSchemas = {
  OPENCODE_SESSION_STARTED: z
    .object({
      sessionId: identifier,
    })
    .strict(),
  RESEARCH_CYCLE_STARTED: z
    .object({
      cycleNumber: z.number().int().positive(),
      sessionDate: z.iso.date().optional(),
      initialEligibility: researchEligibilityV1Schema.optional(),
    })
    .strict()
    .superRefine((payload, refinement) => {
      if (
        (payload.sessionDate === undefined) !==
        (payload.initialEligibility === undefined)
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["initialEligibility"],
          message: "Cycle context must be recorded together",
        })
      }
      if (
        payload.initialEligibility !== undefined &&
        (payload.initialEligibility.sessionDate !== payload.sessionDate ||
          !payload.initialEligibility.researchEligible)
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["initialEligibility"],
          message: "Cycle eligibility must match its eligible session",
        })
      }
    }),
  EVIDENCE_SNAPSHOT_REFERENCED: z
    .object({
      snapshotRef: identifier,
      provider: z.enum(["ALPACA", "FMP", "EXA"]),
      source: z.string().trim().min(1).max(128),
      retrievedAt: timestamp,
      freshUntil: timestamp,
      temporalClass: z.enum(["LIVE", "DELAYED", "PRIOR_CLOSE"]).optional(),
    })
    .strict()
    .refine(
      ({ retrievedAt, freshUntil }) =>
        Date.parse(freshUntil) >= Date.parse(retrievedAt),
      {
        path: ["freshUntil"],
        message: "Snapshot freshness cannot end before retrieval",
      },
    ),
  PRELIMINARY_RESEARCH_RECORDED: z
    .object({
      research: preliminaryResearchV2Schema,
    })
    .strict(),
  RESEARCH_REPORT_RECORDED: z
    .object({
      report: researchReportV3Schema,
    })
    .strict(),
  RESEARCH_DECISION_VALIDATED: z
    .object({
      decision: researchDecisionV2Schema,
    })
    .strict(),
  RESEARCH_DECISION_REJECTED: z
    .object({
      issues: z
        .array(
          z
            .object({
              code: boundedCode,
              path: issuePath,
              schemaCategory: z.enum(SCHEMA_VIOLATION_CATEGORIES).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(64),
    })
    .strict(),
  TRADE_INTENT_DERIVED: z
    .object({
      intent: tradeIntentV2Schema,
    })
    .strict(),
  TRADE_INTENT_DERIVATION_REJECTED: z
    .object({
      reasons: z.array(boundedCode).min(1).max(64),
    })
    .strict(),
  RESEARCH_CYCLE_COMPLETED: z
    .object({
      status: z.enum([
        "VALIDATED_NO_ACTION",
        "PRELIMINARY_RESEARCH_RETAINED",
        "DECISION_REJECTED",
        "INTENT_DERIVATION_REJECTED",
        "INTENT_DERIVED",
      ]),
      researchInvocation: researchInvocationV1Schema.optional(),
    })
    .strict(),
  RESEARCH_CYCLE_INTERRUPTED: z
    .object({
      reason: z.enum([
        "TIMEOUT",
        "CANCELLED",
        "SHUTDOWN",
        "PROCESS_RESTART",
        "FAILED",
      ]),
    })
    .strict(),
  RESEARCH_INVOCATION_IDENTITY_REJECTED: z
    .object({
      invocationVersion: z.enum(SUPPORTED_RESEARCH_INVOCATION_VERSIONS),
      reason: z.enum(RESEARCH_MODEL_DRIFT_CODES),
      expected: identifier,
      observed: identifier,
    })
    .strict(),
  RESEARCH_LOOP_BREAKER_LATCHED: z
    .object({
      stateVersion: z.literal(RESEARCH_LOOP_BREAKER_STATE_VERSION),
      reason: z.literal("CONSECUTIVE_FAILURE_LIMIT"),
      consecutiveFailures: positiveSafeInteger,
      threshold: positiveSafeInteger,
      lastAttempt: positiveSafeInteger,
    })
    .strict()
    .refine(
      ({ consecutiveFailures, threshold }) => consecutiveFailures >= threshold,
      {
        path: ["consecutiveFailures"],
        message: "Latched failure count must reach its threshold",
      },
    ),
  RESEARCH_LOOP_BREAKER_RESET: z
    .object({
      stateVersion: z.literal(RESEARCH_LOOP_BREAKER_STATE_VERSION),
      reason: z.literal("OPERATOR_REQUESTED"),
    })
    .strict(),
  RISK_SHADOW_DECISION_RECORDED: z
    .object({
      decision: shadowRiskDecisionV1Schema,
    })
    .strict(),
  RISK_BREAKER_LATCHED: riskBreakerTransitionV1Schema,
} as const

type EventType = keyof typeof payloadSchemas

const baseEventShape = {
  eventId: identifier,
  eventVersion: z.literal(LEDGER_EVENT_VERSION),
  occurredAt: timestamp,
  correlationId: identifier,
  causationEventId: identifier.optional(),
  cycleId: identifier.optional(),
  sessionId: identifier.optional(),
}
const baseEventSchema = z.object(baseEventShape)

type LedgerEventEnvelopeV1 = z.infer<typeof baseEventSchema>

export type LedgerEventV1 = {
  [T in EventType]: LedgerEventEnvelopeV1 & {
    eventType: T
    payload: z.infer<(typeof payloadSchemas)[T]>
  }
}[EventType]

const eventSchemas = Object.entries(payloadSchemas).map(([eventType, payload]) =>
  z
    .object({
      ...baseEventShape,
      eventType: z.literal(eventType as EventType),
      payload,
    })
    .strict()
    .superRefine((event, refinement) => {
      if (event.causationEventId === event.eventId) {
        refinement.addIssue({
          code: "custom",
          path: ["causationEventId"],
          message: "An event cannot cause itself",
        })
      }

      if (eventType === "OPENCODE_SESSION_STARTED") {
        const payloadSessionId = (
          event.payload as { sessionId?: unknown }
        ).sessionId
        if (
          event.sessionId === undefined ||
          payloadSessionId !== event.sessionId
        ) {
          refinement.addIssue({
            code: "custom",
            path: ["sessionId"],
            message: "Session-start identity must match its payload",
          })
        }
        return
      }

      if (
        eventType === "RESEARCH_LOOP_BREAKER_LATCHED" ||
        eventType === "RESEARCH_LOOP_BREAKER_RESET"
      ) {
        if (
          event.cycleId !== undefined ||
          event.sessionId !== undefined ||
          event.causationEventId !== undefined
        ) {
          refinement.addIssue({
            code: "custom",
            path: ["cycleId"],
            message: "Research-loop breaker events are cycleless",
          })
        }
        return
      }

      if (event.cycleId === undefined) {
        refinement.addIssue({
          code: "custom",
          path: ["cycleId"],
          message: "Research events require a cycle identity",
        })
      }
    }),
)

export const ledgerEventV1Schema = z.union(
  eventSchemas as [
    (typeof eventSchemas)[number],
    (typeof eventSchemas)[number],
    ...(typeof eventSchemas)[number][],
  ],
) as z.ZodType<LedgerEventV1>

export type StoredLedgerEventV1 = LedgerEventV1 & {
  sequence: number
  recordedAt: string
}
