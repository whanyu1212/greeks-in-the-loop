import { describe, expect, it } from "vitest"

import {
  buildResearchCyclePrompt,
  buildResearchReportRepairPrompt,
  RESEARCH_AGENT_NAME,
  RESEARCH_MAX_AGENT_STEPS,
  RESEARCH_MAX_EXA_CALLS,
  RESEARCH_MAX_FMP_CALLS,
  RESEARCH_MAX_SNAPSHOT_REBUILDS,
  RESEARCH_MAX_TOOL_CALLS,
  RESEARCH_PROMPT_VERSION,
  researchToolBudgetViolation,
} from "../src/research/agent.js"
import { projectResearchContextV1 } from "../src/research/context.js"
import { screenOptionUniverseV2 } from "../src/research/symbol-screen.js"

const optionUniverse = {
  snapshotVersion: "2.0.0",
  policyVersion: "5.0.0",
  snapshotId: `option-universe-v2-${"0".repeat(64)}`,
  generatedAt: "2026-08-25T13:29:00.000Z",
  sessionDate: "2026-08-25",
  source: "ALPACA_OPTIONS_SCREENERS",
  candidates: [
    { rank: 1, underlying: "TSLA", activityRank: 2, sessionPercentChange: 4.2 },
    { rank: 2, underlying: "NVDA", activityRank: 1, sessionPercentChange: -3.1 },
    { rank: 3, underlying: "AMD", activityRank: 8, sessionPercentChange: 2.4 },
  ],
} as const

