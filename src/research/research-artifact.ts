import { mkdir, open } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import type { PreliminaryResearchV1 } from "../contracts/preliminary-research-v1.js"
import type { ResearchDecisionV1 } from "../contracts/research-decision-v1.js"
import type { ResearchReportV2 } from "../contracts/research-report-v2.js"
import type { TradeIntentV1 } from "../contracts/trade-intent-v1.js"
import type { StoredLedgerEventV1 } from "../event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../event-ledger/ledger-store.js"
import type { SchemaViolationCategory } from "../shared/schema-diagnostics.js"
import type {
  RiskBreakerTransitionV1,
  ShadowRiskDecisionV1,
} from "../risk/shadow-risk-v1.js"
import {
  newYorkDate,
  type ResearchEligibilityV1,
} from "../scheduling/research-eligibility.js"
import type { ResearchInvocationV1 } from "./research-invocation-v1.js"

export const LEGACY_RESEARCH_RUN_VERSION = "1.0.0" as const
export const SHADOW_RESEARCH_RUN_VERSION = "1.1.0" as const
export const RESEARCH_RUN_VERSION = "1.2.0" as const
export const SUPPORTED_RESEARCH_RUN_VERSIONS = [
  LEGACY_RESEARCH_RUN_VERSION,
  SHADOW_RESEARCH_RUN_VERSION,
  RESEARCH_RUN_VERSION,
] as const
export const DEFAULT_RESEARCH_ARTIFACT_ROOT = "workspace/research" as const

type RejectionIssue = Readonly<{
  code: string
  path: readonly (string | number)[]
  schemaCategory?: SchemaViolationCategory
}>

export type ResearchRunOutcomeV1 =
  | Readonly<{
      outcomeVersion: "1.0.0"
      status: "PRELIMINARY_RESEARCH_RETAINED"
      research: PreliminaryResearchV1
    }>
  | Readonly<{
      outcomeVersion: "1.0.0"
      status: "VALIDATED_NO_ACTION"
      decision: Extract<ResearchDecisionV1, { outcome: "NO_ACTION" }>
    }>
  | Readonly<{
      outcomeVersion: "1.0.0"
      status: "DECISION_REJECTED"
      issues: readonly RejectionIssue[]
    }>
  | Readonly<{
      outcomeVersion: "1.0.0"
      status: "INTENT_DERIVATION_REJECTED"
      reasons: readonly string[]
    }>
  | Readonly<{
      outcomeVersion: "1.0.0"
      status: "INTENT_DERIVED"
      decision: Extract<ResearchDecisionV1, { outcome: "PROPOSE_TRADE" }>
      intent: TradeIntentV1
    }>

export type ResearchRunV1 = Readonly<{
  runVersion: (typeof SUPPORTED_RESEARCH_RUN_VERSIONS)[number]
  cycle: Readonly<{
    cycleId: string
    cycleNumber: number
    correlationId: string
    sessionId: string
    startedAt: string
    completedAt: string
    sessionDate: string
  }>
  initialEligibility?: ResearchEligibilityV1
  researchInvocation?: ResearchInvocationV1
  evidenceSnapshots: readonly Readonly<{
    snapshotRef: string
    provider: "ALPACA" | "FMP" | "EXA"
    source: string
    retrievedAt: string
    freshUntil: string
    temporalClass?: "LIVE" | "DELAYED" | "PRIOR_CLOSE" | undefined
  }>[]
  preliminaryResearch?: PreliminaryResearchV1
  researchReport?: ResearchReportV2
  validatedDecision?: ResearchDecisionV1
  shadowRisk?: Readonly<{
    decision: ShadowRiskDecisionV1
    breakerTransitions: readonly RiskBreakerTransitionV1[]
  }>
  outcome: ResearchRunOutcomeV1
  ledger: Readonly<{
    firstSequence: number
    lastSequence: number
    terminalEventId: string
  }>
}>

const one = <T>(values: readonly T[], label: string): T => {
  if (values.length !== 1) {
    throw new Error(`Research run requires exactly one ${label} event`)
  }
  return values[0]!
}

