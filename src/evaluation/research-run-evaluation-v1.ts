import { isDeepStrictEqual } from "node:util"

import { z } from "zod"

import { preliminaryResearchV1Schema } from "../contracts/preliminary-research-v1.js"
import { researchDecisionV1Schema } from "../contracts/research-decision-v1.js"
import { researchReportV2Schema } from "../contracts/research-report-v2.js"
import { tradeIntentV1Schema } from "../contracts/trade-intent-v1.js"
import {
  RESEARCH_RUN_VERSION,
  type ResearchRunV1,
} from "../research/research-artifact.js"
import {
  newYorkDate,
  newYorkLocalTime,
} from "../scheduling/research-eligibility.js"

export const RESEARCH_RUN_EVALUATION_VERSION = "1.0.0" as const

export const RESEARCH_EVALUATION_ISSUE_CODES = [
  "RUN_VERSION_INVALID",
  "REPORT_CONTRACT_INVALID",
  "OUTCOME_CONTRACT_INVALID",
  "REPORT_RESULT_MISMATCH",
  "OUTCOME_RECORD_MISMATCH",
  "CYCLE_TIME_RANGE_INVALID",
  "REPORT_AS_OF_OUTSIDE_CYCLE",
  "SOURCE_RETRIEVAL_OUTSIDE_CYCLE",
  "SNAPSHOT_RETRIEVAL_OUTSIDE_CYCLE",
  "INTENT_EVALUATION_OUTSIDE_CYCLE",
  "UNGROUNDED_INFERENCE",
  "UNKNOWN_SNAPSHOT_REFERENCE",
  "SNAPSHOT_FROM_FUTURE",
  "STALE_SNAPSHOT",
  "CANDIDATE_IDENTITY_MISMATCH",
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

const candidateKey = (candidate: CandidateIdentity) =>
  [
    candidate.direction,
    candidate.structure,
    candidate.expiration,
    candidate.longContractSymbol,
    candidate.shortContractSymbol,
  ].join("|")

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

  if (run.runVersion !== RESEARCH_RUN_VERSION) {
    contractIssues.push("RUN_VERSION_INVALID")
  }

  const parsedReport =
    run.researchReport === undefined
      ? undefined
      : researchReportV2Schema.safeParse(run.researchReport)
  if (parsedReport?.success === false) {
    contractIssues.push("REPORT_CONTRACT_INVALID")
  }
  if (
    run.preliminaryResearch !== undefined &&
    !preliminaryResearchV1Schema.safeParse(run.preliminaryResearch).success
  ) {
    contractIssues.push("OUTCOME_CONTRACT_INVALID")
  }
  if (
    run.validatedDecision !== undefined &&
    !researchDecisionV1Schema.safeParse(run.validatedDecision).success
  ) {
    contractIssues.push("OUTCOME_CONTRACT_INVALID")
  }

  const reportResult = parsedReport?.success === true
    ? parsedReport.data.result
    : undefined
  const retainedResult = run.preliminaryResearch ?? run.validatedDecision
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
        !isDeepStrictEqual(run.outcome.research, run.preliminaryResearch)
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
        !isDeepStrictEqual(run.outcome.decision, run.validatedDecision)
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
        !isDeepStrictEqual(run.outcome.decision, run.validatedDecision)
      ) {
        contractIssues.push("OUTCOME_RECORD_MISMATCH")
      }
      break
    case "DECISION_REJECTED":
    case "INTENT_DERIVATION_REJECTED":
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
      run.researchReport !== undefined &&
      !timestampWithin(run.researchReport.analysis.asOf, cycleStart, cycleEnd)
    ) {
      temporalIssues.push("REPORT_AS_OF_OUTSIDE_CYCLE")
    }
    if (
      run.researchReport?.analysis.externalContext.some(
        ({ retrievedAt }) => !timestampWithin(retrievedAt, cycleStart, cycleEnd),
      ) === true
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

  const evidence = reportResult?.evidence ?? retainedResult?.evidence ?? []
  const sourcedFacts = evidence.flatMap((claim) =>
    claim.kind === "SOURCED_FACT" ? [claim] : [],
  )
  const inferences = evidence.flatMap((claim) =>
    claim.kind === "INFERENCE" ? [claim] : [],
  )
  const sourcedFactIds = new Set(sourcedFacts.map(({ claimId }) => claimId))
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
  if (snapshotReferences.some((snapshotRef) => !knownSnapshots.has(snapshotRef))) {
    groundingIssues.push("UNKNOWN_SNAPSHOT_REFERENCE")
  }
  if (run.outcome.status === "INTENT_DERIVED") {
    const intentEvaluatedAt = Date.parse(run.outcome.intent.evaluatedAt)
    const snapshotsByReference = new Map(
      run.evidenceSnapshots.map((snapshot) => [snapshot.snapshotRef, snapshot]),
    )
    for (const snapshotReference of snapshotReferences) {
      const snapshot = snapshotsByReference.get(snapshotReference)
      if (snapshot === undefined) continue
      if (Date.parse(snapshot.retrievedAt) > intentEvaluatedAt) {
        groundingIssues.push("SNAPSHOT_FROM_FUTURE")
      }
      if (Date.parse(snapshot.freshUntil) < intentEvaluatedAt) {
        groundingIssues.push("STALE_SNAPSHOT")
      }
    }
  }

  const candidateIdentities: CandidateIdentity[] = []
  const addCandidate = (
    result:
      | typeof reportResult
      | typeof run.preliminaryResearch
      | typeof run.validatedDecision,
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
  addCandidate(run.preliminaryResearch)
  addCandidate(run.validatedDecision)
  if (run.outcome.status === "INTENT_DERIVED") {
    candidateIdentities.push({
      direction: run.outcome.intent.direction,
      structure: run.outcome.intent.structure,
      expiration: run.outcome.intent.expiration,
      longContractSymbol: run.outcome.intent.longContractSymbol,
      shortContractSymbol: run.outcome.intent.shortContractSymbol,
    })
  }
  const candidateApplicable =
    candidateIdentities.length > 0 ||
    run.researchReport?.analysis.candidateEvaluation !== undefined
  if (new Set(candidateIdentities.map(candidateKey)).size > 1) {
    candidateIssues.push("CANDIDATE_IDENTITY_MISMATCH")
  }
  const diagnostics = run.researchReport?.analysis.candidateEvaluation
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
  } else if (diagnostics !== undefined) {
    candidateIssues.push("CANDIDATE_IDENTITY_MISMATCH")
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
      const sessionOpen = Date.parse(eligibility.sessionOpen)
      const sessionClose = Date.parse(eligibility.sessionClose)
      const sessionDate = eligibility.sessionDate
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
      const eligibilityContextValid =
        eligibility.researchEligible &&
        eligibility.reason === undefined &&
        Number.isFinite(eligibilityEvaluatedAt) &&
        Number.isFinite(sessionOpen) &&
        sessionOpen < sessionClose &&
        eligibilityEvaluatedAt >= sessionOpen &&
        Number.isFinite(cycleStart) &&
        Number.isFinite(slotStartedAt) &&
        Number.isFinite(deadline) &&
        slotIsQuarterHour &&
        slotMatchesSession &&
        deadline === Math.min(slotStartedAt + 5 * 60 * 1_000, entryCutoff) &&
        eligibilityEvaluatedAt >= slotStartedAt &&
        eligibilityEvaluatedAt - slotStartedAt <= 119_999 &&
        eligibilityEvaluatedAt <= cycleStart
      if (!eligibilityContextValid) {
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

  const versionedResult = reportResult ?? retainedResult
  const evaluation = {
    evaluationVersion: RESEARCH_RUN_EVALUATION_VERSION,
    cycleId: run.cycle.cycleId,
    terminalEventId: run.ledger.terminalEventId,
    outcomeStatus: run.outcome.status,
    versions: {
      runVersion: run.runVersion,
      ...(run.researchReport === undefined
        ? {}
        : { reportVersion: run.researchReport.reportVersion }),
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
        run.researchReport?.analysis.externalContext.filter(
          ({ provider }) => provider === "EXA",
        ).length ?? 0,
      fmpSourceCount:
        run.researchReport?.analysis.externalContext.filter(
          ({ provider }) => provider === "FMP",
        ).length ?? 0,
    },
  }
  return researchRunEvaluationV1Schema.parse(evaluation)
}
