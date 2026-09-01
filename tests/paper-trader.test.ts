import { describe, expect, it } from "vitest"

import {
  buildPaperTraderPrompt,
  hasPaperTraderModelIdentityV1,
  PAPER_TRADER_MODEL_IDENTITY,
} from "../src/execution/paper-trader.js"
import { paperTraderResultV1Schema } from "../src/execution/paper-trader-result-v1.js"

describe("paper trader boundary", () => {
  it("hands off only the opaque authorization ID", () => {
    const prompt = buildPaperTraderPrompt("cycle-authorization-1")

    expect(prompt).toContain('"cycle-authorization-1"')
    expect(prompt).not.toContain("SPY")
    expect(prompt).not.toContain("limit_price")
    expect(prompt).not.toContain("client_order_id")
  })

  it("pins responses to the trader model rather than the research model", () => {
    expect(PAPER_TRADER_MODEL_IDENTITY).toEqual({
      providerId: "openai",
      modelId: "gpt-5.6-sol",
    })
    expect(hasPaperTraderModelIdentityV1(PAPER_TRADER_MODEL_IDENTITY)).toBe(true)
    expect(hasPaperTraderModelIdentityV1({
      providerId: "openai",
      modelId: "gpt-5.6-terra",
    })).toBe(false)
  })

  it("accepts bounded submission results and rejects incomplete success", () => {
    const result = {
      resultVersion: "1.0.0",
      status: "SUBMITTED",
      authorizationId: "cycle-authorization-1",
      clientOrderId: "gitl-1234",
      paperOrderId: "paper-order-1",
      brokerStatus: "accepted",
      observedAt: "2026-09-01T14:01:00.000Z",
      reasonCodes: [],
    }
    expect(paperTraderResultV1Schema.parse(result)).toEqual(result)
    expect(paperTraderResultV1Schema.safeParse({
      ...result,
      paperOrderId: undefined,
    }).success).toBe(false)
    expect(paperTraderResultV1Schema.safeParse({
      ...result,
      status: "NOT_SUBMITTED",
      clientOrderId: null,
      reasonCodes: [],
    }).success).toBe(false)
  })
})
