import { isDeepStrictEqual } from "node:util"

import {
  validateQualitativeResearchResponseV1,
  type QualitativeResearchResponseValidationCode,
} from "../contracts/qualitative-research-response-v1.js"
import {
  researchPlanV1Schema,
  type ResearchPlanV1,
} from "../contracts/research-plan-v1.js"

export const QUALITATIVE_RESEARCH_EVALUATION_VERSION = "1.0.0" as const

export const QUALITATIVE_RESEARCH_EVALUATION_ISSUE_CODES = Object.freeze([
  "MALFORMED_JSON",
  "PROVIDER_DRIFT",
  "MODEL_DRIFT",
  "FORBIDDEN_TOOL_USED",
  "SKILL_CALL_INVALID",
  "TOTAL_TOOL_BUDGET_EXCEEDED",
  "EXA_TOOL_BUDGET_EXCEEDED",
  "FMP_TOOL_BUDGET_EXCEEDED",
  "CONTRADICTION_SEARCH_TOOL_MISSING",
] as const)

type EvaluatorIssueCode =
  (typeof QUALITATIVE_RESEARCH_EVALUATION_ISSUE_CODES)[number]

export type QualitativeResearchEvaluationIssueCode =
  | EvaluatorIssueCode
  | QualitativeResearchResponseValidationCode

export type QualitativeResearchToolCall = Readonly<{
  name: string
  outcome?: "completed" | "error" | "incomplete"
  input?: unknown
}>

export type QualitativeResearchEvaluationV1 = Readonly<{
  evaluationVersion: typeof QUALITATIVE_RESEARCH_EVALUATION_VERSION
  planId: string
  status: "PASS" | "FAIL"
  issueCodes: readonly QualitativeResearchEvaluationIssueCode[]
  metrics: Readonly<{
    toolCallCount: number
    exaCallCount: number
    fmpCallCount: number
  }>
}>

export type EvaluateQualitativeResearchInput = Readonly<{
  plan: ResearchPlanV1
  rawResponse: string
  toolCalls: readonly QualitativeResearchToolCall[]
  observedModel: Readonly<{ providerId: string; modelId: string }>
  evaluatedAt: string
}>

const completed = ({ outcome }: QualitativeResearchToolCall) =>
  outcome === undefined || outcome === "completed"

const skillName = (call: QualitativeResearchToolCall) =>
  call.input !== null && typeof call.input === "object"
    ? (call.input as { name?: unknown }).name
    : undefined

/** Grades a qualitative response and sanitized tool trace against one plan. */
export function evaluateQualitativeResearchV1({
  plan,
  rawResponse,
  toolCalls,
  observedModel,
  evaluatedAt,
}: EvaluateQualitativeResearchInput): QualitativeResearchEvaluationV1 {
  const parsedPlan = researchPlanV1Schema.parse(plan)
  const issues: QualitativeResearchEvaluationIssueCode[] = []

  let responseInput: unknown
  let disposition: "CONTINUE" | "VETO" | undefined
  try {
    responseInput = JSON.parse(rawResponse)
  } catch {
    issues.push("MALFORMED_JSON")
  }
  if (responseInput !== undefined) {
    const validation = validateQualitativeResearchResponseV1(
      responseInput,
      parsedPlan,
      evaluatedAt,
    )
    if (validation.success) {
      disposition = validation.data.disposition
    } else {
      issues.push(...validation.issues.map(({ code }) => code))
    }
  }

  if (observedModel.providerId !== parsedPlan.invocation.providerId) {
    issues.push("PROVIDER_DRIFT")
  }
  if (observedModel.modelId !== parsedPlan.invocation.modelId) {
    issues.push("MODEL_DRIFT")
  }

  const allowed = (name: string) =>
    name === "skill" || name.startsWith("exa_") || name.startsWith("fmp_")
  if (toolCalls.some(({ name }) => !allowed(name))) {
    issues.push("FORBIDDEN_TOOL_USED")
  }

  const completedCalls = toolCalls.filter(completed)
  const skillCalls = toolCalls.filter(({ name }) => name === "skill")
  if (
    skillCalls.length !== 1 ||
    !completed(skillCalls[0]!) ||
    skillName(skillCalls[0]!) !== parsedPlan.invocation.skillName
  ) {
    issues.push("SKILL_CALL_INVALID")
  }

  const exaCallCount = toolCalls.filter(({ name }) =>
    name.startsWith("exa_")
  ).length
  const fmpCallCount = toolCalls.filter(({ name }) =>
    name.startsWith("fmp_")
  ).length
  if (toolCalls.length > parsedPlan.evidencePolicy.maximumTotalToolCalls) {
    issues.push("TOTAL_TOOL_BUDGET_EXCEEDED")
  }
  if (exaCallCount > parsedPlan.evidencePolicy.maximumExaCalls) {
    issues.push("EXA_TOOL_BUDGET_EXCEEDED")
  }
  if (fmpCallCount > parsedPlan.evidencePolicy.maximumFmpCalls) {
    issues.push("FMP_TOOL_BUDGET_EXCEEDED")
  }
  const distinctCompletedExaCalls = completedCalls
    .filter(({ name }) => name.startsWith("exa_"))
    .filter((call, index, calls) =>
      calls.findIndex((other) => isDeepStrictEqual(other.input, call.input)) ===
        index
    ).length
  if (
    disposition !== "VETO" &&
    parsedPlan.evidencePolicy.requireContradictionSearch &&
    distinctCompletedExaCalls <
      parsedPlan.evidencePolicy.minimumCompletedExaCalls
  ) {
    issues.push("CONTRADICTION_SEARCH_TOOL_MISSING")
  }

  const issueCodes = [...new Set(issues)].sort()
  return {
    evaluationVersion: QUALITATIVE_RESEARCH_EVALUATION_VERSION,
    planId: parsedPlan.planId,
    status: issueCodes.length === 0 ? "PASS" : "FAIL",
    issueCodes,
    metrics: {
      toolCallCount: toolCalls.length,
      exaCallCount,
      fmpCallCount,
    },
  }
}