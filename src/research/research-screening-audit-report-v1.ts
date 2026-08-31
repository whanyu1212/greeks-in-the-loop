import { z } from "zod"

import {
  RESEARCH_SCREENING_COMPARISON_CLASSES,
  type IdenticalInputParityChecksV1,
  type ResearchScreeningAuditInputIdentityV1,
  type ResearchScreeningComparisonClassV1,
} from "../contracts/research-screening-audit-v1.js"
import type { StoredLedgerEventV1 } from "../event-ledger/ledger-event-v1.js"
import type { LedgerStore } from "../event-ledger/ledger-store.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import { researchScreeningAuditWindowV1 } from "./research-screening-audit-runtime-v1.js"

export const RESEARCH_SCREENING_AUDIT_REPORT_VERSION = "1.0.0" as const
export const MAX_IDENTICAL_INPUT_MISMATCH_DETAILS = 100

const REPORT_EVENT_TYPES = [
  "RESEARCH_CYCLE_STARTED",
  "RESEARCH_SCREENING_AUDIT_RECORDED",
] as const
const REPORT_PAGE_SIZE = 1_000
const APPLICATION_STATUSES = [
  "SCREENED",
  "CAPTURE_UNAVAILABLE",
  "SCREENING_UNAVAILABLE",
] as const
const SCREENING_RESULTS = ["SELECTED", "NO_ACTION"] as const
const AGENT_STATUSES = ["AVAILABLE", "MODEL_IDENTITY_DRIFT", "UNAVAILABLE"] as const
const AGENT_TERMINAL_CLASSES = [
  "NO_ACTION",
  "PRELIMINARY_RESEARCH",
  "PROPOSE_TRADE",
] as const
const FIRST_FAILURE_STAGES = [
  "COMPATIBILITY",
  "FEATURE",
  "FRESHNESS",
  "ELIGIBILITY",
  "LIQUIDITY",
  "ECONOMICS",
  "RANKING",
] as const
const IDENTICAL_INPUT_CLASSES = new Set<ResearchScreeningComparisonClassV1>([
  "IDENTICAL_INPUT_MATCH",
  "IDENTICAL_INPUT_FEATURE_MISMATCH",
  "IDENTICAL_INPUT_FILTER_MISMATCH",
  "IDENTICAL_INPUT_RANKING_MISMATCH",
  "IDENTICAL_INPUT_CANDIDATE_MISMATCH",
])
const IDENTICAL_INPUT_MISMATCH_CLASSES = new Set<ResearchScreeningComparisonClassV1>([
  "IDENTICAL_INPUT_FEATURE_MISMATCH",
  "IDENTICAL_INPUT_FILTER_MISMATCH",
  "IDENTICAL_INPUT_RANKING_MISMATCH",
  "IDENTICAL_INPUT_CANDIDATE_MISMATCH",
])

const isoDate = z.iso.date()
const lexicalCompare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0

type StartEvent = Extract<
  StoredLedgerEventV1,
  { eventType: "RESEARCH_CYCLE_STARTED" }
>
type AuditEvent = Extract<
  StoredLedgerEventV1,
  { eventType: "RESEARCH_SCREENING_AUDIT_RECORDED" }
>

export type ResearchScreeningAuditReportWindowV1 = Readonly<{
  fromSessionDate: string
  toSessionDate: string
}>

export type ResearchScreeningAuditLatencySummaryV1 = Readonly<{
  count: number
  min: number | null
  p50: number | null
  p95: number | null
  max: number | null
}>

const zeroCounts = <const Values extends readonly string[]>(values: Values) =>
  Object.fromEntries(values.map((value) => [value, 0])) as Record<Values[number], number>

const increment = (counts: Map<string, number>, key: string, amount = 1) => {
  counts.set(key, (counts.get(key) ?? 0) + amount)
}

const sparseCounts = (
  counts: ReadonlyMap<string, number>,
  compare: (left: string, right: string) => number = lexicalCompare,
) => Object.fromEntries([...counts].sort(([left], [right]) => compare(left, right)))

