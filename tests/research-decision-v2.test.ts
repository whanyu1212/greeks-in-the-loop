import { describe, expect, it } from "vitest"

import {
  NO_ACTION_REASON_CODES,
  proposalQuoteSnapshotRef,
  researchCandidateV3Schema,
  validateResearchDecisionV3,
  type ResearchDecisionValidationContext,
  type TradeProposalV3,
} from "../src/contracts/research-decision-v3.js"

const evaluatedAt = "2026-08-25T14:31:00.000Z"
const snapshot = {
  provider: "ALPACA" as const,
  source: "options-snapshots-indicative",
  retrievedAt: "2026-08-25T14:30:30.000Z",
  freshUntil: "2026-08-25T14:31:30.000Z",
}
const context: ResearchDecisionValidationContext = {
  evaluatedAt,
  snapshots: Object.fromEntries(
    ["SPY", "QQQ", "NVDA"].map((underlying) => [
      proposalQuoteSnapshotRef(underlying),
      snapshot,
    ]),
  ),
}

const noActionEvidence = [{
  claimId: "no-action-fact",
  kind: "SOURCED_FACT" as const,
  claim: "The retained market signal was mixed.",
  provider: "ALPACA" as const,
  temporalClass: "LIVE" as const,
  observedAt: "2026-08-25T14:30:00.000Z",
  locator: "analysis.symbolEvaluations",
}]

const proposal = (
  underlying = "SPY",
  priority = 1,
): TradeProposalV3 => ({
  priority,
  direction: "BULLISH",
  thesis: `${underlying} daily and intraday direction agree.`,
  candidate: {
    underlying,
    structure: "BULL_CALL_SPREAD",
    expiration: "2026-09-18",
    longLeg: {
      contractSymbol: `${underlying}260918C00650000`,
      strike: 650,
    },
    shortLeg: {
      contractSymbol: `${underlying}260918C00655000`,
      strike: 655,
    },
  },
  invalidation: ["Reject if refreshed evidence changes the candidate."],
  evidence: [{
    claimId: `${underlying.toLowerCase()}-quote-fact`,
    kind: "SOURCED_FACT",
    claim: "The application-owned snapshot contains both exact legs.",
    snapshotRef: proposalQuoteSnapshotRef(underlying),
  }],
})

const portfolio = (...proposals: readonly TradeProposalV3[]) => ({
  contractVersion: "3.0.0" as const,
  outcome: "PROPOSE_TRADES" as const,
  proposals,
})

const expectFailureCode = (
  input: unknown,
  expectedCode: string,
  validationContext: ResearchDecisionValidationContext = context,
) => {
  const result = validateResearchDecisionV3(input, validationContext)
  expect(result.success).toBe(false)
  if (result.success) throw new Error("Expected validation to fail")
  expect(result.issues.map(({ code }) => code)).toContain(expectedCode)
  return result
}

