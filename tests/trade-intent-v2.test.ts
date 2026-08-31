import { describe, expect, it } from "vitest"

import {
  deriveTradeIntentV2,
  tradeIntentV2Schema,
  type ConfirmedOptionQuoteV2,
} from "../src/contracts/trade-intent-v2.js"
import type { ProposedTradeDecisionV2 } from "../src/contracts/research-decision-v2.js"
import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"

const bullishDecision: ProposedTradeDecisionV2 = {
  contractVersion: "2.0.0",
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
  invalidation: ["Reject if refreshed evidence changes the candidate."],
  evidence: [
    {
      claimId: "fact-1",
      kind: "SOURCED_FACT",
      claim: "The proposed contracts were present in the quote snapshot.",
      snapshotRef: "alpaca-proposal-quotes-v1",
    },
  ],
}

const quote = (
  contractSymbol: string,
  bidCentsPerShare: number,
  askCentsPerShare: number,
): ConfirmedOptionQuoteV2 => ({
  contractSymbol,
  feed: "INDICATIVE",
  bidCentsPerShare,
  askCentsPerShare,
  providerTimestamp: "2026-08-25T14:30:30.123456789Z",
})

const context = {
  quoteSnapshotRef: "alpaca-proposal-quotes-v1",
  evaluatedAt: "2026-08-25T14:31:00.000Z",
  longQuote: quote("SPY260918C00650000", 220, 223),
  shortQuote: quote("SPY260918C00655000", 120, 121),
} as const

