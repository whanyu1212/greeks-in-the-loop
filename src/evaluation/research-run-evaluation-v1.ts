import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import { preliminaryResearchV1Schema } from "../contracts/preliminary-research-v1.js"
import {
  LEGACY_STRATEGY_VERSION,
  STRATEGY_VERSION,
  researchDecisionV1Schema,
  validateResearchDecisionV1,
} from "../contracts/research-decision-v1.js"
import { researchReportV2Schema } from "../contracts/research-report-v2.js"
import { tradeIntentV1Schema } from "../contracts/trade-intent-v1.js"
import {
  SUPPORTED_RESEARCH_RUN_VERSIONS,
  type ResearchRunV1,
} from "../research/research-artifact.js"
import {
  RESEARCH_INVOCATION_PROVENANCE_BY_VERSION,
  researchInvocationV1Schema,
} from "../research/research-invocation-v1.js"
import {
  ALPACA_OPTION_QUOTE_FRESHNESS_NANOSECONDS,
  ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE,
} from "../market-data/alpaca-option-quotes.js"
import {
  MAX_TERMINAL_REJECTION_DETAILS,
  proposalAccountChecksAreFresh,
  PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT,
  proposalHistoryIssuePath,
  proposalMarketRegimeIsFresh,
  PROPOSAL_QUOTE_SNAPSHOT_REF,
} from "../research/research-cycle.js"
import {
  DRY_RUN_ANYTIME_RESEARCH_MODE,
  DRY_RUN_ANYTIME_SHADOW_MODE,
  newYorkDate,
  newYorkLocalTime,
  researchEligibilityV1Schema,
  TRADE_INTENT_START_GRACE_MS,
  TRADE_INTENT_WINDOW_DURATION_MS,
} from "../scheduling/research-eligibility.js"
import {
  floorNanosecondsToIsoMilliseconds,
  parseRfc3339Nanoseconds,
} from "../shared/value-normalization.js"

export const RESEARCH_RUN_EVALUATION_VERSION = "1.0.0" as const

const INVOCATION_VERSION_BY_RUN_VERSION = {
  "1.0.0": undefined,
  "1.1.0": undefined,
  "1.2.0": "1.0.0",
  "1.3.0": "1.1.0",
} as const satisfies Record<
  (typeof SUPPORTED_RESEARCH_RUN_VERSIONS)[number],
  keyof typeof RESEARCH_INVOCATION_PROVENANCE_BY_VERSION | undefined
>

export const RESEARCH_EVALUATION_ISSUE_CODES = [
  "RUN_VERSION_INVALID",
  "RUN_METADATA_INVALID",
  "REPORT_CONTRACT_INVALID",
  "RESEARCH_REPORT_MISSING",
  "OUTCOME_CONTRACT_INVALID",
  "REPORT_RESULT_MISMATCH",
  "OUTCOME_RECORD_MISMATCH",
  "CYCLE_TIME_RANGE_INVALID",
  "REPORT_AS_OF_OUTSIDE_CYCLE",
  "SOURCE_RETRIEVAL_OUTSIDE_CYCLE",
  "SNAPSHOT_RETRIEVAL_OUTSIDE_CYCLE",
  "INTENT_EVALUATION_OUTSIDE_CYCLE",
  "REPORT_AS_OF_AFTER_INTENT",
  "ACCOUNT_CHECKS_STALE_AT_INTENT",
  "MARKET_REGIME_STALE_AT_INTENT",
  "INTRADAY_BAR_COUNT_MISMATCH",
  "PRELIMINARY_SESSION_CONTEXT_MISSING",
  "PRELIMINARY_TARGET_SESSION_MISMATCH",
  "PRELIMINARY_OBSERVATION_AFTER_CYCLE",
  "DUPLICATE_CLAIM_ID",
  "NO_ACTION_SOURCED_EVIDENCE",
  "UNGROUNDED_INFERENCE",
  "UNKNOWN_SNAPSHOT_REFERENCE",
  "DUPLICATE_SNAPSHOT_REFERENCE",
  "UNEXPECTED_SNAPSHOT_REFERENCE",
  "SNAPSHOT_FROM_FUTURE",
  "STALE_SNAPSHOT",
  "QUOTE_SNAPSHOT_PROVENANCE_INVALID",
  "QUOTE_SNAPSHOT_METADATA_MISMATCH",
  "CANDIDATE_IDENTITY_MISMATCH",
  "CANDIDATE_DTE_MISMATCH",
  "OPEN_INTEREST_HISTORY_INVALID",
  "DRY_RUN_ELIGIBILITY_CONTEXT_INVALID",
  "INELIGIBLE_CYCLE_DERIVED_INTENT",
  "INTENT_ELIGIBILITY_CONTEXT_INVALID",
  "INTENT_ELIGIBILITY_CONTEXT_MISSING",
  "INTENT_OUTSIDE_RETAINED_TRADE_WINDOW",
  "INTENT_WITHOUT_VALIDATED_PROPOSAL",
] as const

const issueCodeSchema = z.enum(RESEARCH_EVALUATION_ISSUE_CODES)
const statusSchema = z.enum(["PASS", "FAIL", "NOT_APPLICABLE"])
const dimensionSchema = z
  .object({
    status: statusSchema,
    issueCodes: z.array(issueCodeSchema),
  })
  .strict()

