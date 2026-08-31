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
} from "../src/research/research-agent.js"
import { projectResearchContextV1 } from "../src/research/research-context-v1.js"

describe("research agent request construction", () => {
  it("uses the fixed checked-in agent identity", () => {
    expect(RESEARCH_AGENT_NAME).toBe("research")
    expect(RESEARCH_PROMPT_VERSION).toBe("3.0.3")
  })

  it("publishes bounded research budgets", () => {
    expect(RESEARCH_MAX_AGENT_STEPS).toBe(24)
    expect(RESEARCH_MAX_TOOL_CALLS).toBe(32)
    expect(RESEARCH_MAX_EXA_CALLS).toBe(4)
    expect(RESEARCH_MAX_FMP_CALLS).toBe(3)
    expect(RESEARCH_MAX_SNAPSHOT_REBUILDS).toBe(1)
  })

  it("builds a bounded cycle request with an optional operator objective", () => {
    expect(
      buildResearchCyclePrompt(
        3,
        new Date("2026-08-25T13:30:00.000Z"),
        "Compare downside catalysts.",
      ),
    ).toBe(
      [
        "Run structured research cycle 3 at 2026-08-25T13:30:00.000Z.",
        "Compare SPY, QQQ, IWM using current regime evidence, select at most one underlying, then research one eligible BULL_CALL_SPREAD or BEAR_PUT_SPREAD candidate or conclude NO_ACTION.",
        "Current operator objective: Compare downside catalysts.",
      ].join("\n"),
    )
  })

  it("does not add an empty operator objective", () => {
    expect(
      buildResearchCyclePrompt(1, new Date("2026-08-25T13:30:00.000Z")),
    ).not.toContain("Current operator objective")
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
  })

  it("labels ledger context as historical and requires current facts to be refreshed", () => {
    const context = projectResearchContextV1([], {
      generatedAt: "2026-08-25T13:29:00.000Z",
    })

    const prompt = buildResearchCyclePrompt(
      1,
      new Date("2026-08-25T13:30:00.000Z"),
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
    expect(prompt).toContain("Do not return PROPOSE_TRADE")
  })

  it("labels anytime dry runs as research-only", () => {
    const prompt = buildResearchCyclePrompt(
      1,
      new Date("2026-08-25T23:00:00.000Z"),
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
    expect(prompt).toContain("Never return PROPOSE_TRADE")
    expect(prompt).toContain('"researchMode":"DRY_RUN"')
  })

  it("allows proposals only for non-executing shadow anytime evaluation", () => {
    const prompt = buildResearchCyclePrompt(
      1,
      new Date("2026-08-25T23:00:00.000Z"),
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
    expect(prompt).toContain("A fresh PROPOSE_TRADE may be returned")
    expect(prompt).toContain('"researchMode":"DRY_RUN"')
    expect(prompt).not.toContain("Never return PROPOSE_TRADE")
  })
})
