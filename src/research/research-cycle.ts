import { deriveTradeIntentV1 } from "../contracts/trade-intent-v1.js"
import { validateResearchDecisionV1 } from "../contracts/research-decision-v1.js"
import { researchReportV2Schema } from "../contracts/research-report-v2.js"
import { MAX_LEDGER_EVENT_PAYLOAD_BYTES } from "../event-ledger/ledger-event-v1.js"
import type {
  OptionQuoteProvider,
} from "../market-data/alpaca-option-quotes.js"
import {
  NOOP_RESEARCH_CYCLE_TRACE,
  type ResearchCycleTrace,
} from "../observability/research-telemetry.js"
import {
  NOOP_TERMINAL_STAGE_REPORTER,
  type TerminalStageReporter,
} from "../observability/terminal-stage-reporter.js"
import type { ResearchEligibilityV1 } from "../scheduling/research-eligibility.js"
import type { ShadowRiskEvaluator } from "../risk/shadow-risk-service.js"
import { safeSchemaDiagnostics } from "../shared/schema-diagnostics.js"
import { SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID } from "../strategy/strategy-identity.js"
import { resolveStrategyManifest } from "../strategy/strategy-registry.js"
import {
  RESEARCH_CYCLE_OUTCOME_VERSION,
  type ResearchCycleOutcomeSink,
} from "./research-cycle-outcome-v1.js"
import {
  processResearchProposalPath,
  type ProposalIntentDeriver,
} from "./research-proposal-path.js"
import { createResearchCycleStageReports } from "./research-cycle-stage-reporting.js"
import {
  recordResearchCycleOutcome,
  type ProcessedResearchCycle,
  type ResearchCycleTerminalResolution,
} from "./research-cycle-terminal.js"
import type { ResearchInvocationV1 } from "./research-invocation-v1.js"

export {
  PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT,
  PROPOSAL_QUOTE_SNAPSHOT_REF,
  proposalAccountChecksAreFresh,
  proposalHistoryIssuePath,
  proposalMarketRegimeIsFresh,
} from "./research-proposal-path.js"
export {
  MAX_TERMINAL_REJECTION_DETAILS,
  type ProcessedResearchCycle,
} from "./research-cycle-terminal.js"

export const MAX_RESEARCH_RESPONSE_BYTES = 64 * 1024

export type ProcessResearchCycleOptions = Readonly<{
  rawResponse: string
  cycleStartedAt: string
  signal: AbortSignal
  quoteProvider: OptionQuoteProvider
  shadowRiskEvaluator: ShadowRiskEvaluator
  outcomeSink: ResearchCycleOutcomeSink
  getEligibility: () => ResearchEligibilityV1
  researchInvocation: ResearchInvocationV1
  now?: () => Date
  deriveIntent?: ProposalIntentDeriver
  trace?: ResearchCycleTrace
  stageReporter?: TerminalStageReporter
}>

/**
 * Parses, validates, confirms, and derives one research-agent response.
 *
 * The raw response is never placed in a rejection result. Quote confirmation and
 * intent derivation are unreachable until the decision passes its preceding
 * validation gate.
 *
 * @param options Untrusted response and application-owned processing ports.
 * @returns One recorded bounded outcome and printable scheduler report.
 */