describe("ResearchDecision v3", () => {
  it.each(NO_ACTION_REASON_CODES)("accepts NO_ACTION reason %s", (reasonCode) => {
    expect(validateResearchDecisionV3({
      contractVersion: "3.0.0",
      outcome: "NO_ACTION",
      reasonCodes: [reasonCode],
      evidence: noActionEvidence,
    }, context)).toMatchObject({ success: true })
  })

  it("strips irrelevant fields from the safe branch", () => {
    const result = validateResearchDecisionV3({
      contractVersion: "3.0.0",
      outcome: "NO_ACTION",
      reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
      evidence: noActionEvidence,
      commentary: "ignored",
    }, context)
    expect(result).toMatchObject({ success: true })
    if (!result.success) throw new Error("Expected validation to succeed")
    expect(result.data).not.toHaveProperty("commentary")
  })

  it("accepts one through three ranked symbol proposals", () => {
    const decision = portfolio(
      proposal("SPY", 1),
      proposal("QQQ", 2),
      proposal("NVDA", 3),
    )
    expect(validateResearchDecisionV3(decision, context)).toEqual({
      success: true,
      data: decision,
    })
  })

  it("rejects an empty or over-capacity portfolio", () => {
    expectFailureCode(portfolio(), "SCHEMA_INVALID")
    expectFailureCode(portfolio(
      proposal("SPY", 1),
      proposal("QQQ", 2),
      proposal("NVDA", 3),
      proposal("AMD", 4),
    ), "SCHEMA_INVALID")
  })

  it("rejects duplicate symbols and non-contiguous priorities", () => {
    expectFailureCode(portfolio(proposal("SPY", 1), proposal("SPY", 2)), "SCHEMA_INVALID")
    expectFailureCode(portfolio(proposal("SPY", 2)), "SCHEMA_INVALID")
  })

  it("accepts a matching bearish put spread", () => {
    const bearish: TradeProposalV3 = {
      ...proposal(),
      direction: "BEARISH",
      candidate: {
        ...proposal().candidate,
        structure: "BEAR_PUT_SPREAD",
        longLeg: { contractSymbol: "SPY260918P00650000", strike: 650 },
        shortLeg: { contractSymbol: "SPY260918P00645000", strike: 645 },
      },
    }
    expect(validateResearchDecisionV3(portfolio(bearish), context)).toMatchObject({
      success: true,
    })
  })

  it("cross-checks OCC identity and strike ordering", () => {
    expect(researchCandidateV3Schema.safeParse({
      ...proposal().candidate,
      longLeg: { contractSymbol: "QQQ260918C00650000", strike: 650 },
    }).success).toBe(false)
    expectFailureCode(portfolio({
      ...proposal(),
      candidate: {
        ...proposal().candidate,
        longLeg: { ...proposal().candidate.longLeg, strike: 655 },
        shortLeg: { ...proposal().candidate.shortLeg, strike: 650 },
      },
    }), "SCHEMA_INVALID")
  })

  it("rejects model-authored execution fields", () => {
    expectFailureCode(portfolio(
      { ...proposal(), quantity: 1 } as unknown as TradeProposalV3,
    ), "SCHEMA_INVALID")
    expectFailureCode(portfolio({
      ...proposal(),
      candidate: { ...proposal().candidate, entryLimit: 2.15 },
    } as unknown as TradeProposalV3), "SCHEMA_INVALID")
  })

  it("requires candidate-specific snapshot references", () => {
    expectFailureCode(portfolio({
      ...proposal(),
      evidence: [{
        ...proposal().evidence[0]!,
        snapshotRef: proposalQuoteSnapshotRef("QQQ"),
      }],
    } as TradeProposalV3), "SCHEMA_INVALID")
  })

  it("fails closed on unknown, future, and stale snapshot metadata", () => {
    const decision = portfolio(proposal())
    expectFailureCode(decision, "UNKNOWN_SNAPSHOT", {
      evaluatedAt,
      snapshots: {},
    })
    expectFailureCode(decision, "SNAPSHOT_FROM_FUTURE", {
      evaluatedAt,
      snapshots: {
        [proposalQuoteSnapshotRef("SPY")]: {
          ...snapshot,
          retrievedAt: "2026-08-25T14:31:01.000Z",
          freshUntil: "2026-08-25T14:32:00.000Z",
        },
      },
    })
    expectFailureCode(decision, "STALE_SNAPSHOT", {
      evaluatedAt,
      snapshots: {
        [proposalQuoteSnapshotRef("SPY")]: {
          ...snapshot,
          freshUntil: "2026-08-25T14:30:59.000Z",
        },
      },
    })
  })

  it("requires inferences to reference sourced facts in the same proposal", () => {
    expectFailureCode(portfolio({
      ...proposal(),
      evidence: [
        ...proposal().evidence,
        {
          claimId: "inference",
          kind: "INFERENCE",
          claim: "The setup remains actionable.",
          basedOn: ["missing-fact"],
        },
      ],
    }), "UNKNOWN_INFERENCE_REFERENCE")
  })
})
