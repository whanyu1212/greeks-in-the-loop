import { mkdir, open } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import type { ResearchDecisionV3 } from "../contracts/research-decision-v3.js"
import type { ResearchReportV6 } from "../contracts/research-report-v6.js"
import type { TradeIntentV3 } from "../contracts/trade-intent-v3.js"
import {
  LEDGER_EVENT_VERSION,
  type StoredLedgerEvent,
  type StoredLedgerEventV4,
} from "../event-ledger/ledger-event-v1.js"
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

export const RESEARCH_RUN_VERSION = "6.0.0" as const
export const SUPPORTED_RESEARCH_RUN_VERSIONS = [RESEARCH_RUN_VERSION] as const
export const DEFAULT_RESEARCH_ARTIFACT_ROOT = "workspace/research" as const

type RejectionIssue = Readonly<{
  code: string
  path: readonly (string | number)[]
  schemaCategory?: SchemaViolationCategory
}>

export type ResearchRunOutcomeV1 =
  | Readonly<{
      outcomeVersion: "3.0.0"
      status: "VALIDATED_NO_ACTION"
      decision: Extract<ResearchDecisionV3, { outcome: "NO_ACTION" }>
    }>
  | Readonly<{
      outcomeVersion: "3.0.0"
      status: "DECISION_REJECTED"
      issues: readonly RejectionIssue[]
    }>
  | Readonly<{
      outcomeVersion: "3.0.0"
      status: "PORTFOLIO_EVALUATED"
      decision: Extract<ResearchDecisionV3, { outcome: "PROPOSE_TRADES" }>
      intents: readonly TradeIntentV3[]
      selectedUnderlyings: readonly string[]
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
  researchReport?: ResearchReportV6
  validatedDecision?: ResearchDecisionV3
  shadowRisk?: Readonly<{
    decision: ShadowRiskDecisionV1
    breakerTransitions: readonly RiskBreakerTransitionV1[]
  }>
  shadowRiskResults?: readonly Readonly<{
    decision: ShadowRiskDecisionV1
    breakerTransitions: readonly RiskBreakerTransitionV1[]
  }>[]
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
  inputEvents: readonly StoredLedgerEvent[],
): ResearchRunV1 {
  if (inputEvents.length === 0) throw new Error("Research cycle was not found")
  const currentEvents = inputEvents.filter(
    (event): event is StoredLedgerEventV4 =>
      event.eventVersion === LEDGER_EVENT_VERSION,
  )
  if (currentEvents.length !== inputEvents.length) {
    throw new Error("Legacy ledger cycles cannot be exported as research run V6")
  }
  const events = [...currentEvents].sort(
    (left, right) => left.sequence - right.sequence,
  )
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

  const reportEvent = optionalOne(
    events.filter((event) => event.eventType === "RESEARCH_REPORT_RECORDED"),
    "research-report",
  )
  const decisionEvent = optionalOne(
    events.filter((event) => event.eventType === "RESEARCH_DECISION_VALIDATED"),
    "validated-decision",
  )
  const decisionRejectionEvents = events.filter(
    (event) => event.eventType === "RESEARCH_DECISION_REJECTED",
  )
  const decisionRejectionEvent = decisionRejectionEvents.find(
    ({ payload }) => payload.proposal === undefined,
  )
  const intentEvents = events.filter(
    (event) => event.eventType === "TRADE_INTENT_DERIVED",
  )
  const riskEvents = events.filter(
    (event) => event.eventType === "RISK_SHADOW_DECISION_RECORDED",
  )
  const portfolioPlanEvent = optionalOne(
    events.filter(
      (event) => event.eventType === "PORTFOLIO_SHADOW_PLAN_RECORDED",
    ),
    "portfolio-shadow-plan",
  )
  const breakerEvents = events.filter(
    (event) => event.eventType === "RISK_BREAKER_LATCHED",
  )
  if (riskEvents.length === 0 && breakerEvents.length > 0) {
    throw new Error("Breaker transitions require a shadow-risk decision")
  }

  let outcome: ResearchRunOutcomeV1
  switch (completed.payload.status) {
    case "VALIDATED_NO_ACTION":
      if (decisionEvent?.payload.decision.outcome !== "NO_ACTION") throw new Error("Validated no-action decision is missing")
      outcome = { outcomeVersion: "3.0.0", status: completed.payload.status, decision: decisionEvent.payload.decision }
      break
    case "DECISION_REJECTED":
      if (decisionRejectionEvent === undefined) throw new Error("Decision rejection details are missing")
      outcome = {
        outcomeVersion: "3.0.0",
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
    case "PORTFOLIO_EVALUATED":
      if (
        decisionEvent?.payload.decision.outcome !== "PROPOSE_TRADES" ||
        portfolioPlanEvent === undefined
      ) {
        throw new Error("Evaluated portfolio or its validated decision is missing")
      }
      outcome = {
        outcomeVersion: "3.0.0",
        status: completed.payload.status,
        decision: decisionEvent.payload.decision,
        intents: intentEvents.map(({ payload }) => payload.intent),
        selectedUnderlyings: portfolioPlanEvent.payload.selectedUnderlyings,
      }
      break
  }
  if (riskEvents.length > 0 && outcome.status !== "PORTFOLIO_EVALUATED") {
    throw new Error("Shadow risk requires an evaluated portfolio")
  }

  const projectedRiskResults = riskEvents.map((riskEvent) => {
    const intentEvent = intentEvents.find(
      (event) => event.eventId === riskEvent.causationEventId,
    )
    const breakerTransitions: RiskBreakerTransitionV1[] = []
    let causationEventId = riskEvent.eventId
    for (const event of events) {
      if (event.causationEventId !== causationEventId) continue
      if (event.eventType !== "RISK_BREAKER_LATCHED") break
      breakerTransitions.push(event.payload)
      causationEventId = event.eventId
    }
    return {
      underlying: intentEvent?.payload.intent.underlying,
      result: {
        decision: riskEvent.payload.decision,
        breakerTransitions,
      },
    }
  })
  const shadowRiskResults = projectedRiskResults.map(({ result }) => result)
  const selectedUnderlying = outcome.status === "PORTFOLIO_EVALUATED"
    ? outcome.selectedUnderlyings[0]
    : undefined
  const primaryShadowRisk = projectedRiskResults.find(
    ({ underlying }) => underlying === selectedUnderlying,
  )?.result ?? shadowRiskResults[0]

  const cycleId = start.cycleId
  const sessionId = start.sessionId
  if (cycleId === undefined || sessionId === undefined) throw new Error("Research cycle identity is incomplete")
  return {
    runVersion: RESEARCH_RUN_VERSION,
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
    ...(reportEvent === undefined ? {} : { researchReport: reportEvent.payload.report }),
    ...(decisionEvent === undefined ? {} : { validatedDecision: decisionEvent.payload.decision }),
    ...(primaryShadowRisk === undefined
      ? {}
      : { shadowRisk: primaryShadowRisk }),
    ...(shadowRiskResults.length === 0 ? {} : { shadowRiskResults }),
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
