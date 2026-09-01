import { describe, expect, it } from "vitest"

import { researchReportV6Schema } from "../src/contracts/research-report-v6.js"
import {
  parseResearchReportV6Response,
  repairResearchReportV6ResponseOnce,
} from "../src/research/research-cycle.js"
import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"

const noAction = {
  reportVersion: "6.0.0",
  result: {
    contractVersion: "3.0.0",
    outcome: "NO_ACTION",
    reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
    evidence: [{
      claimId: "mixed-regime",
      kind: "SOURCED_FACT",
      claim: "The retained market regime signal was mixed.",
      provider: "ALPACA",
      temporalClass: "LIVE",
      observedAt: "2026-08-26T14:29:00.000Z",
      locator: "analysis.marketRegime.signal",
    }],
  },
  analysis: {
    provenance: "AGENT_REPORTED",
    asOf: "2026-08-26T14:30:00.000Z",
    accountChecks: {
      verification: "AGENT_REPORTED",
      observedAt: "2026-08-26T14:25:00.000Z",
      accountStatus: "ACTIVE",
      optionsTradingApproved: true,
      conflictingStrategyExposure: false,
    },
    symbolEvaluations: [],
    marketRegimes: [{
      verification: "AGENT_REPORTED",
      temporalClass: "LIVE",
      observedAt: "2026-08-26T14:29:00.000Z",
      signal: "MIXED",
      dailySessionCount: 50,
      intradayBarCount: 60,
    }],
    optionSurfaces: [],
    candidateEvaluations: [],
    externalContext: [
      {
        sourceId: "exa-current-1",
        provider: "EXA",
        verification: "AGENT_REPORTED",
        title: "Current market context",
        url: "https://example.com/context",
        publishedAt: "2026-08-26T13:00:00.000Z",
        retrievedAt: "2026-08-26T14:28:00.000Z",
        summary: "A bounded summary of the retrieved context.",
        relevance: "NEUTRAL",
      },
    ],
    supportingFactors: [],
    contradictingFactors: [],
    conflicts: [],
  },
} as const

const candidateEvaluation = (
  longContractSymbol = "SPY260918C00650000",
  shortContractSymbol = "SPY260918C00655000",
) => ({
  verification: "AGENT_REPORTED" as const,
  observedAt: "2026-08-26T14:29:00.000Z",
  underlying: longContractSymbol.slice(0, 3),
  expiration: "2026-09-18",
  dte: 23,
  legs: [
    {
      role: "LONG" as const,
      contractSymbol: longContractSymbol,
      delta: 0.55,
      impliedVolatility: 0.2,
      gamma: 0.01,
      theta: -0.1,
      vega: 0.15,
      volume: 1_000,
      openInterest: 2_000,
      openInterestDate: "2026-08-25",
      ivToRealizedVolatility: 1.25,
      bidAskSpreadPercent: 0.08,
    },
    {
      role: "SHORT" as const,
      contractSymbol: shortContractSymbol,
      delta: 0.45,
      impliedVolatility: 0.21,
      gamma: 0.01,
      theta: -0.08,
      vega: 0.14,
      volume: 900,
      openInterest: 1_800,
      openInterestDate: "2026-08-25",
      ivToRealizedVolatility: 1.3125,
      bidAskSpreadPercent: 0.1,
    },
  ],
})

const symbolIndicators = [
  {
    underlying: "SPY",
    throughSessionDate: "2026-08-25",
    return5d: 0.01,
    return20d: 0.03,
    relativeStrengthRank20d: 1,
    realizedVolatility20: 0.16,
    completedSessionVolumeRatio20: 1.1,
    atrPercent20: 0.012,
    ewmaRealizedVolatility20: 0.17,
    sma20Slope5d: 0.004,
    completedSessionDollarVolumeRatio20: 1.12,
    rangePosition20: 0.8,
  },
  {
    underlying: "QQQ",
    throughSessionDate: "2026-08-25",
    return5d: -0.01,
    return20d: 0.01,
    relativeStrengthRank20d: 2,
    realizedVolatility20: 0.21,
    completedSessionVolumeRatio20: 0.9,
    atrPercent20: 0.018,
    ewmaRealizedVolatility20: 0.22,
    sma20Slope5d: -0.002,
    completedSessionDollarVolumeRatio20: 0.88,
    rangePosition20: 0.45,
  },
  {
    underlying: "IWM",
    throughSessionDate: "2026-08-25",
    return5d: -0.02,
    return20d: -0.04,
    relativeStrengthRank20d: 3,
    realizedVolatility20: 0.24,
    completedSessionVolumeRatio20: 1.2,
    atrPercent20: 0.021,
    ewmaRealizedVolatility20: 0.25,
    sma20Slope5d: -0.006,
    completedSessionDollarVolumeRatio20: 1.18,
    rangePosition20: 0.2,
  },
] as const

