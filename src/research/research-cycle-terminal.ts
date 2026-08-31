import type { ResearchDecisionV2 } from "../contracts/research-decision-v2.js"
import type { PreliminaryResearchV2 } from "../contracts/preliminary-research-v2.js"
import type { ResearchReportV3 } from "../contracts/research-report-v3.js"
import type { ResearchCycleTrace } from "../observability/research-telemetry.js"
import type { ShadowRiskResultV1 } from "../risk/shadow-risk-v1.js"
import type {
  ResearchCycleOutcomeSink,
  ResearchCycleOutcomeV1,
  ResearchCycleTerminalRecordV1,
} from "./research-cycle-outcome-v1.js"
import type { ResearchCycleStageReports } from "./research-cycle-stage-reporting.js"
import type { ResearchInvocationV1 } from "./research-invocation-v1.js"

export const MAX_TERMINAL_REJECTION_DETAILS = 64

type CommonTerminalMetadata = Readonly<{
  evidenceSnapshots?: ResearchCycleTerminalRecordV1["evidenceSnapshots"]
  validatedDecision?: ResearchDecisionV2
  preliminaryResearch?: PreliminaryResearchV2
}>

export type ResearchCycleTerminalResolution =
  | Readonly<{
      outcome: Extract<ResearchCycleOutcomeV1, { status: "INTENT_DERIVED" }>
      metadata: CommonTerminalMetadata & Readonly<{
        shadowRisk: ShadowRiskResultV1
      }>
    }>
  | Readonly<{
      outcome: Exclude<ResearchCycleOutcomeV1, { status: "INTENT_DERIVED" }>
      metadata?: CommonTerminalMetadata & Readonly<{ shadowRisk?: never }>
    }>

export type RecordResearchCycleOutcomeContext = Readonly<{
  sink: ResearchCycleOutcomeSink
  signal: AbortSignal
  researchInvocation: ResearchInvocationV1
  researchReport?: ResearchReportV3
  trace: ResearchCycleTrace
  stages: ResearchCycleStageReports
}>

export type ProcessedResearchCycle = Readonly<{
  outcome: ResearchCycleOutcomeV1
  report: string
  researchReport?: ResearchReportV3
  shadowRisk?: ShadowRiskResultV1
}>

const boundTerminalOutcome = (
  outcome: ResearchCycleOutcomeV1,
): ResearchCycleOutcomeV1 => {
  if (outcome.status === "DECISION_REJECTED") {
    return {
      ...outcome,
      issues: outcome.issues.slice(0, MAX_TERMINAL_REJECTION_DETAILS),
    }
  }
  if (outcome.status === "INTENT_DERIVATION_REJECTED") {
    return {
      ...outcome,
      reasons: outcome.reasons.slice(0, MAX_TERMINAL_REJECTION_DETAILS),
    }
  }
  return outcome
}

/**
 * Records one bounded terminal cycle result and reports it to the scheduler.
 *
 * This is the only runtime boundary that pairs a derived intent with shadow risk.
 */
export async function recordResearchCycleOutcome(
  resolution: ResearchCycleTerminalResolution,
  context: RecordResearchCycleOutcomeContext,
): Promise<ProcessedResearchCycle> {
  context.signal.throwIfAborted()
  const boundedOutcome = boundTerminalOutcome(resolution.outcome)
  const metadata = resolution.metadata ?? {}
  const shadowRisk = "shadowRisk" in metadata
    ? metadata.shadowRisk
    : undefined

  const commonRecord = {
    researchInvocation: context.researchInvocation,
    evidenceSnapshots: metadata.evidenceSnapshots ?? [],
    ...(metadata.validatedDecision === undefined
      ? {}
      : { validatedDecision: metadata.validatedDecision }),
    ...(metadata.preliminaryResearch === undefined
      ? {}
      : { preliminaryResearch: metadata.preliminaryResearch }),
    ...(context.researchReport === undefined
      ? {}
      : { researchReport: context.researchReport }),
  }

  let record: ResearchCycleTerminalRecordV1
  if (boundedOutcome.status === "INTENT_DERIVED") {
    if (shadowRisk === undefined) {
      throw new Error("Derived intent outcome requires shadow risk")
    }
    record = {
      ...commonRecord,
      outcome: boundedOutcome,
      shadowRisk,
    }
  } else {
    if (shadowRisk !== undefined) {
      throw new Error("Shadow risk requires a derived intent outcome")
    }
    record = { ...commonRecord, outcome: boundedOutcome }
  }

  await context.trace.run("ledger.cycle.terminalize", () =>
    context.sink.record(record, context.signal),
  )
  context.stages.ledgerCommitted(record)
  context.stages.cycleOutcomeRecorded(record)

  return {
    outcome: boundedOutcome,
    report: `Research cycle outcome: ${boundedOutcome.status}${
      shadowRisk === undefined
        ? ""
        : `\nShadow risk: ${shadowRisk.decision.outcome}`
    }`,
    ...(context.researchReport === undefined
      ? {}
      : { researchReport: context.researchReport }),
    ...(shadowRisk === undefined ? {} : { shadowRisk }),
  }
}
