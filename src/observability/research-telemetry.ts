import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { NodeSDK } from "@opentelemetry/sdk-node"
import {
  OpenInferenceSpanKind,
  SEMRESATTRS_PROJECT_NAME,
  SemanticConventions,
} from "@arizeai/openinference-semantic-conventions"

import type { OpenCodeInvocationSummary } from "./opencode-telemetry-summary.js"

const SERVICE_NAME = "greeks-in-the-loop"
const PROJECT_NAME = SERVICE_NAME
const DEFAULT_EXPORT_TIMEOUT_MS = 2_000
const MAX_EXPORT_TIMEOUT_MS = 5_000
const MAX_ENDPOINT_LENGTH = 2_048
const MAX_HEADERS_LENGTH = 8_192
const MAX_HEADER_COUNT = 16
const MAX_ATTRIBUTE_LENGTH = 128
const OPENCODE_TOOL_SPAN_NAME = "opencode.tool"

export const RESEARCH_TRACE_OPERATIONS = [
  "research.eligibility",
  "market.option_universe.discover",
  "opencode.session.prompt",
  "research.report.parse",
  "research.decision.validate",
  "market.option_quotes.confirm",
  "research.intent.derive",
  "risk.shadow.evaluate",
  "ledger.cycle.terminalize",
  "research.artifact.project",
] as const

export type ResearchTraceOperation = typeof RESEARCH_TRACE_OPERATIONS[number]

const OPERATION_KINDS: Readonly<Record<ResearchTraceOperation, OpenInferenceSpanKind>> = {
  "research.eligibility": OpenInferenceSpanKind.GUARDRAIL,
  "market.option_universe.discover": OpenInferenceSpanKind.TOOL,
  "opencode.session.prompt": OpenInferenceSpanKind.AGENT,
  "research.report.parse": OpenInferenceSpanKind.GUARDRAIL,
  "research.decision.validate": OpenInferenceSpanKind.GUARDRAIL,
  "market.option_quotes.confirm": OpenInferenceSpanKind.TOOL,
  "research.intent.derive": OpenInferenceSpanKind.CHAIN,
  "risk.shadow.evaluate": OpenInferenceSpanKind.GUARDRAIL,
  "ledger.cycle.terminalize": OpenInferenceSpanKind.CHAIN,
  "research.artifact.project": OpenInferenceSpanKind.CHAIN,
}

export const RESEARCH_TRACE_ATTRIBUTE_KEYS = {
  attemptNumber: "research.attempt.number",
  cycleId: "research.cycle.id",
  cycleNumber: "research.cycle.number",
  agentName: "research.agent.name",
  cycleMode: "research.cycle.mode",
  promptVersion: "research.prompt.version",
  decisionContractVersion: "research.decision.contract.version",
  reportVersion: "research.report.version",
  outcome: "research.cycle.outcome",
  skipReason: "research.cycle.skip_reason",
  responseError: "research.opencode.response_error",
  toolCallCount: "research.opencode.tool.count",
  toolErrorCount: "research.opencode.tool.error_count",
  toolIncompleteCount: "research.opencode.tool.incomplete_count",
  toolOmittedCount: "research.opencode.tool.omitted_count",
  toolOutcome: "research.opencode.tool.outcome",
} as const

export type ResearchTelemetrySettings = Readonly<{
  disabled?: string | undefined
  tracesEndpoint?: string | undefined
  endpoint?: string | undefined
  tracesHeaders?: string | undefined
  headers?: string | undefined
  tracesTimeoutMs?: string | undefined
  timeoutMs?: string | undefined
}>

export type ResearchTraceVersions = Readonly<{
  agentName: string
  cycleMode: "STANDARD" | "DRY_RUN"
  promptVersion: string
  decisionContractVersion: string
  reportVersion: string
}>

export type ResearchCycleTrace = Readonly<{
  identify: (identity: Readonly<{
    cycleId: string
    cycleNumber: number
    sessionId: string
  }>) => void
  recordOpenCodeResult: (summary: OpenCodeInvocationSummary) => void
  setOutcome: (outcome: string, skipReason?: string) => void
  run: <T>(operation: ResearchTraceOperation, work: () => T | Promise<T>) => Promise<T>
}>

