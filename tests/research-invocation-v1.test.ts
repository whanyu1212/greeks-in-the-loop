import { describe, expect, it } from "vitest"

import {
  createResearchInvocationV1,
  MAX_RESEARCH_INVOCATION_TOOL_CALLS,
  researchInvocationV1Schema,
} from "../src/research/research-invocation-v1.js"

describe("ResearchInvocationV1", () => {
  it("retains bounded provenance without content-bearing fields", () => {
    const invocation = createResearchInvocationV1(
      {
        agentName: "research",
        cycleMode: "STANDARD",
        promptVersion: "1.3.0",
        skillName: "spy-debit-spread-research",
        skillVersion: "1.1.0",
        strategyVersion: "1.1.0",
        decisionContractVersion: "1.0.0",
        reportVersion: "2.0.0",
      },
      {
        providerId: "provider",
        modelId: "model",
        inputTokenCount: 100,
        outputTokenCount: 20,
        responseError: false,
        toolCallCount: 40,
        toolErrorCount: 1,
        toolIncompleteCount: 2,
        toolCalls: Array.from({ length: 40 }, (_, index) => ({
          name: "other",
          outcome: "completed" as const,
          startedAt: index * 10,
          endedAt: index * 10 + 5,
        })),
        omittedToolCallCount: 8,
      },
    )

    expect(researchInvocationV1Schema.safeParse(invocation).success).toBe(true)
    expect(invocation.tools.calls).toHaveLength(
      MAX_RESEARCH_INVOCATION_TOOL_CALLS,
    )
    expect(invocation.tools.calls[0]).toEqual({
      name: "other",
      outcome: "completed",
      durationMs: 5,
    })
    expect(invocation).not.toHaveProperty("prompt")
    expect(invocation).not.toHaveProperty("response")
  })
})
