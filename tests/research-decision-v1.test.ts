import { describe, expect, it } from "vitest"

import {
  NO_ACTION_REASON_CODES,
  validateResearchDecisionV1,
  type ResearchDecisionValidationContext,
} from "../src/contracts/research-decision-v1.js"

const context: ResearchDecisionValidationContext = {
  evaluatedAt: "2026-08-25T14:31:00.000Z",
  snapshots: {
    "alpaca-market-1": {
      provider: "ALPACA",
      source: "indicative-option-chain",
      retrievedAt: "2026-08-25T14:30:00.000Z",
      freshUntil: "2026-08-25T14:32:00.000Z",
    },
    "fmp-context-1": {
      provider: "FMP",
      source: "economic-calendar",
      retrievedAt: "2026-08-25T14:20:00.000Z",
      freshUntil: "2026-08-25T15:20:00.000Z",
    },
    "exa-context-1": {
      provider: "EXA",
      source: "web-search",
      retrievedAt: "2026-08-25T14:25:00.000Z",
      freshUntil: "2026-08-25T15:25:00.000Z",
    },
  },
}

const sourcedFact = {
  claimId: "fact-1",
  kind: "SOURCED_FACT",
  claim: "The selected SPY option contracts were present in the snapshot.",
  snapshotRef: "alpaca-market-1",
  locator: "contracts[0:2]",
} as const

const bullishProposal = {
  contractVersion: "1.0.0",
  strategyVersion: "1.0.0",
  outcome: "PROPOSE_TRADE",
  direction: "BULLISH",
  thesis: "Daily and intraday direction agree.",
  candidate: {
    underlying: "SPY",
    structure: "BULL_CALL_SPREAD",
    expiration: "2026-09-18",
    longLeg: {
      contractSymbol: "SPY260918C00650000",
      strike: 650,
    },
    shortLeg: {
      contractSymbol: "SPY260918C00655000",
      strike: 655,
    },
  },
  invalidation: ["Reject if refreshed evidence changes the selected candidate."],
  evidence: [sourcedFact],
} as const

const bearishProposal = {
  ...bullishProposal,
  direction: "BEARISH",
  thesis: "Daily and intraday bearish direction agree.",
  candidate: {
    ...bullishProposal.candidate,
    structure: "BEAR_PUT_SPREAD",
    longLeg: {
      contractSymbol: "SPY260918P00650000",
      strike: 650,
    },
    shortLeg: {
      contractSymbol: "SPY260918P00645000",
      strike: 645,
    },
  },
} as const

const expectFailureCode = (
  input: unknown,
  expectedCode: string,
  validationContext: ResearchDecisionValidationContext = context,
) => {
  const result = validateResearchDecisionV1(input, validationContext)

  expect(result.success).toBe(false)
  if (result.success) throw new Error("Expected validation to fail")
  expect(result.issues.map(({ code }) => code)).toContain(expectedCode)
  return result
}

describe("ResearchDecision v1 NO_ACTION contract", () => {
  it.each(NO_ACTION_REASON_CODES)("accepts the minimal %s result", (reasonCode) => {
    const result = validateResearchDecisionV1(
      {
        contractVersion: "1.0.0",
        strategyVersion: "1.0.0",
        outcome: "NO_ACTION",
        reasonCodes: [reasonCode],
      },
      context,
    )

    expect(result).toEqual({
      success: true,
      data: {
        contractVersion: "1.0.0",
        strategyVersion: "1.0.0",
        outcome: "NO_ACTION",
        reasonCodes: [reasonCode],
        evidence: [],
      },
    })
  })

  it("discards irrelevant commentary instead of invalidating a safe result", () => {
    const result = validateResearchDecisionV1(
      {
        contractVersion: "1.0.0",
        strategyVersion: "1.0.0",
        outcome: "NO_ACTION",
        reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
        commentary: { arbitrary: "content" },
      },
      context,
    )

    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected validation to succeed")
    expect(result.data).not.toHaveProperty("commentary")
  })

  it("rejects an empty reason-code list", () => {
    expectFailureCode(
      {
        contractVersion: "1.0.0",
        strategyVersion: "1.0.0",
        outcome: "NO_ACTION",
        reasonCodes: [],
      },
      "SCHEMA_INVALID",
    )
  })

  it("does not require execution-level fields", () => {
    const result = validateResearchDecisionV1(
      {
        contractVersion: "1.0.0",
        strategyVersion: "1.0.0",
        outcome: "NO_ACTION",
        reasonCodes: ["NO_ELIGIBLE_SPREAD"],
      },
      context,
    )

    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected validation to succeed")
    expect(result.data).not.toHaveProperty("candidate")
    expect(result.data).not.toHaveProperty("entryLimit")
    expect(result.data).not.toHaveProperty("maxLoss")
  })
})

