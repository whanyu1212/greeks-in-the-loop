import { describe, expect, it } from "vitest"

import { preliminaryResearchV1Schema } from "../src/contracts/preliminary-research-v1.js"

const preliminary = {
  contractVersion: "1.0.0",
  strategyVersion: "1.1.0",
  outcome: "PRELIMINARY_RESEARCH",
  targetSessionDate: "2026-08-26",
  direction: "BULLISH",
  thesis: "Prior-close trend supports refreshing a bullish setup after open.",
  invalidation: ["Reject if live regular-session evidence reverses the signal."],
  evidence: [
    {
      claimId: "prior-close-trend",
      kind: "SOURCED_FACT",
      claim: "The prior completed session closed above its trend average.",
      provider: "ALPACA",
      temporalClass: "PRIOR_CLOSE",
      observedAt: "2026-08-25T20:00:00.000Z",
    },
    {
      claimId: "bullish-watch",
      kind: "INFERENCE",
      claim: "A bullish candidate is worth refreshing after the open.",
      basedOn: ["prior-close-trend"],
    },
  ],
  requiresRefresh: true,
} as const

describe("PreliminaryResearchV1", () => {
  it("accepts bounded research with explicit temporal labels", () => {
    expect(preliminaryResearchV1Schema.parse(preliminary)).toEqual(preliminary)
  })

  it("keeps legacy strategy research readable", () => {
    expect(
      preliminaryResearchV1Schema.safeParse({
        ...preliminary,
        strategyVersion: "1.0.0",
      }).success,
    ).toBe(true)
  })

  it("requires every sourced observation to identify its temporal class", () => {
    const input = structuredClone(preliminary) as Record<string, any>
    delete input.evidence[0].temporalClass
    expect(preliminaryResearchV1Schema.safeParse(input).success).toBe(false)
  })

  it("rejects executable pricing fields", () => {
    expect(
      preliminaryResearchV1Schema.safeParse({
        ...preliminary,
        entryLimitCentsPerShare: 101,
      }).success,
    ).toBe(false)
  })

  it("requires inferences to reference sourced facts", () => {
    expect(
      preliminaryResearchV1Schema.safeParse({
        ...preliminary,
        evidence: [
          preliminary.evidence[0],
          { ...preliminary.evidence[1], basedOn: ["missing"] },
        ],
      }).success,
    ).toBe(false)
  })

  it.each([
    {
      longLeg: { contractSymbol: "SPY260918C00655000", strike: 655 },
      shortLeg: { contractSymbol: "SPY260918C00650000", strike: 650 },
    },
    {
      longLeg: { contractSymbol: "SPY260918C00650000", strike: 650 },
      shortLeg: { contractSymbol: "SPY260918C00650000", strike: 650 },
    },
    {
      longLeg: { contractSymbol: "SPY260925C00650000", strike: 650 },
      shortLeg: { contractSymbol: "SPY260918C00655000", strike: 655 },
    },
  ])("rejects an internally inconsistent candidate identity", (legs) => {
    expect(
      preliminaryResearchV1Schema.safeParse({
        ...preliminary,
        candidate: {
          underlying: "SPY",
          structure: "BULL_CALL_SPREAD",
          expiration: "2026-09-18",
          ...legs,
        },
      }).success,
    ).toBe(false)
  })
})