const optionUniverse = {
  snapshotVersion: "2.0.0",
  policyVersion: "5.0.0",
  snapshotId: `option-universe-v2-${"e".repeat(64)}`,
  generatedAt: "2026-08-26T14:20:00.000Z",
  sessionDate: "2026-08-26",
  source: "ALPACA_OPTIONS_SCREENERS",
  candidates: ["SPY", "QQQ", "IWM"].map((underlying, index) => ({
    rank: index + 1,
    underlying,
    activityRank: index + 1,
    optionLiquidity: {
      expirationCount: 2,
      viableSeriesCount: 4 - index,
      liquidSeriesCount: 3 - index,
      contractCount: 40 - index * 4,
      liquidContractCount: 24 - index * 4,
      totalOpenInterest: 24_000 - index * 4_000,
      openInterestCoverage: 1,
    },
  })),
} as const

const differentOptionUniverse = {
  snapshotVersion: "2.0.0",
  policyVersion: "5.0.0",
  snapshotId: `option-universe-v2-${"f".repeat(64)}`,
  generatedAt: "2026-08-26T14:20:00.000Z",
  sessionDate: "2026-08-26",
  source: "ALPACA_OPTIONS_SCREENERS",
  candidates: [
    { rank: 1, underlying: "TSLA", activityRank: 1 },
    { rank: 2, underlying: "NVDA", activityRank: 2 },
    { rank: 3, underlying: "AMD", activityRank: 3 },
  ],
} as const

const proposalReport = {
  ...noAction,
  result: {
    contractVersion: "3.0.0",
    outcome: "PROPOSE_TRADES",
    proposals: [{
    priority: 1,
    direction: "BULLISH",
    thesis: "The selected underlying has aligned daily and intraday evidence.",
    candidate: {
      underlying: "SPY",
      structure: "BULL_CALL_SPREAD",
      expiration: "2026-09-18",
      longLeg: { contractSymbol: "SPY260918C00650000", strike: 650 },
      shortLeg: { contractSymbol: "SPY260918C00655000", strike: 655 },
    },
    invalidation: ["Reject if refreshed evidence changes the candidate."],
    evidence: [{
      claimId: "quote-fact",
      kind: "SOURCED_FACT",
      claim: "The exact proposal legs were confirmed.",
      snapshotRef: "alpaca-proposal-quotes-v2-SPY",
    }],
    }],
  },
  analysis: {
    ...noAction.analysis,
    optionUniverse,
    symbolEvaluations: [
      { underlying: "SPY", disposition: "PROPOSE", direction: "BULLISH", summary: "Strongest executable setup." },
      { underlying: "QQQ", disposition: "WATCH", direction: "BULLISH", summary: "Valid but lower-ranked setup." },
      { underlying: "IWM", disposition: "REJECT", direction: "BEARISH", summary: "No eligible spread survived." },
    ],
    marketRegimes: [{
      ...noAction.analysis.marketRegimes[0],
      signal: "BULLISH",
      underlying: "SPY",
      dailyClose: 650,
      sma20: 645,
      sma50: 640,
      sessionVwap: 648,
      spotMidpoint: 651,
      gapPercent: 0.004,
      distanceFromSma20: 0.009302325581395349,
      distanceFromSessionVwap: 0.004629629629629539,
      intradayRealizedVolatility: 0.19,
    }],
    broadMarketContext: {
      verification: "AGENT_REPORTED",
      temporalClass: "LIVE",
      observedAt: "2026-08-26T14:29:00.000Z",
      benchmark: "SPY",
      signal: "BULLISH",
      dailyClose: 650,
      sma20: 645,
      sma50: 640,
      realizedVolatility20: 0.16,
    },
    symbolIndicators,
    optionSurfaces: [{
      verification: "AGENT_REPORTED",
      observedAt: "2026-08-26T14:29:00.000Z",
      underlying: "SPY",
      expiration: "2026-09-18",
      feed: "OPRA",
      atmImpliedVolatility: 0.2,
      forecastRealizedVolatility: 0.17,
      ivRvVarianceSpread: 0.0111,
      impliedMovePercent: 0.025,
      termStructureSlope: 0.01,
      putCallSkew25Delta: 0.025,
      verticalLegIvDifference: -0.01,
      smileCurvature: 0.0125,
      quoteCoverage: 0.95,
      eventRisk: {
        verification: "AGENT_REPORTED",
        status: "CLEAR",
        eventBeforeExpiration: false,
        macroEvents: [],
      },
    }],
    candidateEvaluations: [{
      ...candidateEvaluation(),
      legs: candidateEvaluation().legs.map((leg) =>
        leg.role === "SHORT" ? { ...leg, delta: 0.3 } : leg
      ),
      spreadGreeks: {
        calculation: "LONG_MINUS_SHORT",
        netDelta: 0.25,
        netGamma: 0,
        netTheta: -0.02,
        netVega: 0.01,
      },
    }],
  },
} as const

