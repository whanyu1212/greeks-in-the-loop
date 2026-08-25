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
 * @returns Plain-text cycle request for OpenCode.
 */
export function buildResearchCyclePrompt(
  cycle: number,
  startedAt: Date,
  operatorObjective?: string,
) {
  return [
    `Run structured research cycle ${cycle} at ${startedAt.toISOString()}.`,
    "Inspect observable paper-account state first without claiming reconciliation or risk approval, then inspect only the evidence needed to identify the highest-ranked eligible defined-risk options candidate or conclude NO_ACTION.",
    operatorObjective ? `Current operator objective: ${operatorObjective}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}