describe("ResearchDecision v1 proposal contract", () => {
  it("accepts a bullish call-spread proposal", () => {
    expect(validateResearchDecisionV1(bullishProposal, context)).toEqual({
      success: true,
      data: bullishProposal,
    })
  })

  it("accepts a bearish put-spread proposal", () => {
    expect(validateResearchDecisionV1(bearishProposal, context)).toEqual({
      success: true,
      data: bearishProposal,
    })
  })

  it("accepts sourced optional context and inference based on sourced facts", () => {
    const input = {
      ...bullishProposal,
      evidence: [
        sourcedFact,
        {
          claimId: "fact-2",
          kind: "SOURCED_FACT",
          claim: "No scheduled macro release conflicts with the decision window.",
          snapshotRef: "fmp-context-1",
        },
        {
          claimId: "fact-3",
          kind: "SOURCED_FACT",
          claim: "Current reporting corroborates the identified market context.",
          snapshotRef: "exa-context-1",
        },
        {
          claimId: "inference-1",
          kind: "INFERENCE",
          claim: "The sourced facts support continued evaluation of the candidate.",
          basedOn: ["fact-1", "fact-2", "fact-3"],
        },
      ],
    }

    expect(validateResearchDecisionV1(input, context)).toEqual({
      success: true,
      data: input,
    })
  })

  it.each([
    ["contractVersion", { ...bullishProposal, contractVersion: "2.0.0" }],
    ["strategyVersion", { ...bullishProposal, strategyVersion: "2.0.0" }],
    ["outcome", { ...bullishProposal, outcome: "TRADE" }],
    [
      "underlying",
      {
        ...bullishProposal,
        candidate: { ...bullishProposal.candidate, underlying: "QQQ" },
      },
    ],
    [
      "structure",
      {
        ...bullishProposal,
        candidate: { ...bullishProposal.candidate, structure: "IRON_CONDOR" },
      },
    ],
  ])("rejects an unsupported %s", (_field, input) => {
    expectFailureCode(input, "SCHEMA_INVALID")
  })

  it.each(["contractVersion", "strategyVersion", "outcome"] as const)(
    "rejects a missing %s",
    (field) => {
      const input = structuredClone(bullishProposal) as Record<string, unknown>
      delete input[field]

      expectFailureCode(input, "SCHEMA_INVALID")
    },
  )

  it("rejects a direction and structure mismatch", () => {
    expectFailureCode(
      {
        ...bullishProposal,
        direction: "BEARISH",
      },
      "SCHEMA_INVALID",
    )
  })

  it.each([
    [
      "bull call",
      {
        ...bullishProposal,
        candidate: {
          ...bullishProposal.candidate,
          longLeg: { ...bullishProposal.candidate.longLeg, strike: 655 },
          shortLeg: { ...bullishProposal.candidate.shortLeg, strike: 650 },
        },
      },
    ],
    [
      "bear put",
      {
        ...bearishProposal,
        candidate: {
          ...bearishProposal.candidate,
          longLeg: { ...bearishProposal.candidate.longLeg, strike: 645 },
          shortLeg: { ...bearishProposal.candidate.shortLeg, strike: 650 },
        },
      },
    ],
  ])("rejects incorrect %s strike ordering", (_structure, input) => {
    expectFailureCode(input, "SCHEMA_INVALID")
  })

  it.each([
    [
      "option type",
      {
        ...bullishProposal,
        candidate: {
          ...bullishProposal.candidate,
          longLeg: {
            ...bullishProposal.candidate.longLeg,
            contractSymbol: "SPY260918P00650000",
          },
        },
      },
    ],
    [
      "expiration",
      {
        ...bullishProposal,
        candidate: {
          ...bullishProposal.candidate,
          longLeg: {
            ...bullishProposal.candidate.longLeg,
            contractSymbol: "SPY260919C00650000",
          },
        },
      },
    ],
    [
      "strike",
      {
        ...bullishProposal,
        candidate: {
          ...bullishProposal.candidate,
          longLeg: {
            ...bullishProposal.candidate.longLeg,
            contractSymbol: "SPY260918C00651000",
          },
        },
      },
    ],
  ])("rejects a contract symbol with a mismatched %s", (_field, input) => {
    expectFailureCode(input, "SCHEMA_INVALID")
  })

  it("rejects an expiration whose full year is not uniquely encoded by the OCC symbol", () => {
    expectFailureCode(
      {
        ...bullishProposal,
        candidate: {
          ...bullishProposal.candidate,
          expiration: "2126-09-18",
        },
      },
      "SCHEMA_INVALID",
    )
  })

  it("rejects duplicate leg symbols", () => {
    expectFailureCode(
      {
        ...bullishProposal,
        candidate: {
          ...bullishProposal.candidate,
          shortLeg: {
            ...bullishProposal.candidate.shortLeg,
            contractSymbol: bullishProposal.candidate.longLeg.contractSymbol,
          },
        },
      },
      "SCHEMA_INVALID",
    )
  })

  it("rejects a missing leg identifier", () => {
    const input = structuredClone(bullishProposal) as Record<string, unknown>
    const candidate = input.candidate as {
      longLeg: Record<string, unknown>
    }
    delete candidate.longLeg.contractSymbol

    expectFailureCode(input, "SCHEMA_INVALID")
  })

  it.each([
    ["entryLimit", 2.15],
    ["maxLoss", 215],
    ["buyingPowerImpact", 215],
    ["exits", { stop: 1.1 }],
    ["quantity", 1],
    ["orderType", "LIMIT"],
  ])("rejects model-supplied %s", (field, value) => {
    expectFailureCode(
      {
        ...bullishProposal,
        [field]: value,
      },
      "SCHEMA_INVALID",
    )
  })

  it("rejects execution fields nested in the candidate", () => {
    expectFailureCode(
      {
        ...bullishProposal,
        candidate: {
          ...bullishProposal.candidate,
          entryLimit: 2.15,
        },
      },
      "SCHEMA_INVALID",
    )
  })

  it.each([
    ["empty thesis", { ...bullishProposal, thesis: "" }],
    ["empty invalidation", { ...bullishProposal, invalidation: [] }],
    ["missing evidence", { ...bullishProposal, evidence: [] }],
  ])("rejects %s", (_case, input) => {
    expectFailureCode(input, "SCHEMA_INVALID")
  })
})

