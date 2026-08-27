import { describe, expect, it } from "vitest"

import {
  DRY_RUN_ANYTIME_RESEARCH_MODE,
  evaluateResearchEligibility,
  researchEligibilityV1Schema,
  type MarketSessionV1,
} from "../src/scheduling/research-eligibility.js"

const regularSession: MarketSessionV1 = {
  date: "2026-08-25",
  open: "2026-08-25T13:30:00.000Z",
  close: "2026-08-25T20:00:00.000Z",
  previousSessionDates: ["2026-08-21", "2026-08-24"],
}

const evaluate = (timestamp: string, session: MarketSessionV1 = regularSession) =>
  evaluateResearchEligibility({
    evaluatedAt: new Date(timestamp),
    session,
    premarketStartEt: "08:00",
  })

describe("research eligibility", () => {
  it("separates configured pre-market research from trade-intent eligibility", () => {
    expect(evaluate("2026-08-25T11:59:59.999Z")).toMatchObject({
      researchEligible: false,
      tradeIntentEligible: false,
    })
    expect(evaluate("2026-08-25T12:00:00.000Z")).toMatchObject({
      researchEligible: true,
      tradeIntentEligible: false,
    })
  })

  it("enforces the existing quarter-hour slot boundaries", () => {
    expect(evaluate("2026-08-25T14:00:00.000Z").tradeIntentEligible).toBe(true)
    expect(evaluate("2026-08-25T14:01:59.999Z").tradeIntentEligible).toBe(true)
    expect(evaluate("2026-08-25T14:02:00.000Z").tradeIntentEligible).toBe(false)
  })

  it("preserves the original slot for the five-minute completion window", () => {
    const started = evaluate("2026-08-25T14:01:59.999Z")
    expect(started.tradeIntentEligible).toBe(true)
    expect(started.sessionOpen).toBe("2026-08-25T13:30:00.000Z")
    expect(started.sessionClose).toBe("2026-08-25T20:00:00.000Z")
    expect(started.tradeIntentWindow).toEqual({
      slotStartedAt: "2026-08-25T14:00:00.000Z",
      deadline: "2026-08-25T14:05:00.000Z",
    })

    expect(
      evaluateResearchEligibility({
        evaluatedAt: new Date("2026-08-25T14:04:59.999Z"),
        session: regularSession,
        premarketStartEt: "08:00",
        tradeIntentWindow: started.tradeIntentWindow!,
      }).tradeIntentEligible,
    ).toBe(true)
    expect(
      evaluateResearchEligibility({
        evaluatedAt: new Date("2026-08-25T14:05:00.000Z"),
        session: regularSession,
        premarketStartEt: "08:00",
        tradeIntentWindow: started.tradeIntentWindow!,
      }).tradeIntentEligible,
    ).toBe(false)
  })

  it("does not open a new trade-intent window later in the same cycle", () => {
    expect(
      evaluateResearchEligibility({
        evaluatedAt: new Date("2026-08-25T14:15:00.000Z"),
        session: regularSession,
        premarketStartEt: "08:00",
        tradeIntentWindow: null,
      }).tradeIntentEligible,
    ).toBe(false)
  })

  it("uses early close when it is earlier than the configured entry cutoff", () => {
    const earlyClose = {
      ...regularSession,
      close: "2026-08-25T17:00:00.000Z",
    }
    expect(evaluate("2026-08-25T15:45:00.000Z", earlyClose).tradeIntentEligible).toBe(true)
    expect(evaluate("2026-08-25T16:00:00.000Z", earlyClose).tradeIntentEligible).toBe(false)
  })

  it("fails closed on holidays and outside the session date", () => {
    expect(
      evaluateResearchEligibility({
        evaluatedAt: new Date("2026-12-25T15:00:00.000Z"),
        premarketStartEt: "08:00",
      }),
    ).toMatchObject({
      researchEligible: false,
      tradeIntentEligible: false,
      reason: "NO_MARKET_SESSION",
    })
  })

  it.each(["09:30", "15:00", "invalid"])(
    "rejects an invalid pre-market start during startup validation: %s",
    (premarketStartEt) => {
      expect(() =>
        evaluateResearchEligibility({
          evaluatedAt: new Date("2026-08-25T10:00:00.000Z"),
          premarketStartEt,
        }),
      ).toThrow("Pre-market research start must use HH:MM before 09:30 ET")
    },
  )

  it("honors New York daylight-saving offsets", () => {
    const winter = {
      date: "2026-01-15",
      open: "2026-01-15T14:30:00.000Z",
      close: "2026-01-15T21:00:00.000Z",
    }
    expect(evaluate("2026-01-15T12:59:59.999Z", winter).researchEligible).toBe(false)
    expect(evaluate("2026-01-15T13:00:00.000Z", winter).researchEligible).toBe(true)
  })

  it("keeps expiration-day research non-actionable after the stricter strategy cutoff", () => {
    expect(evaluate("2026-08-25T19:30:00.000Z")).toMatchObject({
      researchEligible: true,
      tradeIntentEligible: false,
    })
  })

  it.each([
    "2026-08-25T04:00:00.000Z",
    "2026-08-25T14:00:00.000Z",
    "2026-08-26T03:59:59.999Z",
  ])("allows research-only dry runs throughout a trading date: %s", (timestamp) => {
    expect(
      evaluateResearchEligibility({
        evaluatedAt: new Date(timestamp),
        session: regularSession,
        premarketStartEt: "08:00",
        researchMode: DRY_RUN_ANYTIME_RESEARCH_MODE,
      }),
    ).toMatchObject({
      sessionDate: regularSession.date,
      researchEligible: true,
      tradeIntentEligible: false,
      researchMode: DRY_RUN_ANYTIME_RESEARCH_MODE,
      reason: "DRY_RUN_RESEARCH_ONLY",
    })
  })

  it("keeps anytime dry runs closed on non-session dates", () => {
    expect(
      evaluateResearchEligibility({
        evaluatedAt: new Date("2026-12-25T15:00:00.000Z"),
        premarketStartEt: "08:00",
        researchMode: DRY_RUN_ANYTIME_RESEARCH_MODE,
      }),
    ).toMatchObject({
      researchEligible: false,
      tradeIntentEligible: false,
      researchMode: DRY_RUN_ANYTIME_RESEARCH_MODE,
      reason: "NO_MARKET_SESSION",
    })
  })

  it("rejects contradictory anytime dry-run eligibility records", () => {
    expect(
      researchEligibilityV1Schema.safeParse({
        evaluatedAt: "2026-08-25T14:00:00.000Z",
        researchEligible: true,
        tradeIntentEligible: true,
        researchMode: DRY_RUN_ANYTIME_RESEARCH_MODE,
        reason: "DRY_RUN_RESEARCH_ONLY",
      }).success,
    ).toBe(false)
    expect(
      researchEligibilityV1Schema.safeParse({
        evaluatedAt: "2026-08-25T14:00:00.000Z",
        researchEligible: true,
        tradeIntentEligible: false,
        reason: "DRY_RUN_RESEARCH_ONLY",
      }).success,
    ).toBe(false)
  })
})
