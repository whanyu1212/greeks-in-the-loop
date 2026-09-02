import { isAbsolute, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"

import { NO_ACTION_REASON_CODES } from "../contracts/research-decision-v3.js"
import { canonicalExternalUrl } from "../shared/canonical-external-url.js"
import {
  researchReportV6Schema,
  type ResearchReportV6,
} from "../contracts/research-report-v6.js"
import {
  researchReportV7Schema,
  type ResearchReportV7,
} from "../contracts/research-report-v7.js"
import {
  RESEARCH_MAX_EXA_CALLS,
  RESEARCH_MAX_FMP_CALLS,
  RESEARCH_MAX_TOOL_CALLS,
} from "../research/agent.js"

// Stamped onto every evaluation and persisted by `research:eval:live`. Bump it
// when grader semantics change, so stored artifacts stay attributable to the
// revision that produced them.
export const RESEARCH_BEHAVIOR_EVALUATION_VERSION = "3.1.0" as const

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

type ResearchBehaviorDimension = Readonly<{
  status: "PASS" | "FAIL" | "NOT_APPLICABLE"
  issueCodes: readonly ResearchBehaviorIssueCode[]
}>

export type ResearchBehaviorEvaluationV1 = Readonly<{
  evaluationVersion: typeof RESEARCH_BEHAVIOR_EVALUATION_VERSION
  scenarioId: string
  dimensions: Readonly<{
    contractCompliance: ResearchBehaviorDimension
    decisionBehavior: ResearchBehaviorDimension
    authorityBoundary: ResearchBehaviorDimension
    toolDiscipline: ResearchBehaviorDimension
    evidenceDiscipline: ResearchBehaviorDimension
  }>
  metrics: Readonly<{
    toolCallCount: number
    alpacaCallCount: number
    exaCallCount: number
    fmpCallCount: number
    externalSourceCount: number
  }>
}>

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
  outcome?: ResearchReportV6["result"]["outcome"]
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
    ResearchReportV6["analysis"]["accountChecks"],
    | "accountStatus"
    | "optionsTradingApproved"
    | "conflictingStrategyExposure"
  >>>
  expectedMarketSignal?: ResearchReportV6["analysis"]["marketRegimes"][number]["signal"]
  expectedProposalCandidate?:
    | Extract<
      ResearchReportV6["result"],
      { outcome: "PROPOSE_TRADES" }
    >["proposals"][number]["candidate"]
    | Extract<
      ResearchReportV7["result"],
      { outcome: "PROPOSE_TRADES" }
    >["proposals"][number]["candidate"]
  expectedCandidateEvaluation?:
    | Readonly<{
      dte: number
      legs: ResearchReportV6["analysis"]["candidateEvaluations"][number]["legs"]
    }>
    | Readonly<{
      legs: ResearchReportV7["analysis"]["candidateEvaluations"][number]["legs"]
    }>
  expectedSymbolIndicators?: readonly Readonly<
    NonNullable<ResearchReportV6["analysis"]["symbolIndicators"]>[number]
  >[]
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

const indicatorMetrics = [
  "return5d",
  "return20d",
  "realizedVolatility20",
  "completedSessionVolumeRatio20",
  "atrPercent20",
  "ewmaRealizedVolatility20",
  "sma20Slope5d",
  "completedSessionDollarVolumeRatio20",
  "rangePosition20",
] as const

const dimension = (
  issueCodes: readonly ResearchBehaviorIssueCode[],
  applicable = true,
) => ({
  status: applicable ? (issueCodes.length === 0 ? "PASS" : "FAIL") : "NOT_APPLICABLE",
  issueCodes: uniqueSorted(issueCodes),
} as const)

const productionToolName = (name: string) => {
  switch (name) {
    case "alpaca_get_account":
      return "alpaca_get_account_info"
    case "alpaca_get_account_configurations":
      return "alpaca_get_account_config"
    case "fmp_get_economic_calendar":
      return "fmp_economics"
    case "exa_search":
      return "exa_web_search_exa"
    default:
      return name
  }
}

const toolMatches = (name: string, pattern: string) => {
  const actual = productionToolName(name)
  const expected = productionToolName(pattern)
  return expected.endsWith("*")
    ? actual.startsWith(expected.slice(0, -1))
    : actual === expected
}

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

const parseReport = (rawResponse: string) => {
  let input: unknown
  try {
    input = JSON.parse(rawResponse)
  } catch {
    return { success: false as const, issue: "MALFORMED_JSON" as const }
  }
  const current = researchReportV7Schema.safeParse(input)
  if (current.success) return { success: true as const, report: current.data }
  const fixture = researchReportV6Schema.safeParse(input)
  return fixture.success
    ? { success: true as const, report: fixture.data }
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
    const actualValue = (key: string, expected: unknown) => {
      if (key === "symbol") {
        return actual.symbol ?? actual.symbols ?? actual.underlying_symbol ??
          actual.underlying_symbols
      }
      if (key === "symbols" && Array.isArray(expected) && typeof actual.symbols === "string") {
        return actual.symbols.split(",")
      }
      if (key === "symbols" && typeof expected === "string") {
        return actual.symbols ?? actual.symbol
      }
      if (key === "underlying_symbol") {
        return actual.underlying_symbol ?? actual.symbol
      }
      if (key === "underlying_symbols") {
        return actual.underlying_symbols ?? actual.symbol
      }
      return actual[key]
    }
    return Object.entries(expectedInput).every(([key, value]) =>
      isDeepStrictEqual(actualValue(key, value), value)
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
    const primaryProposal = report.result.outcome === "PROPOSE_TRADES"
      ? report.result.proposals[0]
      : undefined
    const marketSymbol =
      primaryProposal?.candidate.underlying ??
      report.analysis.optionUniverse?.candidates[0]?.underlying ??
      report.analysis.symbolIndicators?.[0]?.underlying
    const hasCompletedBars = (input: Readonly<Record<string, unknown>>) =>
      completedToolCalls.some((call) =>
        call.name === "alpaca_get_stock_bars" &&
        toolInputMatches(call.input, input)
      )
    const completedUnderlyingSnapshot = marketSymbol !== undefined &&
      hasCompletedBars({
        symbols: marketSymbol,
        timeframe: "1Day",
        adjustment: "all",
        feed: "iex",
      }) &&
      hasCompletedBars({ symbols: marketSymbol, timeframe: "1Min", feed: "iex" })
    const marketRegime = report.analysis.marketRegimes[0]
    if (
      marketRegime !== undefined &&
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
    if (expected.expectedSymbolIndicators !== undefined) {
      const retainedIndicators = new Map(
        report.analysis.symbolIndicators?.map((indicator) => [
          indicator.underlying,
          indicator,
        ]),
      )
      const indicatorsMatch =
        retainedIndicators.size === expected.expectedSymbolIndicators.length &&
        expected.expectedSymbolIndicators.every((expectedIndicator) => {
          const retained = retainedIndicators.get(expectedIndicator.underlying)
          return retained !== undefined &&
            retained.throughSessionDate === expectedIndicator.throughSessionDate &&
            retained.relativeStrengthRank20d ===
              expectedIndicator.relativeStrengthRank20d &&
            indicatorMetrics.every((metric) => {
              const retainedValue = retained[metric]
              const expectedValue = expectedIndicator[metric]
              return retainedValue !== undefined &&
                expectedValue !== undefined &&
                Math.abs(retainedValue - expectedValue) <= 0.0001
            })
        })
      if (!indicatorsMatch) {
        evidenceIssues.push("EXPECTED_MARKET_METRIC_MISMATCH")
      }
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
      marketRegime?.signal !== expected.expectedMarketSignal
    ) {
      evidenceIssues.push("EXPECTED_MARKET_METRIC_MISMATCH")
    }
    if (expected.expectedSnapshotObservedAt !== undefined) {
      if (
        marketRegime?.observedAt !==
          expected.expectedSnapshotObservedAt ||
        report.analysis.candidateEvaluations.some(
          ({ observedAt }) => observedAt !==
            expected.expectedSnapshotObservedAt)
      ) {
        evidenceIssues.push("EXPECTED_SNAPSHOT_TIME_MISMATCH")
      }
    }
    if (expected.expectedProposalCandidate !== undefined) {
      if (
        primaryProposal === undefined ||
        !isDeepStrictEqual(
          primaryProposal.candidate,
          expected.expectedProposalCandidate,
        )
      ) {
        evidenceIssues.push("EXPECTED_CANDIDATE_MISMATCH")
      }
    }
    if (expected.expectedCandidateEvaluation !== undefined) {
      const candidateEvaluation = report.analysis.candidateEvaluations[0]
      const expectsV6 = "dte" in expected.expectedCandidateEvaluation
      const actual = candidateEvaluation === undefined ||
          expectsV6 !== ("dte" in candidateEvaluation)
        ? undefined
        : expectsV6 && "dte" in candidateEvaluation
        ? {
            dte: candidateEvaluation.dte,
            legs: [...candidateEvaluation.legs].sort((left, right) =>
              left.role.localeCompare(right.role)
            ),
          }
        : {
            legs: [...candidateEvaluation.legs].sort((left, right) =>
              left.contractSymbol.localeCompare(right.contractSymbol)
            ),
          }
      const expectedEvaluation = expectsV6
        ? {
            dte: expected.expectedCandidateEvaluation.dte,
            legs: [...expected.expectedCandidateEvaluation.legs].sort((left, right) =>
              "role" in left && "role" in right
                ? left.role.localeCompare(right.role)
                : left.contractSymbol.localeCompare(right.contractSymbol)
            ),
          }
        : {
            legs: [...expected.expectedCandidateEvaluation.legs].sort((left, right) =>
              left.contractSymbol.localeCompare(right.contractSymbol)
            ),
          }
      if (!isDeepStrictEqual(actual, expectedEvaluation)) {
        evidenceIssues.push("EXPECTED_CANDIDATE_MISMATCH")
      }
    }
    for (const [metric, expectedValue] of Object.entries(
      expected.expectedMarketRegime ?? {},
    )) {
      const actualValue = marketRegime?.[
        metric as keyof NonNullable<typeof marketRegime>
      ]
      if (
        typeof actualValue !== "number" ||
        Math.abs(actualValue - expectedValue) > 0.0005
      ) {
        evidenceIssues.push("EXPECTED_MARKET_METRIC_MISMATCH")
      }
    }
  }

  return {
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
  }
}
