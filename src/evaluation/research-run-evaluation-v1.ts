import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import {
  researchDecisionV3Schema,
  proposalQuoteSnapshotRef,
} from "../contracts/research-decision-v3.js"
import { researchReportV6Schema } from "../contracts/research-report-v6.js"
import { tradeIntentV3Schema } from "../contracts/trade-intent-v3.js"
import {
  SUPPORTED_RESEARCH_RUN_VERSIONS,
  type ResearchRunV1,
} from "../research/run/artifact.js"
import { researchInvocationV1Schema } from "../research/invocation-v1.js"
import {
  ALPACA_OPTION_QUOTE_FRESHNESS_NANOSECONDS,
  ALPACA_OPTION_QUOTE_SNAPSHOT_SOURCE,
} from "../market-data/alpaca-option-quotes.js"
import {
  DRY_RUN_MODE,
  TRADE_INTENT_START_GRACE_MS,
  TRADE_INTENT_WINDOW_DURATION_MS,
  newYorkDate,
  newYorkLocalTime,
} from "../scheduling/research-eligibility.js"
import {
  floorNanosecondsToIsoMilliseconds,
  parseRfc3339Nanoseconds,
} from "../shared/value-normalization.js"

// Bump when grader semantics change, so two results are only comparable when
// they share this version.
export const RESEARCH_RUN_EVALUATION_VERSION = "2.0.0" as const

