import { describe, expect, it } from "vitest"

import {
  assertResearchModelIdentityV1,
  createResearchInvocationV1,
  MAX_RESEARCH_INVOCATION_TOOL_CALLS,
  RESEARCH_MODEL_IDENTITY,
  RESEARCH_INVOCATION_PROVENANCE_BY_VERSION,
  RESEARCH_INVOCATION_VERSION,
  researchInvocationV1Schema,
  SUPPORTED_RESEARCH_INVOCATION_VERSIONS,
} from "../src/research/research-invocation-v1.js"

describe("ResearchInvocationV1", () => {
  it("preserves historical provenance while selecting the current version", () => {
    expect(SUPPORTED_RESEARCH_INVOCATION_VERSIONS).toEqual([
      "1.0.0",
      "1.1.0",
      "1.2.0",
    ])
    expect(RESEARCH_INVOCATION_VERSION).toBe("1.2.0")
    expect(RESEARCH_INVOCATION_PROVENANCE_BY_VERSION["1.0.0"]).toMatchObject({
      promptVersion: "1.3.0",
      skillVersion: "1.1.0",
    })
    expect(RESEARCH_INVOCATION_PROVENANCE_BY_VERSION["1.1.0"]).toMatchObject({
      promptVersion: "1.4.0",
      skillVersion: "1.2.0",
      strategyVersion: "1.1.0",
      decisionContractVersion: "1.0.0",
      reportVersion: "2.0.0",
    })
    expect(RESEARCH_INVOCATION_PROVENANCE_BY_VERSION["1.2.0"]).toMatchObject({
      promptVersion: "1.4.0",
      skillVersion: "1.2.0",
      strategyVersion: "1.1.0",
      decisionContractVersion: "1.0.0",
      reportVersion: "2.0.0",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
    })
  })

  it("pins the model only from the current version", () => {
    // Earlier runs happened against an unpinned default; back-filling a pin
    // would claim an assertion they never made.
    expect(
      RESEARCH_INVOCATION_PROVENANCE_BY_VERSION["1.0.0"],
    ).not.toHaveProperty("providerId")
    expect(
      RESEARCH_INVOCATION_PROVENANCE_BY_VERSION["1.1.0"],
    ).not.toHaveProperty("modelId")
    expect(RESEARCH_MODEL_IDENTITY).toEqual({
      providerId: "openai",
      modelId: "gpt-5.6-sol",
    })
  })

  describe("model identity assertion", () => {
    const pinned = { providerId: "openai", modelId: "gpt-5.6-sol" }

    it("accepts the pinned identity", () => {
      expect(assertResearchModelIdentityV1(pinned)).toEqual({ ok: true })
    })

    it("reports provider drift before model drift", () => {
      expect(
        assertResearchModelIdentityV1({
          providerId: "anthropic",
          modelId: "claude-opus-5",
        }),
      ).toEqual({
        ok: false,
        reason: "PROVIDER_DRIFT",
        expected: "openai",
        observed: "anthropic",
      })
    })

    it("reports model drift within the pinned provider", () => {
      expect(
        assertResearchModelIdentityV1({
          ...pinned,
          modelId: "gpt-5.6-sol-fast",
        }),
      ).toEqual({
        ok: false,
        reason: "MODEL_DRIFT",
        expected: "gpt-5.6-sol",
        observed: "gpt-5.6-sol-fast",
      })
    })

    it("reports what was observed rather than coercing it to unknown", () => {
      // durableLabel rewrites an unsafe label to "unknown"; the drift record
      // must instead say what the provider actually returned.
      const result = assertResearchModelIdentityV1({
        providerId: "https://evil.example/path?x=1",
        modelId: "gpt-5.6-sol",
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error("expected drift")
      expect(result.reason).toBe("PROVIDER_DRIFT")
      expect(result.observed).not.toBe("unknown")
      expect(result.observed).toContain("evil.example")
      // Still safe for the ledger: bounded, no scheme, no query characters.
      expect(result.observed.length).toBeLessThanOrEqual(128)
      expect(result.observed).not.toContain("://")
      expect(result.observed).not.toMatch(/[?#@]/u)
    })

    it("bounds an overlong observed label", () => {
      const result = assertResearchModelIdentityV1({
        providerId: "o".repeat(500),
        modelId: "gpt-5.6-sol",
      })
      if (result.ok) throw new Error("expected drift")
      expect(result.observed).toHaveLength(128)
    })
  })

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
    expect(invocation.invocationVersion).toBe(RESEARCH_INVOCATION_VERSION)
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

  it.each([
    ["agentName", "research@example.com"],
    ["promptVersion", "https://prompt.example/1.3.0"],
    ["skillName", "skill\nmetadata"],
    ["skillVersion", "1.1.0?token=secret"],
    ["strategyVersion", "strategy#private"],
    ["decisionContractVersion", "contract@internal"],
    ["reportVersion", "https://report.example/2.0.0"],
  ] as const)("replaces unsafe durable provenance in %s", (field, value) => {
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
        [field]: value,
      },
      {
        providerId: "provider",
        modelId: "model",
        responseError: false,
        toolCallCount: 0,
        toolErrorCount: 0,
        toolIncompleteCount: 0,
        toolCalls: [],
        omittedToolCallCount: 0,
      },
    )

    expect(invocation[field]).toBe("unknown")
    expect(
      researchInvocationV1Schema.safeParse({
        ...invocation,
        [field]: value,
      }).success,
    ).toBe(false)
  })
})
