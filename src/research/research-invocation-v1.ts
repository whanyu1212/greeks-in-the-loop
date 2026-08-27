import { z } from "zod"

import {
  configuredToolName,
  type OpenCodeInvocationSummary,
} from "../observability/opencode-telemetry-summary.js"
import type { ResearchTraceVersions } from "../observability/research-telemetry.js"

export const RESEARCH_INVOCATION_VERSION = "1.0.0" as const
export const MAX_RESEARCH_INVOCATION_TOOL_CALLS = 32

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
    invocationVersion: z.literal(RESEARCH_INVOCATION_VERSION),
    agentName: boundedText,
    cycleMode: z.enum([
      "STANDARD",
      "DRY_RUN_ANYTIME",
      "DRY_RUN_SHADOW_ANYTIME",
    ]),
    promptVersion: boundedText,
    skillName: boundedText,
    skillVersion: boundedText,
    strategyVersion: boundedText,
    decisionContractVersion: boundedText,
    reportVersion: boundedText,
    providerId: safeLabel,
    modelId: safeLabel,
    responseError: z.boolean(),
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
): ResearchInvocationV1 {
  return researchInvocationV1Schema.parse({
    invocationVersion: RESEARCH_INVOCATION_VERSION,
    agentName: bounded(versions.agentName),
    cycleMode: versions.cycleMode,
    promptVersion: bounded(versions.promptVersion),
    skillName: bounded(versions.skillName),
    skillVersion: bounded(versions.skillVersion),
    strategyVersion: bounded(versions.strategyVersion),
    decisionContractVersion: bounded(versions.decisionContractVersion),
    reportVersion: bounded(versions.reportVersion),
    providerId: durableLabel(invocation.providerId),
    modelId: durableLabel(invocation.modelId),
    responseError: invocation.responseError,
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
