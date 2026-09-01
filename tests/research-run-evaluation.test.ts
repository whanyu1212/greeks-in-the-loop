import { describe, expect, it } from "vitest"

import {
  proposalQuoteSnapshotRef,
  type TradeProposalV3,
} from "../src/contracts/research-decision-v3.js"
import type { ResearchReportV6 } from "../src/contracts/research-report-v6.js"
import { deriveTradeIntentV3 } from "../src/contracts/trade-intent-v3.js"
import {
  evaluateResearchRunV1,
  researchRunEvaluationV1Schema,
} from "../src/evaluation/research-run-evaluation-v1.js"
import type { ResearchRunV1 } from "../src/research/research-artifact.js"

const SESSION_DATE = "2026-08-26"
const EXPIRATION = "2026-09-18"
const MARKET_OBSERVED_AT = "2026-08-26T14:33:00.000Z"
const INTENT_EVALUATED_AT = "2026-08-26T14:33:30.000Z"
const SNAPSHOT_REF = proposalQuoteSnapshotRef("SPY")

const cycle = {
  cycleId: "cycle-evaluation-1",
  cycleNumber: 1,
  correlationId: "correlation-evaluation-1",
  sessionId: "session-evaluation-1",
  startedAt: "2026-08-26T14:30:01.000Z",
  completedAt: "2026-08-26T14:34:00.000Z",
  sessionDate: SESSION_DATE,
} as const

const ledger = {
  firstSequence: 1,
  lastSequence: 8,
  terminalEventId: "terminal-evaluation-1",
} as const

const eligibility = {
  evaluatedAt: "2026-08-26T14:30:00.000Z",
  sessionDate: SESSION_DATE,
  sessionOpen: "2026-08-26T13:30:00.000Z",
  sessionClose: "2026-08-26T20:00:00.000Z",
  researchEligible: true,
  tradeIntentEligible: true,
  tradeIntentWindow: {
    slotStartedAt: "2026-08-26T14:30:00.000Z",
    deadline: "2026-08-26T14:35:00.000Z",
  },
  previousSessionDates: ["2026-08-24", "2026-08-25"],
  researchMode: "DRY_RUN",
} as const

const noActionDecision = () => ({
  contractVersion: "3.0.0" as const,
  outcome: "NO_ACTION" as const,
  reasonCodes: ["SIGNAL_NOT_ACTIONABLE" as const],
  evidence: [
    {
      claimId: "prior-close",
      kind: "SOURCED_FACT" as const,
      claim: "The completed-session evidence did not support a trade.",
      provider: "ALPACA" as const,
      temporalClass: "PRIOR_CLOSE" as const,
      observedAt: "2026-08-25T20:00:00.000Z",
    },
    {
      claimId: "derived-view",
      kind: "INFERENCE" as const,
      claim: "The retained setup is not actionable.",
      basedOn: ["prior-close"],
    },
  ],
})

const noActionReport = (): ResearchReportV6 => {
  const result = noActionDecision()
  return {
    reportVersion: "6.0.0",
    result,
    analysis: {
      provenance: "AGENT_REPORTED",
      asOf: "2026-08-26T14:33:00.000Z",
      accountChecks: {
        verification: "AGENT_REPORTED",
        observedAt: "2026-08-26T14:31:00.000Z",
        accountStatus: "ACTIVE",
        optionsTradingApproved: true,
        conflictingStrategyExposure: false,
      },
      symbolEvaluations: [],
      marketRegimes: [],
      optionSurfaces: [],
      candidateEvaluations: [],
      externalContext: [{
        sourceId: "exa-context",
        provider: "EXA",
        verification: "AGENT_REPORTED",
        title: "Current market context",
        url: "https://example.com/context",
        publishedAt: "2026-08-26T13:00:00.000Z",
        retrievedAt: "2026-08-26T14:32:00.000Z",
        summary: "Current context did not resolve the mixed setup.",
        relevance: "NEUTRAL",
      }],
      supportingFactors: [],
      contradictingFactors: [],
      conflicts: [],
    },
  }
}

const noActionRun = (): ResearchRunV1 => {
  const researchReport = noActionReport()
  const decision = researchReport.result
  if (decision.outcome !== "NO_ACTION") throw new Error("Expected no action")
  return {
    runVersion: "6.0.0",
    cycle,
    evidenceSnapshots: [],
    researchReport,
    validatedDecision: decision,
    outcome: {
      outcomeVersion: "3.0.0",
      status: "VALIDATED_NO_ACTION",
      decision,
    },
    ledger,
  }
}

