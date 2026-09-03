import { z } from "zod"

import {
  configuredToolName,
  type OpenCodeInvocationSummary,
} from "../observability/opencode-telemetry-summary.js"
import type { ResearchTraceVersions } from "../observability/research-telemetry.js"
export const RESEARCH_INVOCATION_VERSION = "7.7.0" as const
export const SUPPORTED_RESEARCH_INVOCATION_VERSIONS = Object.freeze([
  "3.0.0",
  "3.1.0",
  "4.0.0",
  "4.1.0",
  "4.2.0",
  "5.0.0",
  "6.0.0",
  "6.1.0",
  "6.1.1",
  "6.2.0",
  "7.0.0",
  "7.1.0",
  "7.2.0",
  "7.3.0",
  "7.4.0",
  "7.5.0",
  "7.6.0",
  RESEARCH_INVOCATION_VERSION,
] as const)
export const RESEARCH_INVOCATION_PROVENANCE_BY_VERSION = Object.freeze({
  "3.0.0": Object.freeze({
    agentName: "research",
    promptVersion: "3.0.3",
    decisionContractVersion: "2.0.0",
    reportVersion: "3.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "3.1.0": Object.freeze({
    agentName: "research",
    promptVersion: "3.1.0",
    decisionContractVersion: "2.0.0",
    reportVersion: "3.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "4.0.0": Object.freeze({
    agentName: "research",
    promptVersion: "4.0.0",
    decisionContractVersion: "2.0.0",
    reportVersion: "4.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "4.1.0": Object.freeze({
    agentName: "research",
    promptVersion: "4.1.0",
    decisionContractVersion: "2.0.0",
    reportVersion: "4.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "4.2.0": Object.freeze({
    agentName: "research",
    promptVersion: "4.2.0",
    decisionContractVersion: "2.0.0",
    reportVersion: "4.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "5.0.0": Object.freeze({
    agentName: "research",
    promptVersion: "5.0.0",
    decisionContractVersion: "2.0.0",
    reportVersion: "5.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "6.0.0": Object.freeze({
    agentName: "research",
    promptVersion: "6.0.0",
    decisionContractVersion: "3.0.0",
    reportVersion: "6.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "6.1.0": Object.freeze({
    agentName: "research",
    promptVersion: "6.1.0",
    decisionContractVersion: "3.0.0",
    reportVersion: "6.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "6.1.1": Object.freeze({
    agentName: "research",
    promptVersion: "6.1.1",
    decisionContractVersion: "3.0.0",
    reportVersion: "6.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "6.2.0": Object.freeze({
    agentName: "research",
    promptVersion: "6.2.0",
    decisionContractVersion: "3.0.0",
    reportVersion: "6.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "7.0.0": Object.freeze({
    agentName: "research",
    promptVersion: "7.0.0",
    decisionContractVersion: "4.0.0",
    reportVersion: "7.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "7.1.0": Object.freeze({
    agentName: "research",
    promptVersion: "7.1.0",
    decisionContractVersion: "4.0.0",
    reportVersion: "7.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-sol",
  }),
  "7.2.0": Object.freeze({
    agentName: "research",
    promptVersion: "7.1.0",
    decisionContractVersion: "4.0.0",
    reportVersion: "7.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-terra",
  }),
  "7.3.0": Object.freeze({
    agentName: "research",
    promptVersion: "7.2.0",
    decisionContractVersion: "4.0.0",
    reportVersion: "7.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-terra",
  }),
  "7.4.0": Object.freeze({
    agentName: "research",
    promptVersion: "7.3.0",
    decisionContractVersion: "4.0.0",
    reportVersion: "7.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-terra",
  }),
  "7.5.0": Object.freeze({
    agentName: "research",
    promptVersion: "7.4.0",
    decisionContractVersion: "4.0.0",
    reportVersion: "7.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-terra",
  }),
  "7.6.0": Object.freeze({
    agentName: "research",
    promptVersion: "7.5.0",
    decisionContractVersion: "4.0.0",
    reportVersion: "7.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-terra",
  }),
  [RESEARCH_INVOCATION_VERSION]: Object.freeze({
    agentName: "research",
    promptVersion: "7.6.0",
    decisionContractVersion: "4.0.0",
    reportVersion: "7.0.0",
    providerId: "openai",
    modelId: "gpt-5.6-terra",
  }),
})

