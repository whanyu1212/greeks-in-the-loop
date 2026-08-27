import { SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api"
import {
  OpenInferenceSpanKind,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions"
import { describe, expect, it, vi } from "vitest"

import {
  RESEARCH_TRACE_ATTRIBUTE_KEYS,
  startResearchTelemetry,
} from "../src/observability/research-telemetry.js"

type RecordedSpan = {
  name: string
  parent?: string
  attributes: Record<string, unknown>
  status?: number
  startTime?: number
  endTime?: number
  ended: boolean
}

const createRecordingTracer = () => {
  const spans: RecordedSpan[] = []
  const stack: RecordedSpan[] = []
  const tracer = {
    startActiveSpan: (
      name: string,
      optionsOrCallback: { startTime?: number } | ((span: Span) => unknown),
      possibleCallback?: (span: Span) => unknown,
    ) => {
      const options =
        typeof optionsOrCallback === "function" ? {} : optionsOrCallback
      const callback =
        typeof optionsOrCallback === "function"
          ? optionsOrCallback
          : possibleCallback
      if (callback === undefined) throw new Error("Span callback is required")
      const parent = stack.at(-1)
      const recorded: RecordedSpan = {
        name,
        ...(parent === undefined ? {} : { parent: parent.name }),
        ...(options.startTime === undefined
          ? {}
          : { startTime: options.startTime }),
        attributes: {},
        ended: false,
      }
      spans.push(recorded)
      const span = {
        setAttribute(key: string, value: unknown) {
          recorded.attributes[key] = value
          return this
        },
        setAttributes(attributes: Record<string, unknown>) {
          Object.assign(recorded.attributes, attributes)
          return this
        },
        setStatus(status: { code: number }) {
          recorded.status = status.code
          return this
        },
        end(endTime?: number) {
          recorded.ended = true
          if (endTime !== undefined) recorded.endTime = endTime
        },
      } as unknown as Span
      stack.push(recorded)
      let result: unknown
      try {
        result = callback(span)
      } catch (error) {
        stack.pop()
        throw error
      }
      if (result instanceof Promise) {
        return result.finally(() => stack.pop())
      }
      stack.pop()
      return result
    },
  } as unknown as Tracer
  return { spans, tracer }
}

const versions = {
  agentName: "research",
  promptVersion: "1.0.0",
  skillName: "spy-debit-spread-research",
  skillVersion: "1.0.0",
  strategyVersion: "1.0.0",
  decisionContractVersion: "1.0.0",
  reportVersion: "2.0.0",
}

describe("startResearchTelemetry", () => {
  it("stays disabled unless an endpoint is explicitly configured", async () => {
    const createSdk = vi.fn()
    const telemetry = startResearchTelemetry({}, { createSdk })

    await telemetry.runCycle(1, versions, async (cycle) =>
      cycle.run("research.report.parse", () => "ok"),
    )
    await telemetry.shutdown()

    expect(createSdk).not.toHaveBeenCalled()
  })

  it("applies trace-specific precedence and caps the exporter timeout", () => {
    const start = vi.fn()
    const createSdk = vi.fn(() => ({ start, shutdown: async () => undefined }))
    startResearchTelemetry(
      {
        endpoint: "https://generic.example/otel",
        tracesEndpoint: "https://traces.example/custom",
        headers: "generic=ignored",
        tracesHeaders: "authorization=Bearer%20token,x-tenant=team",
        timeoutMs: "10",
        tracesTimeoutMs: "9000",
      },
      { createSdk },
    )

    expect(createSdk).toHaveBeenCalledWith({
      url: "https://traces.example/custom",
      headers: { authorization: "Bearer token", "x-tenant": "team" },
      projectName: "greeks-in-the-loop",
      timeoutMillis: 5_000,
    })
    expect(start).toHaveBeenCalledOnce()
  })

  it("treats empty trace-specific settings as unset", () => {
    const createSdk = vi.fn(() => ({
      start: () => undefined,
      shutdown: async () => undefined,
    }))
    startResearchTelemetry(
      {
        endpoint: "https://generic.example/otel",
        tracesHeaders: "  ",
        headers: "authorization=Bearer%20generic",
        tracesTimeoutMs: "",
        timeoutMs: "1234",
      },
      { createSdk },
    )

    expect(createSdk).toHaveBeenCalledWith({
      url: "https://generic.example/otel/v1/traces",
      headers: { authorization: "Bearer generic" },
      projectName: "greeks-in-the-loop",
      timeoutMillis: 1_234,
    })
  })

  it("rejects unsafe configuration without logging its values", () => {
    const warn = vi.fn()
    const createSdk = vi.fn()
    startResearchTelemetry(
      { endpoint: "https://user:secret@example.test?token=secret" },
      { createSdk, warn },
    )

    expect(createSdk).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      "OpenTelemetry tracing disabled because its configuration is invalid",
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
  })

  it("creates the bounded OpenInference span topology without content", async () => {
    const { spans, tracer } = createRecordingTracer()
    const telemetry = startResearchTelemetry(
      { endpoint: "https://collector.example/otel" },
      {
        createSdk: () => ({ start: () => undefined, shutdown: async () => undefined }),
        getTracer: () => tracer,
      },
    )

    await telemetry.runCycle(3, versions, async (cycle) => {
      cycle.identify({ cycleId: "cycle-3", cycleNumber: 3, sessionId: "session-3" })
      await cycle.run("opencode.session.prompt", () => {
        cycle.recordOpenCodeResult({
          providerId: "anthropic",
          modelId: "claude-sonnet-4",
          inputTokenCount: 100,
          outputTokenCount: 40,
          reasoningTokenCount: 10,
          cacheReadTokenCount: 20,
          cacheWriteTokenCount: 5,
          responseError: true,
          toolCallCount: 4,
          toolErrorCount: 1,
          toolIncompleteCount: 0,
          toolCalls: [
            {
              name: "exa_search",
              outcome: "completed",
              startedAt: 1_000,
              endedAt: 1_100,
            },
            {
              name: "trusted_time",
              outcome: "error",
              startedAt: 1_200,
              endedAt: 1_300,
            },
          ],
          omittedToolCallCount: 2,
        })
      })
      cycle.setOutcome("VALIDATED_NO_ACTION")
      await cycle.run("research.report.parse", () => undefined)
    })

    expect(spans.map(({ name, parent }) => ({ name, parent }))).toEqual([
      { name: "research.cycle", parent: undefined },
      { name: "opencode.session.prompt", parent: "research.cycle" },
      { name: "opencode.tool", parent: "opencode.session.prompt" },
      { name: "opencode.tool", parent: "opencode.session.prompt" },
      { name: "research.report.parse", parent: "research.cycle" },
    ])
    expect(spans.every(({ ended }) => ended)).toBe(true)
    expect(spans.map(({ status }) => status)).toEqual([
      SpanStatusCode.OK,
      SpanStatusCode.ERROR,
      SpanStatusCode.OK,
      SpanStatusCode.ERROR,
      SpanStatusCode.OK,
    ])
    expect(spans[0]?.attributes).toMatchObject({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      [SemanticConventions.SESSION_ID]: "session-3",
      [SemanticConventions.LLM_PROVIDER]: "anthropic",
      [SemanticConventions.LLM_MODEL_NAME]: "claude-sonnet-4",
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.attemptNumber]: 3,
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.cycleId]: "cycle-3",
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.promptVersion]: "1.0.0",
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.skillName]:
        "spy-debit-spread-research",
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.skillVersion]: "1.0.0",
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.outcome]: "VALIDATED_NO_ACTION",
    })
    expect(spans[1]?.attributes).toMatchObject({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      [SemanticConventions.LLM_PROVIDER]: "anthropic",
      [SemanticConventions.LLM_MODEL_NAME]: "claude-sonnet-4",
      [SemanticConventions.LLM_TOKEN_COUNT_PROMPT]: 100,
      [SemanticConventions.LLM_TOKEN_COUNT_COMPLETION]: 40,
      [SemanticConventions.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]: 10,
      [SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: 20,
      [SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: 5,
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.responseError]: true,
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolCallCount]: 4,
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolErrorCount]: 1,
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolIncompleteCount]: 0,
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolOmittedCount]: 2,
    })
    expect(spans[2]).toMatchObject({
      startTime: 1_000,
      endTime: 1_100,
      status: SpanStatusCode.OK,
      attributes: {
        [SemanticConventions.OPENINFERENCE_SPAN_KIND]:
          OpenInferenceSpanKind.TOOL,
        [SemanticConventions.TOOL_NAME]: "exa_search",
        [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolOutcome]: "completed",
      },
    })
    expect(spans[3]).toMatchObject({
      startTime: 1_200,
      endTime: 1_300,
      status: SpanStatusCode.ERROR,
      attributes: {
        [SemanticConventions.TOOL_NAME]: "trusted_time",
        [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolOutcome]: "error",
      },
    })
    expect(JSON.stringify(spans)).not.toContain("raw prompt text")
    expect(JSON.stringify(spans)).not.toContain("raw response text")
  })

  it("marks failures without recording exception text and never fails shutdown", async () => {
    const { spans, tracer } = createRecordingTracer()
    const warn = vi.fn()
    const telemetry = startResearchTelemetry(
      { tracesEndpoint: "https://collector.example/v1/traces", tracesTimeoutMs: "1" },
      {
        createSdk: () => ({
          start: () => undefined,
          shutdown: async () => { throw new Error("secret shutdown detail") },
        }),
        getTracer: () => tracer,
        warn,
      },
    )

    await expect(
      telemetry.runCycle(1, versions, async (cycle) =>
        cycle.run("research.decision.validate", () => {
          throw new Error("secret model response")
        }),
      ),
    ).rejects.toThrow("secret model response")
    await expect(telemetry.shutdown()).resolves.toBeUndefined()
    await expect(telemetry.shutdown()).resolves.toBeUndefined()

    expect(spans.every(({ status }) => status === SpanStatusCode.ERROR)).toBe(true)
    expect(JSON.stringify(spans)).not.toContain("secret")
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