export type ResearchTelemetry = Readonly<{
  runCycle: <T>(
    attempt: number,
    versions: ResearchTraceVersions,
    work: (cycleTrace: ResearchCycleTrace) => Promise<T>,
  ) => Promise<T>
  shutdown: () => Promise<void>
}>

type TelemetrySdk = Readonly<{
  start: () => void
  shutdown: () => Promise<void>
}>

export type ResearchTelemetryDependencies = Readonly<{
  createSdk?: (config: Readonly<{
    url: string
    headers: Record<string, string>
    projectName: string
    timeoutMillis: number
  }>) => TelemetrySdk
  getTracer?: () => Tracer
  warn?: (message: string) => void
}>

const noOpCycleTrace: ResearchCycleTrace = {
  identify: () => undefined,
  recordOpenCodeResult: () => undefined,
  setOutcome: () => undefined,
  run: async (_operation, work) => work(),
}

export const NOOP_RESEARCH_CYCLE_TRACE = noOpCycleTrace

const noOpTelemetry: ResearchTelemetry = {
  runCycle: async (_attempt, _versions, work) => work(noOpCycleTrace),
  shutdown: async () => undefined,
}

const valueIsSafe = (value: string) =>
  value.length > 0 &&
  value.length <= MAX_ATTRIBUTE_LENGTH &&
  /^[A-Za-z0-9._:/-]+$/.test(value) &&
  !value.includes("://") &&
  !/[?#@]/.test(value)

const setSafeAttribute = (span: Span, key: string, value: string) => {
  if (valueIsSafe(value)) span.setAttribute(key, value)
}

const resolveEndpoint = (settings: ResearchTelemetrySettings) => {
  const tracesEndpoint = settings.tracesEndpoint?.trim()
  const genericEndpoint = settings.endpoint?.trim()
  const raw = tracesEndpoint || genericEndpoint
  if (!raw || raw.length > MAX_ENDPOINT_LENGTH) return undefined

  const url = new URL(raw)
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid endpoint")
  }
  if (!tracesEndpoint) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/traces`
  }
  return url.toString()
}

const resolveHeaders = (settings: ResearchTelemetrySettings) => {
  const raw = settings.tracesHeaders?.trim()
    ? settings.tracesHeaders
    : settings.headers
  if (raw === undefined || raw.trim() === "") return {}
  if (raw.length > MAX_HEADERS_LENGTH || /[\r\n]/.test(raw)) {
    throw new Error("invalid headers")
  }

  const headers: Record<string, string> = {}
  const names = new Set<string>()
  const entries = raw.split(",")
  if (entries.length > MAX_HEADER_COUNT) throw new Error("invalid headers")
  for (const entry of entries) {
    const separator = entry.indexOf("=")
    if (separator <= 0) throw new Error("invalid headers")
    const name = decodeURIComponent(entry.slice(0, separator).trim())
    const value = decodeURIComponent(entry.slice(separator + 1).trim())
    const normalizedName = name.toLowerCase()
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      value.length === 0 ||
      /[\r\n\0]/.test(value) ||
      names.has(normalizedName)
    ) {
      throw new Error("invalid headers")
    }
    names.add(normalizedName)
    headers[name] = value
  }
  return headers
}

const resolveTimeout = (settings: ResearchTelemetrySettings) => {
  const raw = settings.tracesTimeoutMs?.trim()
    ? settings.tracesTimeoutMs
    : settings.timeoutMs
  if (raw === undefined || raw.trim() === "") return DEFAULT_EXPORT_TIMEOUT_MS
  const timeoutMillis = Number(raw)
  if (!Number.isSafeInteger(timeoutMillis) || timeoutMillis <= 0) {
    throw new Error("invalid timeout")
  }
  return Math.min(timeoutMillis, MAX_EXPORT_TIMEOUT_MS)
}

const defaultCreateSdk: NonNullable<ResearchTelemetryDependencies["createSdk"]> =
  ({ url, headers, projectName, timeoutMillis }) => {
    const exporter = new OTLPTraceExporter({ url, headers, timeoutMillis })
    return new NodeSDK({
      autoDetectResources: false,
      instrumentations: [],
      logRecordProcessors: [],
      metricReaders: [],
      resource: resourceFromAttributes({
        [SEMRESATTRS_PROJECT_NAME]: projectName,
      }),
      serviceName: SERVICE_NAME,
      spanLimits: {
        attributeCountLimit: 24,
        attributeValueLengthLimit: MAX_ATTRIBUTE_LENGTH,
        eventCountLimit: 0,
        linkCountLimit: 0,
      },
      traceExporter: exporter,
    })
  }

const endSpan = (span: Span, failed: boolean, endedAt?: number) => {
  span.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK })
  span.end(endedAt)
}

const setSafeCountAttribute = (
  span: Span,
  key: string,
  value: number | undefined,
) => {
  if (value !== undefined && Number.isSafeInteger(value) && value >= 0) {
    span.setAttribute(key, value)
  }
}

/**
 * Starts the optional, privacy-bounded research tracer.
 *
 * An explicit OTLP endpoint enables tracing. Invalid configuration and SDK
 * failures fall back to a no-op tracer without exposing configuration values.
 */
export function startResearchTelemetry(
  settings: ResearchTelemetrySettings,
  dependencies: ResearchTelemetryDependencies = {},
): ResearchTelemetry {
  const warn = dependencies.warn ?? ((message: string) => console.warn(message))
  if (settings.disabled?.trim().toLowerCase() === "true") return noOpTelemetry

  let url: string | undefined
  let headers: Record<string, string>
  let timeoutMillis: number
  try {
    url = resolveEndpoint(settings)
    if (url === undefined) return noOpTelemetry
    headers = resolveHeaders(settings)
    timeoutMillis = resolveTimeout(settings)
  } catch {
    warn("OpenTelemetry tracing disabled because its configuration is invalid")
    return noOpTelemetry
  }

  const createSdk = dependencies.createSdk ?? defaultCreateSdk
  let sdk: TelemetrySdk
  try {
    sdk = createSdk({
      url,
      headers,
      projectName: PROJECT_NAME,
      timeoutMillis,
    })
    sdk.start()
  } catch {
    warn("OpenTelemetry tracing could not be started; continuing without tracing")
    return noOpTelemetry
  }
  const tracer = dependencies.getTracer?.() ?? trace.getTracer(SERVICE_NAME)

  let shutdownPromise: Promise<void> | undefined
  const shutdown = () => {
    shutdownPromise ??= new Promise<void>((resolve) => {
      let finished = false
      const finish = (warnOnFailure: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (warnOnFailure) {
          warn("OpenTelemetry tracing could not be flushed during shutdown")
        }
        resolve()
      }
      const timer = setTimeout(() => finish(true), timeoutMillis)
      void Promise.resolve()
        .then(() => sdk.shutdown())
        .then(() => finish(false), () => finish(true))
    })
    return shutdownPromise
  }

  return {
    shutdown,
    runCycle: async (attempt, versions, work) =>
      tracer.startActiveSpan("research.cycle", async (rootSpan) => {
        rootSpan.setAttributes({
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
          [RESEARCH_TRACE_ATTRIBUTE_KEYS.attemptNumber]: attempt,
          [RESEARCH_TRACE_ATTRIBUTE_KEYS.agentName]: versions.agentName,
          [RESEARCH_TRACE_ATTRIBUTE_KEYS.cycleMode]: versions.cycleMode,
          [RESEARCH_TRACE_ATTRIBUTE_KEYS.promptVersion]: versions.promptVersion,
          [RESEARCH_TRACE_ATTRIBUTE_KEYS.decisionContractVersion]:
            versions.decisionContractVersion,
          [RESEARCH_TRACE_ATTRIBUTE_KEYS.reportVersion]: versions.reportVersion,
        } satisfies Attributes)

        let activeChildSpan: Span | undefined
        let activeChildReportedFailure = false
        const cycleTrace: ResearchCycleTrace = {
          identify: ({ cycleId, cycleNumber, sessionId }) => {
            setSafeAttribute(rootSpan, RESEARCH_TRACE_ATTRIBUTE_KEYS.cycleId, cycleId)
            rootSpan.setAttribute(RESEARCH_TRACE_ATTRIBUTE_KEYS.cycleNumber, cycleNumber)
            setSafeAttribute(rootSpan, SemanticConventions.SESSION_ID, sessionId)
          },
          recordOpenCodeResult: (summary) => {
            for (const span of [rootSpan, activeChildSpan]) {
              if (span === undefined) continue
              setSafeAttribute(
                span,
                SemanticConventions.LLM_PROVIDER,
                summary.providerId,
              )
              setSafeAttribute(
                span,
                SemanticConventions.LLM_MODEL_NAME,
                summary.modelId,
              )
            }
            if (activeChildSpan === undefined) return
            activeChildReportedFailure = summary.responseError
            setSafeCountAttribute(
              activeChildSpan,
              SemanticConventions.LLM_TOKEN_COUNT_PROMPT,
              summary.inputTokenCount,
            )
            setSafeCountAttribute(
              activeChildSpan,
              SemanticConventions.LLM_TOKEN_COUNT_COMPLETION,
              summary.outputTokenCount,
            )
            setSafeCountAttribute(
              activeChildSpan,
              SemanticConventions.LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING,
              summary.reasoningTokenCount,
            )
            setSafeCountAttribute(
              activeChildSpan,
              SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ,
              summary.cacheReadTokenCount,
            )
            setSafeCountAttribute(
              activeChildSpan,
              SemanticConventions.LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE,
              summary.cacheWriteTokenCount,
            )
            activeChildSpan.setAttributes({
              [RESEARCH_TRACE_ATTRIBUTE_KEYS.responseError]:
                summary.responseError,
              [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolCallCount]:
                summary.toolCallCount,
              [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolErrorCount]:
                summary.toolErrorCount,
              [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolIncompleteCount]:
                summary.toolIncompleteCount,
              [RESEARCH_TRACE_ATTRIBUTE_KEYS.toolOmittedCount]:
                summary.omittedToolCallCount,
            })
            for (const tool of summary.toolCalls) {
              const options =
                tool.startedAt === undefined
                  ? {}
                  : { startTime: tool.startedAt }
              tracer.startActiveSpan(OPENCODE_TOOL_SPAN_NAME, options, (span) => {
                span.setAttribute(
                  SemanticConventions.OPENINFERENCE_SPAN_KIND,
                  OpenInferenceSpanKind.TOOL,
                )
                setSafeAttribute(span, SemanticConventions.TOOL_NAME, tool.name)
                span.setAttribute(
                  RESEARCH_TRACE_ATTRIBUTE_KEYS.toolOutcome,
                  tool.outcome,
                )
                endSpan(
                  span,
                  tool.outcome !== "completed",
                  tool.endedAt,
                )
              })
            }
          },
          setOutcome: (outcome, skipReason) => {
            setSafeAttribute(rootSpan, RESEARCH_TRACE_ATTRIBUTE_KEYS.outcome, outcome)
            if (skipReason !== undefined) {
              setSafeAttribute(
                rootSpan,
                RESEARCH_TRACE_ATTRIBUTE_KEYS.skipReason,
                skipReason,
              )
            }
          },
          run: async (operation, childWork) =>
            tracer.startActiveSpan(operation, async (span) => {
              span.setAttribute(
                SemanticConventions.OPENINFERENCE_SPAN_KIND,
                OPERATION_KINDS[operation],
              )
              let failed = true
              const previousActiveChildSpan = activeChildSpan
              const previousReportedFailure = activeChildReportedFailure
              activeChildSpan = span
              activeChildReportedFailure = false
              try {
                const result = await childWork()
                failed = activeChildReportedFailure
                return result
              } finally {
                activeChildSpan = previousActiveChildSpan
                activeChildReportedFailure = previousReportedFailure
                endSpan(span, failed)
              }
            }),
        }

        let failed = true
        try {
          const result = await work(cycleTrace)
          failed = false
          return result
        } finally {
          endSpan(rootSpan, failed)
        }
      }),
  }
}