const proposal: TradeProposalV3 = {
  priority: 1,
  direction: "BULLISH",
  thesis: "Daily and intraday evidence align for SPY.",
  candidate: {
    underlying: "SPY",
    structure: "BULL_CALL_SPREAD",
    expiration: EXPIRATION,
    longLeg: {
      contractSymbol: "SPY260918C00600000",
      strike: 600,
    },
    shortLeg: {
      contractSymbol: "SPY260918C00605000",
      strike: 605,
    },
  },
  invalidation: ["Reject if refreshed evidence changes the candidate."],
  evidence: [{
    claimId: "spy-quote-fact",
    kind: "SOURCED_FACT",
    claim: "Both exact option legs were present in the quote snapshot.",
    snapshotRef: SNAPSHOT_REF,
  }],
}

const portfolioReport = (): ResearchReportV6 => ({
  reportVersion: "6.0.0",
  result: {
    contractVersion: "3.0.0",
    outcome: "PROPOSE_TRADES",
    proposals: [proposal],
  },
  analysis: {
    provenance: "AGENT_REPORTED",
    asOf: MARKET_OBSERVED_AT,
    optionUniverse: {
      snapshotVersion: "2.0.0",
      policyVersion: "5.0.0",
      snapshotId: `option-universe-v2-${"d".repeat(64)}`,
      generatedAt: "2026-08-26T14:30:00.000Z",
      sessionDate: SESSION_DATE,
      source: "ALPACA_OPTIONS_SCREENERS",
      candidates: ["SPY", "QQQ", "IWM"].map((underlying, index) => ({
        rank: index + 1,
        underlying,
        activityRank: index + 1,
        optionLiquidity: {
          expirationCount: 2,
          viableSeriesCount: 4,
          liquidSeriesCount: 3,
          contractCount: 40,
          liquidContractCount: 24,
          totalOpenInterest: 24_000,
          openInterestCoverage: 1,
        },
      })),
    },
    accountChecks: {
      verification: "AGENT_REPORTED",
      observedAt: "2026-08-26T14:31:00.000Z",
      accountStatus: "ACTIVE",
      optionsTradingApproved: true,
      conflictingStrategyExposure: false,
    },
    broadMarketContext: {
      verification: "AGENT_REPORTED",
      temporalClass: "LIVE",
      observedAt: MARKET_OBSERVED_AT,
      benchmark: "SPY",
      signal: "BULLISH",
      dailyClose: 610,
      sma20: 605,
      sma50: 600,
      realizedVolatility20: 0.18,
    },
    symbolEvaluations: [
      {
        underlying: "SPY",
        disposition: "PROPOSE",
        direction: "BULLISH",
        summary: "SPY was retained for deep research.",
      },
      {
        underlying: "QQQ",
        disposition: "WATCH",
        direction: "NEUTRAL",
        summary: "QQQ remained below the finalist cutoff.",
      },
      {
        underlying: "IWM",
        disposition: "REJECT",
        direction: "NEUTRAL",
        summary: "IWM did not retain an actionable setup.",
      },
    ],
    marketRegimes: [{
      verification: "AGENT_REPORTED",
      temporalClass: "LIVE",
      observedAt: MARKET_OBSERVED_AT,
      signal: "BULLISH",
      underlying: "SPY",
      dailyClose: 610,
      sma20: 605,
      sma50: 600,
      sessionVwap: 608,
      spotMidpoint: 611,
      gapPercent: 0.005,
      distanceFromSma20: 0.01,
      distanceFromSessionVwap: 0.005,
      intradayRealizedVolatility: 0.22,
      dailySessionCount: 50,
      intradayBarCount: 63,
    }],
    symbolIndicators: ["SPY", "QQQ", "IWM"].map((underlying, index) => ({
      underlying,
      throughSessionDate: "2026-08-25",
      return5d: 0.03 - index * 0.01,
      return20d: 0.06 - index * 0.02,
      relativeStrengthRank20d: index + 1,
      realizedVolatility20: 0.2 + index * 0.01,
      completedSessionVolumeRatio20: 1.1,
      atrPercent20: 0.02,
      ewmaRealizedVolatility20: 0.2 + index * 0.01,
      sma20Slope5d: 0.005,
      completedSessionDollarVolumeRatio20: 1.1,
      rangePosition20: 0.8,
    })),
    optionSurfaces: [{
      verification: "AGENT_REPORTED",
      observedAt: MARKET_OBSERVED_AT,
      underlying: "SPY",
      expiration: EXPIRATION,
      feed: "INDICATIVE",
      atmImpliedVolatility: 0.3,
      forecastRealizedVolatility: 0.2,
      ivRvVarianceSpread: 0.05,
      impliedMovePercent: 0.04,
      termStructureSlope: 0.01,
      putCallSkew25Delta: 0.02,
      verticalLegIvDifference: 0.01,
      smileCurvature: 0.015,
      quoteCoverage: 1,
      eventRisk: {
        verification: "AGENT_REPORTED",
        status: "CLEAR",
        eventBeforeExpiration: false,
        macroEvents: [],
      },
    }],
    candidateEvaluations: [{
      verification: "AGENT_REPORTED",
      observedAt: MARKET_OBSERVED_AT,
      underlying: "SPY",
      expiration: EXPIRATION,
      dte: 23,
      legs: [
        {
          role: "LONG",
          contractSymbol: "SPY260918C00600000",
          delta: 0.52,
          impliedVolatility: 0.3,
          gamma: 0.02,
          theta: -0.1,
          vega: 0.15,
          volume: 200,
          openInterest: 1_000,
          openInterestDate: "2026-08-25",
        },
        {
          role: "SHORT",
          contractSymbol: "SPY260918C00605000",
          delta: 0.29,
          impliedVolatility: 0.29,
          gamma: 0.015,
          theta: -0.08,
          vega: 0.12,
          volume: 180,
          openInterest: 900,
          openInterestDate: "2026-08-25",
        },
      ],
      spreadGreeks: {
        calculation: "LONG_MINUS_SHORT",
        netDelta: 0.23,
        netGamma: 0.005,
        netTheta: -0.02,
        netVega: 0.03,
      },
    }],
    externalContext: [{
      sourceId: "exa-proposal-context",
      provider: "EXA",
      verification: "AGENT_REPORTED",
      title: "Current proposal context",
      url: "https://example.com/proposal-context",
      publishedAt: "2026-08-26T13:00:00.000Z",
      retrievedAt: "2026-08-26T14:32:00.000Z",
      summary: "Current context supports the bounded proposal.",
      relevance: "SUPPORTS",
    }],
    supportingFactors: ["Trend and participation align."],
    contradictingFactors: [],
    conflicts: [],
  },
})

