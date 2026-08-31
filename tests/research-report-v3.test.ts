import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { researchReportV3Schema } from "../src/contracts/research-report-v3.js"
import {
  parseResearchReportV3Response,
  repairResearchReportV3ResponseOnce,
} from "../src/research/research-cycle.js"
import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"

const noAction = {
  reportVersion: "3.0.0",
  result: {
    contractVersion: "2.0.0",
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
    marketRegime: {
      verification: "AGENT_REPORTED",
      temporalClass: "LIVE",
      observedAt: "2026-08-26T14:29:00.000Z",
      signal: "MIXED",
      dailySessionCount: 50,
      intradayBarCount: 60,
    },
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
  },
  {
    underlying: "QQQ",
    throughSessionDate: "2026-08-25",
    return5d: -0.01,
    return20d: 0.01,
    relativeStrengthRank20d: 2,
    realizedVolatility20: 0.21,
    completedSessionVolumeRatio20: 0.9,
  },
  {
    underlying: "IWM",
    throughSessionDate: "2026-08-25",
    return5d: -0.02,
    return20d: -0.04,
    relativeStrengthRank20d: 3,
    realizedVolatility20: 0.24,
    completedSessionVolumeRatio20: 1.2,
  },
] as const

const proposalReport = {
  ...noAction,
  result: {
    contractVersion: "2.0.0",
    outcome: "PROPOSE_TRADE",
    direction: "BULLISH",
    thesis: "The selected ETF has aligned daily and intraday evidence.",
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
      snapshotRef: "alpaca-proposal-quotes-v1",
    }],
  },
  analysis: {
    ...noAction.analysis,
    marketRegime: {
      ...noAction.analysis.marketRegime,
      signal: "BULLISH",
      dailyClose: 650,
      sma20: 645,
      sma50: 640,
      sessionVwap: 648,
      spotMidpoint: 651,
    },
    symbolIndicators,
    candidateEvaluation: {
      ...candidateEvaluation(),
      legs: candidateEvaluation().legs.map((leg) =>
        leg.role === "SHORT" ? { ...leg, delta: 0.3 } : leg
      ),
    },
  },
} as const

