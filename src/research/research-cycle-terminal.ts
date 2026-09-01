import type { ResearchDecisionV3 } from "../contracts/research-decision-v3.js"
import type { ResearchReportV6 } from "../contracts/research-report-v6.js"
import type { ResearchCycleTrace } from "../observability/research-telemetry.js"
import type { ShadowRiskResultV1 } from "../risk/shadow-risk-v1.js"
import type {
  ResearchCycleOutcomeSink,
  ResearchCycleOutcomeV3,
  ResearchCycleTerminalRecordV3,
} from "./research-cycle-outcome-v3.js"
import type { ResearchCycleStageReports } from "./research-cycle-stage-reporting.js"
import type { ResearchInvocationV1 } from "./research-invocation-v1.js"

export const MAX_TERMINAL_REJECTION_DETAILS = 64

type CommonTerminalMetadata = Readonly<{
  evidenceSnapshots?: ResearchCycleTerminalRecordV3["evidenceSnapshots"]
  validatedDecision?: ResearchDecisionV3
}>

export type ResearchCycleTerminalResolution = Readonly<{
  outcome: ResearchCycleOutcomeV3
  metadata?: CommonTerminalMetadata
}>

export type RecordResearchCycleOutcomeContext = Readonly<{
  sink: ResearchCycleOutcomeSink
  signal: AbortSignal
  researchInvocation: ResearchInvocationV1
  researchReport?: ResearchReportV6
  trace: ResearchCycleTrace
  stages: ResearchCycleStageReports
}>

export type ProcessedResearchCycle = Readonly<{
  outcome: ResearchCycleOutcomeV3
  report: string
  researchReport?: ResearchReportV6
  shadowRisks?: readonly ShadowRiskResultV1[]
}>

const boundTerminalOutcome = (
  outcome: ResearchCycleOutcomeV3,
): ResearchCycleOutcomeV3 => {
  if (outcome.status === "DECISION_REJECTED") {
    return {
      ...outcome,
      issues: outcome.issues.slice(0, MAX_TERMINAL_REJECTION_DETAILS),
    }
  }
  if (outcome.status === "PORTFOLIO_EVALUATED") {
    return {
      ...outcome,
      proposals: outcome.proposals.map((proposal) =>
        proposal.status === "DECISION_REJECTED"
          ? {
              ...proposal,
              issues: proposal.issues.slice(0, MAX_TERMINAL_REJECTION_DETAILS),
            }
          : proposal.status === "INTENT_DERIVATION_REJECTED"
            ? {
                ...proposal,
                reasons: proposal.reasons.slice(
                  0,
                  MAX_TERMINAL_REJECTION_DETAILS,
                ),
              }
            : proposal,
      ),
    }
  }
  return outcome
}

/** Records one bounded terminal cycle result and reports it to the scheduler. */
export async function recordResearchCycleOutcome(
  resolution: ResearchCycleTerminalResolution,
  context: RecordResearchCycleOutcomeContext,
): Promise<ProcessedResearchCycle> {
  context.signal.throwIfAborted()
  const boundedOutcome = boundTerminalOutcome(resolution.outcome)
  const metadata = resolution.metadata ?? {}
  const record: ResearchCycleTerminalRecordV3 = {
    outcome: boundedOutcome,
    researchInvocation: context.researchInvocation,
    evidenceSnapshots: metadata.evidenceSnapshots ?? [],
    ...(metadata.validatedDecision === undefined
      ? {}
      : { validatedDecision: metadata.validatedDecision }),
    ...(context.researchReport === undefined
      ? {}
      : { researchReport: context.researchReport }),
  }

  await context.trace.run("ledger.cycle.terminalize", () =>
    context.sink.record(record, context.signal),
  )
  context.stages.ledgerCommitted(record)
  context.stages.cycleOutcomeRecorded(record)

  const shadowRisks = boundedOutcome.status === "PORTFOLIO_EVALUATED"
    ? boundedOutcome.proposals.flatMap((proposal) =>
        proposal.status === "RISK_EVALUATED" ? [proposal.shadowRisk] : [],
      )
    : []
  const selectedCount = boundedOutcome.status === "PORTFOLIO_EVALUATED"
    ? boundedOutcome.proposals.filter(
        (proposal) => proposal.status === "RISK_EVALUATED" && proposal.selected,
      ).length
    : 0

  return {
    outcome: boundedOutcome,
    report: `Research cycle outcome: ${boundedOutcome.status}${
      boundedOutcome.status === "PORTFOLIO_EVALUATED"
        ? `\nSelected shadow proposals: ${selectedCount}`
        : ""
    }`,
    ...(context.researchReport === undefined
      ? {}
      : { researchReport: context.researchReport }),
    ...(shadowRisks.length === 0 ? {} : { shadowRisks }),
  }
}