export const RESEARCH_EVALUATION_ISSUE_CODES = [
  "RUN_METADATA_INVALID",
  "RESEARCH_REPORT_MISSING",
  "REPORT_RESULT_MISMATCH",
  "OUTCOME_RECORD_MISMATCH",
  "CYCLE_TIME_RANGE_INVALID",
  "REPORT_AS_OF_OUTSIDE_CYCLE",
  "SOURCE_RETRIEVAL_OUTSIDE_CYCLE",
  "REPORT_AS_OF_AFTER_INTENT",
  "ACCOUNT_CHECKS_STALE_AT_INTENT",
  "MARKET_REGIME_STALE_AT_INTENT",
  "INTRADAY_BAR_COUNT_MISMATCH",
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
  "INELIGIBLE_CYCLE_DERIVED_INTENT",
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
      "VALIDATED_NO_ACTION",
      "DECISION_REJECTED",
      "PORTFOLIO_EVALUATED",
    ]),
    versions: z
      .object({
        runVersion: z.string().min(1).max(32),
        reportVersion: z.string().min(1).max(32).optional(),
        contractVersion: z.string().min(1).max(32).optional(),
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
  underlying: string
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
  if (eligibility.researchMode === DRY_RUN_MODE) {
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
    deadline ===
      Math.min(slotStartedAt + TRADE_INTENT_WINDOW_DURATION_MS, entryCutoff) &&
    eligibilityEvaluatedAt >= slotStartedAt &&
    eligibilityEvaluatedAt - slotStartedAt < TRADE_INTENT_START_GRACE_MS &&
    eligibilityEvaluatedAt <= cycleStartedAt &&
    cycleStartedAt < deadline
  )
}

const candidateKey = (candidate: CandidateIdentity) =>
  [
    candidate.underlying,
    candidate.direction,
    candidate.structure,
    candidate.expiration,
    candidate.longContractSymbol,
    candidate.shortContractSymbol,
  ].join("|")

const hasCanonicalProposalQuoteProvenance = (
  snapshot: ResearchRunV1["evidenceSnapshots"][number],
  expectedSnapshotRef: string,
) =>
  snapshot.snapshotRef === expectedSnapshotRef &&
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
  expectedSnapshotRef: string,
) =>
  hasCanonicalProposalQuoteProvenance(snapshot, expectedSnapshotRef) &&
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

  const parsedInvocation = run.researchInvocation === undefined
    ? undefined
    : researchInvocationV1Schema.safeParse(run.researchInvocation)
  const invocation = parsedInvocation?.success === true
    ? parsedInvocation.data
    : undefined
  if (run.researchInvocation !== undefined && invocation === undefined) {
    contractIssues.push("RUN_METADATA_INVALID")
  }

  const parsedReport = run.researchReport === undefined
    ? undefined
    : researchReportV6Schema.safeParse(run.researchReport)
  const validReport = parsedReport?.success === true ? parsedReport.data : undefined
  const reportResult = validReport?.result
  const parsedValidatedDecision = run.validatedDecision === undefined
    ? undefined
    : researchDecisionV3Schema.safeParse(run.validatedDecision)
  const validRetainedResult = parsedValidatedDecision?.success === true
    ? parsedValidatedDecision.data
    : undefined
  const versionedResult = reportResult ?? validRetainedResult

  if (
    run.researchReport === undefined &&
    run.outcome.status !== "DECISION_REJECTED"
  ) {
    contractIssues.push("RESEARCH_REPORT_MISSING")
  }
  if (
    invocation !== undefined &&
    reportResult !== undefined &&
    (invocation.decisionContractVersion !== reportResult.contractVersion ||
      invocation.reportVersion !== validReport?.reportVersion)
  ) {
    contractIssues.push("RUN_METADATA_INVALID")
  }
  if (
    reportResult !== undefined &&
    run.validatedDecision !== undefined &&
    !isDeepStrictEqual(reportResult, run.validatedDecision)
  ) {
    contractIssues.push("REPORT_RESULT_MISMATCH")
  }

  switch (run.outcome.status) {
    case "VALIDATED_NO_ACTION":
      if (
        validRetainedResult?.outcome !== "NO_ACTION" ||
        !isDeepStrictEqual(run.outcome.decision, validRetainedResult)
      ) {
        contractIssues.push("OUTCOME_RECORD_MISMATCH")
      }
      break
    case "DECISION_REJECTED":
      if (
        run.validatedDecision !== undefined ||
        run.outcome.issues.length === 0 ||
        run.outcome.issues.length > 10
      ) {
        contractIssues.push("OUTCOME_RECORD_MISMATCH")
      }
      break
    case "PORTFOLIO_EVALUATED": {
      const decision = validRetainedResult?.outcome === "PROPOSE_TRADES"
        ? validRetainedResult
        : undefined
      const proposalByUnderlying = new Map(
        decision?.proposals.map((proposal) => [
          proposal.candidate.underlying,
          proposal,
        ]) ?? [],
      )
      const retainedIntentUnderlyings = new Set(
        run.outcome.intents.map(({ underlying }) => underlying),
      )
      if (
        decision === undefined ||
        !isDeepStrictEqual(run.outcome.decision, decision) ||
        run.outcome.intents.some(
          (intent) =>
            !tradeIntentV3Schema.safeParse(intent).success ||
            !proposalByUnderlying.has(intent.underlying),
        ) ||
        new Set(run.outcome.intents.map(({ underlying }) => underlying)).size !==
          run.outcome.intents.length ||
        run.outcome.selectedUnderlyings.length > 1 ||
        run.outcome.selectedUnderlyings.some(
          (underlying) => !retainedIntentUnderlyings.has(underlying),
        )
      ) {
        contractIssues.push("OUTCOME_RECORD_MISMATCH")
      }
      break
    }
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
  }
  const intents = run.outcome.status === "PORTFOLIO_EVALUATED"
    ? run.outcome.intents
    : []
  if (validReport !== undefined) {
    const reportAsOf = Date.parse(validReport.analysis.asOf)
    const accountObservedAt = Date.parse(
      validReport.analysis.accountChecks.observedAt,
    )
    for (const intent of intents) {
      const evaluatedAt = Date.parse(intent.evaluatedAt)
      const market = validReport.analysis.marketRegimes.find(
        ({ underlying }) => underlying === intent.underlying,
      )
      if (reportAsOf > evaluatedAt) {
        temporalIssues.push("REPORT_AS_OF_AFTER_INTENT")
      }
      const accountAge = evaluatedAt - accountObservedAt
      if (accountAge < 0 || accountAge > 5 * 60_000) {
        temporalIssues.push("ACCOUNT_CHECKS_STALE_AT_INTENT")
      }
      if (market === undefined) {
        temporalIssues.push("MARKET_REGIME_STALE_AT_INTENT")
        continue
      }
      const marketObservedAt = Date.parse(market.observedAt)
      const marketAge = evaluatedAt - marketObservedAt
      if (marketAge < 0 || marketAge > 60_000) {
        temporalIssues.push("MARKET_REGIME_STALE_AT_INTENT")
      }
      const sessionDate = run.initialEligibility?.sessionDate
      const expectedIntradayBars = sessionDate === undefined
        ? Number.NaN
        : Math.floor(
            (marketObservedAt -
              newYorkLocalTime(sessionDate, "09:30").getTime()) /
              60_000,
          )
      if (
        !Number.isFinite(marketObservedAt) ||
        expectedIntradayBars <= 0 ||
        market.intradayBarCount !== expectedIntradayBars
      ) {
        temporalIssues.push("INTRADAY_BAR_COUNT_MISMATCH")
      }
    }
  }

  const evidenceFor = (decision: typeof versionedResult) => {
    if (decision === undefined) return []
    return decision.outcome === "NO_ACTION"
      ? decision.evidence.filter(isEvaluableEvidenceClaim)
      : decision.proposals.flatMap(({ evidence }) =>
          evidence.filter(isEvaluableEvidenceClaim),
        )
  }
  const evidence = evidenceFor(reportResult ?? validRetainedResult)
  const sourcedFacts = evidence.flatMap((claim) =>
    claim.kind === "SOURCED_FACT" ? [claim] : [],
  )
  const inferences = evidence.flatMap((claim) =>
    claim.kind === "INFERENCE" ? [claim] : [],
  )
  const sourcedFactIds = new Set(sourcedFacts.map(({ claimId }) => claimId))
  if (new Set(evidence.map(({ claimId }) => claimId)).size !== evidence.length) {
    groundingIssues.push("DUPLICATE_CLAIM_ID")
  }
  if (
    run.outcome.status === "VALIDATED_NO_ACTION" &&
    sourcedFacts.some((claim) => "snapshotRef" in claim)
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
    ...intents.map(({ quoteSnapshotRef }) => quoteSnapshotRef),
  ]
  const knownSnapshots = new Set(
    run.evidenceSnapshots.map(({ snapshotRef }) => snapshotRef),
  )
  if (knownSnapshots.size !== run.evidenceSnapshots.length) {
    groundingIssues.push("DUPLICATE_SNAPSHOT_REFERENCE")
  }
  if (
    run.outcome.status === "VALIDATED_NO_ACTION" &&
    run.evidenceSnapshots.length > 0
  ) {
    groundingIssues.push("UNEXPECTED_SNAPSHOT_REFERENCE")
  }
  if (snapshotReferences.some((snapshotRef) => !knownSnapshots.has(snapshotRef))) {
    groundingIssues.push("UNKNOWN_SNAPSHOT_REFERENCE")
  }
  const proposals = versionedResult?.outcome === "PROPOSE_TRADES"
    ? versionedResult.proposals
    : []
  const expectedSnapshotRefs = new Set(
    proposals.map(({ candidate }) =>
      proposalQuoteSnapshotRef(candidate.underlying),
    ),
  )
  if (
    run.evidenceSnapshots.some(
      ({ snapshotRef }) => !expectedSnapshotRefs.has(snapshotRef),
    )
  ) {
    groundingIssues.push("UNEXPECTED_SNAPSHOT_REFERENCE")
  }
  for (const snapshot of run.evidenceSnapshots) {
    if (
      !expectedSnapshotRefs.has(snapshot.snapshotRef) ||
      !hasCanonicalProposalQuoteProvenance(snapshot, snapshot.snapshotRef)
    ) {
      groundingIssues.push("QUOTE_SNAPSHOT_PROVENANCE_INVALID")
    } else if (!hasAlpacaQuoteFreshnessBound(snapshot)) {
      groundingIssues.push("QUOTE_SNAPSHOT_METADATA_MISMATCH")
    }
  }
  const snapshotsByReference = new Map(
    run.evidenceSnapshots.map((snapshot) => [snapshot.snapshotRef, snapshot]),
  )
  for (const intent of intents) {
    const intentEvaluatedAt = Date.parse(intent.evaluatedAt)
    const parsedIntent = tradeIntentV3Schema.safeParse(intent)
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
    const expectedSnapshotRef = proposalQuoteSnapshotRef(intent.underlying)
    const snapshot = snapshotsByReference.get(intent.quoteSnapshotRef)
    if (intent.quoteSnapshotRef !== expectedSnapshotRef) {
      groundingIssues.push("QUOTE_SNAPSHOT_PROVENANCE_INVALID")
    }
    if (snapshot === undefined) continue
    if (!isCanonicalProposalQuoteSnapshot(snapshot, expectedSnapshotRef)) {
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

  const proposalIdentity = (
    proposal: (typeof proposals)[number],
  ): CandidateIdentity => ({
    underlying: proposal.candidate.underlying,
    direction: proposal.direction,
    structure: proposal.candidate.structure,
    expiration: proposal.candidate.expiration,
    longContractSymbol: proposal.candidate.longLeg.contractSymbol,
    shortContractSymbol: proposal.candidate.shortLeg.contractSymbol,
  })
  const candidateIdentities = proposals.map(proposalIdentity)
  const candidateApplicable = candidateIdentities.length > 0
  const proposalByUnderlying = new Map(
    proposals.map((proposal) => [proposal.candidate.underlying, proposal]),
  )
  for (const intent of intents) {
    const proposal = proposalByUnderlying.get(intent.underlying)
    if (
      proposal === undefined ||
      candidateKey(proposalIdentity(proposal)) !== candidateKey({
        underlying: intent.underlying,
        direction: intent.direction,
        structure: intent.structure,
        expiration: intent.expiration,
        longContractSymbol: intent.longContractSymbol,
        shortContractSymbol: intent.shortContractSymbol,
      })
    ) {
      candidateIssues.push("CANDIDATE_IDENTITY_MISMATCH")
    }
  }
  const diagnostics = validReport?.analysis.candidateEvaluations ?? []
  for (const candidate of candidateIdentities) {
    const diagnostic = diagnostics.find(
      ({ underlying }) => underlying === candidate.underlying,
    )
    if (diagnostic === undefined) {
      candidateIssues.push("OPEN_INTEREST_HISTORY_INVALID")
      continue
    }
    const diagnosticSymbols = new Map(
      diagnostic.legs.map(({ role, contractSymbol }) => [role, contractSymbol]),
    )
    if (
      diagnostic.expiration !== candidate.expiration ||
      diagnosticSymbols.get("LONG") !== candidate.longContractSymbol ||
      diagnosticSymbols.get("SHORT") !== candidate.shortContractSymbol
    ) {
      candidateIssues.push("CANDIDATE_IDENTITY_MISMATCH")
    }
    const sessionDate = run.initialEligibility?.sessionDate
    const previousSessionDates = run.initialEligibility?.previousSessionDates
    if (sessionDate !== undefined) {
      const expectedDte =
        (Date.parse(`${candidate.expiration}T00:00:00.000Z`) -
          Date.parse(`${sessionDate}T00:00:00.000Z`)) /
        86_400_000
      if (!Number.isInteger(expectedDte) || diagnostic.dte !== expectedDte) {
        candidateIssues.push("CANDIDATE_DTE_MISMATCH")
      }
    }
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
        diagnostic.legs.some(
          ({ openInterestDate }) =>
            !eligibleOpenInterestDates.has(openInterestDate),
        )
      ) {
        candidateIssues.push("OPEN_INTEREST_HISTORY_INVALID")
      }
    }
  }

  if (intents.length > 0) {
    const eligibility = run.initialEligibility
    const tradeIntentWindow = eligibility?.tradeIntentWindow
    // Absent context cannot establish eligibility, so it fails closed rather
    // than passing silently. Only the re-derivation of app-computed window
    // boundaries was removed; the retained window is still checked below.
    if (eligibility === undefined) {
      failClosedIssues.push("INTENT_ELIGIBILITY_CONTEXT_MISSING")
    } else if (!eligibility.tradeIntentEligible) {
      failClosedIssues.push("INELIGIBLE_CYCLE_DERIVED_INTENT")
    } else if (tradeIntentWindow === undefined) {
      failClosedIssues.push("INTENT_ELIGIBILITY_CONTEXT_MISSING")
    }
    if (
      eligibility !== undefined &&
      tradeIntentWindow !== undefined &&
      !retainedTradeWindowContextIsValid(eligibility, run.cycle)
    ) {
      failClosedIssues.push("INTENT_OUTSIDE_RETAINED_TRADE_WINDOW")
    }
    if (eligibility !== undefined && tradeIntentWindow !== undefined) {
      const eligibilityEvaluatedAt = Date.parse(eligibility.evaluatedAt)
      const slotStartedAt = Date.parse(tradeIntentWindow.slotStartedAt)
      const deadline = Date.parse(tradeIntentWindow.deadline)
      for (const intent of intents) {
        const intentEvaluatedAt = Date.parse(intent.evaluatedAt)
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
    }
    if (validRetainedResult?.outcome !== "PROPOSE_TRADES") {
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