describe("research agent request construction", () => {
  it("uses the fixed checked-in agent identity", () => {
    expect(RESEARCH_AGENT_NAME).toBe("research")
    expect(RESEARCH_PROMPT_VERSION).toBe("7.4.0")
  })

  it("publishes bounded research budgets", () => {
    expect(RESEARCH_MAX_AGENT_STEPS).toBe(48)
    expect(RESEARCH_MAX_TOOL_CALLS).toBe(64)
    expect(RESEARCH_MAX_EXA_CALLS).toBe(4)
    expect(RESEARCH_MAX_FMP_CALLS).toBe(3)
    expect(RESEARCH_MAX_SNAPSHOT_REBUILDS).toBe(1)
  })

  it("rejects aggregate tool usage above any research budget", () => {
    const usage = (names: readonly string[], toolCallCount = names.length) => ({
      toolCallCount,
      toolCalls: names.map((name) => ({ name })),
    })
    expect(researchToolBudgetViolation(usage([], RESEARCH_MAX_TOOL_CALLS + 1)))
      .toBe("TOTAL_TOOL_BUDGET_EXCEEDED")
    expect(researchToolBudgetViolation(usage(
      Array.from({ length: RESEARCH_MAX_EXA_CALLS + 1 }, () => "exa_search"),
    ))).toBe("EXA_TOOL_BUDGET_EXCEEDED")
    expect(researchToolBudgetViolation(usage(
      Array.from({ length: RESEARCH_MAX_FMP_CALLS + 1 }, () => "fmp_quote"),
    ))).toBe("FMP_TOOL_BUDGET_EXCEEDED")
    expect(researchToolBudgetViolation(usage([
      ...Array.from({ length: RESEARCH_MAX_EXA_CALLS }, () => "exa_search"),
      ...Array.from({ length: RESEARCH_MAX_FMP_CALLS }, () => "fmp_quote"),
    ]))).toBeUndefined()
  })

  it("builds a bounded cycle request with an optional operator objective", () => {
    expect(
      buildResearchCyclePrompt(
        3,
        new Date("2026-08-25T13:30:00.000Z"),
        optionUniverse,
        "Compare downside catalysts.",
      ),
    ).toBe(
      [
        "Run structured research cycle 3 at 2026-08-25T13:30:00.000Z.",
        "The application-authoritative option universe follows. Copy it exactly into analysis.optionUniverse; do not add or substitute symbols.",
        JSON.stringify(optionUniverse),
        "Lightly evaluate every shortlisted underlying (TSLA, NVDA, AMD), promote at most three to deep option research, and return either NO_ACTION or one to three ranked proposals using only exact ACTIONABLE symbol-strategy pairs from the application screen.",
        "Current operator objective: Compare downside catalysts.",
      ].join("\n"),
    )
  })

  it("does not add an empty operator objective", () => {
    expect(
      buildResearchCyclePrompt(
        1,
        new Date("2026-08-25T13:30:00.000Z"),
        optionUniverse,
      ),
    ).not.toContain("Current operator objective")
  })

  it("renders the application-authoritative strategy screen", () => {
    const symbolScreen = screenOptionUniverseV2(optionUniverse)
    const prompt = buildResearchCyclePrompt(
      1,
      new Date("2026-08-25T13:30:00.000Z"),
      optionUniverse,
      undefined,
      undefined,
      undefined,
      symbolScreen,
    )

    expect(prompt).toContain("exact underlying and strategy pair marked ACTIONABLE")
    expect(prompt).toContain("WATCH, REJECTED, and UNAVAILABLE pairs")
    expect(prompt).toContain("account approval does not override this screen")
    expect(prompt).toContain(JSON.stringify({
      policyVersion: symbolScreen.policyVersion,
      evaluatedAt: symbolScreen.evaluatedAt,
      universeSnapshotId: symbolScreen.universeSnapshotId,
      symbols: symbolScreen.symbols,
    }))
    expect(prompt).not.toContain('"mode":"SHADOW"')
  })

  it("builds a bounded schema-only correction request", () => {
    const prompt = buildResearchReportRepairPrompt([
      {
        code: "SCHEMA_INVALID",
        path: ["result", "invalidation"],
        schemaCategory: "TYPE_MISMATCH",
      },
    ])

    expect(prompt).toContain("Do not call tools or add new research")
    expect(prompt).toContain('"path":["result","invalidation"]')
    expect(prompt).toContain("exactly three fractional digits")
    expect(prompt).toContain("NO_ACTION evidence is a non-empty array")
    expect(prompt).toContain("evidence kind is SOURCED_FACT or INFERENCE")
    expect(prompt).toContain("temporalClass is LIVE, DELAYED, or PRIOR_CLOSE")
    expect(prompt).toContain("analysis.accountChecks is exactly")
    expect(prompt).toContain('verification:\"AGENT_REPORTED\"')
    expect(prompt).toContain("Each analysis.symbolIndicators item is exactly")
    expect(prompt).toContain("Do not add verification or any other field to symbol indicators")
    expect(prompt).toContain("largest return is rank 1")
    expect(prompt).toContain("A BULLISH or BEARISH marketRegimes item requires")
    expect(prompt).toContain("Use benchmark, not underlying")
    expect(prompt).toContain("EXA externalContext is exactly")
    expect(prompt).toContain("ResearchReportV7")
  })

  it("labels ledger context as historical and requires current facts to be refreshed", () => {
    const context = projectResearchContextV1([], {
      generatedAt: "2026-08-25T13:29:00.000Z",
    })

    const prompt = buildResearchCyclePrompt(
      1,
      new Date("2026-08-25T13:30:00.000Z"),
      optionUniverse,
      undefined,
      context,
    )

    expect(prompt).toContain(
      "Application-generated durable context from prior cycles follows.",
    )
    expect(prompt).toContain("OpenCode session memory is not authoritative")
    expect(prompt).toContain("all current account, market, quote, and freshness facts must be refreshed")
    expect(prompt).toContain(JSON.stringify(context))
  })

  it("renders application-authoritative staged eligibility", () => {
    const prompt = buildResearchCyclePrompt(
      1,
      new Date("2026-08-25T12:00:00.000Z"),
      optionUniverse,
      undefined,
      undefined,
      {
        evaluatedAt: "2026-08-25T12:00:00.000Z",
        sessionDate: "2026-08-25",
        researchEligible: true,
        tradeIntentEligible: false,
        reason: "OUTSIDE_TRADE_INTENT_WINDOW",
      },
    )

    expect(prompt).toContain("Application-authoritative")
    expect(prompt).toContain('"tradeIntentEligible":false')
    expect(prompt).toContain("Do not return PROPOSE_TRADES")
  })

  it("labels anytime dry runs as research-only", () => {
    const prompt = buildResearchCyclePrompt(
      1,
      new Date("2026-08-25T23:00:00.000Z"),
      optionUniverse,
      undefined,
      undefined,
      {
        evaluatedAt: "2026-08-25T23:00:00.000Z",
        sessionDate: "2026-08-25",
        researchEligible: true,
        tradeIntentEligible: false,
        researchMode: "DRY_RUN",
        reason: "DRY_RUN_RESEARCH_ONLY",
      },
    )

    expect(prompt).toContain("research-only dry run")
    expect(prompt).toContain("Never return PROPOSE_TRADES")
    expect(prompt).toContain('"researchMode":"DRY_RUN"')
  })

  it("allows proposals only for non-executing shadow anytime evaluation", () => {
    const prompt = buildResearchCyclePrompt(
      1,
      new Date("2026-08-25T23:00:00.000Z"),
      optionUniverse,
      undefined,
      undefined,
      {
        evaluatedAt: "2026-08-25T23:00:00.000Z",
        sessionDate: "2026-08-25",
        researchEligible: true,
        tradeIntentEligible: true,
        tradeIntentWindow: {
          slotStartedAt: "2026-08-25T23:00:00.000Z",
          deadline: "2026-08-26T23:00:00.000Z",
        },
        researchMode: "DRY_RUN",
      },
    )

    expect(prompt).toContain("non-executing dry run")
    expect(prompt).toContain("Fresh PROPOSE_TRADES candidates may be returned")
    expect(prompt).toContain('"researchMode":"DRY_RUN"')
    expect(prompt).not.toContain("Never return PROPOSE_TRADES")
  })
})