describe("ResearchReportV6", () => {
  it("keeps indicators and candidates inside the echoed universe", () => {
    const parsed = researchReportV6Schema.safeParse({
      ...proposalReport,
      analysis: {
        ...proposalReport.analysis,
        optionUniverse: differentOptionUniverse,
      },
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error("Expected universe validation to fail")
    expect(parsed.error.issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        ["analysis", "symbolIndicators", 0, "underlying"],
        ["result", "proposals", 0, "candidate", "underlying"],
      ]),
    )
  })

  it("retains a bounded normalized dossier with timestamped Exa context", () => {
    expect(researchReportV6Schema.parse(noAction)).toMatchObject(noAction)
  })

  it("preserves the canonical research report bytes", () => {
    expect(canonicalJsonSha256(researchReportV6Schema.parse(noAction))).toBe(
      "a147926cb8a7cc3facb0fd687caba364f4918624e14462bc75e783c5aa3d9a1a",
    )
  })

  it("accepts SPY candidate diagnostic symbols", () => {
    expect(
      researchReportV6Schema.safeParse({
        ...noAction,
        analysis: {
          ...noAction.analysis,
          candidateEvaluations: [candidateEvaluation()],
        },
      }).success,
    ).toBe(true)
  })

  it("accepts complete advisory context for the shortlisted pool", () => {
    expect(
      researchReportV6Schema.safeParse({
        ...noAction,
        analysis: { ...noAction.analysis, symbolIndicators },
      }).success,
    ).toBe(true)
  })

  it("requires complete shortlist comparison indicators for proposals", () => {
    expect(researchReportV6Schema.safeParse(proposalReport).success).toBe(true)
    const { symbolIndicators: _indicators, ...analysis } = proposalReport.analysis
    const result = researchReportV6Schema.safeParse({
      ...proposalReport,
      analysis,
    })
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected proposal rejection")
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      path: ["analysis", "symbolIndicators"],
    }))
  })

  it("requires broad-market and option-surface evidence for proposals", () => {
    const {
      broadMarketContext: _broadMarketContext,
      optionSurfaces: _optionSurfaces,
      ...analysis
    } = proposalReport.analysis
    const parsed = researchReportV6Schema.safeParse({
      ...proposalReport,
      analysis: { ...analysis, optionSurfaces: [] },
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error("Expected proposal evidence rejection")
    expect(parsed.error.issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        ["analysis", "broadMarketContext"],
        ["analysis", "optionSurfaces"],
      ]),
    )
  })

  it("rejects unknown event risk and an inconsistent IV/RV variance spread", () => {
    const parsed = researchReportV6Schema.safeParse({
      ...proposalReport,
      analysis: {
        ...proposalReport.analysis,
        optionSurfaces: [{
          ...proposalReport.analysis.optionSurfaces[0],
          ivRvVarianceSpread: 0.5,
          eventRisk: {
            verification: "AGENT_REPORTED",
            status: "UNKNOWN",
            macroEvents: [],
          },
        }],
      },
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error("Expected volatility/event rejection")
    expect(parsed.error.issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        ["analysis", "optionSurfaces", 0, "ivRvVarianceSpread"],
        ["analysis", "optionSurfaces", 0, "eventRisk"],
      ]),
    )
  })

  it("requires spread Greeks on proposals", () => {
    const {
      spreadGreeks: _spreadGreeks,
      ...candidateEvaluationWithoutSpreadGreeks
    } = proposalReport.analysis.candidateEvaluations[0]
    const parsed = researchReportV6Schema.safeParse({
      ...proposalReport,
      analysis: {
        ...proposalReport.analysis,
        candidateEvaluations: [candidateEvaluationWithoutSpreadGreeks],
      },
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error("Expected spread-Greek rejection")
    expect(parsed.error.issues).toContainEqual(expect.objectContaining({
      path: ["analysis", "candidateEvaluations", 0, "spreadGreeks"],
    }))
  })

  it("rejects option-surface identity that differs from the proposal", () => {
    const parsed = researchReportV6Schema.safeParse({
      ...proposalReport,
      analysis: {
        ...proposalReport.analysis,
        optionSurfaces: [{
          ...proposalReport.analysis.optionSurfaces[0],
          underlying: "QQQ",
        }],
      },
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error("Expected surface identity rejection")
    expect(parsed.error.issues).toContainEqual(expect.objectContaining({
      path: ["analysis", "optionSurfaces"],
    }))
  })

  it("recomputes retained spread Greeks from the two analyzed legs", () => {
    const parsed = researchReportV6Schema.safeParse({
      ...proposalReport,
      analysis: {
        ...proposalReport.analysis,
        candidateEvaluations: [{
          ...proposalReport.analysis.candidateEvaluations[0],
          spreadGreeks: {
            ...proposalReport.analysis.candidateEvaluations[0].spreadGreeks,
            netVega: 0.5,
          },
        }],
      },
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error("Expected spread-Greek rejection")
    expect(parsed.error.issues).toContainEqual(expect.objectContaining({
      path: ["analysis", "candidateEvaluations", 0, "spreadGreeks"],
    }))
  })

  it("rejects duplicate relative-strength ranks", () => {
    expect(
      researchReportV6Schema.safeParse({
        ...noAction,
        analysis: {
          ...noAction.analysis,
          symbolIndicators: symbolIndicators.map((indicator) => ({
            ...indicator,
            relativeStrengthRank20d: 1,
          })),
        },
      }).success,
    ).toBe(false)
  })

  it("rejects ranks that disagree with 20-day returns", () => {
    expect(
      researchReportV6Schema.safeParse({
        ...noAction,
        analysis: {
          ...noAction.analysis,
          symbolIndicators: symbolIndicators.map((indicator) => ({
            ...indicator,
            relativeStrengthRank20d:
              indicator.relativeStrengthRank20d === 1
                ? 2
                : indicator.relativeStrengthRank20d === 2
                  ? 1
                  : 3,
          })),
        },
      }).success,
    ).toBe(false)
  })

  it.each([
    ["impossible-date", "SPY260431C00650000"],
    ["malformed", "not-an-option"],
  ])("rejects %s candidate diagnostic symbols", (_case, contractSymbol) => {
    expect(
      researchReportV6Schema.safeParse({
        ...noAction,
        analysis: {
          ...noAction.analysis,
          candidateEvaluation: candidateEvaluation(contractSymbol),
        },
      }).success,
    ).toBe(false)
  })

  it("requires Exa for substantive research", () => {
    const result = researchReportV6Schema.safeParse({
      ...noAction,
      analysis: {
        ...noAction.analysis,
        externalContext: [
          {
            sourceId: "fmp-1",
            provider: "FMP",
            verification: "AGENT_REPORTED",
            dataset: "economic-calendar",
            observedAt: "2026-08-26T13:00:00.000Z",
            retrievedAt: "2026-08-26T14:28:00.000Z",
            summary: "Optional FMP context cannot replace Exa.",
            relevance: "NEUTRAL",
          },
        ],
      },
    })

    expect(result.success).toBe(false)
  })

  it("allows Exa-unavailable and early account failures to fail closed", () => {
    for (const reasonCode of [
      "REQUIRED_EXA_EVIDENCE_UNAVAILABLE",
      "ACCOUNT_STATE_INELIGIBLE",
    ]) {
      expect(
        researchReportV6Schema.safeParse({
          ...noAction,
          result: { ...noAction.result, reasonCodes: [reasonCode] },
          analysis: { ...noAction.analysis, externalContext: [] },
        }).success,
      ).toBe(true)
    }
  })

  it("rejects future-dated retained observations", () => {
    expect(
      researchReportV6Schema.safeParse({
        ...noAction,
        analysis: {
          ...noAction.analysis,
          externalContext: [
            {
              ...noAction.analysis.externalContext[0],
              retrievedAt: "2026-08-26T14:31:00.000Z",
            },
          ],
        },
      }).success,
    ).toBe(false)
  })

  it("rejects future-dated no-action evidence at its precise path", () => {
    const result = researchReportV6Schema.safeParse({
      ...noAction,
      result: {
        ...noAction.result,
        evidence: [{
          ...noAction.result.evidence[0],
          observedAt: "2026-08-26T14:30:00.001Z",
        }],
      },
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected report rejection")
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["result", "evidence", 0, "observedAt"],
      }),
    )
  })

  it("allows exactly one schema correction before normal validation", async () => {
    let attempts = 0
    const resolved = await repairResearchReportV6ResponseOnce(
      "not-json",
      async (issues) => {
        attempts += 1
        expect(issues).toEqual([{ code: "MALFORMED_JSON", path: [] }])
        return JSON.stringify(noAction)
      },
    )

    expect(attempts).toBe(1)
    expect(resolved.schemaRepairAttempted).toBe(true)
    expect(parseResearchReportV6Response(resolved.rawResponse).success).toBe(true)
  })
})