const latencySummary = (
  input: readonly number[],
): ResearchScreeningAuditLatencySummaryV1 => {
  if (input.length === 0) {
    return { count: 0, min: null, p50: null, p95: null, max: null }
  }
  const values = [...input].sort((left, right) => left - right)
  const nearestRank = (percentile: number) =>
    values[Math.ceil(percentile * values.length) - 1]!
  return {
    count: values.length,
    min: values[0]!,
    p50: nearestRank(0.5),
    p95: nearestRank(0.95),
    max: values.at(-1)!,
  }
}

export async function loadResearchScreeningAuditReportEventsV1(
  store: Pick<LedgerStore, "list">,
): Promise<readonly StoredLedgerEventV1[]> {
  const [latest] = await store.list({
    direction: "DESC",
    eventTypes: REPORT_EVENT_TYPES,
    limit: 1,
  })
  if (latest === undefined) return []
  if (latest.sequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Research screening audit report sequence is too large")
  }

  const events: StoredLedgerEventV1[] = []
  const beforeSequence = latest.sequence + 1
  let afterSequence = 0
  while (true) {
    const page = await store.list({
      afterSequence,
      beforeSequence,
      direction: "ASC",
      eventTypes: REPORT_EVENT_TYPES,
      limit: REPORT_PAGE_SIZE,
    })
    events.push(...page)
    if (page.length < REPORT_PAGE_SIZE) return events
    afterSequence = page.at(-1)?.sequence ?? afterSequence
  }
}

const selectedResultForMismatch = (
  result: Extract<
    AuditEvent["payload"]["audit"]["application"],
    { status: "SCREENED" }
  >["result"],
) => result.status === "NO_ACTION"
  ? result
  : {
      status: result.status,
      candidateId: result.candidateId,
      direction: result.direction,
      structure: result.structure,
      expirationDate: result.expirationDate,
      dte: result.dte,
      widthCentsPerShare: result.widthCentsPerShare,
      longContractSymbol: result.longContractSymbol,
      shortContractSymbol: result.shortContractSymbol,
      eligibleCandidateCount: result.eligibleCandidateCount,
    }

type IdenticalInputMismatchDetail = Readonly<{
  sequence: number
  eventId: string
  cycleId: string
  sessionId: string | null
  sessionDate: string
  comparisonClass: ResearchScreeningComparisonClassV1
  applicationInputIdentity: ResearchScreeningAuditInputIdentityV1
  trustedAgentInputIdentity: ResearchScreeningAuditInputIdentityV1
  identicalInputChecks: IdenticalInputParityChecksV1
  applicationResult: ReturnType<typeof selectedResultForMismatch>
  agentResult: Readonly<{
    terminalClass: "NO_ACTION" | "PRELIMINARY_RESEARCH" | "PROPOSE_TRADE"
    proposalCandidate: Extract<
      AuditEvent["payload"]["audit"]["agent"],
      { status: "AVAILABLE" }
    >["proposalCandidate"] | null
  }>
}>

