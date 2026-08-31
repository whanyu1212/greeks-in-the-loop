import { describe, expect, it } from "vitest"

import {
  DRY_RUN_MODE,
  evaluateResearchEligibility,
  type MarketSessionV1,
} from "../src/scheduling/research-eligibility.js"

const session: MarketSessionV1 = {
  date: "2026-08-25",
  open: "2026-08-25T13:30:00.000Z",
  close: "2026-08-25T20:00:00.000Z",
  previousSessionDates: ["2026-08-21", "2026-08-24"],
}

describe("research eligibility", () => {
  it("keeps standard research and trade windows deterministic", () => {
    const premarket = evaluateResearchEligibility({
      evaluatedAt: new Date("2026-08-25T12:00:00.000Z"),
      session,
    })
    expect(premarket).toMatchObject({
      researchEligible: true,
      tradeIntentEligible: false,
    })

    const entry = evaluateResearchEligibility({
      evaluatedAt: new Date("2026-08-25T14:00:00.000Z"),
      session,
    })
    expect(entry.tradeIntentWindow).toEqual({
      slotStartedAt: "2026-08-25T14:00:00.000Z",
      deadline: "2026-08-25T14:10:00.000Z",
    })
  })

  it("allows a current-session dry run through shadow risk", () => {
    expect(
      evaluateResearchEligibility({
        evaluatedAt: new Date("2026-08-25T14:07:00.000Z"),
        session,
        researchMode: DRY_RUN_MODE,
      }),
    ).toMatchObject({
      researchEligible: true,
      tradeIntentEligible: true,
      researchMode: DRY_RUN_MODE,
    })
  })

  it("makes a historical dry run research-only", () => {
    expect(
      evaluateResearchEligibility({
        evaluatedAt: new Date("2026-08-31T14:00:00.000Z"),
        session,
        researchMode: DRY_RUN_MODE,
      }),
    ).toMatchObject({
      sessionDate: "2026-08-25",
      researchEligible: true,
      tradeIntentEligible: false,
      reason: "DRY_RUN_RESEARCH_ONLY",
    })
  })

  it("fails closed when no market session exists", () => {
    expect(
      evaluateResearchEligibility({
        evaluatedAt: new Date("2026-12-25T15:00:00.000Z"),
        researchMode: DRY_RUN_MODE,
      }),
    ).toMatchObject({
      researchEligible: false,
      tradeIntentEligible: false,
      reason: "NO_MARKET_SESSION",
    })
  })
})