export async function processResearchCycle({
  rawResponse,
  cycleStartedAt,
  signal,
  quoteProvider,
  shadowRiskEvaluator,
  outcomeSink,
  getEligibility,
  researchInvocation,
  now = () => new Date(),
  deriveIntent = deriveTradeIntentV1,
  trace = NOOP_RESEARCH_CYCLE_TRACE,
  stageReporter = NOOP_TERMINAL_STAGE_REPORTER,
}: ProcessResearchCycleOptions): Promise<ProcessedResearchCycle> {
  signal.throwIfAborted()
  const stages = createResearchCycleStageReports(stageReporter)
  const parsed = await trace.run("research.report.parse", () => {
    if (Buffer.byteLength(rawResponse, "utf8") > MAX_RESEARCH_RESPONSE_BYTES) {
      return {
        success: false as const,
        issues: [{ code: "RESPONSE_TOO_LARGE" as const, path: [] as const }],
      }
    }
    let input: unknown
    try {
      input = JSON.parse(rawResponse)
    } catch {
      return {
        success: false as const,
        issues: [{ code: "MALFORMED_JSON" as const, path: [] as const }],
      }
    }
    const report = researchReportV2Schema.safeParse(input)
    if (!report.success) {
      return {
        success: false as const,
        issues: safeSchemaDiagnostics(report.error.issues, input),
      }
    }
    if (
      Buffer.byteLength(JSON.stringify({ researchReport: report.data }), "utf8") >
      MAX_LEDGER_EVENT_PAYLOAD_BYTES
    ) {
      return {
        success: false as const,
        issues: [{ code: "RESPONSE_TOO_LARGE" as const, path: [] as const }],
      }
    }
    return { success: true as const, report: report.data }
  })
  if (!parsed.success) {
    stages.researchReportRejected(parsed.issues)
    return recordResearchCycleOutcome(
      {
        outcome: {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: parsed.issues,
        },
      },
      {
        sink: outcomeSink,
        signal,
        researchInvocation,
        trace,
        stages,
      },
    )
  }

  const researchReport = parsed.report
  const result = researchReport.result
  const recordReportResolution = (
    resolution: ResearchCycleTerminalResolution,
  ) =>
    recordResearchCycleOutcome(resolution, {
      sink: outcomeSink,
      signal,
      researchInvocation,
      researchReport,
      trace,
      stages,
    })
  stages.researchReportCompleted(researchReport)
  const strategy = resolveStrategyManifest({
    strategyId: SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
    strategyVersion: result.strategyVersion,
  })
  if (!strategy.success) {
    return recordReportResolution({
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{
          code: "SCHEMA_INVALID",
          schemaCategory: "VALUE_NOT_ALLOWED",
          path: ["result", "strategyVersion"],
        }],
      },
    })
  }
  const processingEvaluatedAt = now()
  const cycleStartTime = Date.parse(cycleStartedAt)
  if (
    !Number.isFinite(processingEvaluatedAt.getTime()) ||
    !Number.isFinite(cycleStartTime) ||
    cycleStartTime > processingEvaluatedAt.getTime() ||
    Date.parse(researchReport.analysis.asOf) > processingEvaluatedAt.getTime()
  ) {
    return recordReportResolution({
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["analysis", "asOf"] }],
      },
    })
  }
  const exaSources = researchReport.analysis.externalContext.filter(
    ({ provider }) => provider === "EXA",
  )
  if (
    exaSources.length > 0 &&
    !exaSources.some(({ retrievedAt }) => {
      const retrievedTime = Date.parse(retrievedAt)
      return (
        retrievedTime >= cycleStartTime &&
        retrievedTime <= processingEvaluatedAt.getTime()
      )
    })
  ) {
    return recordReportResolution({
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "externalContext"],
          },
        ],
      },
    })
  }

  if (result.outcome === "PRELIMINARY_RESEARCH") {
    const preliminaryIssuePath = await trace.run(
      "research.decision.validate",
      () => {
        const eligibility = getEligibility()
        const eligibilityTime = Date.parse(eligibility.evaluatedAt)
        const futureObservationIndex = result.evidence.findIndex(
          (claim) =>
            claim.kind === "SOURCED_FACT" &&
            Date.parse(claim.observedAt) > eligibilityTime,
        )
        if (
          eligibility.researchEligible &&
          eligibility.sessionDate === result.targetSessionDate &&
          Number.isFinite(eligibilityTime) &&
          Date.parse(researchReport.analysis.asOf) <= eligibilityTime &&
          futureObservationIndex < 0
        ) {
          return undefined
        }
        return futureObservationIndex >= 0
          ? ["evidence", futureObservationIndex, "observedAt"] as const
          : ["targetSessionDate"] as const
      },
    )
    if (preliminaryIssuePath !== undefined) {
      return recordReportResolution({
        outcome: {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: [
            {
              code: "CONTEXT_INVALID",
              path: preliminaryIssuePath,
            },
          ],
        },
      })
    }
    stages.preliminaryValidated(result)
    return recordReportResolution({
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "PRELIMINARY_RESEARCH_RETAINED",
        research: result,
      },
      metadata: { preliminaryResearch: result },
    })
  }

  if (result.outcome === "NO_ACTION") {
    const validation = await trace.run("research.decision.validate", () =>
      validateResearchDecisionV1(result, {
        evaluatedAt: processingEvaluatedAt.toISOString(),
        snapshots: {},
      }),
    )
    if (!validation.success) {
      return recordReportResolution({
        outcome: {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: validation.issues,
        },
      })
    }

    stages.decisionValidated(validation.data)

    return recordReportResolution({
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "VALIDATED_NO_ACTION",
        decision: result,
      },
      metadata: { validatedDecision: validation.data },
    })
  }

  const proposalResolution = await processResearchProposalPath({
    report: { ...researchReport, result },
    signal,
    quoteProvider,
    shadowRiskEvaluator,
    getEligibility,
    deriveIntent,
    trace,
    stages,
    stageReporter,
  })
  return recordReportResolution(proposalResolution)
}
