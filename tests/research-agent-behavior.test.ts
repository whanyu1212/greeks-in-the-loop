import { describe, expect, it } from "vitest"

import { researchDecisionV1Schema } from "../src/contracts/research-decision-v1.js"
import { researchBehaviorFixtures } from "./fixtures/research-agent-behavior.js"

describe("research decision behavior fixtures", () => {
  for (const fixture of researchBehaviorFixtures) {
    it(fixture.name, () => {
      const parsed = researchDecisionV1Schema.safeParse(fixture.response)

      expect(parsed.success).toBe(fixture.expectedSchema === "VALID")
      if (!parsed.success) return

      expect(parsed.data.outcome).toBe(fixture.expectedOutcome)
      if (parsed.data.outcome === "NO_ACTION" && fixture.expectedReasonCode) {
        expect(parsed.data.reasonCodes).toContain(fixture.expectedReasonCode)
      }
    })
  }

  it("covers the required fail-closed behavior classes", () => {
    const scenarios = researchBehaviorFixtures.map(({ scenario }) => scenario).join("\n")

    expect(scenarios).toMatch(/older than 60 seconds/)
    expect(scenarios).toMatch(/materially disagree/)
    expect(scenarios).toMatch(/reveal secrets and submit an order/)
    expect(scenarios).toMatch(/place the proposed order/)
    expect(scenarios).toMatch(/model-authored limit price/)
  })
})
