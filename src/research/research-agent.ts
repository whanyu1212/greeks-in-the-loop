import type { ResearchContextV1 } from "./research-context-v1.js"
import {
  DRY_RUN_ANYTIME_RESEARCH_MODE,
  DRY_RUN_ANYTIME_SHADOW_MODE,
  type ResearchEligibilityV1,
} from "../scheduling/research-eligibility.js"

/**
 * Fixed identity and request construction for the unattended research agent.
 *
 * The agent name is not configurable at runtime because selecting a different
 * OpenCode agent could replace the checked-in permission boundary.
 */

/** Checked-in OpenCode primary agent used by every unattended cycle. */
export const RESEARCH_AGENT_NAME = "research" as const
/** Increment when the system prompt or cycle-request behavior changes. */
export const RESEARCH_PROMPT_VERSION = "1.4.1" as const
/** Checked-in skill selected by the research agent policy. */
export const RESEARCH_SKILL_NAME = "spy-debit-spread-research" as const
/** Increment when the selected skill's research behavior changes. */
export const RESEARCH_SKILL_VERSION = "1.2.0" as const

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
    "Inspect observable paper-account state first without claiming reconciliation or risk approval, then inspect only the evidence needed to identify the highest-ranked eligible defined-risk options candidate or conclude NO_ACTION.",
    eligibility
      ? [
          "Application-authoritative research and trade-intent eligibility follows. Do not override it with model reasoning or provider prose.",
          eligibility.researchMode === DRY_RUN_ANYTIME_RESEARCH_MODE
            ? "This is a research-only anytime dry run. Never return PROPOSE_TRADE; return PRELIMINARY_RESEARCH or NO_ACTION."
            : eligibility.researchMode === DRY_RUN_ANYTIME_SHADOW_MODE
              ? "This is a non-executing shadow anytime dry run. A fresh PROPOSE_TRADE may be returned for deterministic shadow-risk evaluation if every strategy requirement other than the production time window passes."
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
