import type { AssistantMessage, Part } from "@opencode-ai/sdk"

export const MAX_OPENCODE_TOOL_SPANS = 32

export type OpenCodeToolOutcome = "completed" | "error" | "incomplete"

export type OpenCodeInvocationSummary = Readonly<{
  providerId: string
  modelId: string
  inputTokenCount?: number
  outputTokenCount?: number
  reasoningTokenCount?: number
  cacheReadTokenCount?: number
  cacheWriteTokenCount?: number
  responseError: boolean
  toolCallCount: number
  toolErrorCount: number
  toolIncompleteCount: number
  toolCalls: ReadonlyArray<
    Readonly<{
      name: string
      outcome: OpenCodeToolOutcome
      startedAt?: number
      endedAt?: number
    }>
  >
  omittedToolCallCount: number
}>

const safeCount = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 ? value : undefined

const configuredToolName = (name: string) => {
  if (["trusted_time", "read", "skill"].includes(name)) return name
  return /^(?:alpaca_get_|fmp_|exa_)[A-Za-z0-9_]+$/.test(name)
    ? name
    : "other"
}

const toolTiming = (part: Extract<Part, { type: "tool" }>) => {
  if (part.state.status === "pending") return {}
  const startedAt = part.state.time.start
  if (!Number.isFinite(startedAt) || startedAt < 0) return {}
  if (part.state.status === "running") return {}
  const endedAt = part.state.time.end
  return Number.isFinite(endedAt) && endedAt >= startedAt
    ? { startedAt, endedAt }
    : {}
}

/**
 * Reduces a completed OpenCode response to the metadata permitted in traces.
 * Model content, tool inputs/results, provider metadata, and error text are
 * deliberately absent from the returned type.
 */
export function summarizeOpenCodeInvocation(
  info: AssistantMessage,
  parts: readonly Part[],
): OpenCodeInvocationSummary {
  const inputTokenCount = safeCount(info.tokens.input)
  const outputTokenCount = safeCount(info.tokens.output)
  const reasoningTokenCount = safeCount(info.tokens.reasoning)
  const cacheReadTokenCount = safeCount(info.tokens.cache.read)
  const cacheWriteTokenCount = safeCount(info.tokens.cache.write)
  const toolParts = parts.filter(
    (part): part is Extract<Part, { type: "tool" }> => part.type === "tool",
  )
  return {
    providerId: info.providerID,
    modelId: info.modelID,
    ...(inputTokenCount === undefined ? {} : { inputTokenCount }),
    ...(outputTokenCount === undefined ? {} : { outputTokenCount }),
    ...(reasoningTokenCount === undefined ? {} : { reasoningTokenCount }),
    ...(cacheReadTokenCount === undefined ? {} : { cacheReadTokenCount }),
    ...(cacheWriteTokenCount === undefined ? {} : { cacheWriteTokenCount }),
    responseError: info.error !== undefined,
    toolCallCount: toolParts.length,
    toolErrorCount: toolParts.filter(({ state }) => state.status === "error")
      .length,
    toolIncompleteCount: toolParts.filter(
      ({ state }) =>
        state.status === "pending" || state.status === "running",
    ).length,
    toolCalls: toolParts.slice(0, MAX_OPENCODE_TOOL_SPANS).map((part) => ({
      name: configuredToolName(part.tool),
      outcome:
        part.state.status === "completed" || part.state.status === "error"
          ? part.state.status
          : "incomplete",
      ...toolTiming(part),
    })),
    omittedToolCallCount: Math.max(
      0,
      toolParts.length - MAX_OPENCODE_TOOL_SPANS,
    ),
  }
}
