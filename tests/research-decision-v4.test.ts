import { describe, expect, it } from "vitest"

import {
  RESEARCH_DECISION_V4_CONTRACT_VERSION,
  researchDecisionV4Schema,
  validateResearchDecisionV4,
} from "../src/contracts/research-decision-v4.js"
import {
  candidateEvaluationV7Schema,
  RESEARCH_REPORT_V7_VERSION,
  researchReportV7Schema,
} from "../src/contracts/research-report-v7.js"
import {
  parseResearchReportV7Response,
  repairResearchReportV7ResponseOnce,
} from "../src/research/cycle.js"

const symbols = [
  "SPY261218P00490000",
  "SPY261218P00500000",
  "SPY261218C00520000",
  "SPY261218C00530000",
] as const

const proposal = {
  priority: 1,
  direction: "NEUTRAL",
  thesis: "The bounded range supports a defined-risk iron condor.",
  candidate: {
    underlying: "SPY",
    strategy: "IRON_CONDOR",
    legs: [
      { contractSymbol: symbols[0], positionIntent: "BUY_TO_OPEN", ratioQuantity: 1 },
      { contractSymbol: symbols[1], positionIntent: "SELL_TO_OPEN", ratioQuantity: 1 },
      { contractSymbol: symbols[2], positionIntent: "SELL_TO_OPEN", ratioQuantity: 1 },
      { contractSymbol: symbols[3], positionIntent: "BUY_TO_OPEN", ratioQuantity: 1 },
    ],
  },
  invalidation: ["Abandon if the expected range changes."],
  evidence: [{
    claimId: "quote-fact",
    kind: "SOURCED_FACT",
    claim: "All exact option legs were observed.",
    snapshotRef: "alpaca-proposal-quotes-v2-SPY",
  }],
} as const

describe("ResearchDecisionV4", () => {
  it("accepts an ordered four-leg Alpaca strategy candidate", () => {
    expect(researchDecisionV4Schema.parse({
      contractVersion: RESEARCH_DECISION_V4_CONTRACT_VERSION,
      outcome: "PROPOSE_TRADES",
      proposals: [proposal],
    })).toMatchObject({ proposals: [{ candidate: { legs: proposal.candidate.legs } }] })
  })

  it("rejects a proposal direction that contradicts the strategy catalog", () => {
    expect(researchDecisionV4Schema.safeParse({
      contractVersion: RESEARCH_DECISION_V4_CONTRACT_VERSION,
      outcome: "PROPOSE_TRADES",
      proposals: [{ ...proposal, direction: "BULLISH" }],
    }).success).toBe(false)
  })

  it("rejects legs that do not match the declared Alpaca strategy", () => {
    expect(researchDecisionV4Schema.safeParse({
      contractVersion: RESEARCH_DECISION_V4_CONTRACT_VERSION,
      outcome: "PROPOSE_TRADES",
      proposals: [{
        ...proposal,
        candidate: {
          ...proposal.candidate,
          legs: proposal.candidate.legs.slice(0, 2),
        },
      }],
    }).success).toBe(false)
  })

  it("validates proposal evidence against application snapshot metadata", () => {
    expect(validateResearchDecisionV4({
      contractVersion: RESEARCH_DECISION_V4_CONTRACT_VERSION,
      outcome: "PROPOSE_TRADES",
      proposals: [proposal],
    }, {
      evaluatedAt: "2026-09-01T14:30:00.000Z",
      snapshots: {
        "alpaca-proposal-quotes-v2-SPY": {
          provider: "ALPACA",
          source: "options-snapshots-indicative",
          retrievedAt: "2026-09-01T14:29:59.000Z",
          freshUntil: "2026-09-01T14:30:59.000Z",
        },
      },
    }).success).toBe(true)
  })
})

