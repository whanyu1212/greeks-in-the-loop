import { z } from "zod"

import {
  agentReportedEvidenceSchema,
  researchCandidateV2Schema,
  researchDecisionV2Schema,
} from "../contracts/research-decision-v2.js"
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
import {
  orderFilledPayloadV1Schema,
  orderRejectedPayloadV1Schema,
  orderSubmittedPayloadV1Schema,
} from "../execution/order-submission-v1.js"

export const LEGACY_LEDGER_EVENT_VERSION = "1.0.0" as const
export const LEDGER_EVENT_VERSION = "2.0.0" as const
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
  "ORDER_SUBMITTED",
  "ORDER_FILLED",
  "ORDER_REJECTED",
] as const

export const STORED_LEDGER_EVENT_TYPES = [
  ...LEDGER_EVENT_TYPES,
  "RESEARCH_SCREENING_AUDIT_RECORDED",
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
  ORDER_SUBMITTED: orderSubmittedPayloadV1Schema,
  ORDER_FILLED: orderFilledPayloadV1Schema,
  ORDER_REJECTED: orderRejectedPayloadV1Schema,
} as const

const legacyVersion = z.string().trim().min(1).max(32)
const legacyInvocationSchema = z
  .object({
    invocationVersion: z.enum(["1.0.0", "1.1.0", "1.2.0", "1.3.0"]),
  })
  .passthrough()
const legacyResearchEligibilitySchema = z
  .object({
    evaluatedAt: timestamp,
    sessionDate: z.iso.date().optional(),
    sessionOpen: timestamp.optional(),
    sessionClose: timestamp.optional(),
    researchEligible: z.boolean(),
    tradeIntentEligible: z.boolean(),
    tradeIntentWindow: z
      .object({
        slotStartedAt: timestamp,
        deadline: timestamp,
      })
      .strict()
      .optional(),
    previousSessionDates: z.array(z.iso.date()).max(16).optional(),
    researchMode: z
      .enum(["DRY_RUN_ANYTIME", "DRY_RUN_SHADOW_ANYTIME"])
      .optional(),
    reason: z
      .enum([
        "NO_MARKET_SESSION",
        "OUTSIDE_RESEARCH_WINDOW",
        "OUTSIDE_TRADE_INTENT_WINDOW",
        "DRY_RUN_RESEARCH_ONLY",
      ])
      .optional(),
  })
  .strict()
const legacyCandidateBearingDecisionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      contractVersion: z.literal("1.0.0"),
      strategyVersion: legacyVersion,
      outcome: z.literal("NO_ACTION"),
      reasonCodes: z.array(boundedCode).min(1).max(64),
    })
    .passthrough(),
  z
    .object({
      contractVersion: z.literal("1.0.0"),
      strategyVersion: legacyVersion,
      outcome: z.literal("PROPOSE_TRADE"),
      direction: z.enum(["BULLISH", "BEARISH"]),
      candidate: researchCandidateV2Schema,
    })
    .passthrough(),
])
const legacyShadowDecisionSchema = z.discriminatedUnion("stage", [
  z
    .object({
      decisionVersion: z.literal("1.0.0"),
      mode: z.literal("SHADOW"),
      evaluationVersion: z.literal("1.0.0"),
      ruleVersion: z.literal("1.0.0"),
      stage: z.literal("STATE_CAPTURE_FAILED"),
      outcome: z.literal("REJECTED"),
      evaluatedAt: z.null(),
      captureReasonCodes: z.array(boundedCode).min(1).max(64),
    })
    .passthrough(),
  z
    .object({
      decisionVersion: z.literal("1.0.0"),
      mode: z.literal("SHADOW"),
      evaluationVersion: z.literal("1.0.0"),
      ruleVersion: z.literal("1.0.0"),
      stage: z.literal("INTENT_REFRESH_FAILED"),
      outcome: z.literal("REJECTED"),
      evaluatedAt: timestamp,
      derivationReasonCodes: z.array(boundedCode).min(1).max(64),
    })
    .passthrough(),
  z
    .object({
      decisionVersion: z.literal("1.0.0"),
      mode: z.literal("SHADOW"),
      evaluationVersion: z.literal("1.0.0"),
      ruleVersion: z.literal("1.0.0"),
      stage: z.literal("EVALUATED"),
      outcome: z.enum(["APPROVED", "REJECTED"]),
      evaluation: z.discriminatedUnion("outcome", [
        z
          .object({
            outcome: z.literal("APPROVED"),
            evaluatedAt: timestamp,
          })
          .passthrough(),
        z
          .object({
            outcome: z.literal("REJECTED"),
            evaluatedAt: timestamp.nullable(),
            reasonCodes: z.array(boundedCode).min(1).max(64),
          })
          .passthrough(),
      ]),
    })
    .passthrough(),
])
const legacyPayloadSchemas = {
  ...payloadSchemas,
  RESEARCH_CYCLE_STARTED: z
    .object({
      cycleNumber: z.number().int().positive(),
      sessionDate: z.iso.date().optional(),
      initialEligibility: legacyResearchEligibilitySchema.optional(),
    })
    .strict()
    .superRefine((payload, refinement) => {
      if (
        (payload.sessionDate === undefined) !==
          (payload.initialEligibility === undefined) ||
        (payload.initialEligibility !== undefined &&
          (payload.initialEligibility.sessionDate !== payload.sessionDate ||
            !payload.initialEligibility.researchEligible))
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["initialEligibility"],
          message: "Cycle eligibility must match its eligible session",
        })
      }
    }),
  PRELIMINARY_RESEARCH_RECORDED: z
    .object({
      research: z
        .object({
          contractVersion: z.literal("1.0.0"),
          strategyVersion: legacyVersion,
          outcome: z.literal("PRELIMINARY_RESEARCH"),
          targetSessionDate: z.iso.date(),
          direction: z.enum(["BULLISH", "BEARISH", "UNDETERMINED"]),
          candidate: researchCandidateV2Schema.optional(),
          evidence: agentReportedEvidenceSchema,
        })
        .passthrough(),
    })
    .strict(),
  RESEARCH_REPORT_RECORDED: z
    .object({
      report: z
        .object({ reportVersion: z.literal("2.0.0") })
        .passthrough(),
    })
    .strict(),
  RESEARCH_DECISION_VALIDATED: z
    .object({ decision: legacyCandidateBearingDecisionSchema })
    .strict(),
  TRADE_INTENT_DERIVED: z
    .object({
      intent: z
        .object({ contractVersion: z.literal("1.0.0") })
        .passthrough(),
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
      researchInvocation: legacyInvocationSchema.optional(),
    })
    .strict(),
  RESEARCH_SCREENING_AUDIT_RECORDED: z
    .object({ audit: z.record(z.string(), z.unknown()) })
    .strict(),
  RESEARCH_INVOCATION_IDENTITY_REJECTED: z
    .object({
      invocationVersion: z.enum(["1.0.0", "1.1.0", "1.2.0", "1.3.0"]),
      reason: z.enum(RESEARCH_MODEL_DRIFT_CODES),
      expected: identifier,
      observed: identifier,
    })
    .strict(),
  RISK_SHADOW_DECISION_RECORDED: z
    .object({ decision: legacyShadowDecisionSchema })
    .strict(),
} as const

