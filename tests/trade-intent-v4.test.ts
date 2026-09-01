import { describe, expect, it } from "vitest"

import type { TradeProposalV4 } from "../src/contracts/research-decision-v4.js"
import {
  deriveTradeIntentV4,
  tradeIntentV4Schema,
} from "../src/contracts/trade-intent-v4.js"

const proposal: TradeProposalV4 = {
  priority: 1,
  direction: "NEUTRAL",
  thesis: "The range supports a defined-risk condor.",
  candidate: {
    underlying: "SPY",
    strategy: "IRON_CONDOR",
    legs: [
      { contractSymbol: "SPY261218P00490000", positionIntent: "BUY_TO_OPEN", ratioQuantity: 1 },
      { contractSymbol: "SPY261218P00500000", positionIntent: "SELL_TO_OPEN", ratioQuantity: 1 },
      { contractSymbol: "SPY261218C00520000", positionIntent: "SELL_TO_OPEN", ratioQuantity: 1 },
      { contractSymbol: "SPY261218C00530000", positionIntent: "BUY_TO_OPEN", ratioQuantity: 1 },
    ],
  },
  invalidation: ["The expected range changes."],
  evidence: [{
    claimId: "quotes",
    kind: "SOURCED_FACT",
    claim: "Exact legs were observed.",
    snapshotRef: "alpaca-proposal-quotes-v2-SPY",
  }],
}

const quote = (contractSymbol: string, bid: number, ask: number) => ({
  contractSymbol,
  feed: "INDICATIVE" as const,
  bidCentsPerShare: bid,
  askCentsPerShare: ask,
  providerTimestamp: "2026-09-01T14:29:59.000000000Z",
})

describe("TradeIntentV4", () => {
  it("derives a credit from all ordered ratio legs", () => {
    const result = deriveTradeIntentV4(proposal, {
      quoteSnapshotRef: "alpaca-proposal-quotes-v2-SPY",
      evaluatedAt: "2026-09-01T14:30:00.000Z",
      quotes: [
        quote(proposal.candidate.legs[0]!.contractSymbol, 40, 45),
        quote(proposal.candidate.legs[1]!.contractSymbol, 90, 95),
        quote(proposal.candidate.legs[2]!.contractSymbol, 85, 90),
        quote(proposal.candidate.legs[3]!.contractSymbol, 35, 40),
      ],
    })
    expect(result).toMatchObject({
      success: true,
      intent: {
        strategy: "IRON_CONDOR",
        premiumEffect: "CREDIT",
        entryLimitCentsPerStrategyUnit: 90,
      },
    })
    if (result.success) expect(tradeIntentV4Schema.parse(result.intent)).toEqual(result.intent)
  })

  it("rejects a missing exact-leg quote", () => {
    expect(deriveTradeIntentV4(proposal, {
      quoteSnapshotRef: "alpaca-proposal-quotes-v2-SPY",
      evaluatedAt: "2026-09-01T14:30:00.000Z",
      quotes: [quote(proposal.candidate.legs[0]!.contractSymbol, 40, 45)],
    })).toEqual({ success: false, reasons: ["QUOTE_SYMBOL_MISMATCH"] })
  })
})
