import { describe, expect, it, vi } from "vitest"

import { proposalQuoteSnapshotRef } from "../src/contracts/research-decision-v3.js"
import type { OptionUniverseSnapshotV2 } from "../src/contracts/option-universe-v2.js"
import { researchReportV7Schema } from "../src/contracts/research-report-v7.js"
import type { OptionQuoteProvider } from "../src/market-data/alpaca-option-quotes.js"
import { OPTION_STRATEGIES } from "../src/options/strategy.js"
import type { ShadowRiskEvaluator } from "../src/risk/shadow-risk-service.js"
import type { ResearchEligibilityV1 } from "../src/scheduling/research-eligibility.js"
import type {
  ResearchCycleOutcomeSink,
  ResearchCycleTerminalRecordV3,
  ResearchCycleTerminalRecordV4,
} from "../src/research/cycle/outcome.js"
import { processResearchCycle } from "../src/research/cycle.js"
import type { ResearchInvocationV1 } from "../src/research/invocation.js"
import {
  screenOptionUniverseV2,
  type SymbolScreenResultV2,
} from "../src/research/symbol-screen.js"

const underlyings = ["SPY", "QQQ", "NVDA"] as const
const observedAt = "2026-08-26T14:30:00.000Z"
const evaluatedAt = "2026-08-26T14:30:30.000Z"
const expiration = "2026-09-18"

const optionUniverse: OptionUniverseSnapshotV2 = {
  snapshotVersion: "2.0.0",
  policyVersion: "5.0.0",
  snapshotId: `option-universe-v2-${"a".repeat(64)}`,
  generatedAt: "2026-08-26T14:20:00.000Z",
  sessionDate: "2026-08-26",
  source: "ALPACA_OPTIONS_SCREENERS",
  candidates: underlyings.map((underlying, index) => ({
    rank: index + 1,
    underlying,
    activityRank: index + 1,
    sessionPercentChange: 4 - index,
    optionLiquidity: {
      expirationCount: 2,
      viableSeriesCount: 5 - index,
      liquidSeriesCount: 4 - index,
      contractCount: 50 - index * 5,
      liquidContractCount: 30 - index * 4,
      totalOpenInterest: 30_000 - index * 5_000,
      openInterestCoverage: 1,
    },
  })),
}

const invocation: ResearchInvocationV1 = {
  invocationVersion: "7.0.0",
  agentName: "research",
  cycleMode: "DRY_RUN",
  promptVersion: "7.0.0",
  decisionContractVersion: "4.0.0",
  reportVersion: "7.0.0",
  providerId: "openai",
  modelId: "gpt-5.6-sol",
  responseError: false,
  tokens: {},
  tools: {
    totalCount: 0,
    errorCount: 0,
    incompleteCount: 0,
    omittedCount: 0,
    calls: [],
  },
}

const eligibility: ResearchEligibilityV1 = {
  evaluatedAt,
  sessionDate: "2026-08-26",
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
}

const symbols = (underlying: string) => ({
  long: `${underlying}260918C00600000`,
  short: `${underlying}260918C00605000`,
})

const proposal = (underlying: string, priority: number) => {
  const contracts = symbols(underlying)
  return {
    priority,
    direction: "BULLISH" as const,
    thesis: `${underlying} has aligned daily and intraday evidence.`,
    candidate: {
      underlying,
      strategy: "BULL_CALL_SPREAD" as const,
      legs: [
        {
          contractSymbol: contracts.long,
          positionIntent: "BUY_TO_OPEN" as const,
          ratioQuantity: 1,
        },
        {
          contractSymbol: contracts.short,
          positionIntent: "SELL_TO_OPEN" as const,
          ratioQuantity: 1,
        },
      ],
    },
    invalidation: ["Reject if refreshed evidence changes the candidate."],
    evidence: [{
      claimId: `${underlying.toLowerCase()}-quote-fact`,
      kind: "SOURCED_FACT" as const,
      claim: "The application-owned quote snapshot contains both exact legs.",
      snapshotRef: proposalQuoteSnapshotRef(underlying),
    }],
  }
}