const optionalOne = <T>(values: readonly T[], label: string): T | undefined => {
  if (values.length > 1) {
    throw new Error(`Research run cannot contain multiple ${label} events`)
  }
  return values[0]
}

/** Rebuilds the complete bounded research run from its authoritative events. */
export function projectResearchRunV1(
  inputEvents: readonly StoredLedgerEventV1[],
): ResearchRunV1 {
  if (inputEvents.length === 0) throw new Error("Research cycle was not found")
  const events = [...inputEvents].sort((left, right) => left.sequence - right.sequence)
  const start = one(
    events.filter((event) => event.eventType === "RESEARCH_CYCLE_STARTED"),
    "cycle-start",
  )
  const completed = one(
    events.filter((event) => event.eventType === "RESEARCH_CYCLE_COMPLETED"),
    "cycle-completion",
  )
  if (events.some((event) => event.eventType === "RESEARCH_CYCLE_INTERRUPTED")) {
    throw new Error("Interrupted research cycles cannot be exported as completed runs")
  }
  if (events.at(-1)?.eventId !== completed.eventId) {
    throw new Error("Research cycle completion must be its final event")
  }
  for (const event of events) {
    if (
      event.cycleId !== start.cycleId ||
      event.correlationId !== start.correlationId ||
      event.sessionId !== start.sessionId
    ) {
      throw new Error("Research run contains inconsistent event identities")
    }
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.causationEventId !== events[index - 1]!.eventId) {
      throw new Error("Research run event causation chain is incomplete")
    }
  }

  const preliminaryEvent = optionalOne(
    events.filter((event) => event.eventType === "PRELIMINARY_RESEARCH_RECORDED"),
    "preliminary-research",
  )
  const reportEvent = optionalOne(
    events.filter((event) => event.eventType === "RESEARCH_REPORT_RECORDED"),
    "research-report",
  )
  const decisionEvent = optionalOne(
    events.filter((event) => event.eventType === "RESEARCH_DECISION_VALIDATED"),
    "validated-decision",
  )
  const decisionRejectionEvent = optionalOne(
    events.filter((event) => event.eventType === "RESEARCH_DECISION_REJECTED"),
    "decision-rejection",
  )
  const derivationRejectionEvent = optionalOne(
    events.filter(
      (event) => event.eventType === "TRADE_INTENT_DERIVATION_REJECTED",
    ),
    "intent-derivation-rejection",
  )
  const intentEvent = optionalOne(
    events.filter((event) => event.eventType === "TRADE_INTENT_DERIVED"),
    "trade-intent",
  )
  const riskEvent = optionalOne(
    events.filter(
      (event) => event.eventType === "RISK_SHADOW_DECISION_RECORDED",
    ),
    "shadow-risk-decision",
  )
  const breakerEvents = events.filter(
    (event) => event.eventType === "RISK_BREAKER_LATCHED",
  )
  if (riskEvent === undefined && breakerEvents.length > 0) {
    throw new Error("Breaker transitions require a shadow-risk decision")
  }

  let outcome: ResearchRunOutcomeV1
  switch (completed.payload.status) {
    case "PRELIMINARY_RESEARCH_RETAINED":
      if (preliminaryEvent === undefined) throw new Error("Retained preliminary research is missing")
      outcome = { outcomeVersion: "1.0.0", status: completed.payload.status, research: preliminaryEvent.payload.research }
      break
    case "VALIDATED_NO_ACTION":
      if (decisionEvent?.payload.decision.outcome !== "NO_ACTION") throw new Error("Validated no-action decision is missing")
      outcome = { outcomeVersion: "1.0.0", status: completed.payload.status, decision: decisionEvent.payload.decision }
      break
    case "DECISION_REJECTED":
      if (decisionRejectionEvent === undefined) throw new Error("Decision rejection details are missing")
      outcome = {
        outcomeVersion: "1.0.0",
        status: completed.payload.status,
        issues: decisionRejectionEvent.payload.issues.map((issue) => ({
          code: issue.code,
          path: issue.path,
          ...(issue.schemaCategory === undefined
            ? {}
            : { schemaCategory: issue.schemaCategory }),
        })),
      }
      break
    case "INTENT_DERIVATION_REJECTED":
      if (derivationRejectionEvent === undefined) throw new Error("Intent derivation rejection details are missing")
      outcome = { outcomeVersion: "1.0.0", status: completed.payload.status, reasons: derivationRejectionEvent.payload.reasons }
      break
    case "INTENT_DERIVED":
      if (decisionEvent?.payload.decision.outcome !== "PROPOSE_TRADE" || intentEvent === undefined) {
        throw new Error("Derived intent or its validated decision is missing")
      }
      outcome = { outcomeVersion: "1.0.0", status: completed.payload.status, decision: decisionEvent.payload.decision, intent: intentEvent.payload.intent }
      break
  }
  if (riskEvent !== undefined && outcome.status !== "INTENT_DERIVED") {
    throw new Error("Shadow risk requires a derived trade intent")
  }

  const cycleId = start.cycleId
  const sessionId = start.sessionId
  if (cycleId === undefined || sessionId === undefined) throw new Error("Research cycle identity is incomplete")
  return {
    runVersion: completed.payload.researchInvocation !== undefined
      ? RESEARCH_RUN_VERSION
      : riskEvent === undefined
        ? LEGACY_RESEARCH_RUN_VERSION
        : SHADOW_RESEARCH_RUN_VERSION,
    cycle: {
      cycleId,
      cycleNumber: start.payload.cycleNumber,
      correlationId: start.correlationId,
      sessionId,
      startedAt: start.occurredAt,
      completedAt: completed.occurredAt,
      sessionDate:
        start.payload.sessionDate ?? newYorkDate(new Date(start.occurredAt)),
    },
    ...(start.payload.initialEligibility === undefined ? {} : { initialEligibility: start.payload.initialEligibility }),
    ...(completed.payload.researchInvocation === undefined
      ? {}
      : { researchInvocation: completed.payload.researchInvocation }),
    evidenceSnapshots: events
      .filter((event) => event.eventType === "EVIDENCE_SNAPSHOT_REFERENCED")
      .map((event) => event.payload),
    ...(preliminaryEvent === undefined ? {} : { preliminaryResearch: preliminaryEvent.payload.research }),
    ...(reportEvent === undefined ? {} : { researchReport: reportEvent.payload.report }),
    ...(decisionEvent === undefined ? {} : { validatedDecision: decisionEvent.payload.decision }),
    ...(riskEvent === undefined
      ? {}
      : {
          shadowRisk: {
            decision: riskEvent.payload.decision,
            breakerTransitions: breakerEvents.map((event) => event.payload),
          },
        }),
    outcome,
    ledger: {
      firstSequence: start.sequence,
      lastSequence: completed.sequence,
      terminalEventId: completed.eventId,
    },
  }
}

