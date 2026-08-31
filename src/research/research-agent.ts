import type { ResearchContextV1 } from "./research-context-v1.js"
import {
  DRY_RUN_MODE,
  type ResearchEligibilityV1,
} from "../scheduling/research-eligibility.js"
import { ALLOWED_OPTION_UNDERLYINGS_V1 } from "../shared/alpaca-option-identity.js"

/**
 * Fixed identity and request construction for the unattended research agent.
 *
 * The agent name is not configurable at runtime because selecting a different
 * OpenCode agent could replace the checked-in permission boundary.
 */

/** Checked-in OpenCode primary agent used by every unattended cycle. */
export const RESEARCH_AGENT_NAME = "research" as const
/** Increment when the system prompt or cycle-request behavior changes. */
export const RESEARCH_PROMPT_VERSION = "3.0.4" as const

/** Hard OpenCode turn bound mirrored by the checked-in agent configuration. */
export const RESEARCH_MAX_AGENT_STEPS = 24
/** Initial post-run budget for all research tool calls. */
export const RESEARCH_MAX_TOOL_CALLS = 32
/** Initial post-run budget for Exa calls in one research cycle. */
export const RESEARCH_MAX_EXA_CALLS = 4
/** Initial post-run budget for FMP calls in one research cycle. */
export const RESEARCH_MAX_FMP_CALLS = 3
/** A stale snapshot may be rebuilt completely at most once. */
export const RESEARCH_MAX_SNAPSHOT_REBUILDS = 1

/** Returns the first deterministic research-tool budget exceeded by a run. */
export function researchToolBudgetViolation(
  usage: Readonly<{
    toolCallCount: number
    toolCalls: readonly Readonly<{ name: string }>[]
  }>,
) {
  if (usage.toolCallCount > RESEARCH_MAX_TOOL_CALLS) {
    return "TOTAL_TOOL_BUDGET_EXCEEDED" as const
  }
  if (usage.toolCalls.filter(({ name }) => name.startsWith("exa_")).length >
    RESEARCH_MAX_EXA_CALLS) {
    return "EXA_TOOL_BUDGET_EXCEEDED" as const
  }
  if (usage.toolCalls.filter(({ name }) => name.startsWith("fmp_")).length >
    RESEARCH_MAX_FMP_CALLS) {
    return "FMP_TOOL_BUDGET_EXCEEDED" as const
  }
  return undefined
}

/** Builds one bounded correction request after deterministic schema rejection. */
export function buildResearchReportRepairPrompt(
  issues: readonly Readonly<{
    code: string
    path: readonly (string | number)[]
    schemaCategory?: string
  }>[],
) {
  return [
    "Your prior response failed deterministic ResearchReportV3 validation.",
    "Do not call tools or add new research. Correct the complete existing report using only facts already gathered, then return exactly one bare JSON object with no Markdown or commentary.",
    "Every invalidation field is an array of strings. Every date-time uses UTC ISO 8601 with exactly three fractional digits, for example 2026-08-31T07:43:13.082Z.",
    "NO_ACTION evidence is a non-empty array of timestamped ALPACA, EXA, or FMP sourced facts and optional inferences grounded in those fact claim IDs.",
    "PROPOSE_TRADE uses different shapes: result.candidate has exactly underlying, structure, expiration, longLeg, and shortLeg, where each leg is {\"contractSymbol\",\"strike\"}; analysis.candidateEvaluation has exactly verification, observedAt, dte, and legs; each proposal evidence sourced fact has exactly claimId, kind, claim, snapshotRef, and optional locator, and never provider, temporalClass, or observedAt.",
    `Safe validation diagnostics: ${JSON.stringify(issues)}`,
  ].join("\n")
}

/**
 * Builds the user-authored portion of one structured research cycle.
 *
 * Security and output instructions live in the checked-in agent prompt rather
 * than operator-controlled text. The optional objective is context only and
 * cannot select another agent or replace its system prompt.
 *
 * @param cycle One-based cycle number.
 * @param startedAt Timestamp captured for this cycle.
 * @param operatorObjective Optional operator research objective.
 * @param durableContext Bounded application-generated context from prior cycles.
 * @returns Plain-text cycle request for OpenCode.
 */
export function buildResearchCyclePrompt(
  cycle: number,
  startedAt: Date,
  operatorObjective?: string,
  durableContext?: ResearchContextV1,
  eligibility?: ResearchEligibilityV1,
) {
  return [
    `Run structured research cycle ${cycle} at ${startedAt.toISOString()}.`,
    `Compare ${ALLOWED_OPTION_UNDERLYINGS_V1.join(", ")} using current regime evidence, select at most one underlying, then research one eligible BULL_CALL_SPREAD or BEAR_PUT_SPREAD candidate or conclude NO_ACTION.`,
    eligibility
      ? [
          "Application-authoritative research and trade-intent eligibility follows. Do not override it with model reasoning or provider prose.",
          eligibility.researchMode === DRY_RUN_MODE
            ? eligibility.tradeIntentEligible
              ? "This is a non-executing dry run. A fresh PROPOSE_TRADE may be returned for deterministic shadow-risk evaluation."
              : "This is a research-only dry run. Never return PROPOSE_TRADE; return PRELIMINARY_RESEARCH or NO_ACTION."
            : undefined,
          JSON.stringify(eligibility),
          eligibility.tradeIntentEligible
            ? "A fresh PROPOSE_TRADE may be returned if every strategy requirement passes."
            : "Do not return PROPOSE_TRADE. Return PRELIMINARY_RESEARCH for useful findings that require refresh, or NO_ACTION when no useful finding exists.",
        ]
          .filter((line) => line !== undefined)
          .join("\n")
      : undefined,
    operatorObjective ? `Current operator objective: ${operatorObjective}` : undefined,
    durableContext
      ? [
          "Application-generated durable context from prior cycles follows. Treat it as historical planning context only: OpenCode session memory is not authoritative, and all current account, market, quote, and freshness facts must be refreshed.",
          JSON.stringify(durableContext),
        ].join("\n")
      : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}