describe("ResearchReportV7", () => {
  it("retains a schema-valid generic no-action report", () => {
    expect(researchReportV7Schema.parse({
      reportVersion: RESEARCH_REPORT_V7_VERSION,
      result: {
        contractVersion: RESEARCH_DECISION_V4_CONTRACT_VERSION,
        outcome: "NO_ACTION",
        reasonCodes: ["INSUFFICIENT_UNDERLYING_DATA"],
        evidence: [{
          claimId: "empty-universe",
          kind: "SOURCED_FACT",
          claim: "The supplied option universe was empty.",
          provider: "ALPACA",
          temporalClass: "LIVE",
          observedAt: "2026-09-01T14:30:00.000Z",
        }],
      },
      analysis: {
        provenance: "AGENT_REPORTED",
        asOf: "2026-09-01T14:30:00.000Z",
        accountChecks: {
          verification: "AGENT_REPORTED",
          observedAt: "2026-09-01T14:30:00.000Z",
          accountStatus: "ACTIVE",
          optionsTradingApproved: true,
          conflictingStrategyExposure: false,
        },
        symbolEvaluations: [],
        marketRegimes: [],
        optionSurfaces: [],
        candidateEvaluations: [],
        externalContext: [],
        supportingFactors: [],
        contradictingFactors: [],
        conflicts: [],
      },
    })).toMatchObject({ reportVersion: "7.0.0" })
  })

  it("verifies signed ratio-weighted aggregate Greeks", () => {
    const legs = proposal.candidate.legs.map((leg, index) => ({
      ...leg,
      delta: [0.2, 0.3, 0.25, 0.15][index],
      impliedVolatility: 0.2,
      gamma: 0.01,
      theta: -0.02,
      vega: 0.05,
      volume: 100,
      openInterest: 500,
      openInterestDate: "2026-09-01",
    }))
    expect(candidateEvaluationV7Schema.safeParse({
      verification: "AGENT_REPORTED",
      observedAt: "2026-09-01T14:30:00.000Z",
      underlying: "SPY",
      legs,
      aggregateGreeks: {
        calculation: "POSITION_WEIGHTED_SUM",
        netDelta: -0.2,
        netGamma: 0,
        netTheta: 0,
        netVega: 0,
      },
    }).success).toBe(true)
  })

  it("allows one repair before V7 response validation", async () => {
    const report = researchReportV7Schema.parse({
      reportVersion: RESEARCH_REPORT_V7_VERSION,
      result: {
        contractVersion: RESEARCH_DECISION_V4_CONTRACT_VERSION,
        outcome: "NO_ACTION",
        reasonCodes: ["INSUFFICIENT_UNDERLYING_DATA"],
        evidence: [{
          claimId: "empty-universe",
          kind: "SOURCED_FACT",
          claim: "The supplied option universe was empty.",
          provider: "ALPACA",
          temporalClass: "LIVE",
          observedAt: "2026-09-01T14:30:00.000Z",
        }],
      },
      analysis: {
        provenance: "AGENT_REPORTED",
        asOf: "2026-09-01T14:30:00.000Z",
        accountChecks: {
          verification: "AGENT_REPORTED",
          observedAt: "2026-09-01T14:30:00.000Z",
          accountStatus: "ACTIVE",
          optionsTradingApproved: true,
          conflictingStrategyExposure: false,
        },
        symbolEvaluations: [],
        marketRegimes: [],
        optionSurfaces: [],
        candidateEvaluations: [],
        externalContext: [],
        supportingFactors: [],
        contradictingFactors: [],
        conflicts: [],
      },
    })
    const resolved = await repairResearchReportV7ResponseOnce(
      "not-json",
      async (issues) => {
        expect(issues).toEqual([{ code: "MALFORMED_JSON", path: [] }])
        return JSON.stringify(report)
      },
    )
    expect(resolved.schemaRepairAttempted).toBe(true)
    expect(parseResearchReportV7Response(resolved.rawResponse).success).toBe(true)
  })
})
