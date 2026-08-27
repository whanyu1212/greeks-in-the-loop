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

  it.each([
    {
      totalCount: 0,
      errorCount: 1,
      incompleteCount: 0,
      omittedCount: 0,
      calls: [],
    },
    {
      totalCount: 2,
      errorCount: 0,
      incompleteCount: 0,
      omittedCount: 0,
      calls: [{ name: "other", outcome: "completed" as const }],
    },
    {
      totalCount: 1,
      errorCount: 0,
      incompleteCount: 0,
      omittedCount: 0,
      calls: [{ name: "other", outcome: "error" as const }],
    },
    {
      totalCount: 2,
      errorCount: 2,
      incompleteCount: 1,
      omittedCount: 1,
      calls: [{ name: "other", outcome: "completed" as const }],
    },
    {
      totalCount: 3,
      errorCount: 2,
      incompleteCount: 1,
      omittedCount: 2,
      calls: [{ name: "other", outcome: "completed" as const }],
    },
  ])("rejects inconsistent tool aggregates", (tools) => {
    const result = researchInvocationV1Schema.safeParse({
      invocationVersion: "1.0.0",
      agentName: "research",
      cycleMode: "STANDARD",
      promptVersion: "1.3.0",
      skillName: "spy-debit-spread-research",
      skillVersion: "1.1.0",
      strategyVersion: "1.1.0",
      decisionContractVersion: "1.0.0",
      reportVersion: "2.0.0",
      providerId: "provider",
      modelId: "model",
      responseError: false,
      tokens: {},
      tools,
    })

    expect(result.success).toBe(false)
  })

  it.each([
    ["https://provider.example/path", "model", "providerId"],
    ["provider@example.com", "model", "providerId"],
    ["provider\nmetadata", "model", "providerId"],
    ["provider", "https://model.example/path", "modelId"],
  ] as const)(
    "replaces unsafe durable provider and model labels",
    (providerId, modelId, replacedField) => {
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
          providerId,
          modelId,
          responseError: false,
          toolCallCount: 0,
          toolErrorCount: 0,
          toolIncompleteCount: 0,
          toolCalls: [],
          omittedToolCallCount: 0,
        },
      )

      expect(invocation[replacedField]).toBe("unknown")
      expect(JSON.stringify(invocation)).not.toContain("example")
      expect(researchInvocationV1Schema.safeParse({
        ...invocation,
        [replacedField]: replacedField === "providerId" ? providerId : modelId,
      }).success).toBe(false)
    },
  )

  it.each([
    "https://tools.example/read",
    "tool@example.com",
    "read\nmetadata",
    "unconfigured_tool",
  ])("replaces unapproved durable tool names", (name) => {
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
        responseError: false,
        toolCallCount: 1,
        toolErrorCount: 0,
        toolIncompleteCount: 0,
        toolCalls: [{ name, outcome: "completed" }],
        omittedToolCallCount: 0,
      },
    )

    expect(invocation.tools.calls[0]?.name).toBe("other")
    expect(JSON.stringify(invocation)).not.toContain(name)
    expect(
      researchInvocationV1Schema.safeParse({
        ...invocation,
        tools: {
          ...invocation.tools,
          calls: [{ name, outcome: "completed" }],
        },
      }).success,
    ).toBe(false)
  })
})
