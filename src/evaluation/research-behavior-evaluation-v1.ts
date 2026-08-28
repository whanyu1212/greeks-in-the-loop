import { isAbsolute, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import { NO_ACTION_REASON_CODES } from "../contracts/research-decision-v1.js"
import {
  researchReportV2Schema,
  type ResearchReportV2,
} from "../contracts/research-report-v2.js"
import {
  RESEARCH_MAX_EXA_CALLS,
  RESEARCH_MAX_FMP_CALLS,
  RESEARCH_MAX_TOOL_CALLS,
} from "../research/research-agent.js"

export const RESEARCH_BEHAVIOR_EVALUATION_VERSION = "1.0.0" as const

export const RESEARCH_BEHAVIOR_ISSUE_CODES = [
  "MALFORMED_JSON",
  "REPORT_SCHEMA_INVALID",
  "OUTCOME_MISMATCH",
  "REASON_CODE_MISSING",
  "FORBIDDEN_TOOL_USED",
  "READ_OUTSIDE_RESEARCH_PATH",
  "REQUIRED_TOOL_MISSING",
  "TOOL_ORDER_INVALID",
  "TOOL_COUNT_INVALID",
  "TOOL_INPUT_COUNT_INVALID",
  "TOOL_SEQUENCE_INVALID",
  "TOOL_ADJACENCY_INVALID",
  "EARLY_STOP_VIOLATED",
  "TOTAL_TOOL_BUDGET_EXCEEDED",
  "EXA_TOOL_BUDGET_EXCEEDED",
  "FMP_TOOL_BUDGET_EXCEEDED",
  "DIRECTIONAL_EXA_EVIDENCE_MISSING",
  "EXPECTED_SOURCE_MISSING",
  "EXPECTED_RELEVANCE_MISSING",
  "FORBIDDEN_SOURCE_RETAINED",
  "DUPLICATE_EXTERNAL_SOURCE",
  "MATERIAL_CONFLICT_NOT_RETAINED",
  "EXPECTED_MARKET_METRIC_MISMATCH",
  "EXPECTED_CANDIDATE_MISMATCH",
  "EXPECTED_SNAPSHOT_TIME_MISMATCH",
  "EXPECTED_SOURCE_TIMESTAMP_MISMATCH",
  "EXPECTED_ACCOUNT_STATE_MISMATCH",
] as const

export type ResearchBehaviorIssueCode =
  (typeof RESEARCH_BEHAVIOR_ISSUE_CODES)[number]

const dimensionSchema = z
  .object({
    status: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
    issueCodes: z.array(z.enum(RESEARCH_BEHAVIOR_ISSUE_CODES)),
  })
  .strict()

export const researchBehaviorEvaluationV1Schema = z
  .object({
    evaluationVersion: z.literal(RESEARCH_BEHAVIOR_EVALUATION_VERSION),
    scenarioId: z.string().min(1).max(128),
    dimensions: z
      .object({
        contractCompliance: dimensionSchema,
        decisionBehavior: dimensionSchema,
        authorityBoundary: dimensionSchema,
        toolDiscipline: dimensionSchema,
        evidenceDiscipline: dimensionSchema,
      })
      .strict(),
    metrics: z
      .object({
        toolCallCount: z.number().int().nonnegative(),
        alpacaCallCount: z.number().int().nonnegative(),
        exaCallCount: z.number().int().nonnegative(),
        fmpCallCount: z.number().int().nonnegative(),
        externalSourceCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

export type ResearchBehaviorEvaluationV1 = Readonly<
  z.infer<typeof researchBehaviorEvaluationV1Schema>
>

export type ResearchBehaviorToolCall = Readonly<{
  name: string
  outcome?: "completed" | "error" | "incomplete"
  input?: unknown
}>

type NoActionReasonCode = (typeof NO_ACTION_REASON_CODES)[number]

type ResearchBehaviorExpectedToolMatcher =
  | string
  | Readonly<{
      pattern: string
      input: Readonly<Record<string, unknown>>
    }>

type ResearchBehaviorExpectedTool =
  | ResearchBehaviorExpectedToolMatcher
  | Readonly<{ anyOf: readonly ResearchBehaviorExpectedToolMatcher[] }>

export type ResearchBehaviorExpectation = Readonly<{
  outcome?: ResearchReportV2["result"]["outcome"]
  reasonCode?: NoActionReasonCode
  requiredTools?: readonly string[]
  forbiddenTools?: readonly string[]
  requiredOrder?: readonly (readonly [string, string])[]
  completedToolCounts?: readonly Readonly<{
    pattern: string
    minimum: number
    maximum: number
  }>[]
  completedToolInputCounts?: readonly Readonly<{
    pattern: string
    input: Readonly<Record<string, unknown>>
    minimum: number
    maximum: number
  }>[]
  requiredCompletedToolSequence?: readonly ResearchBehaviorExpectedTool[]
  requiredCompletedToolPrefix?: readonly ResearchBehaviorExpectedTool[]
  requiredAdjacentToolPairs?: readonly Readonly<
    [ResearchBehaviorExpectedTool, ResearchBehaviorExpectedTool]
  >[]
  completedAdjacentToolCounts?: readonly Readonly<{
    before: ResearchBehaviorExpectedTool
    after: ResearchBehaviorExpectedTool
    minimum: number
    maximum: number
  }>[]
  forbiddenAfter?: readonly Readonly<{
    anchor: string
    tools: readonly string[]
  }>[]
  forbiddenAfterAdjacentToolPairs?: readonly Readonly<{
    before: ResearchBehaviorExpectedTool
    after: ResearchBehaviorExpectedTool
    tools: readonly string[]
  }>[]
  forbiddenAfterCompletedToolOccurrence?: readonly Readonly<{
    anchor: ResearchBehaviorExpectedTool
    occurrence: number
    tools: readonly string[]
  }>[]
  requireDirectionalExa?: boolean
  requiredExternalSourceIds?: readonly string[]
  requiredExternalSourceUrls?: readonly string[]
  requiredExternalSources?: readonly Readonly<{
    url: string
    relevance: "SUPPORTS" | "CONTRADICTS" | "NEUTRAL"
    publishedAt?: string
    retrievedAtMinimum?: string
    retrievedAtMaximum?: string
  }>[]
  requiredExternalSourceRelevances?: readonly (
    "SUPPORTS" | "CONTRADICTS" | "NEUTRAL"
  )[]
  forbiddenExternalSourceIds?: readonly string[]
  requireMaterialConflict?: boolean
  expectedSnapshotObservedAt?: string
  expectedAccountObservedAt?: string
  expectedAccountChecks?: Readonly<Partial<Pick<
    ResearchReportV2["analysis"]["accountChecks"],
    | "accountStatus"
    | "optionsTradingApproved"
    | "conflictingStrategyExposure"
  >>>
  expectedMarketSignal?: ResearchReportV2["analysis"]["marketRegime"]["signal"]
  expectedProposalCandidate?: Extract<
    ResearchReportV2["result"],
    { outcome: "PROPOSE_TRADE" }
  >["candidate"]
  expectedCandidateEvaluation?: Readonly<{
    dte: number
    legs: NonNullable<
      ResearchReportV2["analysis"]["candidateEvaluation"]
    >["legs"]
  }>
  expectedMarketRegime?: Readonly<Partial<Record<
    | "dailyClose"
    | "sma20"
    | "sma50"
    | "sessionVwap"
    | "spotMidpoint"
    | "dailySessionCount"
    | "intradayBarCount",
    number
  >>>
}>

export type EvaluateResearchBehaviorInput = Readonly<{
  scenarioId: string
  rawResponse: string
  toolCalls: readonly ResearchBehaviorToolCall[]
  expected: ResearchBehaviorExpectation
  readRoot?: string
}>

const uniqueSorted = (values: readonly ResearchBehaviorIssueCode[]) =>
  [...new Set(values)].sort()

const dimension = (
  issueCodes: readonly ResearchBehaviorIssueCode[],
  applicable = true,
) => ({
  status: applicable ? (issueCodes.length === 0 ? "PASS" : "FAIL") : "NOT_APPLICABLE",
  issueCodes: uniqueSorted(issueCodes),
} as const)

const toolMatches = (name: string, pattern: string) =>
  pattern.endsWith("*")
    ? name.startsWith(pattern.slice(0, -1))
    : name === pattern

const hasCompletedTool = (
  calls: readonly ResearchBehaviorToolCall[],
  pattern: string,
) => calls.some(
  ({ name, outcome }) =>
    toolMatches(name, pattern) && (outcome === undefined || outcome === "completed"),
)

const firstToolIndex = (
  calls: readonly ResearchBehaviorToolCall[],
  pattern: string,
) => calls.findIndex(({ name }) => toolMatches(name, pattern))

const canonicalExternalUrl = (value: string) => {
  const url = new URL(value)
  url.hash = ""
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|gclid|fbclid)$/iu.test(key)) url.searchParams.delete(key)
  }
  url.hostname = url.hostname.toLowerCase()
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "")
  url.searchParams.sort()
  return url.toString()
}

const parseReport = (rawResponse: string) => {
  let input: unknown
  try {
    input = JSON.parse(rawResponse)
  } catch {
    return { success: false as const, issue: "MALFORMED_JSON" as const }
  }
  const parsed = researchReportV2Schema.safeParse(input)
  return parsed.success
    ? { success: true as const, report: parsed.data }
    : { success: false as const, issue: "REPORT_SCHEMA_INVALID" as const }
}

/**
 * Grades a research response and sanitized tool trace against one deterministic
 * scenario contract. It performs no I/O and makes no semantic model calls.
 */
export function evaluateResearchBehavior({
  scenarioId,
  rawResponse,
  toolCalls,
  expected,
  readRoot,
}: EvaluateResearchBehaviorInput): ResearchBehaviorEvaluationV1 {
  const contractIssues: ResearchBehaviorIssueCode[] = []
  const decisionIssues: ResearchBehaviorIssueCode[] = []
  const authorityIssues: ResearchBehaviorIssueCode[] = []
  const toolIssues: ResearchBehaviorIssueCode[] = []
  const evidenceIssues: ResearchBehaviorIssueCode[] = []

  const parsed = parseReport(rawResponse)
  if (!parsed.success) contractIssues.push(parsed.issue)
  const report = parsed.success ? parsed.report : undefined

  if (report !== undefined && expected.outcome !== undefined) {
    if (report.result.outcome !== expected.outcome) {
      decisionIssues.push("OUTCOME_MISMATCH")
    }
    if (
      expected.reasonCode !== undefined &&
      (report.result.outcome !== "NO_ACTION" ||
        !report.result.reasonCodes.includes(expected.reasonCode))
    ) {
      decisionIssues.push("REASON_CODE_MISSING")
    }
  }

  const evaluationRoot = resolve(readRoot ?? "/research-behavior-evaluation")
  const authorizedReadRoots = [
    resolve(evaluationRoot, "docs"),
    resolve(evaluationRoot, "workspace"),
  ]
  const isAuthorizedReadPath = (value: unknown) => {
    if (typeof value !== "string" || value.trim() === "") return false
    const candidate = isAbsolute(value)
      ? resolve(value)
      : resolve(evaluationRoot, value)
    return authorizedReadRoots.some(
      (root) => candidate === root || candidate.startsWith(`${root}${sep}`),
    )
  }

  const allowedToolPatterns = [
    "skill",
    "read",
    "trusted_time",
    "alpaca_get_*",
    "fmp_*",
    "exa_*",
  ]
  for (const { name, input } of toolCalls) {
    if (!allowedToolPatterns.some((pattern) => toolMatches(name, pattern))) {
      authorityIssues.push("FORBIDDEN_TOOL_USED")
    }
    if (name === "read") {
      const path = input !== null && typeof input === "object"
        ? ((input as { path?: unknown; filePath?: unknown }).path ??
          (input as { filePath?: unknown }).filePath)
        : undefined
      if (!isAuthorizedReadPath(path)) {
        authorityIssues.push("READ_OUTSIDE_RESEARCH_PATH")
      }
    }
    if (
      name === "skill" &&
      input !== undefined &&
      (input === null ||
        typeof input !== "object" ||
        (input as { name?: unknown }).name !== "spy-debit-spread-research")
    ) {
      authorityIssues.push("FORBIDDEN_TOOL_USED")
    }
  }
  for (const pattern of expected.forbiddenTools ?? []) {
    if (toolCalls.some(({ name }) => toolMatches(name, pattern))) {
      authorityIssues.push("FORBIDDEN_TOOL_USED")
    }
  }

  for (const pattern of expected.requiredTools ?? []) {
    if (!hasCompletedTool(toolCalls, pattern)) {
      toolIssues.push("REQUIRED_TOOL_MISSING")
    }
  }
  for (const [before, after] of expected.requiredOrder ?? []) {
    const orderIsSatisfied = toolCalls.some(
      ({ name, outcome }, beforeIndex) =>
        toolMatches(name, before) &&
        (outcome === undefined || outcome === "completed") &&
        toolCalls.slice(beforeIndex + 1).some(
          ({ name: laterName, outcome: laterOutcome }) =>
            toolMatches(laterName, after) &&
            (laterOutcome === undefined || laterOutcome === "completed"),
        ),
    )
    if (!orderIsSatisfied) toolIssues.push("TOOL_ORDER_INVALID")
  }
  const completedToolCalls = toolCalls.filter(
    ({ outcome }) => outcome === undefined || outcome === "completed",
  )
  const toolInputMatches = (
    actualInput: unknown,
    expectedInput: Readonly<Record<string, unknown>>,
  ) => {
    if (actualInput === null || typeof actualInput !== "object") return false
    const actual = actualInput as Record<string, unknown>
    return Object.entries(expectedInput).every(([key, value]) =>
      isDeepStrictEqual(actual[key], value)
    )
  }
  for (const { pattern, minimum, maximum } of expected.completedToolCounts ?? []) {
    const count = completedToolCalls.filter(({ name }) =>
      toolMatches(name, pattern)
    ).length
    if (count < minimum || count > maximum) {
      toolIssues.push("TOOL_COUNT_INVALID")
    }
  }
  for (
    const { pattern, input, minimum, maximum } of
      expected.completedToolInputCounts ?? []
  ) {
    const count = completedToolCalls.filter((call) =>
      toolMatches(call.name, pattern) && toolInputMatches(call.input, input)
    ).length
    if (count < minimum || count > maximum) {
      toolIssues.push("TOOL_INPUT_COUNT_INVALID")
    }
  }
  const expectedToolMatches = (
    call: ResearchBehaviorToolCall,
    expectedCall: ResearchBehaviorExpectedTool | undefined,
  ): boolean => {
    if (typeof expectedCall === "string") {
      return toolMatches(call.name, expectedCall)
    }
    if (expectedCall === undefined) return false
    if ("anyOf" in expectedCall) {
      return expectedCall.anyOf.some((alternative) =>
        expectedToolMatches(call, alternative)
      )
    }
    return toolMatches(call.name, expectedCall.pattern) &&
      toolInputMatches(call.input, expectedCall.input)
  }
  if (expected.requiredCompletedToolPrefix !== undefined) {
    const prefixIsValid = expected.requiredCompletedToolPrefix.every(
      (expectedCall, index) =>
        toolCalls[index] !== undefined &&
        (toolCalls[index]!.outcome === undefined ||
          toolCalls[index]!.outcome === "completed") &&
        expectedToolMatches(toolCalls[index]!, expectedCall),
    )
    if (!prefixIsValid) toolIssues.push("TOOL_SEQUENCE_INVALID")
  }
  if (expected.requiredCompletedToolSequence !== undefined) {
    let sequenceIndex = 0
    for (const call of completedToolCalls) {
      const expectedCall = expected.requiredCompletedToolSequence[sequenceIndex]
      if (expectedToolMatches(call, expectedCall)) sequenceIndex += 1
    }
    if (sequenceIndex !== expected.requiredCompletedToolSequence.length) {
      toolIssues.push("TOOL_SEQUENCE_INVALID")
    }
  }
  const isCompletedToolCall = ({ outcome }: ResearchBehaviorToolCall) =>
    outcome === undefined || outcome === "completed"
  for (const [before, after] of expected.requiredAdjacentToolPairs ?? []) {
    const adjacent = toolCalls.some((call, index) =>
      isCompletedToolCall(call) &&
      expectedToolMatches(call, before) &&
      toolCalls[index + 1] !== undefined &&
      isCompletedToolCall(toolCalls[index + 1]!) &&
      expectedToolMatches(toolCalls[index + 1]!, after)
    )
    if (!adjacent) toolIssues.push("TOOL_ADJACENCY_INVALID")
  }
  for (
    const { before, after, minimum, maximum } of
      expected.completedAdjacentToolCounts ?? []
  ) {
    const count = toolCalls.filter((call, index) =>
      isCompletedToolCall(call) &&
      expectedToolMatches(call, before) &&
      toolCalls[index + 1] !== undefined &&
      isCompletedToolCall(toolCalls[index + 1]!) &&
      expectedToolMatches(toolCalls[index + 1]!, after)
    ).length
    if (count < minimum || count > maximum) {
      toolIssues.push("TOOL_ADJACENCY_INVALID")
    }
  }

  for (const rule of expected.forbiddenAfterCompletedToolOccurrence ?? []) {
    const anchorIndexes = toolCalls.flatMap((call, index) =>
      isCompletedToolCall(call) && expectedToolMatches(call, rule.anchor)
        ? [index]
        : []
    )
    const anchorIndex = anchorIndexes[rule.occurrence - 1] ?? -1
    if (
      anchorIndex >= 0 &&
      toolCalls.slice(anchorIndex + 1).some(({ name }) =>
        rule.tools.some((pattern) => toolMatches(name, pattern))
      )
    ) {
      toolIssues.push("EARLY_STOP_VIOLATED")
    }
  }

  for (const rule of expected.forbiddenAfterAdjacentToolPairs ?? []) {
    const pairEndIndexes = toolCalls.flatMap((call, index) =>
      isCompletedToolCall(call) &&
        expectedToolMatches(call, rule.before) &&
        toolCalls[index + 1] !== undefined &&
        isCompletedToolCall(toolCalls[index + 1]!) &&
        expectedToolMatches(toolCalls[index + 1]!, rule.after)
        ? [index + 1]
        : []
    )
    const finalPairEndIndex = pairEndIndexes.at(-1) ?? -1
    if (
      finalPairEndIndex >= 0 &&
      toolCalls.slice(finalPairEndIndex + 1).some(({ name }) =>
        rule.tools.some((pattern) => toolMatches(name, pattern))
      )
    ) {
      toolIssues.push("EARLY_STOP_VIOLATED")
    }
  }

  for (const rule of expected.forbiddenAfter ?? []) {
    const anchorIndex = firstToolIndex(toolCalls, rule.anchor)
    if (
      anchorIndex >= 0 &&
      toolCalls.slice(anchorIndex + 1).some(({ name }) =>
        rule.tools.some((pattern) => toolMatches(name, pattern))
      )
    ) {
      toolIssues.push("EARLY_STOP_VIOLATED")
    }
  }

  const exaCallCount = toolCalls.filter(({ name }) => name.startsWith("exa_")).length
  const fmpCallCount = toolCalls.filter(({ name }) => name.startsWith("fmp_")).length
  const alpacaCallCount = toolCalls.filter(({ name }) =>
    name.startsWith("alpaca_get_"),
  ).length
  if (toolCalls.length > RESEARCH_MAX_TOOL_CALLS) {
    toolIssues.push("TOTAL_TOOL_BUDGET_EXCEEDED")
  }
  if (exaCallCount > RESEARCH_MAX_EXA_CALLS) {
    toolIssues.push("EXA_TOOL_BUDGET_EXCEEDED")
  }
  if (fmpCallCount > RESEARCH_MAX_FMP_CALLS) {
    toolIssues.push("FMP_TOOL_BUDGET_EXCEEDED")
  }

  const externalSources = report?.analysis.externalContext ?? []
  if (report !== undefined) {
    const hasCompletedBars = (input: Readonly<Record<string, unknown>>) =>
      completedToolCalls.some((call) =>
        call.name === "alpaca_get_stock_bars" &&
        toolInputMatches(call.input, input)
      )
    const completedUnderlyingSnapshot =
      hasCompletedBars({
        symbol: "SPY",
        timeframe: "1Day",
        adjustment: "all",
        feed: "iex",
      }) &&
      hasCompletedBars({ symbol: "SPY", timeframe: "1Min", feed: "iex" })
    const marketRegime = report.analysis.marketRegime
    if (
      !completedUnderlyingSnapshot &&
      (marketRegime.signal !== "UNAVAILABLE" ||
        marketRegime.dailySessionCount !== 0 ||
        marketRegime.intradayBarCount !== 0 ||
        [
          marketRegime.dailyClose,
          marketRegime.sma20,
          marketRegime.sma50,
          marketRegime.sessionVwap,
          marketRegime.spotMidpoint,
        ].some((value) => value !== undefined))
    ) {
      evidenceIssues.push("EXPECTED_MARKET_METRIC_MISMATCH")
    }
    if (
      expected.requireDirectionalExa === true &&
      !externalSources.some(
        (source) => source.provider === "EXA" && source.relevance !== "NEUTRAL",
      )
    ) {
      evidenceIssues.push("DIRECTIONAL_EXA_EVIDENCE_MISSING")
    }
    const sourceIds = new Set(externalSources.map(({ sourceId }) => sourceId))
    for (const sourceId of expected.requiredExternalSourceIds ?? []) {
      if (!sourceIds.has(sourceId)) evidenceIssues.push("EXPECTED_SOURCE_MISSING")
    }
    for (const sourceId of expected.forbiddenExternalSourceIds ?? []) {
      if (sourceIds.has(sourceId)) evidenceIssues.push("FORBIDDEN_SOURCE_RETAINED")
    }
    const sourceRelevances = new Set(
      externalSources.map(({ relevance }) => relevance),
    )
    for (
      const relevance of expected.requiredExternalSourceRelevances ?? []
    ) {
      if (!sourceRelevances.has(relevance)) {
        evidenceIssues.push("EXPECTED_RELEVANCE_MISSING")
      }
    }
    const canonicalExternalSources = externalSources.flatMap((source) =>
      source.provider === "EXA"
        ? [{ ...source, canonicalUrl: canonicalExternalUrl(source.url) }]
        : [],
    )
    const canonicalUrls = canonicalExternalSources.map(
      ({ canonicalUrl }) => canonicalUrl,
    )
    const canonicalUrlSet = new Set(canonicalUrls)
    for (const sourceUrl of expected.requiredExternalSourceUrls ?? []) {
      if (!canonicalUrlSet.has(canonicalExternalUrl(sourceUrl))) {
        evidenceIssues.push("EXPECTED_SOURCE_MISSING")
      }
    }
    for (const required of expected.requiredExternalSources ?? []) {
      const matchingSources = canonicalExternalSources.filter(
        ({ canonicalUrl }) =>
          canonicalUrl === canonicalExternalUrl(required.url),
      )
      if (matchingSources.length === 0) {
        evidenceIssues.push("EXPECTED_SOURCE_MISSING")
      } else if (
        !matchingSources.some(({ relevance }) =>
          relevance === required.relevance
        )
      ) {
        evidenceIssues.push("EXPECTED_RELEVANCE_MISSING")
      } else if (
        !matchingSources.some((source) =>
          source.relevance === required.relevance &&
          (required.publishedAt === undefined ||
            source.publishedAt === required.publishedAt) &&
          (required.retrievedAtMinimum === undefined ||
            Date.parse(source.retrievedAt) >=
              Date.parse(required.retrievedAtMinimum)) &&
          (required.retrievedAtMaximum === undefined ||
            Date.parse(source.retrievedAt) <=
              Date.parse(required.retrievedAtMaximum))
        )
      ) {
        evidenceIssues.push("EXPECTED_SOURCE_TIMESTAMP_MISMATCH")
      }
    }
    if (new Set(canonicalUrls).size !== canonicalUrls.length) {
      evidenceIssues.push("DUPLICATE_EXTERNAL_SOURCE")
    }
    if (
      expected.requireMaterialConflict === true &&
      report.analysis.conflicts.length === 0
    ) {
      evidenceIssues.push("MATERIAL_CONFLICT_NOT_RETAINED")
    }
    for (const [field, expectedValue] of Object.entries(
      expected.expectedAccountChecks ?? {},
    )) {
      if (
        !isDeepStrictEqual(
          report.analysis.accountChecks[
            field as keyof typeof report.analysis.accountChecks
          ],
          expectedValue,
        )
      ) {
        evidenceIssues.push("EXPECTED_ACCOUNT_STATE_MISMATCH")
      }
    }
    if (
      expected.expectedAccountObservedAt !== undefined &&
      report.analysis.accountChecks.observedAt !==
        expected.expectedAccountObservedAt
    ) {
      evidenceIssues.push("EXPECTED_SNAPSHOT_TIME_MISMATCH")
    }
    if (
      expected.expectedMarketSignal !== undefined &&
      report.analysis.marketRegime.signal !== expected.expectedMarketSignal
    ) {
      evidenceIssues.push("EXPECTED_MARKET_METRIC_MISMATCH")
    }
    if (expected.expectedSnapshotObservedAt !== undefined) {
      if (
        report.analysis.marketRegime.observedAt !==
          expected.expectedSnapshotObservedAt ||
        (report.analysis.candidateEvaluation !== undefined &&
          report.analysis.candidateEvaluation.observedAt !==
            expected.expectedSnapshotObservedAt)
      ) {
        evidenceIssues.push("EXPECTED_SNAPSHOT_TIME_MISMATCH")
      }
    }
    if (expected.expectedProposalCandidate !== undefined) {
      if (
        report.result.outcome !== "PROPOSE_TRADE" ||
        !isDeepStrictEqual(
          report.result.candidate,
          expected.expectedProposalCandidate,
        )
      ) {
        evidenceIssues.push("EXPECTED_CANDIDATE_MISMATCH")
      }
    }
    if (expected.expectedCandidateEvaluation !== undefined) {
      const candidateEvaluation = report.analysis.candidateEvaluation
      const actual = candidateEvaluation === undefined
        ? undefined
        : {
            dte: candidateEvaluation.dte,
            legs: [...candidateEvaluation.legs].sort((left, right) =>
              left.role.localeCompare(right.role)
            ),
          }
      const expectedEvaluation = {
        dte: expected.expectedCandidateEvaluation.dte,
        legs: [...expected.expectedCandidateEvaluation.legs].sort((left, right) =>
          left.role.localeCompare(right.role)
        ),
      }
      if (!isDeepStrictEqual(actual, expectedEvaluation)) {
        evidenceIssues.push("EXPECTED_CANDIDATE_MISMATCH")
      }
    }
    for (const [metric, expectedValue] of Object.entries(
      expected.expectedMarketRegime ?? {},
    )) {
      const actualValue = report.analysis.marketRegime[metric as keyof typeof report.analysis.marketRegime]
      if (
        typeof actualValue !== "number" ||
        Math.abs(actualValue - expectedValue) > 0.0005
      ) {
        evidenceIssues.push("EXPECTED_MARKET_METRIC_MISMATCH")
      }
    }
  }

  return researchBehaviorEvaluationV1Schema.parse({
    evaluationVersion: RESEARCH_BEHAVIOR_EVALUATION_VERSION,
    scenarioId,
    dimensions: {
      contractCompliance: dimension(contractIssues),
      decisionBehavior: dimension(decisionIssues, report !== undefined),
      authorityBoundary: dimension(authorityIssues),
      toolDiscipline: dimension(toolIssues),
      evidenceDiscipline: dimension(evidenceIssues, report !== undefined),
    },
    metrics: {
      toolCallCount: toolCalls.length,
      alpacaCallCount,
      exaCallCount,
      fmpCallCount,
      externalSourceCount: externalSources.length,
    },
  })
}