type PayloadSchemas = Record<string, z.ZodType>
type EventType<Schemas extends PayloadSchemas> = Extract<keyof Schemas, string>

const baseEventShape = {
  eventId: identifier,
  occurredAt: timestamp,
  correlationId: identifier,
  causationEventId: identifier.optional(),
  cycleId: identifier.optional(),
  sessionId: identifier.optional(),
}
const baseEventSchema = z.object(baseEventShape)

type LedgerEventEnvelope = z.infer<typeof baseEventSchema>
type VersionedLedgerEvent<
  Version extends string,
  Schemas extends PayloadSchemas,
> = {
  [T in EventType<Schemas>]: LedgerEventEnvelope & {
    eventVersion: Version
    eventType: T
    payload: z.infer<Schemas[T]>
  }
}[EventType<Schemas>]

const createEventSchemas = (
  schemas: PayloadSchemas,
  eventVersion: typeof LEGACY_LEDGER_EVENT_VERSION | typeof LEDGER_EVENT_VERSION,
) => Object.entries(schemas).map(([eventType, payload]) =>
  z
    .object({
      ...baseEventShape,
      eventVersion: z.literal(eventVersion),
      eventType: z.literal(eventType),
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

export type LedgerEventV1 = VersionedLedgerEvent<
  typeof LEGACY_LEDGER_EVENT_VERSION,
  typeof legacyPayloadSchemas
>
export type LedgerEventV2 = VersionedLedgerEvent<
  typeof LEDGER_EVENT_VERSION,
  typeof payloadSchemas
>
export type LedgerEvent = LedgerEventV1 | LedgerEventV2

const legacyEventSchemas = createEventSchemas(
  legacyPayloadSchemas,
  LEGACY_LEDGER_EVENT_VERSION,
)
const eventSchemas = createEventSchemas(payloadSchemas, LEDGER_EVENT_VERSION)

export const ledgerEventV1Schema = z.union(
  legacyEventSchemas as [
    (typeof legacyEventSchemas)[number],
    (typeof legacyEventSchemas)[number],
    ...(typeof legacyEventSchemas)[number][],
  ],
) as z.ZodType<LedgerEventV1>
export const ledgerEventV2Schema = z.union(
  eventSchemas as [
    (typeof eventSchemas)[number],
    (typeof eventSchemas)[number],
    ...(typeof eventSchemas)[number][],
  ],
) as z.ZodType<LedgerEventV2>
export const ledgerEventSchema = z.union([
  ledgerEventV1Schema,
  ledgerEventV2Schema,
]) as z.ZodType<LedgerEvent>

type Stored<Event extends LedgerEvent> = Event extends LedgerEvent ? Event & {
  sequence: number
  recordedAt: string
} : never

export type StoredLedgerEventV1 = Stored<LedgerEventV1>
export type StoredLedgerEventV2 = Stored<LedgerEventV2>
export type StoredLedgerEvent = StoredLedgerEventV1 | StoredLedgerEventV2
