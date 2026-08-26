import { z } from "zod"

import { researchDecisionV1Schema } from "../contracts/research-decision-v1.js"
import { preliminaryResearchV1Schema } from "../contracts/preliminary-research-v1.js"
import { tradeIntentV1Schema } from "../contracts/trade-intent-v1.js"
import { researchReportV2Schema } from "../contracts/research-report-v2.js"
import { researchEligibilityV1Schema } from "../scheduling/research-eligibility.js"

export const LEDGER_EVENT_VERSION = "1.0.0" as const
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
      research: preliminaryResearchV1Schema,
    })
    .strict(),
  RESEARCH_REPORT_RECORDED: z
    .object({
      report: researchReportV2Schema,
    })
    .strict(),
  RESEARCH_DECISION_VALIDATED: z
    .object({
      decision: researchDecisionV1Schema,
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
            })
            .strict(),
        )
        .min(1)
        .max(64),
    })
    .strict(),
  TRADE_INTENT_DERIVED: z
    .object({
      intent: tradeIntentV1Schema,
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
