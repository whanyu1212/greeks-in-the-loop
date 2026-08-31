import { describe, expect, it } from "vitest"

import {
  assertResearchModelIdentityV1,
  createResearchInvocationV1,
  RESEARCH_INVOCATION_PROVENANCE_BY_VERSION,
  RESEARCH_INVOCATION_VERSION,
  researchInvocationV1Schema,
  SUPPORTED_RESEARCH_INVOCATION_VERSIONS,
} from "../src/research/research-invocation-v1.js"

const versions = {
  agentName: "research",
  cycleMode: "DRY_RUN" as const,
  promptVersion: "3.0.3",
  decisionContractVersion: "2.0.0",
  reportVersion: "3.0.0",
}

describe("ResearchInvocationV1", () => {
  it("supports only the current generic-agent provenance", () => {
    expect(SUPPORTED_RESEARCH_INVOCATION_VERSIONS).toEqual(["3.0.0"])
    expect(RESEARCH_INVOCATION_PROVENANCE_BY_VERSION[RESEARCH_INVOCATION_VERSION]).toEqual({
      agentName: "research",
      promptVersion: "3.0.3",
      decisionContractVersion: "2.0.0",
      reportVersion: "3.0.0",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
    })
  })

  it("pins the configured model", () => {
    expect(
      assertResearchModelIdentityV1({
        providerId: "openai",
        modelId: "gpt-5.6-sol",
      }),
    ).toEqual({ ok: true })
    expect(
      assertResearchModelIdentityV1({
        providerId: "openai",
        modelId: "other",
      }),
    ).toMatchObject({ ok: false, reason: "MODEL_DRIFT" })
  })

  it("retains bounded content-free provenance", () => {
    const invocation = createResearchInvocationV1(
      versions,
      {
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        inputTokenCount: 100,
        outputTokenCount: 20,
        responseError: false,
        toolCallCount: 1,
        toolErrorCount: 0,
        toolIncompleteCount: 0,
        toolCalls: [{
          name: "alpaca_get_account",
          outcome: "completed",
          startedAt: 0,
          endedAt: 5,
        }],
        omittedToolCallCount: 0,
      },
      { schemaRepairAttempted: true },
    )

    expect(researchInvocationV1Schema.parse(invocation)).toEqual(invocation)
    expect(invocation).not.toHaveProperty("strategyVersion")
    expect(invocation).not.toHaveProperty("skillName")
    expect(invocation.schemaRepairAttempted).toBe(true)
  })
})