/** Loads a completed cycle from SQLite and projects its portable run record. */
export async function loadResearchRunV1(store: LedgerStore, cycleId: string): Promise<ResearchRunV1> {
  const events = await store.list({ cycleId, direction: "ASC", limit: 1_000 })
  return projectResearchRunV1(events)
}

export type WriteResearchRunArtifactOptions = Readonly<{
  run: ResearchRunV1
  root?: string
  overwrite?: boolean
}>

/** Writes the canonical portable JSON export of a committed SQLite research run. */
export async function writeResearchRunArtifact({
  run,
  root = DEFAULT_RESEARCH_ARTIFACT_ROOT,
  overwrite = false,
}: WriteResearchRunArtifactOptions): Promise<string> {
  const cycleId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).parse(run.cycle.cycleId)
  const sessionDate = z.iso.date().parse(run.cycle.sessionDate)
  const directory = join(root, sessionDate)
  const path = join(directory, `cycle-${run.cycle.cycleNumber}-${cycleId}.json`)
  await mkdir(directory, { recursive: true })
  const handle = await open(path, overwrite ? "w" : "wx", 0o600)
  try {
    await handle.chmod(0o600)
    await handle.writeFile(`${JSON.stringify(run, null, 2)}\n`, "utf8")
  } finally {
    await handle.close()
  }
  return path
}
