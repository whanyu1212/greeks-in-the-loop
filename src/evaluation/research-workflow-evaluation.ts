import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { createSqliteLedgerStore } from "../event-ledger/deprecated/sqlite-ledger-store.js"
import { createResearchLifecycleRecorder } from "../event-ledger/research-lifecycle-recorder.js"
import {
  ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE,
  type OptionQuoteProvider,
} from "../market-data/alpaca-option-quotes.js"
import type { OpenCodeInvocationSummary } from "../observability/opencode-telemetry-summary.js"
import type { RiskStateProvider } from "../risk/alpaca-risk-state-provider.js"
import {
  createLedgerDurableRiskControlStateLoader,
  createShadowRiskEvaluator,
} from "../risk/shadow-risk-service.js"
import type { ResearchEligibilityV1 } from "../scheduling/research-eligibility.js"
import { processResearchCycle } from "../research/cycle.js"
import {
  createResearchInvocationV1,
  RESEARCH_INVOCATION_PROVENANCE_BY_VERSION,
  RESEARCH_INVOCATION_VERSION,
} from "../research/invocation.js"
import { loadResearchRunV1 } from "../research/run/artifact.js"
import { writeResearchRunArtifacts } from "../research/run/presentation.js"
import { screenOptionUniverseV2 } from "../research/symbol-screen.js"
import { RESEARCH_EVALUATION_OPTION_UNIVERSE } from "./research-behavior-scenarios.js"

const cycleStartedAt = "2026-08-26T14:20:00.000Z"
const workflowEvaluatedAt = "2026-08-26T14:30:00.000Z"
const quoteProviderTimestamp = "2026-08-26T14:30:00.000000000Z"
const sessionDate = "2026-08-26"

const eligibility: ResearchEligibilityV1 = {
  evaluatedAt: cycleStartedAt,
  sessionDate,
  sessionOpen: "2026-08-26T13:30:00.000Z",
  sessionClose: "2026-08-26T20:00:00.000Z",
  researchEligible: true,
  tradeIntentEligible: true,
  tradeIntentWindow: {
    slotStartedAt: cycleStartedAt,
    deadline: "2026-08-27T14:20:00.000Z",
  },
  previousSessionDates: ["2026-08-24", "2026-08-25"],
  researchMode: "DRY_RUN",
}

const processingEligibility: ResearchEligibilityV1 = {
  ...eligibility,
  evaluatedAt: workflowEvaluatedAt,
}

const quoteFor = (
  contractSymbol: string,
  positionIntent: "BUY_TO_OPEN" | "SELL_TO_OPEN",
) => ({
  contractSymbol,
  feed: "INDICATIVE" as const,
  bidCentsPerShare: positionIntent === "BUY_TO_OPEN" ? 820 : 440,
  askCentsPerShare: positionIntent === "BUY_TO_OPEN" ? 840 : 460,
  providerTimestamp: quoteProviderTimestamp,
})

const quoteProvider: OptionQuoteProvider = {
  async confirmQuotes({ contractSymbols }) {
    return {
      success: true,
      snapshot: {
        snapshotVersion: "2.0.0",
        evaluatedAt: workflowEvaluatedAt,
        snapshotMetadata: {
          provider: "ALPACA",
          source: ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE,
          retrievedAt: workflowEvaluatedAt,
          freshUntil: "2026-08-26T14:31:00.000Z",
        },
        quotes: contractSymbols.map((contractSymbol, index) =>
          quoteFor(
            contractSymbol,
            index === 0 ? "BUY_TO_OPEN" : "SELL_TO_OPEN",
          )
        ),
      },
    }
  },
}

