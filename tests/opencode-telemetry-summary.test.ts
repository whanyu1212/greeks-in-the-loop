import type { AssistantMessage, Part } from "@opencode-ai/sdk"
import { describe, expect, it } from "vitest"

import {
  MAX_OPENCODE_TOOL_SPANS,
  summarizeOpenCodeInvocation,
} from "../src/observability/opencode-telemetry-summary.js"

const assistantMessage = (overrides: Partial<AssistantMessage> = {}) => ({
  id: "message-1",
  sessionID: "session-1",
  role: "assistant" as const,
  time: { created: 1_000, completed: 2_000 },
  parentID: "message-parent",
  modelID: "claude-sonnet-4",
  providerID: "anthropic",
  mode: "research",
  path: { cwd: "/workspace", root: "/workspace" },
  cost: 0.01,
  tokens: {
    input: 100,
    output: 40,
    reasoning: 10,
    cache: { read: 20, write: 5 },
  },
  ...overrides,
}) satisfies AssistantMessage

const completedTool = (index: number, name = "exa_search") => ({
  id: `part-${index}`,
  sessionID: "session-1",
  messageID: "message-1",
  type: "tool" as const,
  callID: `call-${index}`,
  tool: name,
  state: {
    status: "completed" as const,
    input: { query: "secret tool input" },
    output: "secret tool output",
    title: "secret title",
    metadata: { providerPayload: "secret metadata" },
    time: { start: 1_100 + index, end: 1_200 + index },
  },
  metadata: { hidden: "secret part metadata" },
}) satisfies Extract<Part, { type: "tool" }>

const failedTool = (index: number, name = "exa_search") => ({
  ...completedTool(index, name),
  state: {
    status: "error" as const,
    input: { token: "secret" },
    error: "secret tool failure",
    time: { start: 1_300 + index, end: 1_400 + index },
  },
}) satisfies Extract<Part, { type: "tool" }>

describe("summarizeOpenCodeInvocation", () => {
  it("retains only bounded model, token, and finalized tool metadata", () => {
    const info = assistantMessage({
      error: { name: "UnknownError", data: { message: "secret error text" } },
    })
    const parts: Part[] = [
      {
        id: "text-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text: "secret model response",
      },
      completedTool(1, "alpaca_get_option_chain"),
      failedTool(0, "untrusted-secret-tool-name"),
      {
        ...completedTool(3, "trusted_time"),
        state: {
          status: "running",
          input: { clock: "secret input" },
          time: { start: 1_500 },
        },
      },
    ]

    const summary = summarizeOpenCodeInvocation(info, parts)

    expect(summary).toEqual({
      providerId: "anthropic",
      modelId: "claude-sonnet-4",
      inputTokenCount: 100,
      outputTokenCount: 40,
      reasoningTokenCount: 10,
      cacheReadTokenCount: 20,
      cacheWriteTokenCount: 5,
      responseError: true,
      toolCallCount: 3,
      toolErrorCount: 1,
      toolIncompleteCount: 1,
      toolCalls: [
        {
          name: "alpaca_get_option_chain",
          outcome: "completed",
          startedAt: 1_101,
          endedAt: 1_201,
        },
        {
          name: "other",
          outcome: "error",
          startedAt: 1_300,
          endedAt: 1_400,
        },
        { name: "trusted_time", outcome: "incomplete" },
      ],
      omittedToolCallCount: 0,
    })
    expect(JSON.stringify(summary)).not.toContain("secret")
  })

  it("caps tool records and reports the omitted count", () => {
    const parts = Array.from(
      { length: MAX_OPENCODE_TOOL_SPANS + 3 },
      (_, index) =>
        index === MAX_OPENCODE_TOOL_SPANS + 2
          ? failedTool(index)
          : completedTool(index),
    )

    const summary = summarizeOpenCodeInvocation(assistantMessage(), parts)

    expect(summary.toolCalls).toHaveLength(MAX_OPENCODE_TOOL_SPANS)
    expect(summary.toolCallCount).toBe(MAX_OPENCODE_TOOL_SPANS + 3)
    expect(summary.toolErrorCount).toBe(1)
    expect(summary.omittedToolCallCount).toBe(3)
  })

  it("drops invalid counts and timing instead of exporting them", () => {
    const info = assistantMessage({
      tokens: {
        input: -1,
        output: Number.POSITIVE_INFINITY,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    })
    const part = completedTool(1)
    part.state.time.start = Number.NaN

    const summary = summarizeOpenCodeInvocation(info, [part])

    expect(summary).not.toHaveProperty("inputTokenCount")
    expect(summary).not.toHaveProperty("outputTokenCount")
    expect(summary.toolCalls[0]).toEqual({
      name: "exa_search",
      outcome: "completed",
    })
  })
})
