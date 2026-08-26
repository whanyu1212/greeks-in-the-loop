import type { ResearchContextV1 } from "./research-context-v1.js"
import type { ResearchEligibilityV1 } from "../scheduling/research-eligibility.js"

/**
 * Fixed identity and request construction for the unattended research agent.
 *
 * The agent name is not configurable at runtime because selecting a different
 * OpenCode agent could replace the checked-in permission boundary.
 */

/** Checked-in OpenCode primary agent used by every unattended cycle. */
export const RESEARCH_AGENT_NAME = "research" as const

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
          JSON.stringify(eligibility),
          eligibility.tradeIntentEligible
            ? "A fresh PROPOSE_TRADE may be returned if every strategy requirement passes."
            : "Do not return PROPOSE_TRADE. Return PRELIMINARY_RESEARCH for useful findings that require refresh, or NO_ACTION when no useful finding exists.",
        ].join("\n")
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
