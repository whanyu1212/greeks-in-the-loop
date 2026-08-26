import { describe, expect, it } from "vitest"

import {
  buildResearchCyclePrompt,
  RESEARCH_AGENT_NAME,
} from "../src/research/research-agent.js"
import { projectResearchContextV1 } from "../src/research/research-context-v1.js"

describe("research agent request construction", () => {
  it("uses the fixed checked-in agent identity", () => {
    expect(RESEARCH_AGENT_NAME).toBe("research")
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
        "Inspect observable paper-account state first without claiming reconciliation or risk approval, then inspect only the evidence needed to identify the highest-ranked eligible defined-risk options candidate or conclude NO_ACTION.",
        "Current operator objective: Compare downside catalysts.",
      ].join("\n"),
    )
  })

  it("does not add an empty operator objective", () => {
    expect(
      buildResearchCyclePrompt(1, new Date("2026-08-25T13:30:00.000Z")),
    ).not.toContain("Current operator objective")
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
})
