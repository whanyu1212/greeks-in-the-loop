import { describe, expect, it } from "vitest"

import { researchReportV2Schema } from "../src/contracts/research-report-v2.js"

const noAction = {
  reportVersion: "2.0.0",
  result: {
    contractVersion: "1.0.0",
    strategyVersion: "1.1.0",
    outcome: "NO_ACTION",
    reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
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
    },
  ],
})

describe("ResearchReportV2", () => {
  it("retains a bounded normalized dossier with timestamped Exa context", () => {
    expect(researchReportV2Schema.parse(noAction)).toMatchObject(noAction)
  })

  it("accepts SPY candidate diagnostic symbols", () => {
    expect(
      researchReportV2Schema.safeParse({
        ...noAction,
        analysis: {
          ...noAction.analysis,
          candidateEvaluation: candidateEvaluation(),
        },
      }).success,
    ).toBe(true)
  })

  it.each([
    ["unsupported", "QQQ260918C00650000"],
    ["impossible-date", "SPY260431C00650000"],
  ])("rejects %s candidate diagnostic symbols", (_case, contractSymbol) => {
    expect(
      researchReportV2Schema.safeParse({
        ...noAction,
        analysis: {
          ...noAction.analysis,
          candidateEvaluation: candidateEvaluation(contractSymbol),
        },
      }).success,
    ).toBe(false)
  })

  it("requires Exa for substantive research", () => {
    const result = researchReportV2Schema.safeParse({
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
        researchReportV2Schema.safeParse({
          ...noAction,
          result: { ...noAction.result, reasonCodes: [reasonCode] },
          analysis: { ...noAction.analysis, externalContext: [] },
        }).success,
      ).toBe(true)
    }
  })

  it("rejects future-dated retained observations", () => {
    expect(
      researchReportV2Schema.safeParse({
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

  it("rejects preliminary sourced facts observed after the report as-of", () => {
    const result = researchReportV2Schema.safeParse({
      ...noAction,
      result: {
        contractVersion: "1.0.0",
        strategyVersion: "1.1.0",
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
})