describe("deriveTradeIntentV2", () => {
  it("derives exact economics and half-cent exit marks", () => {
    const result = deriveTradeIntentV2(bullishDecision, context)

    expect(result).toEqual({
      success: true,
      intent: {
        contractVersion: "2.0.0",
        decisionContractVersion: "2.0.0",
        direction: "BULLISH",
        structure: "BULL_CALL_SPREAD",
        expiration: "2026-09-18",
        longContractSymbol: "SPY260918C00650000",
        shortContractSymbol: "SPY260918C00655000",
        quoteSnapshotRef: "alpaca-proposal-quotes-v1",
        evaluatedAt: "2026-08-25T14:31:00.000Z",
        longQuote: context.longQuote,
        shortQuote: context.shortQuote,
        entryLimitCentsPerShare: 101,
        widthCentsPerShare: 500,
        maxLossCentsPerContract: 10_100,
        maxProfitCentsPerContract: 39_900,
        stopLossMarkHalfCentsPerShare: 101,
        profitTargetMarkHalfCentsPerShare: 601,
      },
    })
  })

  it("rounds an odd half-cent net midpoint upward", () => {
    const result = deriveTradeIntentV2(bullishDecision, {
      ...context,
      longQuote: quote("SPY260918C00650000", 220, 222),
      shortQuote: quote("SPY260918C00655000", 120, 121),
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected derivation to succeed")
    expect(result.intent.entryLimitCentsPerShare).toBe(101)
  })

  it("derives a bearish put spread without changing the arithmetic", () => {
    const bearishDecision: ProposedTradeDecisionV2 = {
      ...bullishDecision,
      direction: "BEARISH",
      candidate: {
        ...bullishDecision.candidate,
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
    }

    const result = deriveTradeIntentV2(bearishDecision, {
      ...context,
      longQuote: quote("SPY260918P00650000", 220, 223),
      shortQuote: quote("SPY260918P00645000", 120, 121),
    })

    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected derivation to succeed")
    expect(result.intent).toMatchObject({
      direction: "BEARISH",
      structure: "BEAR_PUT_SPREAD",
      widthCentsPerShare: 500,
    })
  })

  it("derives an intent for a matching QQQ candidate", () => {
    const decision: ProposedTradeDecisionV2 = {
      ...bullishDecision,
      candidate: {
        ...bullishDecision.candidate,
        underlying: "QQQ",
        longLeg: { contractSymbol: "QQQ260918C00650000", strike: 650 },
        shortLeg: { contractSymbol: "QQQ260918C00655000", strike: 655 },
      },
    }

    expect(deriveTradeIntentV2(decision, {
      ...context,
      longQuote: quote("QQQ260918C00650000", 220, 223),
      shortQuote: quote("QQQ260918C00655000", 120, 121),
    })).toMatchObject({ success: true })
  })

  it("returns identical intents for fixed inputs", () => {
    expect(deriveTradeIntentV2(bullishDecision, context)).toEqual(
      deriveTradeIntentV2(bullishDecision, context),
    )
  })

  it("preserves the canonical trade intent bytes", () => {
    const derived = deriveTradeIntentV2(bullishDecision, context)
    if (!derived.success) throw new Error("Expected intent derivation")

    expect(canonicalJsonSha256(derived.intent)).toBe("c22a2c06e60477b67d2644371507bfd91e3e76a476051a1842e9d80b291ffd15")
  })

  it("rejects quote symbols that do not match the proposed legs", () => {
    expect(
      deriveTradeIntentV2(bullishDecision, {
        ...context,
        longQuote: quote("SPY260918C00660000", 220, 223),
      }),
    ).toEqual({
      success: false,
      reasons: ["QUOTE_SYMBOL_MISMATCH"],
    })
  })

  it("rejects a non-positive net debit", () => {
    expect(
      deriveTradeIntentV2(bullishDecision, {
        ...context,
        longQuote: quote("SPY260918C00650000", 100, 101),
        shortQuote: quote("SPY260918C00655000", 110, 111),
      }),
    ).toEqual({
      success: false,
      reasons: ["NON_POSITIVE_NET_DEBIT"],
    })
  })

  it("rejects an entry limit equal to the spread width", () => {
    expect(
      deriveTradeIntentV2(bullishDecision, {
        ...context,
        longQuote: quote("SPY260918C00650000", 600, 601),
        shortQuote: quote("SPY260918C00655000", 100, 101),
      }),
    ).toEqual({
      success: false,
      reasons: ["ENTRY_LIMIT_NOT_BELOW_WIDTH"],
    })
  })

  it("rejects unsupported sub-cent strike encoding", () => {
    const decision: ProposedTradeDecisionV2 = {
      ...bullishDecision,
      candidate: {
        ...bullishDecision.candidate,
        longLeg: {
          contractSymbol: "SPY260918C00650001",
          strike: 650.001,
        },
      },
    }

    expect(
      deriveTradeIntentV2(decision, {
        ...context,
        longQuote: quote("SPY260918C00650001", 220, 223),
      }),
    ).toEqual({
      success: false,
      reasons: ["STRIKE_PRECISION_UNSUPPORTED"],
    })
  })

  it.each([
    ["unsupported root", "DIA260918C00650000", "DIA260918C00655000"],
    ["impossible expiration", "SPY260431C00650000", "SPY260431C00655000"],
  ])(
    "maps an %s to the existing derivation-input failure",
    (_case, longContractSymbol, shortContractSymbol) => {
      const decision = {
        ...bullishDecision,
        candidate: {
          ...bullishDecision.candidate,
          longLeg: {
            ...bullishDecision.candidate.longLeg,
            contractSymbol: longContractSymbol,
          },
          shortLeg: {
            ...bullishDecision.candidate.shortLeg,
            contractSymbol: shortContractSymbol,
          },
        },
      } as ProposedTradeDecisionV2

      expect(
        deriveTradeIntentV2(decision, {
          ...context,
          longQuote: quote(longContractSymbol, 220, 223),
          shortQuote: quote(shortContractSymbol, 120, 121),
        }),
      ).toEqual({
        success: false,
        reasons: ["DERIVATION_INPUT_INVALID"],
      })
    },
  )

  it("rejects an extreme debit at the spread-width boundary before conversion", () => {
    expect(
      deriveTradeIntentV2(bullishDecision, {
        ...context,
        longQuote: quote(
          "SPY260918C00650000",
          Number.MAX_SAFE_INTEGER - 1,
          Number.MAX_SAFE_INTEGER,
        ),
        shortQuote: quote("SPY260918C00655000", 1, 2),
      }),
    ).toEqual({
      success: false,
      reasons: ["ENTRY_LIMIT_NOT_BELOW_WIDTH"],
    })
  })

  it("rejects invalid quote inputs before arithmetic", () => {
    expect(
      deriveTradeIntentV2(bullishDecision, {
        ...context,
        longQuote: {
          ...context.longQuote,
          askCentsPerShare: context.longQuote.bidCentsPerShare,
        },
      }),
    ).toEqual({
      success: false,
      reasons: ["DERIVATION_INPUT_INVALID"],
    })
  })

  it("returns a bounded failure when quote time is invalid at evaluation", () => {
    expect(
      deriveTradeIntentV2(bullishDecision, {
        ...context,
        longQuote: {
          ...context.longQuote,
          providerTimestamp: "2026-08-25T14:31:00.0009Z",
        },
      }),
    ).toEqual({
      success: false,
      reasons: ["DERIVATION_INPUT_INVALID"],
    })
  })

  it("independently rejects inconsistent serialized intent fields", () => {
    const result = deriveTradeIntentV2(bullishDecision, context)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected derivation to succeed")

    const mutations = [
      { structure: "BEAR_PUT_SPREAD" },
      {
        longQuote: {
          ...result.intent.longQuote,
          contractSymbol: "SPY260918C00660000",
        },
      },
      {
        longQuote: {
          ...result.intent.longQuote,
          feed: "OPRA",
        },
      },
      { expiration: "2026-09-19" },
      {
        longQuote: {
          ...result.intent.longQuote,
          providerTimestamp: "2026-08-25T14:31:00.0009Z",
        },
      },
      {
        longQuote: {
          ...result.intent.longQuote,
          providerTimestamp: "2026-08-25T14:29:59.999Z",
        },
      },
      { entryLimitCentsPerShare: 102 },
      { widthCentsPerShare: 501 },
      { maxLossCentsPerContract: 10_200 },
      { maxProfitCentsPerContract: 40_000 },
      { stopLossMarkHalfCentsPerShare: 102 },
      { profitTargetMarkHalfCentsPerShare: 602 },
    ]

    for (const mutation of mutations) {
      expect(
        tradeIntentV2Schema.safeParse({
          ...result.intent,
          ...mutation,
        }).success,
      ).toBe(false)
    }
  })

  it("does not admit executable or approval fields", () => {
    const result = deriveTradeIntentV2(bullishDecision, context)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("Expected derivation to succeed")

    expect(result.intent).not.toHaveProperty("quantity")
    expect(result.intent).not.toHaveProperty("orderType")
    expect(result.intent).not.toHaveProperty("timeInForce")
    expect(result.intent).not.toHaveProperty("approved")

    expect(
      tradeIntentV2Schema.safeParse({
        ...result.intent,
        quantity: 1,
      }).success,
    ).toBe(false)
  })
})
