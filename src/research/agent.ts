import type { OptionUniverseSnapshotV2 } from "../contracts/option-universe-v2.js"
import {
  DRY_RUN_MODE,
  type ResearchEligibilityV1,
} from "../scheduling/research-eligibility.js"
import type { ResearchContextV1 } from "./context.js"

/**
 * Fixed identity and request construction for the unattended research agent.
 *
 * The agent name is not configurable at runtime because selecting a different
 * OpenCode agent could replace the checked-in permission boundary.
 */

/** Checked-in OpenCode primary agent used by every unattended cycle. */
export const RESEARCH_AGENT_NAME = "research" as const
/** Increment when the system prompt or cycle-request behavior changes. */
export const RESEARCH_PROMPT_VERSION = "6.1.1" as const

/** Hard OpenCode turn bound mirrored by the checked-in agent configuration. */
export const RESEARCH_MAX_AGENT_STEPS = 32
/** Initial post-run budget for all research tool calls. */
export const RESEARCH_MAX_TOOL_CALLS = 64
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
    "Your prior response failed deterministic ResearchReportV6 validation.",
    "Do not call tools or add new research. Correct the complete existing report using only facts already gathered, then return exactly one bare JSON object with no Markdown or commentary.",
    "Every invalidation field is an array of strings. Every date-time uses UTC ISO 8601 with exactly three fractional digits, for example 2026-08-31T07:43:13.082Z.",
    "Case-sensitive enums: evidence kind is SOURCED_FACT or INFERENCE; temporalClass is LIVE, DELAYED, or PRIOR_CLOSE; symbol direction is BULLISH, BEARISH, or NEUTRAL; symbol disposition is REJECT, WATCH, or PROPOSE.",
    "NO_ACTION evidence is a non-empty array. Sourced facts are exactly {claimId,kind:\"SOURCED_FACT\",claim,provider,temporalClass,observedAt} plus optional locator. Inferences are exactly {claimId,kind:\"INFERENCE\",claim,basedOn} and basedOn references sourced-fact claim IDs.",
    "When analysis.broadMarketContext is present it requires verification, temporalClass, observedAt, benchmark, and signal. Use benchmark, not underlying.",
    "EXA externalContext is exactly {sourceId,provider:\"EXA\",verification:\"AGENT_REPORTED\",title,url,publishedAt,retrievedAt,summary,relevance}. FMP externalContext is exactly {sourceId,provider:\"FMP\",verification:\"AGENT_REPORTED\",dataset,observedAt,retrievedAt,summary,relevance}. Do not retain provider aliases or extra fields.",
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
 * @param optionUniverse Application-authoritative candidate shortlist.
 * @param operatorObjective Optional operator research objective.
 * @param durableContext Bounded application-generated context from prior cycles.
 * @returns Plain-text cycle request for OpenCode.
 */
export function buildResearchCyclePrompt(
  cycle: number,
  startedAt: Date,
  optionUniverse: OptionUniverseSnapshotV2,
  operatorObjective?: string,
  durableContext?: ResearchContextV1,
  eligibility?: ResearchEligibilityV1,
) {
  const underlyings = optionUniverse.candidates.map(({ underlying }) => underlying)
  return [
    `Run structured research cycle ${cycle} at ${startedAt.toISOString()}.`,
    "The application-authoritative option universe follows. Copy it exactly into analysis.optionUniverse; do not add or substitute symbols.",
    JSON.stringify(optionUniverse),
    underlyings.length === 0
      ? "The dynamic shortlist is empty. Return NO_ACTION with INSUFFICIENT_UNDERLYING_DATA and do not substitute a symbol."
      : `Lightly evaluate every shortlisted underlying (${underlyings.join(", ")}), promote at most three to deep option research, and return either NO_ACTION or one to three ranked BULL_CALL_SPREAD or BEAR_PUT_SPREAD proposals.`,
    eligibility
      ? [
          "Application-authoritative research and trade-intent eligibility follows. Do not override it with model reasoning or provider prose.",
          eligibility.researchMode === DRY_RUN_MODE
            ? eligibility.tradeIntentEligible
              ? "This is a non-executing dry run. Fresh PROPOSE_TRADES candidates may be returned for deterministic shadow-risk evaluation."
              : "This is a research-only dry run. Never return PROPOSE_TRADES; return NO_ACTION with MARKET_WINDOW_INELIGIBLE while retaining useful research in analysis."
            : undefined,
          JSON.stringify(eligibility),
          eligibility.tradeIntentEligible
            ? "Fresh PROPOSE_TRADES candidates may be returned if every strategy requirement passes. Rank them by priority; deterministic code independently evaluates each and selects within current portfolio capacity."
            : "Do not return PROPOSE_TRADES. Return NO_ACTION with MARKET_WINDOW_INELIGIBLE while retaining useful research in analysis.",
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