const riskStateProvider: RiskStateProvider = {
  async capture({ sessionDate, slotStartedAt, entryPlan }) {
    const quotes = entryPlan.legs.map(({ contractSymbol, positionIntent }) =>
      quoteFor(contractSymbol, positionIntent)
    )
    return {
      success: true,
      snapshot: {
        snapshotVersion: "2.0.0",
        evaluatedAt: workflowEvaluatedAt,
        quoteSnapshot: {
          snapshotVersion: "2.0.0",
          evaluatedAt: workflowEvaluatedAt,
          snapshotMetadata: {
            provider: "ALPACA",
            source: ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE,
            retrievedAt: workflowEvaluatedAt,
            freshUntil: "2026-08-26T14:31:00.000Z",
          },
          quotes,
        },
        account: {
          snapshotVersion: "2.0.0",
          observedAt: workflowEvaluatedAt,
          status: "ACTIVE",
          tradingRestricted: false,
          optionsApprovedLevel: 3,
          optionsTradingLevel: 3,
          multilegOptionsApproved: true,
          buyingPowerCents: 20_000_000,
          cashCents: 5_000_000,
          equityCents: 10_000_000,
          lastEquityCents: 10_000_000,
        },
        positions: [],
        candidateCollateral: {
          underlying: entryPlan.underlying,
          longUnderlyingShares: 0,
          cashAvailableCents: 5_000_000,
          requiredLongSharesPerUnit: 0,
          requiredCashCentsPerUnit: 0,
          maxUnitsFromShares: null,
          maxUnitsFromCash: null,
        },
        portfolio: {
          observedAt: workflowEvaluatedAt,
          consistent: true,
          openStrategyPositionCount: 0,
          pendingEntryCount: 0,
          entriesSubmittedToday: 0,
          dailyBreakerActive: false,
          competitionBreakerActive: false,
        },
        contracts: {
          snapshotVersion: "2.0.0",
          slotStartedAt,
          observedAt: workflowEvaluatedAt,
          legs: entryPlan.legs.map((leg) => {
            const put = leg.contractSymbol.at(-9) === "P"
            const magnitude = leg.positionIntent === "BUY_TO_OPEN" ? 0.52 : 0.29
            return {
              ...leg,
              active: true,
              tradable: true,
              exerciseStyle: "AMERICAN" as const,
              multiplier: 100,
              delta: put ? -magnitude : magnitude,
              impliedVolatility: leg.positionIntent === "BUY_TO_OPEN" ? 0.2 : 0.19,
              gamma: leg.positionIntent === "BUY_TO_OPEN" ? 0.02 : 0.015,
              theta: leg.positionIntent === "BUY_TO_OPEN" ? -0.1 : -0.08,
              vega: leg.positionIntent === "BUY_TO_OPEN" ? 0.15 : 0.12,
              volume: 200,
              volumeDate: sessionDate,
              openInterest: 1_000,
              openInterestDate: sessionDate,
            }
          }),
        },
        reconciliationReasonCodes: [],
      },
    }
  },
}

export type ResearchWorkflowEvaluationResult = Readonly<{
  outcome: string
  actionability: string
  evaluation: ReturnType<
    typeof import("../research/run/presentation.js").buildResearchRunPresentation
  >["evaluation"]
  runArtifactPath: string
  operatorBriefPath: string
}>

export async function runResearchWorkflowEvaluation(options: Readonly<{
  scenarioId: string
  rawResponse: string
  invocation: OpenCodeInvocationSummary
  outputRoot: string
}>): Promise<ResearchWorkflowEvaluationResult> {
  const ledgerRoot = await mkdtemp(join(tmpdir(), "greeks-research-workflow-eval-"))
  let currentTime = cycleStartedAt
  let nextId = 0
  const store = createSqliteLedgerStore({
    path: join(ledgerRoot, "ledger.sqlite"),
    knownCredentialValues: [],
    now: () => new Date(currentTime),
  })
  try {
    await store.migrate()
    const recorder = createResearchLifecycleRecorder({
      store,
      idFactory: () => `eval-${options.scenarioId}-${++nextId}`,
      now: () => new Date(currentTime),
    })
    const sessionId = `eval-${options.scenarioId}`
    const signal = new AbortController().signal
    await recorder.recordOpenCodeSessionStarted(sessionId, signal)
    const cycle = await recorder.startCycle({
      sessionId,
      cycleNumber: 1,
      sessionDate,
      initialEligibility: eligibility,
      signal,
    })
    currentTime = workflowEvaluatedAt
    const provenance =
      RESEARCH_INVOCATION_PROVENANCE_BY_VERSION[RESEARCH_INVOCATION_VERSION]
    const researchInvocation = createResearchInvocationV1(
      {
        agentName: provenance.agentName,
        cycleMode: "DRY_RUN",
        promptVersion: provenance.promptVersion,
        decisionContractVersion: provenance.decisionContractVersion,
        reportVersion: provenance.reportVersion,
      },
      options.invocation,
    )
    const shadowRiskEvaluator = createShadowRiskEvaluator({
      provider: riskStateProvider,
      durableControl: createLedgerDurableRiskControlStateLoader(store),
    })
    await processResearchCycle({
      rawResponse: options.rawResponse,
      cycleStartedAt: cycle.startedAt,
      optionUniverse: RESEARCH_EVALUATION_OPTION_UNIVERSE,
      symbolScreen: screenOptionUniverseV2(RESEARCH_EVALUATION_OPTION_UNIVERSE),
      signal,
      quoteProvider,
      shadowRiskEvaluator,
      outcomeSink: cycle.outcomeSink,
      getEligibility: () => processingEligibility,
      researchInvocation,
      now: () => new Date(workflowEvaluatedAt),
    })
    const run = await loadResearchRunV1(store, cycle.cycleId)
    const artifacts = await writeResearchRunArtifacts({
      run,
      root: join(options.outputRoot, options.scenarioId),
      overwrite: true,
    })
    return {
      outcome: run.outcome.status,
      actionability: artifacts.presentation.actionability,
      evaluation: artifacts.presentation.evaluation,
      runArtifactPath: relative(options.outputRoot, artifacts.jsonPath),
      operatorBriefPath: relative(options.outputRoot, artifacts.markdownPath),
    }
  } finally {
    await store.close()
    await rm(ledgerRoot, { recursive: true, force: true })
  }
}