const indicator = (underlying: string, index: number) => ({
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
})

const marketRegime = (underlying: string) => ({
  verification: "AGENT_REPORTED" as const,
  temporalClass: "LIVE" as const,
  observedAt,
  signal: "BULLISH" as const,
  underlying,
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
  intradayBarCount: 60,
})

const surface = (underlying: string, index: number) => {
  const forecast = 0.2 + index * 0.01
  const atm = 0.3
  return {
    verification: "AGENT_REPORTED" as const,
    observedAt,
    underlying,
    expiration,
    feed: "INDICATIVE" as const,
    atmImpliedVolatility: atm,
    forecastRealizedVolatility: forecast,
    ivRvVarianceSpread: atm ** 2 - forecast ** 2,
    impliedMovePercent: 0.04,
    termStructureSlope: 0.01,
    putCallSkew25Delta: 0.02,
    verticalLegIvDifference: 0.01,
    smileCurvature: 0.015,
    quoteCoverage: 1,
    eventRisk: {
      verification: "AGENT_REPORTED" as const,
      status: "CLEAR" as const,
      eventBeforeExpiration: false,
      macroEvents: [],
    },
  }
}

const candidateEvaluation = (underlying: string) => {
  const contracts = symbols(underlying)
  return {
    verification: "AGENT_REPORTED" as const,
    observedAt,
    underlying,
    legs: [
      {
        contractSymbol: contracts.long,
        positionIntent: "BUY_TO_OPEN" as const,
        ratioQuantity: 1,
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
        contractSymbol: contracts.short,
        positionIntent: "SELL_TO_OPEN" as const,
        ratioQuantity: 1,
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
    aggregateGreeks: {
      calculation: "POSITION_WEIGHTED_SUM" as const,
      netDelta: 0.23,
      netGamma: 0.005,
      netTheta: -0.02,
      netVega: 0.03,
    },
  }
}

const proposalReport = (count = 3) => {
  const finalists = underlyings.slice(0, count)
  return {
    reportVersion: "7.0.0" as const,
    result: {
      contractVersion: "4.0.0" as const,
      outcome: "PROPOSE_TRADES" as const,
      proposals: finalists.map((underlying, index) =>
        proposal(underlying, index + 1)
      ),
    },
    analysis: {
      provenance: "AGENT_REPORTED" as const,
      asOf: "2026-08-26T14:30:20.000Z",
      optionUniverse,
      accountChecks: {
        verification: "AGENT_REPORTED" as const,
        observedAt,
        accountStatus: "ACTIVE" as const,
        optionsTradingApproved: true,
        conflictingStrategyExposure: false,
      },
      broadMarketContext: {
        verification: "AGENT_REPORTED" as const,
        temporalClass: "LIVE" as const,
        observedAt,
        benchmark: "SPY",
        signal: "BULLISH" as const,
        dailyClose: 610,
        sma20: 605,
        sma50: 600,
        realizedVolatility20: 0.18,
      },
      symbolEvaluations: underlyings.map((underlying) => ({
        underlying,
        disposition: finalists.includes(underlying) ? "PROPOSE" as const : "WATCH" as const,
        direction: "BULLISH" as const,
        summary: finalists.includes(underlying)
          ? "Retained for deep research."
          : "Valid but below the finalist cutoff.",
      })),
      marketRegimes: finalists.map(marketRegime),
      symbolIndicators: underlyings.map(indicator),
      optionSurfaces: finalists.map((underlying) =>
        surface(underlying, underlyings.indexOf(underlying))
      ),
      candidateEvaluations: finalists.map(candidateEvaluation),
      externalContext: [{
        sourceId: "exa-current",
        provider: "EXA" as const,
        verification: "AGENT_REPORTED" as const,
        title: "Current market context",
        url: "https://example.com/current-context",
        publishedAt: "2026-08-26T13:00:00.000Z",
        retrievedAt: "2026-08-26T14:29:00.000Z",
        summary: "Current context includes both support and bounded downside risk.",
        relevance: "NEUTRAL" as const,
      }],
      supportingFactors: ["Trend and participation align."],
      contradictingFactors: ["Event and volatility risks were checked."],
      conflicts: [],
    },
  }
}

const noActionReport = () => ({
  reportVersion: "7.0.0" as const,
  result: {
    contractVersion: "4.0.0" as const,
    outcome: "NO_ACTION" as const,
    reasonCodes: ["SIGNAL_NOT_ACTIONABLE" as const],
    evidence: [{
      claimId: "mixed",
      kind: "SOURCED_FACT" as const,
      claim: "The symbol comparisons did not retain an actionable setup.",
      provider: "ALPACA" as const,
      temporalClass: "LIVE" as const,
      observedAt,
    }],
  },
  analysis: {
    provenance: "AGENT_REPORTED" as const,
    asOf: "2026-08-26T14:30:20.000Z",
    optionUniverse,
    accountChecks: {
      verification: "AGENT_REPORTED" as const,
      observedAt,
      accountStatus: "ACTIVE" as const,
      optionsTradingApproved: true,
      conflictingStrategyExposure: false,
    },
    symbolEvaluations: underlyings.map((underlying) => ({
      underlying,
      disposition: "WATCH" as const,
      direction: "NEUTRAL" as const,
      summary: "No actionable setup survived.",
    })),
    marketRegimes: [],
    symbolIndicators: underlyings.map(indicator),
    optionSurfaces: [],
    candidateEvaluations: [],
    externalContext: [{
      sourceId: "exa-current",
      provider: "EXA" as const,
      verification: "AGENT_REPORTED" as const,
      title: "Current market context",
      url: "https://example.com/current-context",
      publishedAt: "2026-08-26T13:00:00.000Z",
      retrievedAt: "2026-08-26T14:29:00.000Z",
      summary: "Current context did not resolve the mixed setup.",
      relevance: "NEUTRAL" as const,
    }],
    supportingFactors: [],
    contradictingFactors: [],
    conflicts: [],
  },
})

const quoteProvider: OptionQuoteProvider = {
  async confirmQuotes({ contractSymbols }) {
    const [longContractSymbol, shortContractSymbol] = contractSymbols
    return {
      success: true,
      snapshot: {
        snapshotVersion: "2.0.0",
        evaluatedAt: "2026-08-26T14:30:40.000Z",
        snapshotMetadata: {
          provider: "ALPACA",
          source: "options-snapshots-indicative",
          retrievedAt: "2026-08-26T14:30:40.000Z",
          freshUntil: "2026-08-26T14:31:40.000Z",
        },
        quotes: [
          {
            contractSymbol: longContractSymbol!,
            feed: "INDICATIVE",
            bidCentsPerShare: 300,
            askCentsPerShare: 310,
            providerTimestamp: "2026-08-26T14:30:35.000000000Z",
          },
          {
            contractSymbol: shortContractSymbol!,
            feed: "INDICATIVE",
            bidCentsPerShare: 100,
            askCentsPerShare: 110,
            providerTimestamp: "2026-08-26T14:30:35.000000000Z",
          },
        ],
      },
    }
  },
}

const approvedRisk = {
  evaluate: vi.fn(async ({ sourceIntent }) => ({
    decision: {
      stage: "EVALUATED",
      outcome: "APPROVED",
      evaluatedIntent: sourceIntent,
      evaluation: { outcome: "APPROVED" },
    },
    breakerTransitions: [],
  })),
} as unknown as ShadowRiskEvaluator

const run = async (
  report: unknown,
  options: Readonly<{
    universe?: OptionUniverseSnapshotV2
    screen?: SymbolScreenResultV2
    quotes?: OptionQuoteProvider
    risk?: ShadowRiskEvaluator
  }> = {},
) => {
  const records: Array<
    ResearchCycleTerminalRecordV3 | ResearchCycleTerminalRecordV4
  > = []
  const selectedUniverse = options.universe ?? optionUniverse
  const outcomeSink: ResearchCycleOutcomeSink = {
    async record(record) {
      records.push(record)
    },
  }
  const processed = await processResearchCycle({
    rawResponse: typeof report === "string" ? report : JSON.stringify(report),
    cycleStartedAt: "2026-08-26T14:28:00.000Z",
    optionUniverse: selectedUniverse,
    symbolScreen: options.screen ?? screenOptionUniverseV2(selectedUniverse),
    signal: new AbortController().signal,
    quoteProvider: options.quotes ?? quoteProvider,
    shadowRiskEvaluator: options.risk ?? approvedRisk,
    outcomeSink,
    getEligibility: () => eligibility,
    researchInvocation: invocation,
    now: () => new Date("2026-08-26T14:31:00.000Z"),
  })
  return { processed, records }
}

describe("processResearchCycle", () => {
  it("records a validated no-action decision without quote or risk work", async () => {
    const quotes = { confirmQuotes: vi.fn() }
    const risk = { evaluate: vi.fn() }
    const { processed, records } = await run(noActionReport(), {
      quotes: quotes as unknown as OptionQuoteProvider,
      risk: risk as unknown as ShadowRiskEvaluator,
    })

    expect(processed.outcome.status).toBe("VALIDATED_NO_ACTION")
    expect(quotes.confirmQuotes).not.toHaveBeenCalled()
    expect(risk.evaluate).not.toHaveBeenCalled()
    expect(records).toHaveLength(1)
    expect(records[0]!.symbolScreen).toMatchObject({
      screenVersion: "2.0.0",
      policyVersion: "5.0.0",
      mode: "SHADOW",
      universeSnapshotId: optionUniverse.snapshotId,
      symbols: underlyings.map((underlying) => ({
        underlying,
        strategies: expect.arrayContaining([{
          strategy: "BULL_CALL_SPREAD",
          actionability: "ACTIONABLE",
          reasonCodes: [],
        }]),
      })),
    })
  })

  it("rejects overall no-action when a symbol is marked actionable", async () => {
    const report = noActionReport()
    const inconsistentReport = {
      ...report,
      analysis: {
        ...report.analysis,
        symbolEvaluations: report.analysis.symbolEvaluations.map(
          (evaluation, index) => index === 1
            ? {
                ...evaluation,
                disposition: "PROPOSE" as const,
                direction: "BULLISH" as const,
              }
            : evaluation,
        ),
      },
    }
    const quotes = { confirmQuotes: vi.fn() }
    const risk = { evaluate: vi.fn() }
    const { processed } = await run(inconsistentReport, {
      quotes: quotes as unknown as OptionQuoteProvider,
      risk: risk as unknown as ShadowRiskEvaluator,
    })

    expect(processed.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{
        code: "CONTEXT_INVALID",
        path: ["analysis", "symbolEvaluations", 1, "disposition"],
      }],
    })
    expect(quotes.confirmQuotes).not.toHaveBeenCalled()
    expect(risk.evaluate).not.toHaveBeenCalled()
  })

  it("evaluates up to three proposals and uses priority to break equal quality", async () => {
    const parsedReport = researchReportV7Schema.safeParse(proposalReport(3))
    if (!parsedReport.success) throw new Error(JSON.stringify(parsedReport.error.issues))
    const risk = {
      evaluate: vi.fn(async ({ sourceIntent }) => ({
        decision: {
          stage: "EVALUATED",
          outcome: "APPROVED",
          evaluatedIntent: sourceIntent,
          evaluation: { outcome: "APPROVED" },
        },
        breakerTransitions: [],
      })),
    } as unknown as ShadowRiskEvaluator
    const { processed, records } = await run(proposalReport(3), { risk })

    expect(processed.outcome.status).toBe("PORTFOLIO_EVALUATED")
    if (processed.outcome.status !== "PORTFOLIO_EVALUATED") return
    expect(processed.outcome.proposals).toHaveLength(3)
    expect(processed.outcome.proposals.map((item) =>
      item.status === "RISK_EVALUATED" ? item.selected : false
    )).toEqual([true, false, false])
    expect(risk.evaluate).toHaveBeenCalledTimes(3)
    expect(records[0]?.evidenceSnapshots).toHaveLength(3)
  })

  it("rejects V7 proposals that omit required deep-research gates", () => {
    const report = proposalReport(1)
    const expectRejectedAt = (
      input: unknown,
      path: readonly (string | number)[],
    ) => {
      const parsed = researchReportV7Schema.safeParse(input)
      expect(parsed.success).toBe(false)
      if (parsed.success) throw new Error("Expected V7 proposal rejection")
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path }))
    }

    expectRejectedAt({
      ...report,
      analysis: { ...report.analysis, externalContext: [] },
    }, ["analysis", "externalContext"])
    expectRejectedAt({
      ...report,
      analysis: { ...report.analysis, optionSurfaces: [] },
    }, ["analysis", "optionSurfaces"])

    const {
      ewmaRealizedVolatility20: _ewmaRealizedVolatility20,
      ...incompleteIndicator
    } = report.analysis.symbolIndicators[0]!
    expectRejectedAt({
      ...report,
      analysis: {
        ...report.analysis,
        symbolIndicators: [
          incompleteIndicator,
          ...report.analysis.symbolIndicators.slice(1),
        ],
      },
    }, ["analysis", "symbolIndicators", 0, "ewmaRealizedVolatility20"])

    expectRejectedAt({
      ...report,
      analysis: {
        ...report.analysis,
        optionSurfaces: [{
          ...report.analysis.optionSurfaces[0]!,
          eventRisk: {
            verification: "AGENT_REPORTED",
            status: "UNKNOWN",
            macroEvents: [],
          },
        }],
      },
    }, ["analysis", "optionSurfaces", 0, "eventRisk"])
  })

  it("rejects a proposal not marked actionable by the application screen", async () => {
    const screen = screenOptionUniverseV2(optionUniverse)
    const blockedScreen: SymbolScreenResultV2 = {
      ...screen,
      symbols: screen.symbols.map((entry, symbolIndex) => symbolIndex === 0
        ? {
            ...entry,
            strategies: entry.strategies.map((assessment) =>
              assessment.strategy === "BULL_CALL_SPREAD"
                ? {
                    ...assessment,
                    actionability: "WATCH" as const,
                    reasonCodes: ["SESSION_MOVE_BELOW_THRESHOLD" as const],
                  }
                : assessment
            ),
          }
        : entry),
    }
    const quotes = { confirmQuotes: vi.fn() }
    const risk = { evaluate: vi.fn() }
    const { processed } = await run(proposalReport(1), {
      screen: blockedScreen,
      quotes: quotes as unknown as OptionQuoteProvider,
      risk: risk as unknown as ShadowRiskEvaluator,
    })

    expect(processed.outcome.status).toBe("PORTFOLIO_EVALUATED")
    if (processed.outcome.status !== "PORTFOLIO_EVALUATED") return
    expect(processed.outcome.proposals[0]).toMatchObject({
      underlying: "SPY",
      status: "DECISION_REJECTED",
      issues: [{
        code: "CONTEXT_INVALID",
        path: [
          "symbolScreen",
          "symbols",
          0,
          "strategies",
          OPTION_STRATEGIES.indexOf("BULL_CALL_SPREAD"),
          "actionability",
        ],
      }],
    })
    expect(quotes.confirmQuotes).not.toHaveBeenCalled()
    expect(risk.evaluate).not.toHaveBeenCalled()
  })

  it("selects the best refreshed execution quality instead of agent priority", async () => {
    const quotes: OptionQuoteProvider = {
      async confirmQuotes(input) {
        const [longContractSymbol, shortContractSymbol] = input.contractSymbols
        const underlying = longContractSymbol!.slice(0, -15)
        const quoteWidth = underlying === "QQQ" ? 5 : underlying === "NVDA" ? 10 : 20
        return {
          success: true,
          snapshot: {
            snapshotVersion: "2.0.0",
            evaluatedAt: "2026-08-26T14:30:40.000Z",
            snapshotMetadata: {
              provider: "ALPACA",
              source: "options-snapshots-indicative",
              retrievedAt: "2026-08-26T14:30:40.000Z",
              freshUntil: "2026-08-26T14:31:40.000Z",
            },
            quotes: [
              {
                contractSymbol: longContractSymbol!,
                feed: "INDICATIVE",
                bidCentsPerShare: 300,
                askCentsPerShare: 300 + quoteWidth,
                providerTimestamp: "2026-08-26T14:30:35.000000000Z",
              },
              {
                contractSymbol: shortContractSymbol!,
                feed: "INDICATIVE",
                bidCentsPerShare: 100,
                askCentsPerShare: 100 + quoteWidth,
                providerTimestamp: "2026-08-26T14:30:35.000000000Z",
              },
            ],
          },
        }
      },
    }
    const { processed } = await run(proposalReport(3), { quotes })

    expect(processed.outcome.status).toBe("PORTFOLIO_EVALUATED")
    if (processed.outcome.status !== "PORTFOLIO_EVALUATED") return
    expect(processed.outcome.proposals.map((item) =>
      item.status === "RISK_EVALUATED" ? item.selected : false
    )).toEqual([false, true, false])
  })

  it("rejects a proposal whose symbol-level direction does not match", async () => {
    const report = proposalReport(3)
    const mismatchedReport = {
      ...report,
      analysis: {
        ...report.analysis,
        symbolEvaluations: report.analysis.symbolEvaluations.map(
          (evaluation, index) => index === 1
            ? { ...evaluation, direction: "BEARISH" as const }
            : evaluation,
        ),
      },
    }
    const { processed } = await run(mismatchedReport)

    expect(processed.outcome.status).toBe("PORTFOLIO_EVALUATED")
    if (processed.outcome.status !== "PORTFOLIO_EVALUATED") return
    expect(processed.outcome.proposals[1]).toMatchObject({
      underlying: "QQQ",
      status: "DECISION_REJECTED",
      issues: [{
        code: "CONTEXT_INVALID",
        path: ["analysis", "symbolEvaluations", 1, "direction"],
      }],
    })
  })

  it("keeps a failed quote as a per-symbol disposition and continues", async () => {
    const quotes: OptionQuoteProvider = {
      confirmQuotes: vi.fn(async (input) =>
        input.contractSymbols[0]?.startsWith("QQQ")
          ? { success: false as const, reasons: ["QUOTE_REQUEST_FAILED" as const] }
          : quoteProvider.confirmQuotes(input)
      ),
    }
    const { processed } = await run(proposalReport(3), { quotes })

    expect(processed.outcome.status).toBe("PORTFOLIO_EVALUATED")
    if (processed.outcome.status !== "PORTFOLIO_EVALUATED") return
    expect(processed.outcome.proposals.map(({ underlying, status }) => ({
      underlying,
      status,
    }))).toEqual([
      { underlying: "SPY", status: "RISK_EVALUATED" },
      { underlying: "QQQ", status: "INTENT_DERIVATION_REJECTED" },
      { underlying: "NVDA", status: "RISK_EVALUATED" },
    ])
  })

  it("rejects malformed output before downstream work", async () => {
    const { processed, records } = await run("not json")
    expect(processed.outcome).toEqual({
      outcomeVersion: "4.0.0",
      status: "DECISION_REJECTED",
      issues: [{ code: "MALFORMED_JSON", path: [] }],
    })
    expect(records).toHaveLength(1)
  })

  it("rejects a report that does not echo the application universe", async () => {
    const differentUniverse = {
      ...optionUniverse,
      snapshotId: `option-universe-v2-${"b".repeat(64)}`,
    }
    const { processed } = await run(noActionReport(), {
      universe: differentUniverse,
    })
    expect(processed.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{ code: "CONTEXT_INVALID", path: ["analysis", "optionUniverse"] }],
    })
  })
})