const portfolioRun = (): ResearchRunV1 => {
  const report = portfolioReport()
  if (report.result.outcome !== "PROPOSE_TRADES") {
    throw new Error("Expected a portfolio report")
  }
  const derived = deriveTradeIntentV3(proposal, {
    quoteSnapshotRef: SNAPSHOT_REF,
    evaluatedAt: INTENT_EVALUATED_AT,
    longQuote: {
      contractSymbol: proposal.candidate.longLeg.contractSymbol,
      feed: "INDICATIVE",
      bidCentsPerShare: 300,
      askCentsPerShare: 310,
      providerTimestamp: "2026-08-26T14:33:29.000000000Z",
    },
    shortQuote: {
      contractSymbol: proposal.candidate.shortLeg.contractSymbol,
      feed: "INDICATIVE",
      bidCentsPerShare: 100,
      askCentsPerShare: 110,
      providerTimestamp: "2026-08-26T14:33:29.000000000Z",
    },
  })
  if (!derived.success) throw new Error("Expected a derived intent")
  return {
    runVersion: "6.0.0",
    cycle,
    initialEligibility: eligibility,
    evidenceSnapshots: [{
      snapshotRef: SNAPSHOT_REF,
      provider: "ALPACA",
      source: "options-snapshots-indicative",
      retrievedAt: INTENT_EVALUATED_AT,
      freshUntil: "2026-08-26T14:34:29.000Z",
      temporalClass: "LIVE",
    }],
    researchReport: report,
    validatedDecision: report.result,
    outcome: {
      outcomeVersion: "3.0.0",
      status: "PORTFOLIO_EVALUATED",
      decision: report.result,
      intents: [derived.intent],
      selectedUnderlyings: ["SPY"],
    },
    ledger,
  }
}

const issuesFor = (run: ResearchRunV1) => {
  const evaluation = evaluateResearchRunV1(run)
  return Object.values(evaluation.dimensions).flatMap(
    ({ issueCodes }) => issueCodes,
  )
}