describe("ResearchReportV3", () => {
  it("retains a bounded normalized dossier with timestamped Exa context", () => {
    expect(researchReportV3Schema.parse(noAction)).toMatchObject(noAction)
  })

  it("preserves the canonical research report bytes", () => {
    expect(canonicalJsonSha256(researchReportV3Schema.parse(noAction))).toBe(
      "993058eea31879d1789d04f9ed4d9eb594d34296c6b53c345b6bd26c754dfca8",
    )
  })

  it("accepts SPY candidate diagnostic symbols", () => {
    expect(
      researchReportV3Schema.safeParse({
        ...noAction,
        analysis: {
          ...noAction.analysis,
          candidateEvaluation: candidateEvaluation(),
        },
      }).success,
    ).toBe(true)
  })

  it("accepts complete advisory context for the ETF pool", () => {
    expect(
      researchReportV3Schema.safeParse({
        ...noAction,
        analysis: { ...noAction.analysis, symbolIndicators },
      }).success,
    ).toBe(true)
  })

  it("requires complete ETF comparison indicators for proposals", () => {
    expect(researchReportV3Schema.safeParse(proposalReport).success).toBe(true)
    const { symbolIndicators: _indicators, ...analysis } = proposalReport.analysis
    const result = researchReportV3Schema.safeParse({
      ...proposalReport,
      analysis,
    })
    expect(result.success).toBe(false)
    if (result.success) throw new Error("Expected proposal rejection")
    expect(result.error.issues).toContainEqual(expect.objectContaining({
      path: ["analysis", "symbolIndicators"],
    }))
  })

  it("rejects duplicate relative-strength ranks", () => {
    expect(
      researchReportV3Schema.safeParse({
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
      researchReportV3Schema.safeParse({
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
    ["unsupported", "DIA260918C00650000"],
    ["impossible-date", "SPY260431C00650000"],
  ])("rejects %s candidate diagnostic symbols", (_case, contractSymbol) => {
    expect(
      researchReportV3Schema.safeParse({
        ...noAction,
        analysis: {
          ...noAction.analysis,
          candidateEvaluation: candidateEvaluation(contractSymbol),
        },
      }).success,
    ).toBe(false)
  })

  it("requires Exa for substantive research", () => {
    const result = researchReportV3Schema.safeParse({
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
        researchReportV3Schema.safeParse({
          ...noAction,
          result: { ...noAction.result, reasonCodes: [reasonCode] },
          analysis: { ...noAction.analysis, externalContext: [] },
        }).success,
      ).toBe(true)
    }
  })

  it("rejects future-dated retained observations", () => {
    expect(
      researchReportV3Schema.safeParse({
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
    const result = researchReportV3Schema.safeParse({
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

  it("rejects preliminary sourced facts observed after the report as-of", () => {
    const result = researchReportV3Schema.safeParse({
      ...noAction,
      result: {
        contractVersion: "2.0.0",
        outcome: "PRELIMINARY_RESEARCH",
        targetSessionDate: "2026-08-26",
        direction: "UNDETERMINED",
        thesis: "Retain context for a later refresh.",
        invalidation: ["Discard when refreshed facts disagree."],
        evidence: [
          {
            claimId: "future-fact",
            kind: "SOURCED_FACT",
            claim: "This observation postdates the report snapshot.",
            provider: "ALPACA",
            temporalClass: "LIVE",
            observedAt: "2026-08-26T14:30:00.001Z",
          },
        ],
        requiresRefresh: true,
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

  it("reports the precise path for a malformed preliminary invalidation", () => {
    const parsed = parseResearchReportV3Response(JSON.stringify({
      ...noAction,
      result: {
        contractVersion: "2.0.0",
        outcome: "PRELIMINARY_RESEARCH",
        targetSessionDate: "2026-08-26",
        direction: "UNDETERMINED",
        thesis: "Retain context for a later refresh.",
        invalidation: "Refresh after the open.",
        evidence: [
          {
            claimId: "fact-1",
            kind: "SOURCED_FACT",
            claim: "The regular session is closed.",
            provider: "ALPACA",
            temporalClass: "LIVE",
            observedAt: "2026-08-26T14:29:00.000Z",
          },
        ],
        requiresRefresh: true,
      },
    }))

    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error("Expected report rejection")
    expect(parsed.issues).toContainEqual({
      code: "SCHEMA_INVALID",
      schemaCategory: "TYPE_MISMATCH",
      path: ["result", "invalidation"],
    })
  })

  it("allows exactly one schema correction before normal validation", async () => {
    let attempts = 0
    const resolved = await repairResearchReportV3ResponseOnce(
      "not-json",
      async (issues) => {
        attempts += 1
        expect(issues).toEqual([{ code: "MALFORMED_JSON", path: [] }])
        return JSON.stringify(noAction)
      },
    )

    expect(attempts).toBe(1)
    expect(resolved.schemaRepairAttempted).toBe(true)
    expect(parseResearchReportV3Response(resolved.rawResponse).success).toBe(true)
  })

  // The agent only emits the proposal shape correctly when the prompt shows it
  // literally, so every JSON example in the prompt must stay contract-valid.
  it("keeps the agent prompt's proposal examples schema-valid", () => {
    const prompt = readFileSync(
      new URL("../src/research/research-agent-system.md", import.meta.url),
      "utf8",
    )
    const examples = [...prompt.matchAll(/`(\{.*?\})`/gsu)].map(
      ([, json]) => JSON.parse(json ?? "") as Record<string, unknown>,
    )
    const candidate = examples.find((example) => "longLeg" in example)
    const evaluation = examples.find((example) => "dte" in example)
    const proposalFact = examples.find((example) => "snapshotRef" in example)
    expect([candidate, evaluation, proposalFact]).not.toContain(undefined)

    const parsed = researchReportV3Schema.safeParse({
      ...proposalReport,
      result: {
        ...proposalReport.result,
        candidate,
        evidence: [proposalFact],
      },
      analysis: {
        ...proposalReport.analysis,
        asOf: (evaluation as { observedAt: string }).observedAt,
        accountChecks: {
          ...proposalReport.analysis.accountChecks,
          observedAt: (evaluation as { observedAt: string }).observedAt,
        },
        marketRegime: {
          ...proposalReport.analysis.marketRegime,
          observedAt: (evaluation as { observedAt: string }).observedAt,
        },
        candidateEvaluation: evaluation,
      },
    })

    expect(parsed.error?.issues ?? []).toEqual([])
  })
})
