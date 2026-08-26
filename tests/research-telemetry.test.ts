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
  ended: boolean
}

const createRecordingTracer = () => {
  const spans: RecordedSpan[] = []
  const stack: RecordedSpan[] = []
  const tracer = {
    startActiveSpan: async (name: string, callback: (span: Span) => unknown) => {
      const parent = stack.at(-1)
      const recorded: RecordedSpan = {
        name,
        ...(parent === undefined ? {} : { parent: parent.name }),
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
        end() {
          recorded.ended = true
        },
      } as unknown as Span
      stack.push(recorded)
      try {
        return await callback(span)
      } finally {
        stack.pop()
      }
    },
  } as unknown as Tracer
  return { spans, tracer }
}

const versions = {
  agentName: "research",
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
        cycle.setModel({ providerId: "anthropic", modelId: "claude-sonnet-4" })
      })
      cycle.setOutcome("VALIDATED_NO_ACTION")
      await cycle.run("research.report.parse", () => undefined)
    })

    expect(spans.map(({ name, parent }) => ({ name, parent }))).toEqual([
      { name: "research.cycle", parent: undefined },
      { name: "opencode.session.prompt", parent: "research.cycle" },
      { name: "research.report.parse", parent: "research.cycle" },
    ])
    expect(spans.every(({ ended, status }) => ended && status === SpanStatusCode.OK))
      .toBe(true)
    expect(spans[0]?.attributes).toMatchObject({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      [SemanticConventions.SESSION_ID]: "session-3",
      [SemanticConventions.LLM_PROVIDER]: "anthropic",
      [SemanticConventions.LLM_MODEL_NAME]: "claude-sonnet-4",
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.attemptNumber]: 3,
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.cycleId]: "cycle-3",
      [RESEARCH_TRACE_ATTRIBUTE_KEYS.outcome]: "VALIDATED_NO_ACTION",
    })
    expect(spans[1]?.attributes).toMatchObject({
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
      [SemanticConventions.LLM_PROVIDER]: "anthropic",
      [SemanticConventions.LLM_MODEL_NAME]: "claude-sonnet-4",
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