/**
 * The provider and model the research agent must run against.
 *
 * `opencode.json` selects the model; this constant is what the application
 * asserts the observed invocation against. Changing the model therefore
 * requires editing both and bumping `RESEARCH_INVOCATION_VERSION`, matching how
 * prompt versions are already pinned. Reasoning effort is configured
 * alongside the model but is deliberately not asserted — it is a tuning knob,
 * not part of model identity.
 */
export const RESEARCH_MODEL_IDENTITY = Object.freeze({
  providerId:
    RESEARCH_INVOCATION_PROVENANCE_BY_VERSION[RESEARCH_INVOCATION_VERSION]
      .providerId satisfies string,
  modelId:
    RESEARCH_INVOCATION_PROVENANCE_BY_VERSION[RESEARCH_INVOCATION_VERSION]
      .modelId satisfies string,
})

/**
 * Bounds an observed label for the drift record.
 *
 * The observed value reaches the ledger, so it is length-capped and reduced to
 * the safe label alphabet. Unlike `durableLabel` this preserves the sanitized
 * remainder instead of collapsing to "unknown", because the whole point of the
 * record is to say what was actually returned.
 */
const boundedObservedLabel = (value: string) =>
  value
    .trim()
    .slice(0, 128)
    .replace(/[^A-Za-z0-9._:/-]/gu, ".")
    .replaceAll("://", ".//") || "unknown"

export const RESEARCH_MODEL_DRIFT_CODES = Object.freeze([
  "PROVIDER_DRIFT",
  "MODEL_DRIFT",
] as const)
export type ResearchModelDriftCode =
  (typeof RESEARCH_MODEL_DRIFT_CODES)[number]

export type ResearchModelIdentityResult =
  | { ok: true }
  | {
      ok: false
      reason: ResearchModelDriftCode
      expected: string
      observed: string
    }

/**
 * Compares an observed invocation against the pinned identity.
 *
 * Takes the raw `OpenCodeInvocationSummary` values rather than the durable
 * projection: `durableLabel` rewrites an unsafe label to "unknown", so
 * asserting after it would report drift against "unknown" instead of what the
 * provider actually returned, and would hide an injection-shaped label as
 * ordinary drift.
 */
export function assertResearchModelIdentityV1(
  observed: Readonly<{ providerId: string; modelId: string }>,
): ResearchModelIdentityResult {
  if (observed.providerId !== RESEARCH_MODEL_IDENTITY.providerId) {
    return {
      ok: false,
      reason: "PROVIDER_DRIFT",
      expected: RESEARCH_MODEL_IDENTITY.providerId,
      observed: boundedObservedLabel(observed.providerId),
    }
  }
  if (observed.modelId !== RESEARCH_MODEL_IDENTITY.modelId) {
    return {
      ok: false,
      reason: "MODEL_DRIFT",
      expected: RESEARCH_MODEL_IDENTITY.modelId,
      observed: boundedObservedLabel(observed.modelId),
    }
  }
  return { ok: true }
}
export const MAX_RESEARCH_INVOCATION_TOOL_CALLS = 64