export const researchRunEvaluationV1Schema = z
  .object({
    evaluationVersion: z.literal(RESEARCH_RUN_EVALUATION_VERSION),
    cycleId: z.string().min(1).max(128),
    terminalEventId: z.string().min(1).max(128),
    outcomeStatus: z.enum([
      "PRELIMINARY_RESEARCH_RETAINED",
      "VALIDATED_NO_ACTION",
      "DECISION_REJECTED",
      "INTENT_DERIVATION_REJECTED",
      "INTENT_DERIVED",
    ]),
    versions: z
      .object({
        runVersion: z.string().min(1).max(32),
        reportVersion: z.string().min(1).max(32).optional(),
        contractVersion: z.string().min(1).max(32).optional(),
        strategyVersion: z.string().min(1).max(32).optional(),
      })
      .strict(),
    dimensions: z
      .object({
        contractCompliance: dimensionSchema,
        temporalIntegrity: dimensionSchema,
        grounding: dimensionSchema,
        candidateIdentity: dimensionSchema,
        failClosedBehavior: dimensionSchema,
      })
      .strict(),
    metrics: z
      .object({
        sourcedFactCount: z.number().int().nonnegative(),
        inferenceCount: z.number().int().nonnegative(),
        groundedInferenceCount: z.number().int().nonnegative(),
        snapshotReferenceCount: z.number().int().nonnegative(),
        exaSourceCount: z.number().int().nonnegative(),
        fmpSourceCount: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()

export type ResearchRunEvaluationV1 = Readonly<
  z.infer<typeof researchRunEvaluationV1Schema>
>
type EvaluationIssueCode = (typeof RESEARCH_EVALUATION_ISSUE_CODES)[number]

const uniqueSorted = (
  issueCodes: readonly EvaluationIssueCode[],
): EvaluationIssueCode[] => [...new Set(issueCodes)].sort()

const dimension = (
  issueCodes: readonly EvaluationIssueCode[],
  applicable = true,
) => ({
  status: applicable ? (issueCodes.length === 0 ? "PASS" : "FAIL") : "NOT_APPLICABLE",
  issueCodes: uniqueSorted(issueCodes),
} as const)

const timestampWithin = (value: string, start: number, end: number) => {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end
}

type CandidateIdentity = Readonly<{
  direction: "BULLISH" | "BEARISH"
  structure: "BULL_CALL_SPREAD" | "BEAR_PUT_SPREAD"
  expiration: string
  longContractSymbol: string
  shortContractSymbol: string
}>

type EvaluableEvidenceClaim =
  | Readonly<{ kind: "SOURCED_FACT"; claimId: string }>
  | Readonly<{
      kind: "INFERENCE"
      claimId: string
      basedOn: readonly string[]
    }>

const isEvaluableEvidenceClaim = (
  claim: unknown,
): claim is EvaluableEvidenceClaim => {
  if (typeof claim !== "object" || claim === null) return false
  const candidate = claim as Record<string, unknown>
  if (typeof candidate.claimId !== "string") return false
  if (candidate.kind === "SOURCED_FACT") return true
  return (
    candidate.kind === "INFERENCE" &&
    Array.isArray(candidate.basedOn) &&
    candidate.basedOn.every((claimId) => typeof claimId === "string")
  )
}

const retainedTradeWindowContextIsValid = (
  eligibility: NonNullable<ResearchRunV1["initialEligibility"]>,
  cycle: ResearchRunV1["cycle"],
  strategyVersion: string | undefined,
) => {
  const window = eligibility.tradeIntentWindow
  if (
    !eligibility.tradeIntentEligible ||
    window === undefined ||
    eligibility.sessionOpen === undefined ||
    eligibility.sessionClose === undefined
  ) {
    return false
  }
  const eligibilityEvaluatedAt = Date.parse(eligibility.evaluatedAt)
  const cycleStartedAt = Date.parse(cycle.startedAt)
  const slotStartedAt = Date.parse(window.slotStartedAt)
  const deadline = Date.parse(window.deadline)
  const sessionOpen = Date.parse(eligibility.sessionOpen)
  const sessionClose = Date.parse(eligibility.sessionClose)
  const sessionDate = eligibility.sessionDate
  if (eligibility.researchMode === DRY_RUN_ANYTIME_SHADOW_MODE) {
    return (
      eligibility.researchEligible &&
      eligibility.tradeIntentEligible &&
      sessionDate === cycle.sessionDate &&
      eligibility.reason === undefined &&
      Number.isFinite(eligibilityEvaluatedAt) &&
      Number.isFinite(cycleStartedAt) &&
      Number.isFinite(slotStartedAt) &&
      Number.isFinite(deadline) &&
      Number.isFinite(sessionOpen) &&
      sessionOpen < sessionClose &&
      newYorkDate(new Date(eligibilityEvaluatedAt)) === sessionDate &&
      slotStartedAt === eligibilityEvaluatedAt &&
      eligibilityEvaluatedAt <= cycleStartedAt &&
      cycleStartedAt < deadline
    )
  }
  const slotDate = new Date(slotStartedAt)
  const tradeIntentTiming =
    strategyVersion === LEGACY_STRATEGY_VERSION
      ? {
          startGraceMs: 2 * 60 * 1_000,
          windowDurationMs: 5 * 60 * 1_000,
        }
      : strategyVersion === STRATEGY_VERSION
        ? {
            startGraceMs: TRADE_INTENT_START_GRACE_MS,
            windowDurationMs: TRADE_INTENT_WINDOW_DURATION_MS,
          }
        : undefined
  const slotIsQuarterHour =
    Number.isFinite(slotStartedAt) &&
    slotDate.getUTCMinutes() % 15 === 0 &&
    slotDate.getUTCSeconds() === 0 &&
    slotDate.getUTCMilliseconds() === 0
  const entryCutoff =
    sessionDate === undefined || !Number.isFinite(sessionClose)
      ? Number.NaN
      : Math.min(
          newYorkLocalTime(sessionDate, "15:00").getTime(),
          sessionClose - 60 * 60 * 1_000,
        )
  const slotMatchesSession =
    sessionDate !== undefined &&
    Number.isFinite(slotStartedAt) &&
    Number.isFinite(sessionOpen) &&
    Number.isFinite(sessionClose) &&
    newYorkDate(slotDate) === sessionDate &&
    newYorkDate(new Date(sessionOpen)) === sessionDate &&
    newYorkDate(new Date(sessionClose)) === sessionDate &&
    slotStartedAt >= newYorkLocalTime(sessionDate, "10:00").getTime() &&
    slotStartedAt < entryCutoff
  return (
    eligibility.researchEligible &&
    sessionDate === cycle.sessionDate &&
    eligibility.reason === undefined &&
    Number.isFinite(eligibilityEvaluatedAt) &&
    Number.isFinite(sessionOpen) &&
    sessionOpen < sessionClose &&
    eligibilityEvaluatedAt >= sessionOpen &&
    Number.isFinite(cycleStartedAt) &&
    Number.isFinite(deadline) &&
    slotIsQuarterHour &&
    slotMatchesSession &&
    tradeIntentTiming !== undefined &&
    deadline ===
      Math.min(slotStartedAt + tradeIntentTiming.windowDurationMs, entryCutoff) &&
    eligibilityEvaluatedAt >= slotStartedAt &&
    eligibilityEvaluatedAt - slotStartedAt < tradeIntentTiming.startGraceMs &&
    eligibilityEvaluatedAt <= cycleStartedAt &&
    cycleStartedAt < deadline
  )
}

const candidateKey = (candidate: CandidateIdentity) =>
  [
    candidate.direction,
    candidate.structure,
    candidate.expiration,
    candidate.longContractSymbol,
    candidate.shortContractSymbol,
  ].join("|")

const QUOTE_CONFIRMATION_REJECTION_REASONS = new Set([
  "QUOTE_REQUEST_FAILED",
  "QUOTE_RESPONSE_INVALID",
  "QUOTE_SYMBOL_MISSING",
  "QUOTE_PRICE_INVALID",
  "QUOTE_TIMESTAMP_INVALID",
  "QUOTE_FROM_FUTURE",
  "QUOTE_STALE",
  "EVALUATION_TIME_INVALID",
])

const INTENT_DERIVATION_REJECTION_REASONS = new Set([
  "STRIKE_PRECISION_UNSUPPORTED",
  "NON_POSITIVE_NET_DEBIT",
  "ENTRY_LIMIT_NOT_BELOW_WIDTH",
  "ARITHMETIC_OVERFLOW",
])

const hasCanonicalProposalQuoteProvenance = (
  snapshot: ResearchRunV1["evidenceSnapshots"][number],
) =>
  snapshot.snapshotRef === PROPOSAL_QUOTE_SNAPSHOT_REF &&
  snapshot.provider === "ALPACA" &&
  snapshot.source === ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE &&
  snapshot.temporalClass === "LIVE"

const hasAlpacaQuoteFreshnessBound = (
  snapshot: ResearchRunV1["evidenceSnapshots"][number],
) => {
  const retrievedAt = Date.parse(snapshot.retrievedAt)
  const freshUntil = Date.parse(snapshot.freshUntil)
  return (
    Number.isFinite(retrievedAt) &&
    Number.isFinite(freshUntil) &&
    freshUntil >= retrievedAt &&
    freshUntil <= retrievedAt + 60_000
  )
}

const isCanonicalProposalQuoteSnapshot = (
  snapshot: ResearchRunV1["evidenceSnapshots"][number],
) =>
  hasCanonicalProposalQuoteProvenance(snapshot) &&
  hasAlpacaQuoteFreshnessBound(snapshot)

/**
 * Evaluates one already-projected research run without I/O or wall-clock input.
 *
 * The output contains identifiers, issue codes, counts, and retained version
 * labels only. It deliberately excludes research prose, URLs, option symbols,
 * provider payloads, and credentials.
 */
export function evaluateResearchRunV1(
  run: ResearchRunV1,
): ResearchRunEvaluationV1 {
  const contractIssues: EvaluationIssueCode[] = []
  const temporalIssues: EvaluationIssueCode[] = []
  const groundingIssues: EvaluationIssueCode[] = []
  const candidateIssues: EvaluationIssueCode[] = []
  const failClosedIssues: EvaluationIssueCode[] = []

  if (!SUPPORTED_RESEARCH_RUN_VERSIONS.includes(run.runVersion)) {
    contractIssues.push("RUN_VERSION_INVALID")
  }

  const parsedInvocation = run.researchInvocation === undefined
    ? undefined
    : researchInvocationV1Schema.safeParse(run.researchInvocation)
  const parsedEligibility = run.initialEligibility === undefined
    ? undefined
    : researchEligibilityV1Schema.safeParse(run.initialEligibility)
  const expectedCycleMode = parsedEligibility?.success === true
    ? parsedEligibility.data.researchMode ?? "STANDARD"
    : "STANDARD"
  const invocation = parsedInvocation?.success === true
    ? parsedInvocation.data
    : undefined
  const expectedInvocationVersion =
    INVOCATION_VERSION_BY_RUN_VERSION[run.runVersion]
  const expectedInvocationProvenance = invocation === undefined
    ? undefined
    : RESEARCH_INVOCATION_PROVENANCE_BY_VERSION[invocation.invocationVersion]
  if (
    (expectedInvocationVersion !== undefined && invocation === undefined) ||
    (expectedInvocationVersion !== undefined && parsedEligibility?.success !== true) ||
    (expectedInvocationVersion === undefined && run.researchInvocation !== undefined) ||
    (parsedInvocation?.success === false) ||
    (invocation !== undefined &&
      (invocation.invocationVersion !== expectedInvocationVersion ||
        expectedInvocationProvenance === undefined ||
        invocation.agentName !== expectedInvocationProvenance.agentName ||
        invocation.cycleMode !== expectedCycleMode ||
        invocation.promptVersion !== expectedInvocationProvenance.promptVersion ||
        invocation.skillName !== expectedInvocationProvenance.skillName ||
        invocation.skillVersion !== expectedInvocationProvenance.skillVersion ||
        invocation.strategyVersion !== expectedInvocationProvenance.strategyVersion ||
        invocation.decisionContractVersion !==
          expectedInvocationProvenance.decisionContractVersion ||
        invocation.reportVersion !== expectedInvocationProvenance.reportVersion))
  ) {
    contractIssues.push("RUN_METADATA_INVALID")
  }
  if (
    expectedInvocationVersion !== undefined &&
    run.outcome.status === "DECISION_REJECTED" &&
    run.outcome.issues.some(
      (issue) =>
        issue.code === "SCHEMA_INVALID" &&
        issue.schemaCategory === undefined,
    )
  ) {
    contractIssues.push("RUN_METADATA_INVALID")
  }

  const initialEligibility = run.initialEligibility
  const isAnytimeDryRun =
    initialEligibility?.researchMode === DRY_RUN_ANYTIME_RESEARCH_MODE
  const isShadowAnytimeDryRun =
    initialEligibility?.researchMode === DRY_RUN_ANYTIME_SHADOW_MODE
  if (
    (isAnytimeDryRun &&
      (initialEligibility.researchEligible !== true ||
        initialEligibility.tradeIntentEligible !== false ||
        initialEligibility.tradeIntentWindow !== undefined ||
        initialEligibility.reason !== "DRY_RUN_RESEARCH_ONLY")) ||
    (!isAnytimeDryRun &&
      initialEligibility?.reason === "DRY_RUN_RESEARCH_ONLY") ||
    (isShadowAnytimeDryRun &&
      (initialEligibility?.researchEligible !== true ||
        initialEligibility.tradeIntentEligible !== true ||
        initialEligibility.tradeIntentWindow === undefined ||
        initialEligibility.reason !== undefined))
  ) {
    contractIssues.push("DRY_RUN_ELIGIBILITY_CONTEXT_INVALID")
  }

  const parsedReport =
    run.researchReport === undefined
      ? undefined
      : researchReportV2Schema.safeParse(run.researchReport)
  if (parsedReport?.success === false) {
    contractIssues.push("REPORT_CONTRACT_INVALID")
  }
  if (
    run.researchReport === undefined &&
    [
      "PRELIMINARY_RESEARCH_RETAINED",
      "VALIDATED_NO_ACTION",
      "INTENT_DERIVATION_REJECTED",
      "INTENT_DERIVED",
    ].includes(run.outcome.status)
  ) {
    contractIssues.push("RESEARCH_REPORT_MISSING")
  }
  const parsedPreliminaryResearch =
    run.preliminaryResearch === undefined
      ? undefined
      : preliminaryResearchV1Schema.safeParse(run.preliminaryResearch)
  if (parsedPreliminaryResearch?.success === false) {
    contractIssues.push("OUTCOME_CONTRACT_INVALID")
  }
  const parsedValidatedDecision =
    run.validatedDecision === undefined
      ? undefined
      : researchDecisionV1Schema.safeParse(run.validatedDecision)
  if (parsedValidatedDecision?.success === false) {
    contractIssues.push("OUTCOME_CONTRACT_INVALID")
  }

  const validReport =
    parsedReport?.success === true ? parsedReport.data : undefined
  const reportResult = validReport?.result
  const expectedStrategyVersionRejection =
    invocation !== undefined &&
    reportResult !== undefined &&
    invocation.strategyVersion !== reportResult.strategyVersion &&
    run.evidenceSnapshots.length === 0 &&
    run.outcome.status === "DECISION_REJECTED" &&
    isDeepStrictEqual(run.outcome.issues, [
      {
        code: "SCHEMA_INVALID",
        schemaCategory: "VALUE_NOT_ALLOWED",
        path: ["result", "strategyVersion"],
      },
    ])
  if (
    invocation !== undefined &&
    reportResult !== undefined &&
    ((invocation.strategyVersion !== reportResult.strategyVersion &&
      !expectedStrategyVersionRejection) ||
      invocation.decisionContractVersion !== reportResult.contractVersion ||
      invocation.reportVersion !== validReport?.reportVersion)
  ) {
    contractIssues.push("RUN_METADATA_INVALID")
  }
  const expectedCommonReportRejectionIssues = (() => {
    if (validReport === undefined) return undefined
    const cycleStart = Date.parse(run.cycle.startedAt)
    const cycleEnd = Date.parse(run.cycle.completedAt)
    const reportAsOf = Date.parse(validReport.analysis.asOf)
    if (
      !Number.isFinite(cycleStart) ||
      !Number.isFinite(cycleEnd) ||
      cycleStart > cycleEnd ||
      reportAsOf > cycleEnd
    ) {
      return [
        { code: "CONTEXT_INVALID" as const, path: ["analysis", "asOf"] },
      ]
    }
    const exaSources = validReport.analysis.externalContext.filter(
      ({ provider }) => provider === "EXA",
    )
    return exaSources.length > 0 &&
      !exaSources.some(({ retrievedAt }) =>
        timestampWithin(retrievedAt, cycleStart, cycleEnd),
      )
      ? [
          {
            code: "CONTEXT_INVALID" as const,
            path: ["analysis", "externalContext"],
          },
        ]
      : undefined
  })()
  const plausibleCommonReportRejectionIssues = (() => {
    if (
      validReport === undefined ||
      expectedCommonReportRejectionIssues !== undefined
    ) {
      return []
    }
    const cycleStart = Date.parse(run.cycle.startedAt)
    const cycleEnd = Date.parse(run.cycle.completedAt)
    const reportAsOf = Date.parse(validReport.analysis.asOf)
    if (
      !Number.isFinite(cycleStart) ||
      !Number.isFinite(cycleEnd) ||
      !Number.isFinite(reportAsOf)
    ) {
      return []
    }
    const plausible: Array<
      ReadonlyArray<
        Readonly<{ code: string; path: readonly (string | number)[] }>
      >
    > = []
    if (reportAsOf > cycleStart && reportAsOf <= cycleEnd) {
      plausible.push([
        { code: "CONTEXT_INVALID", path: ["analysis", "asOf"] },
      ])
    }
    const exaSources = validReport.analysis.externalContext.filter(
      ({ provider }) => provider === "EXA",
    )
    if (
      exaSources.length > 0 &&
      !exaSources.some(
        ({ retrievedAt }) =>
          Date.parse(retrievedAt) >= cycleStart &&
          Date.parse(retrievedAt) <= Math.max(cycleStart, reportAsOf),
      )
    ) {
      plausible.push([
        { code: "CONTEXT_INVALID", path: ["analysis", "externalContext"] },
      ])
    }
    return plausible
  })()
  const rejectedOutcomeIssues =
    run.outcome.status === "DECISION_REJECTED"
      ? run.outcome.issues
      : undefined
  const retainedCommonReportRejectionMatches =
    rejectedOutcomeIssues !== undefined &&
    (expectedCommonReportRejectionIssues !== undefined
      ? isDeepStrictEqual(
          rejectedOutcomeIssues,
          expectedCommonReportRejectionIssues,
        )
      : plausibleCommonReportRejectionIssues.some((issues) =>
          isDeepStrictEqual(rejectedOutcomeIssues, issues),
        ))
  const retainedProposalEvaluationLowerBound = (() => {
    if (validReport === undefined || run.initialEligibility === undefined) {
      return undefined
    }
    const eligibilityEvaluatedAt = Date.parse(
      run.initialEligibility.evaluatedAt,
    )
    const reportAsOf = Date.parse(validReport.analysis.asOf)
    const cycleStart = Date.parse(run.cycle.startedAt)
    const cycleEnd = Date.parse(run.cycle.completedAt)
    const earliestInCycleExaRetrieval = Math.min(
      ...validReport.analysis.externalContext
        .filter(({ provider }) => provider === "EXA")
        .map(({ retrievedAt }) => Date.parse(retrievedAt))
        .filter(
          (retrievedAt) =>
            Number.isFinite(retrievedAt) &&
            retrievedAt >= cycleStart &&
            retrievedAt <= cycleEnd,
        ),
    )
    return Number.isFinite(eligibilityEvaluatedAt) && Number.isFinite(reportAsOf)
      ? new Date(
          Math.max(
            eligibilityEvaluatedAt,
            reportAsOf,
            Number.isFinite(earliestInCycleExaRetrieval)
              ? earliestInCycleExaRetrieval
              : Number.NEGATIVE_INFINITY,
          ),
        ).toISOString()
      : undefined
  })()
  const retainedResult = run.preliminaryResearch ?? run.validatedDecision
  const validRetainedResult =
    parsedPreliminaryResearch?.success === true
      ? parsedPreliminaryResearch.data
      : parsedValidatedDecision?.success === true
        ? parsedValidatedDecision.data
        : undefined
  const versionedResult = reportResult ?? validRetainedResult
  const hasRetainedEligibleTradeWindow =
    run.initialEligibility !== undefined &&
    retainedTradeWindowContextIsValid(
      run.initialEligibility,
      run.cycle,
      versionedResult?.strategyVersion,
    )
  const quoteConfirmationRejection =
    run.outcome.status === "INTENT_DERIVATION_REJECTED" &&
    run.outcome.reasons.length === 1 &&
    run.outcome.reasons.every((reason) =>
      QUOTE_CONFIRMATION_REJECTION_REASONS.has(reason),
    )
  const proposalPreflightValidation =
    run.outcome.status === "DECISION_REJECTED" &&
    !retainedCommonReportRejectionMatches &&
    reportResult?.outcome === "PROPOSE_TRADE"
      ? validateResearchDecisionV1(
          reportResult,
          PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT,
        )
      : undefined
  const expectedPreQuoteDecisionRejectionIssues = (() => {
    if (
      proposalPreflightValidation?.success !== true ||
      !hasRetainedEligibleTradeWindow ||
      validReport === undefined ||
      run.initialEligibility === undefined ||
      retainedProposalEvaluationLowerBound === undefined
    ) {
      return undefined
    }
    if (
      !proposalMarketRegimeIsFresh(
        validReport,
        retainedProposalEvaluationLowerBound,
      )
    ) {
      return [
        {
          code: "CONTEXT_INVALID" as const,
          path: ["analysis", "marketRegime", "observedAt"],
        },
      ]
    }
    if (
      !proposalAccountChecksAreFresh(
        validReport,
        retainedProposalEvaluationLowerBound,
      )
    ) {
      return [
        {
          code: "CONTEXT_INVALID" as const,
          path: ["analysis", "accountChecks", "observedAt"],
        },
      ]
    }
    const historyIssuePath = proposalHistoryIssuePath(
      validReport,
      run.initialEligibility,
    )
    return historyIssuePath === undefined
      ? undefined
      : [{ code: "CONTEXT_INVALID" as const, path: historyIssuePath }]
  })()
  const canonicalRetainedQuoteSnapshot =
    run.evidenceSnapshots.length === 1 &&
    run.evidenceSnapshots[0] !== undefined &&
    isCanonicalProposalQuoteSnapshot(run.evidenceSnapshots[0])
      ? run.evidenceSnapshots[0]
      : undefined
  const expectedSnapshotDecisionRejectionIssues = (() => {
    if (
      run.outcome.status !== "DECISION_REJECTED" ||
      canonicalRetainedQuoteSnapshot === undefined ||
      validReport === undefined ||
      reportResult?.outcome !== "PROPOSE_TRADE"
    ) {
      return undefined
    }
    const evaluatedAt = Date.parse(canonicalRetainedQuoteSnapshot.retrievedAt)
    const accountAge =
      evaluatedAt - Date.parse(validReport.analysis.accountChecks.observedAt)
    const marketAge =
      evaluatedAt - Date.parse(validReport.analysis.marketRegime.observedAt)
    if (marketAge < 0 || marketAge > 60_000) {
      return [
        {
          code: "CONTEXT_INVALID" as const,
          path: ["analysis", "marketRegime", "observedAt"],
        },
      ]
    }
    if (accountAge < 0 || accountAge > 5 * 60 * 1_000) {
      return [
        {
          code: "CONTEXT_INVALID" as const,
          path: ["analysis", "accountChecks", "observedAt"],
        },
      ]
    }
    const validation = validateResearchDecisionV1(reportResult, {
      evaluatedAt: canonicalRetainedQuoteSnapshot.retrievedAt,
      snapshots: {
        [PROPOSAL_QUOTE_SNAPSHOT_REF]: {
          provider: canonicalRetainedQuoteSnapshot.provider,
          source: canonicalRetainedQuoteSnapshot.source,
          retrievedAt: canonicalRetainedQuoteSnapshot.retrievedAt,
          freshUntil: canonicalRetainedQuoteSnapshot.freshUntil,
        },
      },
    })
    return validation.success ? undefined : validation.issues
  })()
  if (
    reportResult !== undefined &&
    retainedResult !== undefined &&
    !isDeepStrictEqual(reportResult, retainedResult)
  ) {
    contractIssues.push("REPORT_RESULT_MISMATCH")
  }

  switch (run.outcome.status) {
    case "PRELIMINARY_RESEARCH_RETAINED":
      if (
        !preliminaryResearchV1Schema.safeParse(run.outcome.research).success
      ) {
        contractIssues.push("OUTCOME_CONTRACT_INVALID")
      }
      if (
        run.preliminaryResearch === undefined ||
        !isDeepStrictEqual(run.outcome.research, run.preliminaryResearch) ||
        run.validatedDecision !== undefined
      ) {
        contractIssues.push("OUTCOME_RECORD_MISMATCH")
      }
      break
    case "VALIDATED_NO_ACTION":
      if (!researchDecisionV1Schema.safeParse(run.outcome.decision).success) {
        contractIssues.push("OUTCOME_CONTRACT_INVALID")
      }
      if (
        run.validatedDecision === undefined ||
        !isDeepStrictEqual(run.outcome.decision, run.validatedDecision) ||
        run.preliminaryResearch !== undefined
      ) {
        contractIssues.push("OUTCOME_RECORD_MISMATCH")
      }
      break
    case "INTENT_DERIVED":
      if (
        !researchDecisionV1Schema.safeParse(run.outcome.decision).success ||
        !tradeIntentV1Schema.safeParse(run.outcome.intent).success
      ) {
        contractIssues.push("OUTCOME_CONTRACT_INVALID")
      }
      if (
        run.validatedDecision === undefined ||
        !isDeepStrictEqual(run.outcome.decision, run.validatedDecision) ||
        run.preliminaryResearch !== undefined
      ) {
        contractIssues.push("OUTCOME_RECORD_MISMATCH")
      }
      break
    case "DECISION_REJECTED":
      const rejectedIssues = run.outcome.issues
      const rejectionIssuesMatch = (
        expected: readonly Readonly<{
          code: string
          path: readonly (string | number)[]
        }>[],
      ) =>
        isDeepStrictEqual(
          rejectedIssues,
          expected.slice(0, MAX_TERMINAL_REJECTION_DETAILS),
        )
      const parsedRejectedReport =
        parsedReport?.success === true ? parsedReport.data : undefined
      const parsedRejectedResult = parsedRejectedReport?.result
      const rejectedPreliminaryTargetSessionDate =
        parsedRejectedResult?.outcome === "PRELIMINARY_RESEARCH"
          ? parsedRejectedResult.targetSessionDate
          : undefined
      const preliminaryTargetSessionDateRejectionIssues = [
        { code: "CONTEXT_INVALID" as const, path: ["targetSessionDate"] },
      ]
      const preliminaryCouldBeRetained =
        !retainedCommonReportRejectionMatches &&
        parsedRejectedReport !== undefined &&
        parsedRejectedResult?.outcome === "PRELIMINARY_RESEARCH" &&
        run.initialEligibility?.researchEligible === true &&
        run.initialEligibility.sessionDate ===
          parsedRejectedResult.targetSessionDate &&
        run.cycle.sessionDate === parsedRejectedResult.targetSessionDate &&
        Date.parse(parsedRejectedReport.analysis.asOf) <=
          Date.parse(run.cycle.completedAt) &&
        parsedRejectedResult.evidence.every(
          (claim) =>
            claim.kind !== "SOURCED_FACT" ||
            Date.parse(claim.observedAt) <= Date.parse(run.cycle.completedAt),
        )
      const preliminaryFutureObservationIndex =
        parsedRejectedResult?.outcome === "PRELIMINARY_RESEARCH"
          ? parsedRejectedResult.evidence.findIndex(
              (claim) =>
                claim.kind === "SOURCED_FACT" &&
                Date.parse(claim.observedAt) >
                  Date.parse(run.cycle.completedAt),
            )
          : -1
      const expectedPreliminaryDecisionRejectionIssues =
        retainedCommonReportRejectionMatches ||
        parsedRejectedResult?.outcome !== "PRELIMINARY_RESEARCH"
          ? undefined
          : preliminaryFutureObservationIndex >= 0
            ? [
                {
                  code: "CONTEXT_INVALID" as const,
                  path: [
                    "evidence",
                    preliminaryFutureObservationIndex,
                    "observedAt",
                  ],
                },
              ]
            : run.cycle.sessionDate !== parsedRejectedResult.targetSessionDate
              ? [
                  {
                    code: "CONTEXT_INVALID" as const,
                    path: ["targetSessionDate"],
                  },
                ]
              : undefined
      const plausiblePreliminaryObservationRejectionIssues = (() => {
        if (
          retainedCommonReportRejectionMatches ||
          preliminaryFutureObservationIndex >= 0 ||
          parsedRejectedReport === undefined ||
          parsedRejectedResult?.outcome !== "PRELIMINARY_RESEARCH"
        ) {
          return []
        }
        const cycleStartedAt = Date.parse(run.cycle.startedAt)
        const completedAt = Date.parse(run.cycle.completedAt)
        const earliestInCycleExaRetrieval = Math.min(
          ...parsedRejectedReport.analysis.externalContext
            .filter(({ provider }) => provider === "EXA")
            .map(({ retrievedAt }) => Date.parse(retrievedAt))
            .filter(
              (retrievedAt) =>
                Number.isFinite(retrievedAt) &&
                retrievedAt >= cycleStartedAt &&
                retrievedAt <= completedAt,
            ),
        )
        const processingLowerBound = Math.max(
          cycleStartedAt,
          Date.parse(run.initialEligibility?.evaluatedAt ?? ""),
          Date.parse(parsedRejectedReport.analysis.asOf),
          Number.isFinite(earliestInCycleExaRetrieval)
            ? earliestInCycleExaRetrieval
            : Number.NEGATIVE_INFINITY,
        )
        if (
          !Number.isFinite(processingLowerBound) ||
          !Number.isFinite(completedAt)
        ) {
          return []
        }
        let priorObservation = processingLowerBound
        return parsedRejectedResult.evidence.flatMap((claim, index) => {
          if (claim.kind !== "SOURCED_FACT") return []
          const observedAt = Date.parse(claim.observedAt)
          const couldBeFirstFutureObservation =
            Number.isFinite(observedAt) &&
            observedAt > priorObservation &&
            observedAt <= completedAt
          priorObservation = Math.max(priorObservation, observedAt)
          return couldBeFirstFutureObservation
            ? [
                [
                  {
                    code: "CONTEXT_INVALID" as const,
                    path: ["evidence", index, "observedAt"],
                  },
                ],
              ]
            : []
        })
      })()
      const plausiblePreliminaryObservationRejectionMatches =
        plausiblePreliminaryObservationRejectionIssues.some((issues) =>
          rejectionIssuesMatch(issues),
        )
      const noActionValidation =
        !retainedCommonReportRejectionMatches &&
        parsedRejectedResult?.outcome === "NO_ACTION"
          ? validateResearchDecisionV1(parsedRejectedResult, {
              evaluatedAt: run.cycle.completedAt,
              snapshots: {},
            })
          : undefined
      const noActionCouldBeRetained = noActionValidation?.success === true
      const reportFreeRejectionIssuesMatch =
        parsedRejectedReport !== undefined ||
        isDeepStrictEqual(rejectedIssues, [
          { code: "MALFORMED_JSON", path: [] },
        ]) ||
        isDeepStrictEqual(rejectedIssues, [
          { code: "RESPONSE_TOO_LARGE", path: [] },
        ]) ||
        (rejectedIssues.length > 0 &&
          rejectedIssues.length <= MAX_TERMINAL_REJECTION_DETAILS &&
          rejectedIssues.every(({ code }) => code === "SCHEMA_INVALID"))
      const plausibleLaterPreliminaryEligibilityRejection =
        rejectedPreliminaryTargetSessionDate !== undefined &&
        expectedPreliminaryDecisionRejectionIssues === undefined &&
        rejectionIssuesMatch(preliminaryTargetSessionDateRejectionIssues) &&
        (() => {
          const completedAt = Date.parse(run.cycle.completedAt)
          if (isAnytimeDryRun) {
            return (
              Number.isFinite(completedAt) &&
              run.cycle.sessionDate === rejectedPreliminaryTargetSessionDate &&
              newYorkDate(new Date(completedAt)) >
                rejectedPreliminaryTargetSessionDate
            )
          }

          const sessionClose = Date.parse(
            run.initialEligibility?.sessionClose ?? "",
          )
          return (
            !Number.isFinite(sessionClose) ||
            !Number.isFinite(completedAt) ||
            completedAt >= sessionClose
          )
        })()
      const plausibleLaterProposalRejectionIssues = (() => {
        if (
          proposalPreflightValidation?.success !== true ||
          !hasRetainedEligibleTradeWindow ||
          validReport === undefined
        ) {
          return []
        }
        const completedAt = Date.parse(run.cycle.completedAt)
        const deadline = Date.parse(
          run.initialEligibility?.tradeIntentWindow?.deadline ?? "",
        )
        const marketObservedAt = Date.parse(
          validReport.analysis.marketRegime.observedAt,
        )
        const accountObservedAt = Date.parse(
          validReport.analysis.accountChecks.observedAt,
        )
        if (
          !Number.isFinite(completedAt) ||
          !Number.isFinite(deadline) ||
          !Number.isFinite(marketObservedAt) ||
          !Number.isFinite(accountObservedAt)
        ) {
          return []
        }
        const latestHiddenEvaluation = Math.min(completedAt, deadline - 1)
        const plausible: Array<
          ReadonlyArray<
            Readonly<{ code: string; path: readonly (string | number)[] }>
          >
        > = []
        if (latestHiddenEvaluation > marketObservedAt + 60_000) {
          plausible.push([
            {
              code: "CONTEXT_INVALID",
              path: ["analysis", "marketRegime", "observedAt"],
            },
          ])
        }
        if (
          Math.min(latestHiddenEvaluation, marketObservedAt + 60_000) >
          accountObservedAt + 5 * 60_000
        ) {
          plausible.push([
            {
              code: "CONTEXT_INVALID",
              path: ["analysis", "accountChecks", "observedAt"],
            },
          ])
        }
        return plausible
      })()
      const proposalRejectionIssuesMatch =
        proposalPreflightValidation?.success !== true ||
        (hasRetainedEligibleTradeWindow &&
          (() => {
            const expectedPriority =
              expectedPreQuoteDecisionRejectionIssues === undefined
                ? 2
                : isDeepStrictEqual(
                      expectedPreQuoteDecisionRejectionIssues[0]?.path,
                      ["analysis", "marketRegime", "observedAt"],
                    )
                  ? 0
                  : isDeepStrictEqual(
                        expectedPreQuoteDecisionRejectionIssues[0]?.path,
                        ["analysis", "accountChecks", "observedAt"],
                      )
                    ? 1
                    : 2
            const possibleIssues = [
              ...(expectedPreQuoteDecisionRejectionIssues === undefined
                ? []
                : [expectedPreQuoteDecisionRejectionIssues]),
              ...plausibleLaterProposalRejectionIssues.filter((issues) => {
                const priority = isDeepStrictEqual(issues[0]?.path, [
                  "analysis",
                  "marketRegime",
                  "observedAt",
                ])
                  ? 0
                  : 1
                return priority <= expectedPriority
              }),
            ]
            return possibleIssues.some((issues) =>
              rejectionIssuesMatch(issues),
            )
          })())
      if (
        run.preliminaryResearch !== undefined ||
        run.validatedDecision !== undefined ||
        (!expectedStrategyVersionRejection &&
          ((run.evidenceSnapshots.length === 0 &&
            ((preliminaryCouldBeRetained &&
              !plausibleLaterPreliminaryEligibilityRejection &&
              !plausiblePreliminaryObservationRejectionMatches) ||
              noActionCouldBeRetained)) ||
            !reportFreeRejectionIssuesMatch ||
            (expectedCommonReportRejectionIssues !== undefined &&
              !rejectionIssuesMatch(expectedCommonReportRejectionIssues)) ||
            (retainedCommonReportRejectionMatches &&
              run.evidenceSnapshots.length > 0) ||
            (expectedPreliminaryDecisionRejectionIssues !== undefined &&
              !plausiblePreliminaryObservationRejectionMatches &&
              !rejectionIssuesMatch(expectedPreliminaryDecisionRejectionIssues)) ||
            (run.evidenceSnapshots.length === 0 &&
              noActionValidation?.success === false &&
              !rejectionIssuesMatch(noActionValidation.issues)) ||
            (proposalPreflightValidation?.success === false &&
              (run.evidenceSnapshots.length > 0 ||
                !rejectionIssuesMatch(proposalPreflightValidation.issues))) ||
            !proposalRejectionIssuesMatch ||
            (run.evidenceSnapshots.length > 0 &&
              (parsedReport?.success !== true ||
                parsedReport.data.result.outcome !== "PROPOSE_TRADE")) ||
            (canonicalRetainedQuoteSnapshot !== undefined &&
              (!hasRetainedEligibleTradeWindow ||
                expectedSnapshotDecisionRejectionIssues === undefined ||
                !rejectionIssuesMatch(expectedSnapshotDecisionRejectionIssues)))))
      ) {
        contractIssues.push("OUTCOME_RECORD_MISMATCH")
      }
      break
    case "INTENT_DERIVATION_REJECTED":
      const reasons = run.outcome.reasons
      const candidateUsesSubCentStrike =
        reportResult?.outcome === "PROPOSE_TRADE" &&
        [
          reportResult.candidate.longLeg.contractSymbol,
          reportResult.candidate.shortLeg.contractSymbol,
        ].some((symbol) => Number(symbol.slice(-8)) % 10 !== 0)
      const derivationRejected =
        reasons.length === 1 &&
        reasons.every((reason) =>
          INTENT_DERIVATION_REJECTION_REASONS.has(reason),
        ) &&
        (reasons[0] !== "STRIKE_PRECISION_UNSUPPORTED" ||
          candidateUsesSubCentStrike)
      const marketWindowRejected =
        reasons.length === 1 &&
        reasons.every((reason) => reason === "MARKET_WINDOW_INELIGIBLE")
      const hasCanonicalQuoteSnapshot =
        run.evidenceSnapshots.length === 1 &&
        run.evidenceSnapshots[0] !== undefined &&
        isCanonicalProposalQuoteSnapshot(run.evidenceSnapshots[0])
      const hasValidatedProposal =
        parsedValidatedDecision?.success === true &&
        parsedValidatedDecision.data.outcome === "PROPOSE_TRADE"
      const retainedWindowDeadline = Date.parse(
        run.initialEligibility?.tradeIntentWindow?.deadline ?? "",
      )
      const cycleCompletedAt = Date.parse(run.cycle.completedAt)
      const retainedTradeWindowCanExpireByCompletion =
        hasRetainedEligibleTradeWindow &&
        (!Number.isFinite(retainedWindowDeadline) ||
          !Number.isFinite(cycleCompletedAt) ||
          cycleCompletedAt >= retainedWindowDeadline)
      const postQuoteMarketWindowRejectionPlausible =
        hasCanonicalQuoteSnapshot && retainedTradeWindowCanExpireByCompletion
      const rejectionRecordsMatch =
        (quoteConfirmationRejection &&
          hasRetainedEligibleTradeWindow &&
          run.validatedDecision === undefined &&
          run.evidenceSnapshots.length === 0) ||
        (derivationRejected &&
          hasRetainedEligibleTradeWindow &&
          hasValidatedProposal &&
          hasCanonicalQuoteSnapshot) ||
        (marketWindowRejected &&
          run.validatedDecision === undefined &&
          ((run.evidenceSnapshots.length === 0 &&
            (!hasRetainedEligibleTradeWindow ||
              retainedTradeWindowCanExpireByCompletion)) ||
            postQuoteMarketWindowRejectionPlausible))
      if (
        (parsedReport?.success === true &&
          parsedReport.data.result.outcome !== "PROPOSE_TRADE") ||
        run.preliminaryResearch !== undefined ||
        !rejectionRecordsMatch
      ) {
        contractIssues.push("OUTCOME_RECORD_MISMATCH")
      }
      break
  }

  const cycleStart = Date.parse(run.cycle.startedAt)
  const cycleEnd = Date.parse(run.cycle.completedAt)
  const validCycleRange =
    Number.isFinite(cycleStart) &&
    Number.isFinite(cycleEnd) &&
    cycleStart <= cycleEnd
  if (!validCycleRange) {
    temporalIssues.push("CYCLE_TIME_RANGE_INVALID")
  } else {
    if (
      parsedReport?.success === true &&
      !timestampWithin(parsedReport.data.analysis.asOf, cycleStart, cycleEnd)
    ) {
      temporalIssues.push("REPORT_AS_OF_OUTSIDE_CYCLE")
    }
    if (
      parsedReport?.success === true &&
      parsedReport.data.analysis.externalContext.some(
        ({ retrievedAt }) => !timestampWithin(retrievedAt, cycleStart, cycleEnd),
      )
    ) {
      temporalIssues.push("SOURCE_RETRIEVAL_OUTSIDE_CYCLE")
    }
    if (
      run.evidenceSnapshots.some(
        ({ retrievedAt }) => !timestampWithin(retrievedAt, cycleStart, cycleEnd),
      )
    ) {
      temporalIssues.push("SNAPSHOT_RETRIEVAL_OUTSIDE_CYCLE")
    }
    if (
      run.outcome.status === "INTENT_DERIVED" &&
      !timestampWithin(run.outcome.intent.evaluatedAt, cycleStart, cycleEnd)
    ) {
      temporalIssues.push("INTENT_EVALUATION_OUTSIDE_CYCLE")
    }
  }
  const postQuoteRejectionEvaluatedAt =
    run.outcome.status === "INTENT_DERIVATION_REJECTED" &&
    run.evidenceSnapshots.length === 1 &&
    run.evidenceSnapshots[0] !== undefined &&
    isCanonicalProposalQuoteSnapshot(run.evidenceSnapshots[0]) &&
    run.outcome.reasons.length > 0 &&
    (run.outcome.reasons.every((reason) =>
      INTENT_DERIVATION_REJECTION_REASONS.has(reason),
    ) ||
      run.outcome.reasons.every(
        (reason) => reason === "MARKET_WINDOW_INELIGIBLE",
      ))
      ? run.evidenceSnapshots[0].retrievedAt
      : undefined
  const quoteConfirmationEvaluationLowerBound = (() => {
    return quoteConfirmationRejection
      ? retainedProposalEvaluationLowerBound
      : undefined
  })()
  const decisionRejectionEvaluatedAt =
    run.outcome.status === "DECISION_REJECTED"
      ? canonicalRetainedQuoteSnapshot?.retrievedAt
      : undefined
  const proposalEvaluatedAt =
    run.outcome.status === "INTENT_DERIVED"
      ? run.outcome.intent.evaluatedAt
      : postQuoteRejectionEvaluatedAt ??
        quoteConfirmationEvaluationLowerBound ??
        decisionRejectionEvaluatedAt
  if (proposalEvaluatedAt !== undefined && parsedReport?.success === true) {
    const evaluatedAt = Date.parse(proposalEvaluatedAt)
    const reportAsOf = Date.parse(parsedReport.data.analysis.asOf)
    const accountObservedAt = Date.parse(
      parsedReport.data.analysis.accountChecks.observedAt,
    )
    const marketObservedAt = Date.parse(
      parsedReport.data.analysis.marketRegime.observedAt,
    )
    if (reportAsOf > evaluatedAt) {
      temporalIssues.push("REPORT_AS_OF_AFTER_INTENT")
    }
    const accountAge = evaluatedAt - accountObservedAt
    if (accountAge < 0 || accountAge > 5 * 60 * 1_000) {
      temporalIssues.push("ACCOUNT_CHECKS_STALE_AT_INTENT")
    }
    const marketAge = evaluatedAt - marketObservedAt
    if (marketAge < 0 || marketAge > 60_000) {
      temporalIssues.push("MARKET_REGIME_STALE_AT_INTENT")
    }
  }
  if (
    parsedReport?.success === true &&
    (proposalEvaluatedAt !== undefined || quoteConfirmationRejection)
  ) {
    const marketObservedAt = Date.parse(
      parsedReport.data.analysis.marketRegime.observedAt,
    )
    const sessionDate = run.initialEligibility?.sessionDate
    const expectedIntradayBars =
      sessionDate === undefined
        ? Number.NaN
        : Math.floor(
            (marketObservedAt -
              newYorkLocalTime(sessionDate, "09:30").getTime()) /
              60_000,
          )
    if (
      !Number.isFinite(marketObservedAt) ||
      expectedIntradayBars <= 0 ||
      parsedReport.data.analysis.marketRegime.intradayBarCount !==
        expectedIntradayBars
    ) {
      temporalIssues.push("INTRADAY_BAR_COUNT_MISMATCH")
    }
  }
  if (run.outcome.status === "PRELIMINARY_RESEARCH_RETAINED") {
    const eligibilitySessionDate = run.initialEligibility?.sessionDate
    if (eligibilitySessionDate === undefined) {
      temporalIssues.push("PRELIMINARY_SESSION_CONTEXT_MISSING")
    } else if (
      run.outcome.research.targetSessionDate !== eligibilitySessionDate ||
      run.outcome.research.targetSessionDate !== run.cycle.sessionDate
    ) {
      temporalIssues.push("PRELIMINARY_TARGET_SESSION_MISMATCH")
    }
    const preliminaryResult =
      reportResult?.outcome === "PRELIMINARY_RESEARCH"
        ? reportResult
        : parsedPreliminaryResearch?.success === true
          ? parsedPreliminaryResearch.data
          : undefined
    if (
      validCycleRange &&
      preliminaryResult?.evidence.some(
        (claim) =>
          claim.kind === "SOURCED_FACT" &&
          Date.parse(claim.observedAt) > cycleEnd,
      )
    ) {
      temporalIssues.push("PRELIMINARY_OBSERVATION_AFTER_CYCLE")
    }
  }

  const retainedEvidence =
    typeof retainedResult === "object" &&
    retainedResult !== null &&
    "evidence" in retainedResult &&
    Array.isArray(retainedResult.evidence)
      ? retainedResult.evidence.filter(isEvaluableEvidenceClaim)
      : []
  const evidence = reportResult?.evidence ?? retainedEvidence
  const sourcedFacts = evidence.flatMap((claim) =>
    claim.kind === "SOURCED_FACT" ? [claim] : [],
  )
  const inferences = evidence.flatMap((claim) =>
    claim.kind === "INFERENCE" ? [claim] : [],
  )
  const sourcedFactIds = new Set(sourcedFacts.map(({ claimId }) => claimId))
  if (
    ["INTENT_DERIVED", "INTENT_DERIVATION_REJECTED"].includes(
      run.outcome.status,
    ) &&
    new Set(evidence.map(({ claimId }) => claimId)).size !== evidence.length
  ) {
    groundingIssues.push("DUPLICATE_CLAIM_ID")
  }
  if (
    run.outcome.status === "VALIDATED_NO_ACTION" &&
    sourcedFacts.length > 0
  ) {
    groundingIssues.push("NO_ACTION_SOURCED_EVIDENCE")
  }
  const groundedInferenceCount = inferences.filter(({ basedOn }) =>
    basedOn.every((claimId) => sourcedFactIds.has(claimId)),
  ).length
  if (groundedInferenceCount !== inferences.length) {
    groundingIssues.push("UNGROUNDED_INFERENCE")
  }

  const snapshotReferences = [
    ...sourcedFacts.flatMap((claim) =>
      "snapshotRef" in claim ? [claim.snapshotRef] : [],
    ),
    ...(run.outcome.status === "INTENT_DERIVED"
      ? [run.outcome.intent.quoteSnapshotRef]
      : []),
  ]
  const knownSnapshots = new Set(
    run.evidenceSnapshots.map(({ snapshotRef }) => snapshotRef),
  )
  if (
    run.outcome.status === "INTENT_DERIVED" &&
    knownSnapshots.size !== run.evidenceSnapshots.length
  ) {
    groundingIssues.push("DUPLICATE_SNAPSHOT_REFERENCE")
  }
  if (
    run.outcome.status === "INTENT_DERIVED" &&
    ((knownSnapshots.size === run.evidenceSnapshots.length &&
      run.evidenceSnapshots.length > 1) ||
      run.evidenceSnapshots.some(
        ({ snapshotRef }) => snapshotRef !== PROPOSAL_QUOTE_SNAPSHOT_REF,
      ))
  ) {
    groundingIssues.push("UNEXPECTED_SNAPSHOT_REFERENCE")
  }
  if (
    ["PRELIMINARY_RESEARCH_RETAINED", "VALIDATED_NO_ACTION"].includes(
      run.outcome.status,
    ) &&
    run.evidenceSnapshots.length > 0
  ) {
    groundingIssues.push("UNEXPECTED_SNAPSHOT_REFERENCE")
  }
  if (snapshotReferences.some((snapshotRef) => !knownSnapshots.has(snapshotRef))) {
    groundingIssues.push("UNKNOWN_SNAPSHOT_REFERENCE")
  }
  if (
    run.outcome.status === "INTENT_DERIVATION_REJECTED" &&
    run.evidenceSnapshots.some(
      (snapshot) => !hasCanonicalProposalQuoteProvenance(snapshot),
    )
  ) {
    groundingIssues.push("QUOTE_SNAPSHOT_PROVENANCE_INVALID")
  }
  if (
    run.outcome.status === "INTENT_DERIVATION_REJECTED" &&
    run.evidenceSnapshots.some(
      (snapshot) =>
        hasCanonicalProposalQuoteProvenance(snapshot) &&
        !hasAlpacaQuoteFreshnessBound(snapshot),
    )
  ) {
    groundingIssues.push("QUOTE_SNAPSHOT_METADATA_MISMATCH")
  }
  if (run.outcome.status === "DECISION_REJECTED") {
    if (run.evidenceSnapshots.length > 1) {
      groundingIssues.push("UNEXPECTED_SNAPSHOT_REFERENCE")
    }
    if (
      run.evidenceSnapshots.some(
        (snapshot) => !hasCanonicalProposalQuoteProvenance(snapshot),
      )
    ) {
      groundingIssues.push("QUOTE_SNAPSHOT_PROVENANCE_INVALID")
    }
    if (
      run.evidenceSnapshots.some(
        (snapshot) =>
          hasCanonicalProposalQuoteProvenance(snapshot) &&
          !hasAlpacaQuoteFreshnessBound(snapshot),
      )
    ) {
      groundingIssues.push("QUOTE_SNAPSHOT_METADATA_MISMATCH")
    }
  }
  if (run.outcome.status === "INTENT_DERIVED") {
    const intentEvaluatedAt = Date.parse(run.outcome.intent.evaluatedAt)
    const parsedIntent = tradeIntentV1Schema.safeParse(run.outcome.intent)
    const longQuoteTimestamp = parsedIntent.success
      ? parseRfc3339Nanoseconds(
          parsedIntent.data.longQuote.providerTimestamp,
        )
      : undefined
    const shortQuoteTimestamp = parsedIntent.success
      ? parseRfc3339Nanoseconds(
          parsedIntent.data.shortQuote.providerTimestamp,
        )
      : undefined
    const expectedFreshUntil =
      longQuoteTimestamp === undefined || shortQuoteTimestamp === undefined
        ? undefined
        : floorNanosecondsToIsoMilliseconds(
            (longQuoteTimestamp < shortQuoteTimestamp
              ? longQuoteTimestamp
              : shortQuoteTimestamp) +
              ALPACA_OPTION_QUOTE_FRESHNESS_NANOSECONDS,
          )
    const snapshotsByReference = new Map(
      run.evidenceSnapshots.map((snapshot) => [snapshot.snapshotRef, snapshot]),
    )
    for (const snapshotReference of snapshotReferences) {
      const snapshot = snapshotsByReference.get(snapshotReference)
      if (snapshot === undefined) continue
      if (
        !hasCanonicalProposalQuoteProvenance(snapshot)
      ) {
        groundingIssues.push("QUOTE_SNAPSHOT_PROVENANCE_INVALID")
      }
      if (Date.parse(snapshot.retrievedAt) > intentEvaluatedAt) {
        groundingIssues.push("SNAPSHOT_FROM_FUTURE")
      }
      if (Date.parse(snapshot.freshUntil) < intentEvaluatedAt) {
        groundingIssues.push("STALE_SNAPSHOT")
      }
      if (
        Date.parse(snapshot.retrievedAt) <= intentEvaluatedAt &&
        Date.parse(snapshot.freshUntil) >= intentEvaluatedAt &&
        parsedIntent.success &&
        (snapshot.retrievedAt !== parsedIntent.data.evaluatedAt ||
          expectedFreshUntil === undefined ||
          snapshot.freshUntil !== expectedFreshUntil)
      ) {
        groundingIssues.push("QUOTE_SNAPSHOT_METADATA_MISMATCH")
      }
    }
    if (
      snapshotReferences.some(
        (snapshotReference) =>
          snapshotReference !== PROPOSAL_QUOTE_SNAPSHOT_REF,
      )
    ) {
      groundingIssues.push("QUOTE_SNAPSHOT_PROVENANCE_INVALID")
    }
  }

  const candidateIdentities: CandidateIdentity[] = []
  const addCandidate = (
    result:
      | typeof reportResult
      | typeof validRetainedResult,
  ) => {
    if (result === undefined || !("candidate" in result) || result.candidate === undefined) {
      return
    }
    if (!("direction" in result) || result.direction === "UNDETERMINED") return
    candidateIdentities.push({
      direction: result.direction,
      structure: result.candidate.structure,
      expiration: result.candidate.expiration,
      longContractSymbol: result.candidate.longLeg.contractSymbol,
      shortContractSymbol: result.candidate.shortLeg.contractSymbol,
    })
  }
  addCandidate(reportResult)
  addCandidate(
    parsedPreliminaryResearch?.success === true
      ? parsedPreliminaryResearch.data
      : undefined,
  )
  addCandidate(
    parsedValidatedDecision?.success === true
      ? parsedValidatedDecision.data
      : undefined,
  )
  if (run.outcome.status === "INTENT_DERIVED") {
    candidateIdentities.push({
      direction: run.outcome.intent.direction,
      structure: run.outcome.intent.structure,
      expiration: run.outcome.intent.expiration,
      longContractSymbol: run.outcome.intent.longContractSymbol,
      shortContractSymbol: run.outcome.intent.shortContractSymbol,
    })
  }
  const candidateApplicable = candidateIdentities.length > 0
  if (new Set(candidateIdentities.map(candidateKey)).size > 1) {
    candidateIssues.push("CANDIDATE_IDENTITY_MISMATCH")
  }
  const diagnostics = parsedReport?.success === true
    ? parsedReport.data.analysis.candidateEvaluation
    : undefined
  const canonicalCandidate = candidateIdentities[0]
  if (diagnostics !== undefined && canonicalCandidate !== undefined) {
    const diagnosticSymbols = new Map(
      diagnostics.legs.map(({ role, contractSymbol }) => [role, contractSymbol]),
    )
    if (
      diagnosticSymbols.get("LONG") !== canonicalCandidate.longContractSymbol ||
      diagnosticSymbols.get("SHORT") !== canonicalCandidate.shortContractSymbol
    ) {
      candidateIssues.push("CANDIDATE_IDENTITY_MISMATCH")
    }
  }
  if (
    diagnostics !== undefined &&
    canonicalCandidate !== undefined &&
    run.initialEligibility?.sessionDate !== undefined
  ) {
    const sessionDay = Date.parse(
      `${run.initialEligibility.sessionDate}T00:00:00.000Z`,
    )
    const expirationDay = Date.parse(
      `${canonicalCandidate.expiration}T00:00:00.000Z`,
    )
    const expectedDte = (expirationDay - sessionDay) / 86_400_000
    if (!Number.isInteger(expectedDte) || diagnostics.dte !== expectedDte) {
      candidateIssues.push("CANDIDATE_DTE_MISMATCH")
    }
  }
  const proposalHistoryRequired =
    run.outcome.status === "INTENT_DERIVED" ||
    postQuoteRejectionEvaluatedAt !== undefined ||
    quoteConfirmationRejection ||
    decisionRejectionEvaluatedAt !== undefined
  if (proposalHistoryRequired && diagnostics === undefined) {
    candidateIssues.push("OPEN_INTEREST_HISTORY_INVALID")
  }
  if (proposalHistoryRequired && diagnostics !== undefined) {
    const sessionDate = run.initialEligibility?.sessionDate
    const previousSessionDates = run.initialEligibility?.previousSessionDates
    const priorSessionHistoryIsValid =
      previousSessionDates !== undefined &&
      previousSessionDates.length >= 2 &&
      sessionDate !== undefined &&
      new Set(previousSessionDates).size === previousSessionDates.length &&
      previousSessionDates.every((date) => date < sessionDate) &&
      previousSessionDates.every(
        (date, index) => index === 0 || previousSessionDates[index - 1]! < date,
      )
    if (
      sessionDate === undefined ||
      previousSessionDates === undefined ||
      !priorSessionHistoryIsValid
    ) {
      candidateIssues.push("OPEN_INTEREST_HISTORY_INVALID")
    } else {
      const eligibleOpenInterestDates = new Set([
        sessionDate,
        ...previousSessionDates.slice(-2),
      ])
      if (
        diagnostics.legs.some(
          ({ openInterestDate }) =>
            !eligibleOpenInterestDates.has(openInterestDate),
        )
      ) {
        candidateIssues.push("OPEN_INTEREST_HISTORY_INVALID")
      }
    }
  }

  if (run.outcome.status === "INTENT_DERIVED") {
    const eligibility = run.initialEligibility
    if (eligibility === undefined) {
      failClosedIssues.push("INTENT_ELIGIBILITY_CONTEXT_MISSING")
    } else if (!eligibility.tradeIntentEligible) {
      failClosedIssues.push("INELIGIBLE_CYCLE_DERIVED_INTENT")
    } else if (eligibility.tradeIntentWindow === undefined) {
      failClosedIssues.push("INTENT_ELIGIBILITY_CONTEXT_MISSING")
    } else if (
      eligibility.sessionOpen === undefined ||
      eligibility.sessionClose === undefined
    ) {
      failClosedIssues.push("INTENT_ELIGIBILITY_CONTEXT_MISSING")
    } else {
      const eligibilityEvaluatedAt = Date.parse(eligibility.evaluatedAt)
      const intentEvaluatedAt = Date.parse(run.outcome.intent.evaluatedAt)
      const slotStartedAt = Date.parse(
        eligibility.tradeIntentWindow.slotStartedAt,
      )
      const deadline = Date.parse(eligibility.tradeIntentWindow.deadline)
      if (
        !retainedTradeWindowContextIsValid(
          eligibility,
          run.cycle,
          versionedResult?.strategyVersion,
        )
      ) {
        failClosedIssues.push("INTENT_ELIGIBILITY_CONTEXT_INVALID")
      }
      if (
        !Number.isFinite(intentEvaluatedAt) ||
        !Number.isFinite(slotStartedAt) ||
        !Number.isFinite(deadline) ||
        intentEvaluatedAt < slotStartedAt ||
        intentEvaluatedAt < eligibilityEvaluatedAt ||
        intentEvaluatedAt >= deadline
      ) {
        failClosedIssues.push("INTENT_OUTSIDE_RETAINED_TRADE_WINDOW")
      }
    }
    if (run.validatedDecision?.outcome !== "PROPOSE_TRADE") {
      failClosedIssues.push("INTENT_WITHOUT_VALIDATED_PROPOSAL")
    }
  }

  const evaluation = {
    evaluationVersion: RESEARCH_RUN_EVALUATION_VERSION,
    cycleId: run.cycle.cycleId,
    terminalEventId: run.ledger.terminalEventId,
    outcomeStatus: run.outcome.status,
    versions: {
      runVersion: run.runVersion,
      ...(parsedReport?.success !== true
        ? {}
        : { reportVersion: parsedReport.data.reportVersion }),
      ...(versionedResult === undefined
        ? {}
        : {
            contractVersion: versionedResult.contractVersion,
            strategyVersion: versionedResult.strategyVersion,
          }),
    },
    dimensions: {
      contractCompliance: dimension(contractIssues),
      temporalIntegrity: dimension(temporalIssues),
      grounding: dimension(groundingIssues),
      candidateIdentity: dimension(candidateIssues, candidateApplicable),
      failClosedBehavior: dimension(failClosedIssues),
    },
    metrics: {
      sourcedFactCount: sourcedFacts.length,
      inferenceCount: inferences.length,
      groundedInferenceCount,
      snapshotReferenceCount: snapshotReferences.length,
      exaSourceCount:
        parsedReport?.success === true
          ? parsedReport.data.analysis.externalContext.filter(
              ({ provider }) => provider === "EXA",
            ).length
          : 0,
      fmpSourceCount:
        parsedReport?.success === true
          ? parsedReport.data.analysis.externalContext.filter(
              ({ provider }) => provider === "FMP",
            ).length
          : 0,
    },
  }
  return researchRunEvaluationV1Schema.parse(evaluation)
}