describe("ResearchDecision v1 evidence validation", () => {
  it("rejects an invalid evaluation timestamp", () => {
    expectFailureCode(
      bullishProposal,
      "CONTEXT_INVALID",
      {
        ...context,
        evaluatedAt: "not-a-timestamp",
      },
    )
  })

  it("rejects a freshness deadline before snapshot retrieval", () => {
    expectFailureCode(
      bullishProposal,
      "CONTEXT_INVALID",
      {
        ...context,
        snapshots: {
          ...context.snapshots,
          "alpaca-market-1": {
            ...context.snapshots["alpaca-market-1"]!,
            freshUntil: "2026-08-25T14:29:59.999Z",
          },
        },
      },
    )
  })

  it("rejects duplicate claim IDs", () => {
    expectFailureCode(
      {
        ...bullishProposal,
        evidence: [sourcedFact, { ...sourcedFact }],
      },
      "DUPLICATE_CLAIM_ID",
    )
  })

  it("rejects an unknown snapshot reference", () => {
    expectFailureCode(
      {
        ...bullishProposal,
        evidence: [{ ...sourcedFact, snapshotRef: "missing-snapshot" }],
      },
      "UNKNOWN_SNAPSHOT",
    )
  })

  it.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "rejects inherited snapshot key %s without a trusted own snapshot",
    (snapshotRef) => {
      expectFailureCode(
        {
          ...bullishProposal,
          evidence: [{ ...sourcedFact, snapshotRef }],
        },
        "UNKNOWN_SNAPSHOT",
      )
    },
  )

  it("accepts a trusted own snapshot whose key collides with a prototype name", () => {
    const result = validateResearchDecisionV1(
      {
        ...bullishProposal,
        evidence: [{ ...sourcedFact, snapshotRef: "constructor" }],
      },
      {
        ...context,
        snapshots: {
          constructor: context.snapshots["alpaca-market-1"]!,
        },
      },
    )

    expect(result.success).toBe(true)
  })

  it("rejects a snapshot retrieved after evaluation", () => {
    expectFailureCode(
      bullishProposal,
      "SNAPSHOT_FROM_FUTURE",
      {
        ...context,
        snapshots: {
          ...context.snapshots,
          "alpaca-market-1": {
            ...context.snapshots["alpaca-market-1"]!,
            retrievedAt: "2026-08-25T14:31:01.000Z",
          },
        },
      },
    )
  })

  it("rejects a stale snapshot", () => {
    expectFailureCode(
      bullishProposal,
      "STALE_SNAPSHOT",
      {
        ...context,
        snapshots: {
          ...context.snapshots,
          "alpaca-market-1": {
            ...context.snapshots["alpaca-market-1"]!,
            freshUntil: "2026-08-25T14:30:59.999Z",
          },
        },
      },
    )
  })

  it("accepts a snapshot fresh exactly through evaluation", () => {
    const result = validateResearchDecisionV1(bullishProposal, {
      ...context,
      snapshots: {
        ...context.snapshots,
        "alpaca-market-1": {
          ...context.snapshots["alpaca-market-1"]!,
          freshUntil: context.evaluatedAt,
        },
      },
    })

    expect(result.success).toBe(true)
  })

  it("rejects an inference without supporting claims", () => {
    expectFailureCode(
      {
        ...bullishProposal,
        evidence: [
          sourcedFact,
          {
            claimId: "inference-1",
            kind: "INFERENCE",
            claim: "Unsupported inference.",
            basedOn: [],
          },
        ],
      },
      "SCHEMA_INVALID",
    )
  })

  it("rejects an inference referencing an unknown claim", () => {
    expectFailureCode(
      {
        ...bullishProposal,
        evidence: [
          sourcedFact,
          {
            claimId: "inference-1",
            kind: "INFERENCE",
            claim: "Inference with a missing basis.",
            basedOn: ["missing-fact"],
          },
        ],
      },
      "UNKNOWN_INFERENCE_REFERENCE",
    )
  })

  it("rejects an inference based on another inference", () => {
    expectFailureCode(
      {
        ...bullishProposal,
        evidence: [
          sourcedFact,
          {
            claimId: "inference-1",
            kind: "INFERENCE",
            claim: "First inference.",
            basedOn: ["fact-1"],
          },
          {
            claimId: "inference-2",
            kind: "INFERENCE",
            claim: "Second inference.",
            basedOn: ["inference-1"],
          },
        ],
      },
      "INFERENCE_REFERENCE_NOT_FACT",
    )
  })

  it("returns bounded failures without the raw payload", () => {
    const secretMarker = "raw-payload-must-not-be-returned"
    const result = expectFailureCode(
      {
        ...bullishProposal,
        thesis: secretMarker,
        unexpected: secretMarker,
      },
      "SCHEMA_INVALID",
    )

    expect(JSON.stringify(result)).not.toContain(secretMarker)
  })

  it("returns the same result for identical input and context", () => {
    const first = validateResearchDecisionV1(bullishProposal, context)
    const second = validateResearchDecisionV1(bullishProposal, context)

    expect(second).toEqual(first)
  })
})