const boundedText = z.string().trim().min(1).max(128)
const safeCount = z.number().int().nonnegative().safe()
const labelIsSafe = (value: string) =>
  /^[A-Za-z0-9._:/-]+$/u.test(value) &&
  !value.includes("://") &&
  !/[?#@]/u.test(value)
const safeLabel = boundedText.refine(labelIsSafe)
const safeToolName = boundedText.refine(
  (value) => configuredToolName(value) === value,
)

export const researchInvocationV1Schema = z
  .object({
    invocationVersion: z.enum(SUPPORTED_RESEARCH_INVOCATION_VERSIONS),
    agentName: safeLabel,
    cycleMode: z.enum(["STANDARD", "DRY_RUN"]),
    promptVersion: safeLabel,
    decisionContractVersion: safeLabel,
    reportVersion: safeLabel,
    providerId: safeLabel,
    modelId: safeLabel,
    responseError: z.boolean(),
    schemaRepairAttempted: z.boolean().optional(),
    tokens: z
      .object({
        input: safeCount.optional(),
        output: safeCount.optional(),
        reasoning: safeCount.optional(),
        cacheRead: safeCount.optional(),
        cacheWrite: safeCount.optional(),
      })
      .strict(),
    tools: z
      .object({
        totalCount: safeCount,
        errorCount: safeCount,
        incompleteCount: safeCount,
        omittedCount: safeCount,
        calls: z
          .array(
            z
              .object({
                name: safeToolName,
                outcome: z.enum(["completed", "error", "incomplete"]),
                durationMs: safeCount.optional(),
              })
              .strict(),
          )
          .max(MAX_RESEARCH_INVOCATION_TOOL_CALLS),
      })
      .strict()
      .superRefine((tools, refinement) => {
        const retainedErrorCount = tools.calls.filter(
          ({ outcome }) => outcome === "error",
        ).length
        const retainedIncompleteCount = tools.calls.filter(
          ({ outcome }) => outcome === "incomplete",
        ).length
        const omittedErrorCount = tools.errorCount - retainedErrorCount
        const omittedIncompleteCount =
          tools.incompleteCount - retainedIncompleteCount
        if (tools.totalCount !== tools.calls.length + tools.omittedCount) {
          refinement.addIssue({
            code: "custom",
            path: ["totalCount"],
            message: "Tool totals must reconcile retained and omitted calls",
          })
        }
        if (
          tools.errorCount + tools.incompleteCount > tools.totalCount ||
          tools.errorCount < retainedErrorCount ||
          tools.incompleteCount < retainedIncompleteCount ||
          tools.errorCount > retainedErrorCount + tools.omittedCount ||
          tools.incompleteCount > retainedIncompleteCount + tools.omittedCount ||
          omittedErrorCount + omittedIncompleteCount > tools.omittedCount
        ) {
          refinement.addIssue({
            code: "custom",
            path: ["errorCount"],
            message: "Tool outcome counts must match retained or omitted calls",
          })
        }
      }),
  })
  .strict()

export type ResearchInvocationV1 = Readonly<
  z.infer<typeof researchInvocationV1Schema>
>

const bounded = (value: string) => value.trim().slice(0, 128) || "unknown"
const durableLabel = (value: string) => {
  const normalized = bounded(value)
  return labelIsSafe(normalized) ? normalized : "unknown"
}
const toolDuration = (startedAt?: number, endedAt?: number) => {
  if (startedAt === undefined || endedAt === undefined) return undefined
  const durationMs = endedAt - startedAt
  return Number.isSafeInteger(durationMs) && durationMs >= 0
    ? durationMs
    : undefined
}

/** Builds the durable, content-free provenance retained with a completed run. */
export function createResearchInvocationV1(
  versions: ResearchTraceVersions,
  invocation: OpenCodeInvocationSummary,
  options: Readonly<{ schemaRepairAttempted?: boolean }> = {},
): ResearchInvocationV1 {
  return researchInvocationV1Schema.parse({
    invocationVersion: RESEARCH_INVOCATION_VERSION,
    agentName: durableLabel(versions.agentName),
    cycleMode: versions.cycleMode,
    promptVersion: durableLabel(versions.promptVersion),
    decisionContractVersion: durableLabel(versions.decisionContractVersion),
    reportVersion: durableLabel(versions.reportVersion),
    providerId: durableLabel(invocation.providerId),
    modelId: durableLabel(invocation.modelId),
    responseError: invocation.responseError,
    ...(options.schemaRepairAttempted === undefined
      ? {}
      : { schemaRepairAttempted: options.schemaRepairAttempted }),
    tokens: {
      ...(invocation.inputTokenCount === undefined
        ? {}
        : { input: invocation.inputTokenCount }),
      ...(invocation.outputTokenCount === undefined
        ? {}
        : { output: invocation.outputTokenCount }),
      ...(invocation.reasoningTokenCount === undefined
        ? {}
        : { reasoning: invocation.reasoningTokenCount }),
      ...(invocation.cacheReadTokenCount === undefined
        ? {}
        : { cacheRead: invocation.cacheReadTokenCount }),
      ...(invocation.cacheWriteTokenCount === undefined
        ? {}
        : { cacheWrite: invocation.cacheWriteTokenCount }),
    },
    tools: {
      totalCount: invocation.toolCallCount,
      errorCount: invocation.toolErrorCount,
      incompleteCount: invocation.toolIncompleteCount,
      omittedCount: invocation.omittedToolCallCount,
      calls: invocation.toolCalls
        .slice(0, MAX_RESEARCH_INVOCATION_TOOL_CALLS)
        .map((tool) => {
          const durationMs = toolDuration(tool.startedAt, tool.endedAt)
          return {
            name: configuredToolName(bounded(tool.name)),
            outcome: tool.outcome,
            ...(durationMs === undefined ? {} : { durationMs }),
          }
        }),
    },
  })
}