/** Builds one deterministic, diagnostic-only report from validated ledger events. */
export function buildResearchScreeningAuditReportV1(
  inputEvents: readonly StoredLedgerEventV1[],
  window: ResearchScreeningAuditReportWindowV1,
) {
  const fromSessionDate = isoDate.parse(window.fromSessionDate)
  const toSessionDate = isoDate.parse(window.toSessionDate)
  if (fromSessionDate > toSessionDate) {
    throw new Error("Research screening audit report date range is reversed")
  }

  const events = [...inputEvents].sort((left, right) =>
    left.sequence - right.sequence || lexicalCompare(left.eventId, right.eventId),
  )
  const starts = new Map<string, StartEvent>()
  for (const event of events) {
    if (event.eventType === "RESEARCH_CYCLE_STARTED" && event.cycleId !== undefined) {
      starts.set(event.cycleId, event)
    }
  }
  const inWindow = (start: StartEvent) => {
    const sessionDate = start.payload.sessionDate
    return sessionDate !== undefined &&
      sessionDate >= fromSessionDate && sessionDate <= toSessionDate
  }
  const eligible = (start: StartEvent) =>
    start.payload.initialEligibility !== undefined &&
    researchScreeningAuditWindowV1(start.payload.initialEligibility) !== undefined

  const startsInWindow = [...starts.values()].filter(inWindow)
  const auditsInWindow = events.flatMap((event) => {
    if (event.eventType !== "RESEARCH_SCREENING_AUDIT_RECORDED" ||
      event.cycleId === undefined) return []
    const start = starts.get(event.cycleId)
    return start === undefined || !inWindow(start) ? [] : [{ event, start }]
  })
  const auditsByCycle = new Set(auditsInWindow.map(({ event }) => event.cycleId!))
  const eligibleStarts = startsInWindow.filter(eligible)
  const recordedAudits = auditsInWindow.filter(({ start }) => eligible(start))
  const unexpectedAudit = auditsInWindow.length - recordedAudits.length
  const sourceSequences = [
    ...startsInWindow.map(({ sequence }) => sequence),
    ...auditsInWindow.map(({ event }) => event.sequence),
  ].sort((left, right) => left - right)

  const applicationStatusCounts = zeroCounts(APPLICATION_STATUSES)
  const screeningResultCounts = zeroCounts(SCREENING_RESULTS)
  const captureFailureReasonCounts = new Map<string, number>()
  const screeningUnavailableReasonCounts = new Map<string, number>()
  const noActionReasonCounts = new Map<string, number>()
  const firstFailureByStage = zeroCounts(FIRST_FAILURE_STAGES)
  const firstFailureByReason = new Map<string, number>()
  const captureLatencies: number[] = []
  const screeningLatencies: number[] = []
  const byDirection = zeroCounts(["BULLISH", "BEARISH"] as const)
  const byDte = new Map<string, number>()
  const byExpiration = new Map<string, number>()
  const byWidth = new Map<string, number>()

  const agentStatusCounts = zeroCounts(AGENT_STATUSES)
  const terminalClassCounts = zeroCounts(AGENT_TERMINAL_CLASSES)
  const unavailableReasonCounts = new Map<string, number>()
  const modelDriftReasonCounts = new Map<string, number>()
  const invocationIdentityCounts = new Map<
    string,
    { invocationVersion: string; providerId: string; modelId: string; count: number }
  >()

  const comparisonClassCounts = zeroCounts(RESEARCH_SCREENING_COMPARISON_CLASSES)
  const mismatchDetails: IdenticalInputMismatchDetail[] = []
  let identicalInputComparable = 0

  for (const { event, start } of recordedAudits) {
    const audit = event.payload.audit
    const application = audit.application
    applicationStatusCounts[application.status] += 1
    captureLatencies.push(application.captureDurationMs)
    if (application.status === "CAPTURE_UNAVAILABLE") {
      for (const reason of application.reasons) increment(captureFailureReasonCounts, reason)
    } else {
      screeningLatencies.push(application.screeningDurationMs)
      if (application.status === "SCREENING_UNAVAILABLE") {
        increment(screeningUnavailableReasonCounts, application.reason)
      } else {
        screeningResultCounts[application.result.status] += 1
        if (application.result.status === "NO_ACTION") {
          increment(noActionReasonCounts, application.result.reason)
        } else {
          byDirection[application.result.direction] += 1
          increment(byDte, String(application.result.dte))
          increment(byExpiration, application.result.expirationDate)
          increment(byWidth, String(application.result.widthCentsPerShare))
        }
        for (const failure of application.diagnostics.firstFailureCounts) {
          firstFailureByStage[failure.stage] += failure.count
          increment(firstFailureByReason, failure.reason, failure.count)
        }
      }
    }

    const agent = audit.agent
    agentStatusCounts[agent.status] += 1
    if (agent.status === "UNAVAILABLE") {
      increment(unavailableReasonCounts, agent.reason)
    } else if (agent.status === "MODEL_IDENTITY_DRIFT") {
      increment(modelDriftReasonCounts, agent.reason)
    } else {
      terminalClassCounts[agent.terminalClass] += 1
      const identity = agent.invocation
      const key = JSON.stringify([
        identity.invocationVersion,
        identity.providerId,
        identity.modelId,
      ])
      const existing = invocationIdentityCounts.get(key)
      if (existing === undefined) {
        invocationIdentityCounts.set(key, { ...identity, count: 1 })
      } else {
        existing.count += 1
      }
    }

    const comparisonClass = audit.comparison.class
    comparisonClassCounts[comparisonClass] += 1
    if (IDENTICAL_INPUT_CLASSES.has(comparisonClass)) {
      identicalInputComparable += 1
    }
    if (
      IDENTICAL_INPUT_MISMATCH_CLASSES.has(comparisonClass) &&
      application.status === "SCREENED" &&
      agent.status === "AVAILABLE" &&
      audit.trustedAgentInputIdentity !== undefined &&
      audit.comparison.identicalInputChecks !== undefined &&
      event.cycleId !== undefined &&
      start.payload.sessionDate !== undefined
    ) {
      mismatchDetails.push({
        sequence: event.sequence,
        eventId: event.eventId,
        cycleId: event.cycleId,
        sessionId: event.sessionId ?? null,
        sessionDate: start.payload.sessionDate,
        comparisonClass,
        applicationInputIdentity: application.inputIdentity,
        trustedAgentInputIdentity: audit.trustedAgentInputIdentity,
        identicalInputChecks: audit.comparison.identicalInputChecks,
        applicationResult: selectedResultForMismatch(application.result),
        agentResult: {
          terminalClass: agent.terminalClass,
          proposalCandidate: agent.proposalCandidate ?? null,
        },
      })
    }
  }

  const reportWithoutChecksum = {
    reportVersion: RESEARCH_SCREENING_AUDIT_REPORT_VERSION,
    fromSessionDate,
    toSessionDate,
    sourceSequenceBounds: {
      firstSequence: sourceSequences[0] ?? null,
      lastSequence: sourceSequences.at(-1) ?? null,
    },
    cycleCounts: {
      auditEligible: eligibleStarts.length,
      recordedAudit: recordedAudits.length,
      missingAudit: eligibleStarts.filter(
        (start) => start.cycleId !== undefined && !auditsByCycle.has(start.cycleId),
      ).length,
      unexpectedAudit,
      identicalInputComparable,
    },
    application: {
      statusCounts: applicationStatusCounts,
      captureFailureReasonCounts: sparseCounts(captureFailureReasonCounts),
      screeningUnavailableReasonCounts: sparseCounts(
        screeningUnavailableReasonCounts,
      ),
      latencyMs: {
        capture: latencySummary(captureLatencies),
        screening: latencySummary(screeningLatencies),
      },
      screeningResultCounts,
      candidateFrequency: {
        selectedCycles: screeningResultCounts.SELECTED,
        screenedCycles:
          screeningResultCounts.SELECTED + screeningResultCounts.NO_ACTION,
      },
      noActionReasonCounts: sparseCounts(noActionReasonCounts),
      firstFailureEvaluationUnitCounts: {
        byStage: firstFailureByStage,
        byReason: sparseCounts(firstFailureByReason),
      },
      selectedCandidateDimensionCounts: {
        byDirection,
        bySessionRelativeCalendarDte: sparseCounts(
          byDte,
          (left, right) => Number(left) - Number(right),
        ),
        byExpirationDate: sparseCounts(byExpiration),
        byWidthCentsPerShare: sparseCounts(
          byWidth,
          (left, right) => Number(left) - Number(right),
        ),
      },
    },
    agent: {
      statusCounts: agentStatusCounts,
      terminalClassCounts,
      unavailableReasonCounts: sparseCounts(unavailableReasonCounts),
      modelDriftReasonCounts: sparseCounts(modelDriftReasonCounts),
      availableInvocationIdentityCounts: [...invocationIdentityCounts.values()]
        .sort((left, right) =>
          lexicalCompare(left.invocationVersion, right.invocationVersion) ||
          lexicalCompare(left.providerId, right.providerId) ||
          lexicalCompare(left.modelId, right.modelId),
        ),
    },
    comparison: {
      classCounts: comparisonClassCounts,
      identicalInputMismatches: {
        total: mismatchDetails.length,
        truncated: mismatchDetails.length > MAX_IDENTICAL_INPUT_MISMATCH_DETAILS,
        details: mismatchDetails.slice(0, MAX_IDENTICAL_INPUT_MISMATCH_DETAILS),
      },
    },
  }
  return {
    ...reportWithoutChecksum,
    checksum: canonicalJsonSha256(reportWithoutChecksum),
  }
}

export type ResearchScreeningAuditReportV1 = ReturnType<
  typeof buildResearchScreeningAuditReportV1
>
