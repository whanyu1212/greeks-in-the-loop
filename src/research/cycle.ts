import { deriveTradeIntentV4 } from "../contracts/trade-intent-v4.js"
import type { OptionUniverseSnapshotV2 } from "../contracts/option-universe-v2.js"
import {
  validateResearchDecisionV4,
} from "../contracts/research-decision-v4.js"
import {
  researchReportV7Schema,
  type ResearchReportV7,
} from "../contracts/research-report-v7.js"
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
import { canonicalJson } from "../shared/canonical-json.js"
import { safeSchemaDiagnostics } from "../shared/schema-diagnostics.js"
import {
  RESEARCH_CYCLE_OUTCOME_VERSION,
  type DecisionRejectionIssue,
  type ResearchCycleOutcomeSink,
} from "./cycle/outcome.js"
import {
  isProposedPortfolioReport,
  processResearchProposalPath,
  type ProposalIntentDeriver,
} from "./cycle/proposal-path.js"
import { createResearchCycleStageReports } from "./cycle/stage-reporting.js"
import {
  recordResearchCycleOutcome,
  type ProcessedResearchCycle,
  type ResearchCycleTerminalResolution,
} from "./cycle/terminal.js"
import type { ResearchInvocationV1 } from "./invocation.js"
import type { SymbolScreenResultV2 } from "./symbol-screen.js"

export {
  PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT,
  MAX_SELECTED_SHADOW_PROPOSALS,
  proposalAccountChecksAreFresh,
  proposalHistoryIssuePath,
  proposalMarketRegimeIsFresh,
} from "./cycle/proposal-path.js"
export {
  MAX_TERMINAL_REJECTION_DETAILS,
  type ProcessedResearchCycle,
} from "./cycle/terminal.js"

export const MAX_RESEARCH_RESPONSE_BYTES = 256 * 1024

export type ResearchReportResponseParseResult =
  | Readonly<{ success: true; report: ResearchReportV7 }>
  | Readonly<{ success: false; issues: readonly DecisionRejectionIssue[] }>

/** Parses an untrusted response without retaining rejected model content. */
export function parseResearchReportV7Response(
  rawResponse: string,
): ResearchReportResponseParseResult {
  if (Buffer.byteLength(rawResponse, "utf8") > MAX_RESEARCH_RESPONSE_BYTES) {
    return {
      success: false,
      issues: [{ code: "RESPONSE_TOO_LARGE", path: [] }],
    }
  }
  let input: unknown
  try {
    input = JSON.parse(rawResponse)
  } catch {
    return {
      success: false,
      issues: [{ code: "MALFORMED_JSON", path: [] }],
    }
  }
  const report = researchReportV7Schema.safeParse(input)
  if (!report.success) {
    return {
      success: false,
      issues: safeSchemaDiagnostics(report.error.issues, input),
    }
  }
  if (
    Buffer.byteLength(JSON.stringify({ researchReport: report.data }), "utf8") >
    MAX_LEDGER_EVENT_PAYLOAD_BYTES
  ) {
    return {
      success: false,
      issues: [{ code: "RESPONSE_TOO_LARGE", path: [] }],
    }
  }
  return { success: true, report: report.data }
}

/** Allows at most one model correction before the normal trust boundary runs. */
export async function repairResearchReportV7ResponseOnce(
  rawResponse: string,
  repair: (issues: readonly DecisionRejectionIssue[]) => Promise<string>,
) {
  const parsed = parseResearchReportV7Response(rawResponse)
  if (parsed.success) {
    return { rawResponse, schemaRepairAttempted: false } as const
  }
  return {
    rawResponse: await repair(parsed.issues),
    schemaRepairAttempted: true,
  } as const
}

export type ProcessResearchCycleOptions = Readonly<{
  rawResponse: string
  cycleStartedAt: string
  optionUniverse: OptionUniverseSnapshotV2
  symbolScreen: SymbolScreenResultV2
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

const optionUniverseIssuePath = (
  report: ResearchReportV7,
  expected: OptionUniverseSnapshotV2,
): readonly (string | number)[] | undefined => {
  if (
    report.analysis.optionUniverse === undefined ||
    canonicalJson(report.analysis.optionUniverse) !== canonicalJson(expected)
  ) return ["analysis", "optionUniverse"]
  return undefined
}

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
  optionUniverse,
  symbolScreen,
  signal,
  quoteProvider,
  shadowRiskEvaluator,
  outcomeSink,
  getEligibility,
  researchInvocation,
  now = () => new Date(),
  deriveIntent = deriveTradeIntentV4,
  trace = NOOP_RESEARCH_CYCLE_TRACE,
  stageReporter = NOOP_TERMINAL_STAGE_REPORTER,
}: ProcessResearchCycleOptions): Promise<ProcessedResearchCycle> {
  signal.throwIfAborted()
  const stages = createResearchCycleStageReports(stageReporter)
  const parsed = await trace.run("research.report.parse", () =>
    parseResearchReportV7Response(rawResponse),
  )
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
        symbolScreen,
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
      symbolScreen,
      researchReport,
      trace,
      stages,
    })
  stages.researchReportCompleted(researchReport)
  const processingEvaluatedAt = now()
  const universeIssuePath = optionUniverseIssuePath(
    researchReport,
    optionUniverse,
  )
  if (universeIssuePath !== undefined) {
    return recordReportResolution({
      outcome: {
        outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: universeIssuePath }],
      },
    })
  }
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

  if (result.outcome === "NO_ACTION") {
    const actionableSymbolIndex = researchReport.analysis.symbolEvaluations
      .findIndex(({ disposition }) => disposition === "PROPOSE")
    if (actionableSymbolIndex >= 0) {
      return recordReportResolution({
        outcome: {
          outcomeVersion: RESEARCH_CYCLE_OUTCOME_VERSION,
          status: "DECISION_REJECTED",
          issues: [{
            code: "CONTEXT_INVALID",
            path: [
              "analysis",
              "symbolEvaluations",
              actionableSymbolIndex,
              "disposition",
            ],
          }],
        },
      })
    }
    const validation = await trace.run("research.decision.validate", () =>
      validateResearchDecisionV4(result, {
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

  if (!isProposedPortfolioReport(researchReport)) {
    throw new Error("Proposal path requires a proposed portfolio report")
  }

  const proposalResolution = await processResearchProposalPath({
    report: researchReport,
    symbolScreen,
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