describe("evaluateResearchRunV1", () => {
  it("returns a bounded, prose-free evaluation for current no-action runs", () => {
    const evaluation = evaluateResearchRunV1(noActionRun())

    expect(researchRunEvaluationV1Schema.parse(evaluation)).toEqual(evaluation)
    expect(evaluation.evaluationVersion).toBe("2.0.0")
    expect(evaluation.dimensions).toMatchObject({
      contractCompliance: { status: "PASS" },
      temporalIntegrity: { status: "PASS" },
      grounding: { status: "PASS" },
      candidateIdentity: { status: "NOT_APPLICABLE" },
      failClosedBehavior: { status: "PASS" },
    })
    expect(evaluation.metrics).toMatchObject({
      sourcedFactCount: 1,
      inferenceCount: 1,
      groundedInferenceCount: 1,
      exaSourceCount: 1,
    })
    expect(JSON.stringify(evaluation)).not.toContain("completed-session evidence")
  })

  it("passes every dimension for a current evaluated portfolio", () => {
    const evaluation = evaluateResearchRunV1(portfolioRun())

    expect(Object.values(evaluation.dimensions).map(({ status }) => status)).toEqual([
      "PASS",
      "PASS",
      "PASS",
      "PASS",
      "PASS",
    ])
    expect(evaluation.metrics.snapshotReferenceCount).toBe(2)
  })

  it("detects report, retained decision, and outcome mismatches", () => {
    const source = noActionRun()
    if (source.outcome.status !== "VALIDATED_NO_ACTION") {
      throw new Error("Expected a no-action run")
    }
    const changedDecision = {
      ...source.outcome.decision,
      reasonCodes: ["MARKET_WINDOW_INELIGIBLE" as const],
    }
    const run = {
      ...source,
      validatedDecision: changedDecision,
    } as ResearchRunV1

    expect(issuesFor(run)).toEqual(expect.arrayContaining([
      "REPORT_RESULT_MISMATCH",
      "OUTCOME_RECORD_MISMATCH",
    ]))
  })

  it("detects invalid cycle and report timestamps", () => {
    const source = noActionRun()
    const run = {
      ...source,
      cycle: {
        ...source.cycle,
        startedAt: "2026-08-26T14:35:00.000Z",
        completedAt: "2026-08-26T14:34:00.000Z",
      },
    } as ResearchRunV1

    expect(issuesFor(run)).toContain("CYCLE_TIME_RANGE_INVALID")
  })

  it("detects ungrounded and unknown evidence references", () => {
    const source = portfolioRun()
    if (source.researchReport?.result.outcome !== "PROPOSE_TRADES") {
      throw new Error("Expected a portfolio report")
    }
    const changedResult = {
      ...source.researchReport.result,
      proposals: [{
        ...source.researchReport.result.proposals[0]!,
        evidence: [
          source.researchReport.result.proposals[0]!.evidence[0]!,
          {
            claimId: "unsupported-inference",
            kind: "INFERENCE" as const,
            claim: "This inference has no retained source.",
            basedOn: ["missing-source"],
          },
        ],
      }],
    }
    const run = {
      ...source,
      researchReport: { ...source.researchReport, result: changedResult },
      validatedDecision: changedResult,
      outcome: { ...source.outcome, decision: changedResult },
      evidenceSnapshots: [],
    } as ResearchRunV1

    expect(issuesFor(run)).toEqual(expect.arrayContaining([
      "UNGROUNDED_INFERENCE",
      "UNKNOWN_SNAPSHOT_REFERENCE",
    ]))
  })

  it("detects candidate identity drift", () => {
    const source = portfolioRun()
    if (source.outcome.status !== "PORTFOLIO_EVALUATED") {
      throw new Error("Expected an evaluated portfolio")
    }
    const intent = source.outcome.intents[0]!
    const run = {
      ...source,
      outcome: {
        ...source.outcome,
        intents: [{ ...intent, shortContractSymbol: intent.longContractSymbol }],
      },
    } as ResearchRunV1

    expect(issuesFor(run)).toContain("CANDIDATE_IDENTITY_MISMATCH")
  })

  it("fails closed when retained trade-window context is missing", () => {
    const { initialEligibility: _eligibility, ...run } = portfolioRun()

    expect(issuesFor(run as ResearchRunV1)).toContain(
      "INTENT_ELIGIBILITY_CONTEXT_MISSING",
    )
  })

  it("flags malformed invocation metadata without retaining raw values", () => {
    const run = {
      ...noActionRun(),
      researchInvocation: {
        invocationVersion: "invalid",
      },
    } as unknown as ResearchRunV1
    const evaluation = evaluateResearchRunV1(run)

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "RUN_METADATA_INVALID",
    )
    expect(JSON.stringify(evaluation)).not.toContain("invalid")
  })
})
