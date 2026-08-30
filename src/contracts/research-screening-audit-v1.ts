import { z } from "zod"

import { NO_ACTION_REASON_CODES } from "./research-decision-v1.js"
import { MAX_OPTION_UNIVERSE_CONTRACTS } from "./research-market-snapshot-v1.js"
import type { ResearchReportV2 } from "./research-report-v2.js"
import type {
  DebitVerticalFirstFailureReasonV1,
  ValidatedResearchSnapshotPairV1,
  SpyDebitVerticalAuditedScreeningResultV1,
} from "../strategy/directional-debit-vertical-v1.js"
import {
  computeDebitVerticalCandidateIdV1,
  DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
  DEBIT_VERTICAL_CANDIDATE_VERSION,
  DEBIT_VERTICAL_FIRST_FAILURE_REASONS,
  DEBIT_VERTICAL_FIRST_FAILURE_STAGE_BY_REASON,
  DEBIT_VERTICAL_SCREENING_DIAGNOSTICS_VERSION,
  DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
  DIRECTIONAL_TREND_FEATURE_VERSION,
} from "../strategy/directional-debit-vertical-v1.js"
import type { ResearchInvocationV1 } from "../research/research-invocation-v1.js"
import {
  RESEARCH_INVOCATION_PROVENANCE_BY_VERSION,
  SUPPORTED_RESEARCH_INVOCATION_VERSIONS,
} from "../research/research-invocation-v1.js"
import {
  SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID,
  STRATEGY_VERSION,
} from "../strategy/strategy-identity.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import {
  alpacaOptionStrikeCents,
  parseAlpacaOptionSymbol,
  spyAlpacaOptionSymbolV1Schema,
} from "../shared/alpaca-option-identity.js"

export const RESEARCH_SCREENING_AUDIT_VERSION = "1.0.0" as const
export const RESEARCH_SCREENING_COMPARISON_VERSION = "1.0.0" as const

export const RESEARCH_SCREENING_COMPARISON_CLASSES = Object.freeze([
  "IDENTICAL_INPUT_MATCH",
  "IDENTICAL_INPUT_FEATURE_MISMATCH",
  "IDENTICAL_INPUT_FILTER_MISMATCH",
  "IDENTICAL_INPUT_RANKING_MISMATCH",
  "IDENTICAL_INPUT_CANDIDATE_MISMATCH",
  "DIFFERENT_SNAPSHOT_TIME",
  "DIFFERENT_SNAPSHOT_MEMBERSHIP",
  "APPLICATION_CAPTURE_UNAVAILABLE",
  "APPLICATION_SCREENING_UNAVAILABLE",
  "AGENT_RESULT_UNAVAILABLE",
  "MODEL_IDENTITY_DRIFT",
  "COMPARISON_NOT_REPRESENTABLE",
] as const)

export const APPLICATION_CAPTURE_AUDIT_FAILURE_REASONS = Object.freeze([
  "CAPTURE_INPUT_INVALID",
  "CAPTURE_TIME_INVALID",
  "REQUEST_TIMED_OUT",
  "PROVIDER_RATE_LIMITED",
  "CALENDAR_REQUEST_FAILED",
  "CALENDAR_RESPONSE_INVALID",
  "DAILY_BARS_REQUEST_FAILED",
  "DAILY_BARS_RESPONSE_INVALID",
  "MINUTE_BARS_REQUEST_FAILED",
  "MINUTE_BARS_RESPONSE_INVALID",
  "UNDERLYING_QUOTE_REQUEST_FAILED",
  "UNDERLYING_QUOTE_RESPONSE_INVALID",
  "OPTION_CONTRACTS_REQUEST_FAILED",
  "OPTION_CONTRACTS_RESPONSE_INVALID",
  "OPTION_SNAPSHOTS_REQUEST_FAILED",
  "OPTION_SNAPSHOTS_RESPONSE_INVALID",
  "PAGINATION_INCOMPLETE",
  "DATA_CONTAMINATED",
  "INPUT_INVALID",
  "STRATEGY_MANIFEST_INCOMPATIBLE",
  "UNDERLYING_MISMATCH",
  "DUPLICATE_RECORD",
  "DATA_INCOMPLETE",
  "OBSERVATION_FROM_FUTURE",
  "OBSERVATION_STALE",
  "SNAPSHOT_INVALID",
  "UNDERLYING_SNAPSHOT_INVALID",
  "IDENTITY_MISMATCH",
  "OPTION_UNIVERSE_SNAPSHOT_INVALID",
  "SNAPSHOT_LINK_MISMATCH",
  "AUDIT_CANCELLED",
  "AUDIT_DEADLINE_EXCEEDED",
  "UNEXPECTED_FAILURE",
] as const)

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const version = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const safeCount = z.number().int().nonnegative().safe()
const durationMs = safeCount

export const researchScreeningAuditInputIdentityV1Schema = z
  .object({
    authority: z.literal("APPLICATION"),
    evaluatedAt: timestamp,
    underlyingSnapshotId: digest,
    optionUniverseSnapshotId: digest,
    optionUniverseMembershipId: digest,
    optionContractCount: safeCount.max(MAX_OPTION_UNIVERSE_CONTRACTS),
  })
  .strict()

export type ResearchScreeningAuditInputIdentityV1 = Readonly<
  z.infer<typeof researchScreeningAuditInputIdentityV1Schema>
>

const strategyIdentitySchema = z
  .object({
    strategyId: identifier,
    strategyVersion: version,
    featureComponentId: z.literal(DIRECTIONAL_TREND_FEATURE_COMPONENT_ID),
    featureVersion: z.literal(DIRECTIONAL_TREND_FEATURE_VERSION),
    candidateComponentId: z.literal(DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID),
    candidateVersion: z.literal(DEBIT_VERTICAL_CANDIDATE_VERSION),
  })
  .strict()

const firstFailureCountSchema = z
  .object({
    stage: z.enum([
      "COMPATIBILITY",
      "FEATURE",
      "FRESHNESS",
      "ELIGIBILITY",
      "LIQUIDITY",
      "ECONOMICS",
      "RANKING",
    ]),
    reason: z.enum(DEBIT_VERTICAL_FIRST_FAILURE_REASONS),
    count: z.number().int().positive().safe(),
  })
  .strict()
  .refine(
    ({ stage, reason }) =>
      DEBIT_VERTICAL_FIRST_FAILURE_STAGE_BY_REASON[reason] === stage,
    { path: ["stage"], message: "Failure stage must match its bounded reason" },
  )

const CYCLE_FAILURE_REASONS = new Set<DebitVerticalFirstFailureReasonV1>([
  "STRATEGY_MANIFEST_INCOMPATIBLE",
  "FEATURE_SIGNAL_NOT_ACTIONABLE",
  "UNDERLYING_QUOTE_STALE",
  "LATEST_MINUTE_BAR_STALE",
])
const CONTRACT_FAILURE_REASONS = new Set<DebitVerticalFirstFailureReasonV1>([
  "OPTION_TYPE_MISMATCH",
  "DTE_INVALID",
  "DTE_OUT_OF_RANGE",
  "CONTRACT_INACTIVE",
  "CONTRACT_NOT_TRADABLE",
  "EXERCISE_STYLE_UNSUPPORTED",
  "MULTIPLIER_UNSUPPORTED",
  "DELTA_OUT_OF_RANGE",
  "IMPLIED_VOLATILITY_INVALID",
  "OPTION_QUOTE_NON_POSITIVE",
  "OPTION_QUOTE_CROSSED",
  "OPTION_QUOTE_WIDTH_EXCEEDED",
  "OPTION_QUOTE_RELATIVE_WIDTH_EXCEEDED",
  "OPTION_QUOTE_STALE",
  "VOLUME_SESSION_MISMATCH",
  "VOLUME_TOO_LOW",
  "OPEN_INTEREST_TOO_LOW",
])
const PAIR_FAILURE_REASONS = new Set<DebitVerticalFirstFailureReasonV1>([
  "EXPIRATION_MISMATCH",
  "STRIKE_ORDER_INVALID",
  "SPREAD_WIDTH_OUT_OF_RANGE",
  "NON_POSITIVE_NET_DEBIT",
  "ENTRY_LIMIT_NOT_BELOW_WIDTH",
  "ARITHMETIC_OVERFLOW",
  "DEBIT_RATIO_EXCEEDED",
  "MAX_LOSS_EXCEEDED",
])

export const debitVerticalScreeningDiagnosticsV1Schema = z
  .object({
    diagnosticsVersion: z.literal(DEBIT_VERTICAL_SCREENING_DIAGNOSTICS_VERSION),
    underlyingSnapshotId: digest,
    optionUniverseSnapshotId: digest,
    inputContractCount: safeCount.max(MAX_OPTION_UNIVERSE_CONTRACTS),
    contractRoleEvaluationCount: safeCount,
    eligibleLongContractCount: safeCount,
    eligibleShortContractCount: safeCount,
    spreadPairEvaluationCount: safeCount,
    eligibleCandidateCount: safeCount,
    firstFailureCounts: z.array(firstFailureCountSchema).max(
      DEBIT_VERTICAL_FIRST_FAILURE_REASONS.length,
    ),
  })
  .strict()
  .superRefine((diagnostics, refinement) => {
    const counts = new Map(
      diagnostics.firstFailureCounts.map(({ reason, count }) => [reason, count]),
    )
    const countFor = (reasons: ReadonlySet<DebitVerticalFirstFailureReasonV1>) =>
      [...reasons].reduce((total, reason) => total + (counts.get(reason) ?? 0), 0)
    const reachedContractScreening = diagnostics.contractRoleEvaluationCount > 0
    const expectedRoleEvaluations = diagnostics.inputContractCount * 2
    const expectedPairEvaluations =
      diagnostics.eligibleLongContractCount *
      diagnostics.eligibleShortContractCount
    if (
      diagnostics.contractRoleEvaluationCount !== 0 &&
      diagnostics.contractRoleEvaluationCount !== expectedRoleEvaluations
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["contractRoleEvaluationCount"],
        message: "Contract screening must evaluate both roles exactly once",
      })
    }
    if (
      diagnostics.eligibleLongContractCount +
        diagnostics.eligibleShortContractCount >
      diagnostics.inputContractCount
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["eligibleLongContractCount"],
        message: "One contract cannot be eligible for both leg roles",
      })
    }
    if (diagnostics.spreadPairEvaluationCount !== expectedPairEvaluations) {
      refinement.addIssue({
        code: "custom",
        path: ["spreadPairEvaluationCount"],
        message: "Every eligible long/short pair must be evaluated exactly once",
      })
    }
    if (diagnostics.eligibleCandidateCount > diagnostics.spreadPairEvaluationCount) {
      refinement.addIssue({
        code: "custom",
        path: ["eligibleCandidateCount"],
        message: "Eligible candidates cannot exceed evaluated spread pairs",
      })
    }
    const contractFailureCount = countFor(CONTRACT_FAILURE_REASONS)
    const pairFailureCount = countFor(PAIR_FAILURE_REASONS)
    const cycleFailureCount = countFor(CYCLE_FAILURE_REASONS)
    const rankingFailureCount = counts.get("NOT_RANK_ONE") ?? 0
    if (
      reachedContractScreening
        ? contractFailureCount !==
            diagnostics.contractRoleEvaluationCount -
              diagnostics.eligibleLongContractCount -
              diagnostics.eligibleShortContractCount ||
          pairFailureCount !==
            diagnostics.spreadPairEvaluationCount -
              diagnostics.eligibleCandidateCount ||
          cycleFailureCount !== 0
        : diagnostics.eligibleLongContractCount !== 0 ||
          diagnostics.eligibleShortContractCount !== 0 ||
          diagnostics.spreadPairEvaluationCount !== 0 ||
          diagnostics.eligibleCandidateCount !== 0 ||
          contractFailureCount !== 0 ||
          pairFailureCount !== 0 ||
          cycleFailureCount > 1 ||
          (diagnostics.inputContractCount > 0 && cycleFailureCount !== 1)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["firstFailureCounts"],
        message: "First-failure counts must reconcile with funnel evaluations",
      })
    }
    if (rankingFailureCount !== Math.max(diagnostics.eligibleCandidateCount - 1, 0)) {
      refinement.addIssue({
        code: "custom",
        path: ["firstFailureCounts"],
        message: "Ranking failures must contain every eligible non-winner",
      })
    }
    const indexes = diagnostics.firstFailureCounts.map(({ reason }) =>
      DEBIT_VERTICAL_FIRST_FAILURE_REASONS.indexOf(reason),
    )
    if (indexes.some((value, index) => index > 0 && indexes[index - 1]! >= value)) {
      refinement.addIssue({
        code: "custom",
        path: ["firstFailureCounts"],
        message: "Failure counts must be unique and canonically ordered",
      })
    }
  })

type CandidateLegIdentity = Readonly<{
  direction: "BULLISH" | "BEARISH"
  structure: "BULL_CALL_SPREAD" | "BEAR_PUT_SPREAD"
  expiration: string
  longContractSymbol: string
  shortContractSymbol: string
}>

const candidateLegWidthCents = (candidate: CandidateLegIdentity) => {
  const long = parseAlpacaOptionSymbol(candidate.longContractSymbol)
  const short = parseAlpacaOptionSymbol(candidate.shortContractSymbol)
  if (!long.success || !short.success) return undefined
  const longStrike = alpacaOptionStrikeCents(long.identity)
  const shortStrike = alpacaOptionStrikeCents(short.identity)
  if (!longStrike.success || !shortStrike.success) return undefined
  const bullish = candidate.direction === "BULLISH"
  const expectedStructure = bullish ? "BULL_CALL_SPREAD" : "BEAR_PUT_SPREAD"
  const expectedOptionType = bullish ? "C" : "P"
  if (
    candidate.structure !== expectedStructure ||
    long.identity.optionType !== expectedOptionType ||
    short.identity.optionType !== expectedOptionType ||
    long.identity.expiration !== candidate.expiration ||
    short.identity.expiration !== candidate.expiration ||
    candidate.longContractSymbol === candidate.shortContractSymbol ||
    (bullish
      ? longStrike.strikeCentsPerShare >= shortStrike.strikeCentsPerShare
      : longStrike.strikeCentsPerShare <= shortStrike.strikeCentsPerShare)
  ) return undefined
  return Math.abs(
    longStrike.strikeCentsPerShare - shortStrike.strikeCentsPerShare,
  )
}

const selectedApplicationResultSchema = z
  .object({
    status: z.literal("SELECTED"),
    candidateId: digest,
    direction: z.enum(["BULLISH", "BEARISH"]),
    structure: z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]),
    expirationDate: z.iso.date(),
    dte: safeCount.min(14).max(30),
    widthCentsPerShare: z.number().int().min(100).max(1_000),
    longContractSymbol: spyAlpacaOptionSymbolV1Schema,
    shortContractSymbol: spyAlpacaOptionSymbolV1Schema,
    eligibleCandidateCount: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((candidate, refinement) => {
    const width = candidateLegWidthCents({
      ...candidate,
      expiration: candidate.expirationDate,
    })
    if (width === undefined || width !== candidate.widthCentsPerShare) {
      refinement.addIssue({
        code: "custom",
        path: ["longContractSymbol"],
        message: "Selected leg identity and spread width must be coherent",
      })
    }
  })

const noActionApplicationResultSchema = z
  .object({
    status: z.literal("NO_ACTION"),
    reason: z.enum([
      "SIGNAL_NOT_ACTIONABLE",
      "MARKET_DATA_STALE",
      "NO_ELIGIBLE_SPREAD",
      "STRATEGY_MANIFEST_INCOMPATIBLE",
    ]),
  })
  .strict()

export const applicationResearchScreeningAuditV1Schema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("CAPTURE_UNAVAILABLE"),
        captureDurationMs: durationMs,
        reasons: z
          .array(z.enum(APPLICATION_CAPTURE_AUDIT_FAILURE_REASONS))
          .min(1)
          .max(APPLICATION_CAPTURE_AUDIT_FAILURE_REASONS.length),
      })
      .strict(),
    z
      .object({
        status: z.literal("SCREENING_UNAVAILABLE"),
        captureDurationMs: durationMs,
        screeningDurationMs: durationMs,
        inputIdentity: researchScreeningAuditInputIdentityV1Schema,
        strategy: strategyIdentitySchema,
        reason: z.enum(["FEATURE_INPUT_INVALID", "UNEXPECTED_FAILURE"]),
      })
      .strict(),
    z
      .object({
        status: z.literal("SCREENED"),
        captureDurationMs: durationMs,
        screeningDurationMs: durationMs,
        inputIdentity: researchScreeningAuditInputIdentityV1Schema,
        strategy: strategyIdentitySchema,
        result: z.discriminatedUnion("status", [
          selectedApplicationResultSchema,
          noActionApplicationResultSchema,
        ]),
        diagnostics: debitVerticalScreeningDiagnosticsV1Schema,
      })
      .strict()
      .superRefine((audit, refinement) => {
        if (
          audit.inputIdentity.optionContractCount !==
            audit.diagnostics.inputContractCount ||
          audit.inputIdentity.underlyingSnapshotId !==
            audit.diagnostics.underlyingSnapshotId ||
          audit.inputIdentity.optionUniverseSnapshotId !==
            audit.diagnostics.optionUniverseSnapshotId
        ) {
          refinement.addIssue({
            code: "custom",
            path: ["diagnostics"],
            message: "Diagnostics must identify the captured snapshot pair",
          })
        }
        const requiresCompatibleStrategy = audit.result.status === "SELECTED" ||
          audit.result.reason !== "STRATEGY_MANIFEST_INCOMPATIBLE"
        if (
          requiresCompatibleStrategy &&
          (audit.strategy.strategyId !==
              SPY_DIRECTIONAL_DEBIT_VERTICAL_STRATEGY_ID ||
            audit.strategy.strategyVersion !== STRATEGY_VERSION)
        ) {
          refinement.addIssue({
            code: "custom",
            path: ["strategy"],
            message: "Completed screening requires the compatible V1 strategy",
          })
        }
        const expectedCandidates = audit.result.status === "SELECTED"
          ? audit.result.eligibleCandidateCount
          : 0
        if (audit.diagnostics.eligibleCandidateCount !== expectedCandidates) {
          refinement.addIssue({
            code: "custom",
            path: ["diagnostics", "eligibleCandidateCount"],
            message: "Diagnostic and screening candidate counts must match",
          })
        }
        const failureCount = (reason: DebitVerticalFirstFailureReasonV1) =>
          audit.diagnostics.firstFailureCounts.find(
            (failure) => failure.reason === reason,
          )?.count ?? 0
        if (audit.result.status === "NO_ACTION") {
          const cycleFailureCount = [...CYCLE_FAILURE_REASONS].reduce(
            (total, reason) => total + failureCount(reason),
            0,
          )
          const reasonMatches = audit.result.reason ===
              "STRATEGY_MANIFEST_INCOMPATIBLE"
            ? failureCount("STRATEGY_MANIFEST_INCOMPATIBLE") === 1
            : audit.result.reason === "SIGNAL_NOT_ACTIONABLE"
              ? failureCount("FEATURE_SIGNAL_NOT_ACTIONABLE") === 1
              : audit.result.reason === "MARKET_DATA_STALE"
                ? failureCount("UNDERLYING_QUOTE_STALE") +
                    failureCount("LATEST_MINUTE_BAR_STALE") === 1
                : cycleFailureCount === 0 &&
                  audit.diagnostics.contractRoleEvaluationCount ===
                    audit.diagnostics.inputContractCount * 2
          if (!reasonMatches) {
            refinement.addIssue({
              code: "custom",
              path: ["result", "reason"],
              message: "No-action reason must match the recorded stopping stage",
            })
          }
        }
        if (audit.result.status === "SELECTED") {
          const sessionDate = audit.inputIdentity.evaluatedAt.slice(0, 10)
          const expectedDte = (
            Date.parse(`${audit.result.expirationDate}T00:00:00.000Z`) -
            Date.parse(`${sessionDate}T00:00:00.000Z`)
          ) / 86_400_000
          if (audit.result.dte !== expectedDte) {
            refinement.addIssue({
              code: "custom",
              path: ["result", "dte"],
              message: "Selected DTE must match evaluation and expiration dates",
            })
          }
          const expectedCandidateId = computeDebitVerticalCandidateIdV1({
            underlyingSnapshotId: audit.inputIdentity.underlyingSnapshotId,
            optionUniverseSnapshotId:
              audit.inputIdentity.optionUniverseSnapshotId,
            ...audit.strategy,
            underlying: "SPY",
            direction: audit.result.direction,
            structure: audit.result.structure,
            expirationDate: audit.result.expirationDate,
            longLeg: { contractSymbol: audit.result.longContractSymbol },
            shortLeg: { contractSymbol: audit.result.shortContractSymbol },
          })
          if (audit.result.candidateId !== expectedCandidateId) {
            refinement.addIssue({
              code: "custom",
              path: ["result", "candidateId"],
              message: "Selected candidate ID must bind its retained identity",
            })
          }
        }
      }),
  ],
)

export type ApplicationResearchScreeningAuditV1 = Readonly<
  z.infer<typeof applicationResearchScreeningAuditV1Schema>
>

const agentCandidateIdentitySchema = z
  .object({
    direction: z.enum(["BULLISH", "BEARISH"]),
    underlying: z.literal("SPY"),
    structure: z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]),
    expiration: z.iso.date(),
    longContractSymbol: spyAlpacaOptionSymbolV1Schema,
    shortContractSymbol: spyAlpacaOptionSymbolV1Schema,
  })
  .strict()
  .superRefine((candidate, refinement) => {
    if (candidateLegWidthCents(candidate) === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["longContractSymbol"],
        message: "Agent candidate leg identity must be coherent",
      })
    }
  })

const agentEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("SNAPSHOT"),
      snapshotRef: identifier,
    })
    .strict(),
  z
    .object({
      kind: z.literal("OBSERVATION"),
      claimId: identifier,
      provider: z.enum(["ALPACA", "EXA", "FMP"]),
      observedAt: timestamp,
    })
    .strict(),
  z
    .object({
      kind: z.literal("EXTERNAL"),
      sourceId: identifier,
      provider: z.enum(["EXA", "FMP"]),
      observedAt: timestamp,
      retrievedAt: timestamp,
    })
    .strict(),
])

const availableAgentAuditSchema = z
  .object({
    status: z.literal("AVAILABLE"),
    invocation: z
      .object({
        invocationVersion: z.enum(SUPPORTED_RESEARCH_INVOCATION_VERSIONS),
        providerId: identifier,
        modelId: identifier,
      })
      .strict(),
    reportVersion: z.literal("2.0.0"),
    asOf: timestamp,
    terminalClass: z.enum([
      "NO_ACTION",
      "PRELIMINARY_RESEARCH",
      "PROPOSE_TRADE",
    ]),
    evidenceReferences: z.array(agentEvidenceReferenceSchema).max(72),
    noActionReasonCodes: z
      .array(z.enum(NO_ACTION_REASON_CODES))
      .min(1)
      .max(NO_ACTION_REASON_CODES.length)
      .optional(),
    proposalCandidate: agentCandidateIdentitySchema.optional(),
  })
  .strict()
  .superRefine((audit, refinement) => {
    const expectedInvocation =
      RESEARCH_INVOCATION_PROVENANCE_BY_VERSION[
        audit.invocation.invocationVersion
      ]
    if (
      "providerId" in expectedInvocation &&
      (audit.invocation.providerId !== expectedInvocation.providerId ||
        audit.invocation.modelId !== expectedInvocation.modelId)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["invocation"],
        message: "Available result must match its pinned model identity",
      })
    }
    if ((audit.terminalClass === "NO_ACTION") !==
      (audit.noActionReasonCodes !== undefined)) {
      refinement.addIssue({
        code: "custom",
        path: ["noActionReasonCodes"],
        message: "Only no-action results retain no-action reasons",
      })
    }
    if (audit.terminalClass === "PROPOSE_TRADE" &&
      audit.proposalCandidate === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["proposalCandidate"],
        message: "Trade proposals require bounded candidate identity",
      })
    }
    if (audit.terminalClass === "NO_ACTION" &&
      audit.proposalCandidate !== undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["proposalCandidate"],
        message: "No-action results cannot retain candidate identity",
      })
    }
  })

export const agentResearchScreeningAuditV1Schema = z.discriminatedUnion(
  "status",
  [
    availableAgentAuditSchema,
    z
      .object({
        status: z.literal("MODEL_IDENTITY_DRIFT"),
        reason: z.enum(["PROVIDER_DRIFT", "MODEL_DRIFT"]),
        expected: identifier,
        observed: identifier,
      })
      .strict(),
    z
      .object({
        status: z.literal("UNAVAILABLE"),
        reason: z.enum([
          "INVOCATION_FAILED",
          "REPORT_REJECTED",
          "AUDIT_CANCELLED",
          "UNEXPECTED_FAILURE",
        ]),
      })
      .strict(),
  ],
)

export type AgentResearchScreeningAuditV1 = Readonly<
  z.infer<typeof agentResearchScreeningAuditV1Schema>
>

export const identicalInputParityChecksV1Schema = z
  .object({
    feature: z.enum(["MATCH", "MISMATCH", "UNAVAILABLE"]),
    filter: z.enum(["MATCH", "MISMATCH", "UNAVAILABLE"]),
    ranking: z.enum(["MATCH", "MISMATCH", "UNAVAILABLE"]),
    candidate: z.enum(["MATCH", "MISMATCH", "UNAVAILABLE"]),
  })
  .strict()

export type IdenticalInputParityChecksV1 = Readonly<
  z.infer<typeof identicalInputParityChecksV1Schema>
>
export type ResearchScreeningComparisonClassV1 =
  (typeof RESEARCH_SCREENING_COMPARISON_CLASSES)[number]

export const researchScreeningComparisonV1Schema = z
  .object({
    comparisonVersion: z.literal(RESEARCH_SCREENING_COMPARISON_VERSION),
    class: z.enum(RESEARCH_SCREENING_COMPARISON_CLASSES),
    identicalInputChecks: identicalInputParityChecksV1Schema.optional(),
  })
  .strict()
  .superRefine((comparison, refinement) => {
    const identicalClass = comparison.class.startsWith("IDENTICAL_INPUT_")
    if (identicalClass && comparison.identicalInputChecks === undefined) {
      refinement.addIssue({
        code: "custom",
        path: ["identicalInputChecks"],
        message: "Identical-input classifications require parity checks",
      })
    }
    if (
      !identicalClass &&
      comparison.class !== "COMPARISON_NOT_REPRESENTABLE" &&
      comparison.identicalInputChecks !== undefined
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["identicalInputChecks"],
        message: "Non-identical comparisons cannot retain parity checks",
      })
    }
  })

export type ResearchScreeningComparisonV1 = Readonly<
  z.infer<typeof researchScreeningComparisonV1Schema>
>

export const researchScreeningAuditV1Schema = z
  .object({
    auditVersion: z.literal(RESEARCH_SCREENING_AUDIT_VERSION),
    application: applicationResearchScreeningAuditV1Schema,
    agent: agentResearchScreeningAuditV1Schema,
    trustedAgentInputIdentity: researchScreeningAuditInputIdentityV1Schema.optional(),
    comparison: researchScreeningComparisonV1Schema,
  })
  .strict()
  .superRefine((audit, refinement) => {
    if (audit.comparison.identicalInputChecks !== undefined) {
      const applicationIdentity = audit.application.status === "SCREENED"
        ? audit.application.inputIdentity
        : undefined
      const agentIdentity = audit.trustedAgentInputIdentity
      if (
        applicationIdentity === undefined ||
        audit.agent.status !== "AVAILABLE" ||
        agentIdentity === undefined ||
        agentIdentity.evaluatedAt !== applicationIdentity.evaluatedAt ||
        agentIdentity.optionUniverseMembershipId !==
          applicationIdentity.optionUniverseMembershipId ||
        agentIdentity.optionContractCount !== applicationIdentity.optionContractCount ||
        agentIdentity.underlyingSnapshotId !== applicationIdentity.underlyingSnapshotId ||
        agentIdentity.optionUniverseSnapshotId !==
          applicationIdentity.optionUniverseSnapshotId
      ) {
        refinement.addIssue({
          code: "custom",
          path: ["comparison", "identicalInputChecks"],
          message: "Parity checks require identical application-owned input identity",
        })
      }
    }
    const expected = classifyResearchScreeningComparisonV1({
      application: audit.application,
      agent: audit.agent,
      ...(audit.trustedAgentInputIdentity === undefined
        ? {}
        : { trustedAgentInputIdentity: audit.trustedAgentInputIdentity }),
      ...(audit.comparison.identicalInputChecks === undefined
        ? {}
        : { identicalInputChecks: audit.comparison.identicalInputChecks }),
    })
    if (expected.class !== audit.comparison.class) {
      refinement.addIssue({
        code: "custom",
        path: ["comparison", "class"],
        message: "Comparison class must match the retained audit evidence",
      })
    }
  })

export type ResearchScreeningAuditV1 = Readonly<
  z.infer<typeof researchScreeningAuditV1Schema>
>

export const createResearchScreeningAuditInputIdentityV1 = (
  pair: ValidatedResearchSnapshotPairV1,
): ResearchScreeningAuditInputIdentityV1 =>
  researchScreeningAuditInputIdentityV1Schema.parse({
    authority: "APPLICATION",
    evaluatedAt: pair.underlying.times.evaluatedAt,
    underlyingSnapshotId: pair.underlying.snapshotId,
    optionUniverseSnapshotId: pair.optionUniverse.snapshotId,
    optionUniverseMembershipId: canonicalJsonSha256({
      domain: "research-screening-option-membership-v1",
      contractSymbols: pair.optionUniverse.contracts.map(
        ({ contractSymbol }) => contractSymbol,
      ),
    }),
    optionContractCount: pair.optionUniverse.contracts.length,
  })

const strategyIdentity = (pair: ValidatedResearchSnapshotPairV1) => ({
  strategyId: pair.underlying.strategyManifest.strategyId,
  strategyVersion: pair.underlying.strategyManifest.strategyVersion,
  featureComponentId: DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
  featureVersion: DIRECTIONAL_TREND_FEATURE_VERSION,
  candidateComponentId: DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
  candidateVersion: DEBIT_VERTICAL_CANDIDATE_VERSION,
})

export function createApplicationResearchScreeningAuditV1(options: Readonly<{
  pair: ValidatedResearchSnapshotPairV1
  audited: SpyDebitVerticalAuditedScreeningResultV1
  captureDurationMs: number
  screeningDurationMs: number
}>): ApplicationResearchScreeningAuditV1 {
  const result = options.audited.result
  if (
    options.audited.diagnostics.underlyingSnapshotId !==
      options.pair.underlying.snapshotId ||
    options.audited.diagnostics.optionUniverseSnapshotId !==
      options.pair.optionUniverse.snapshotId ||
    (result.status === "SELECTED" && (
      result.selectedCandidate.underlyingSnapshotId !==
        options.pair.underlying.snapshotId ||
      result.selectedCandidate.optionUniverseSnapshotId !==
        options.pair.optionUniverse.snapshotId ||
      result.selectedCandidate.candidateId !==
        computeDebitVerticalCandidateIdV1(result.selectedCandidate)
    ))
  ) {
    throw new Error("Audited screening result does not match its snapshot pair")
  }
  return applicationResearchScreeningAuditV1Schema.parse({
    status: "SCREENED",
    captureDurationMs: options.captureDurationMs,
    screeningDurationMs: options.screeningDurationMs,
    inputIdentity: createResearchScreeningAuditInputIdentityV1(options.pair),
    strategy: strategyIdentity(options.pair),
    result: result.status === "NO_ACTION"
      ? { status: result.status, reason: result.reason }
      : {
          status: result.status,
          candidateId: result.selectedCandidate.candidateId,
          direction: result.selectedCandidate.direction,
          structure: result.selectedCandidate.structure,
          expirationDate: result.selectedCandidate.expirationDate,
          dte: result.selectedCandidate.dte,
          widthCentsPerShare: result.selectedCandidate.economics.widthCentsPerShare,
          longContractSymbol: result.selectedCandidate.longLeg.contractSymbol,
          shortContractSymbol: result.selectedCandidate.shortLeg.contractSymbol,
          eligibleCandidateCount: result.eligibleCandidateCount,
        },
    diagnostics: options.audited.diagnostics,
  })
}

export function createApplicationCaptureUnavailableAuditV1(
  reasons: readonly (typeof APPLICATION_CAPTURE_AUDIT_FAILURE_REASONS)[number][],
  captureDurationMs: number,
): ApplicationResearchScreeningAuditV1 {
  const ordered = APPLICATION_CAPTURE_AUDIT_FAILURE_REASONS.filter((reason) =>
    reasons.includes(reason),
  )
  return applicationResearchScreeningAuditV1Schema.parse({
    status: "CAPTURE_UNAVAILABLE",
    captureDurationMs,
    reasons: ordered,
  })
}

export function createApplicationScreeningUnavailableAuditV1(options: Readonly<{
  pair: ValidatedResearchSnapshotPairV1
  captureDurationMs: number
  screeningDurationMs: number
  reason: "FEATURE_INPUT_INVALID" | "UNEXPECTED_FAILURE"
}>): ApplicationResearchScreeningAuditV1 {
  return applicationResearchScreeningAuditV1Schema.parse({
    status: "SCREENING_UNAVAILABLE",
    captureDurationMs: options.captureDurationMs,
    screeningDurationMs: options.screeningDurationMs,
    inputIdentity: createResearchScreeningAuditInputIdentityV1(options.pair),
    strategy: strategyIdentity(options.pair),
    reason: options.reason,
  })
}

const candidateIdentity = (
  result: ResearchReportV2["result"],
) => {
  const candidate = result.outcome === "PROPOSE_TRADE"
    ? result.candidate
    : result.outcome === "PRELIMINARY_RESEARCH"
      ? result.candidate
      : undefined
  const direction = result.outcome === "PROPOSE_TRADE"
    ? result.direction
    : result.outcome === "PRELIMINARY_RESEARCH" &&
        result.direction !== "UNDETERMINED"
      ? result.direction
      : undefined
  return candidate === undefined || direction === undefined
    ? undefined
    : {
        direction,
        underlying: candidate.underlying,
        structure: candidate.structure,
        expiration: candidate.expiration,
        longContractSymbol: candidate.longLeg.contractSymbol,
        shortContractSymbol: candidate.shortLeg.contractSymbol,
      }
}

export function projectResearchReportV2ForScreeningAudit(
  report: ResearchReportV2,
  invocation: ResearchInvocationV1,
): AgentResearchScreeningAuditV1 {
  const resultReferences: z.infer<typeof agentEvidenceReferenceSchema>[] = []
  for (const claim of report.result.evidence) {
    if (claim.kind !== "SOURCED_FACT") continue
    resultReferences.push(
      "snapshotRef" in claim
        ? { kind: "SNAPSHOT", snapshotRef: claim.snapshotRef }
        : {
            kind: "OBSERVATION",
            claimId: claim.claimId,
            provider: claim.provider,
            observedAt: claim.observedAt,
          },
    )
  }
  const externalReferences = report.analysis.externalContext.map((source) => ({
    kind: "EXTERNAL" as const,
    sourceId: source.sourceId,
    provider: source.provider,
    observedAt: source.provider === "EXA" ? source.publishedAt : source.observedAt,
    retrievedAt: source.retrievedAt,
  }))
  return agentResearchScreeningAuditV1Schema.parse({
    status: "AVAILABLE",
    invocation: {
      invocationVersion: invocation.invocationVersion,
      providerId: invocation.providerId,
      modelId: invocation.modelId,
    },
    reportVersion: report.reportVersion,
    asOf: report.analysis.asOf,
    terminalClass: report.result.outcome,
    evidenceReferences: [...resultReferences, ...externalReferences],
    ...(report.result.outcome === "NO_ACTION"
      ? { noActionReasonCodes: report.result.reasonCodes }
      : {}),
    ...(candidateIdentity(report.result) === undefined
      ? {}
      : { proposalCandidate: candidateIdentity(report.result) }),
  })
}

export function classifyResearchScreeningComparisonV1(options: Readonly<{
  application: ApplicationResearchScreeningAuditV1
  agent: AgentResearchScreeningAuditV1
  trustedAgentInputIdentity?: ResearchScreeningAuditInputIdentityV1
  identicalInputChecks?: IdenticalInputParityChecksV1
}>): ResearchScreeningComparisonV1 {
  const comparison = (
    value: ResearchScreeningComparisonClassV1,
    retainChecks = false,
  ) => researchScreeningComparisonV1Schema.parse({
    comparisonVersion: RESEARCH_SCREENING_COMPARISON_VERSION,
    class: value,
    ...(!retainChecks || options.identicalInputChecks === undefined
      ? {}
      : { identicalInputChecks: options.identicalInputChecks }),
  })
  if (options.application.status === "CAPTURE_UNAVAILABLE") {
    return comparison("APPLICATION_CAPTURE_UNAVAILABLE")
  }
  if (options.application.status === "SCREENING_UNAVAILABLE") {
    return comparison("APPLICATION_SCREENING_UNAVAILABLE")
  }
  if (options.agent.status === "MODEL_IDENTITY_DRIFT") {
    return comparison("MODEL_IDENTITY_DRIFT")
  }
  if (options.agent.status === "UNAVAILABLE") {
    return comparison("AGENT_RESULT_UNAVAILABLE")
  }

  const applicationIdentity = options.application.inputIdentity
  const agentTime = options.trustedAgentInputIdentity?.evaluatedAt ?? options.agent.asOf
  if (agentTime !== applicationIdentity.evaluatedAt) {
    return comparison("DIFFERENT_SNAPSHOT_TIME")
  }
  const agentIdentity = options.trustedAgentInputIdentity
  if (agentIdentity === undefined) return comparison("COMPARISON_NOT_REPRESENTABLE")
  if (
    agentIdentity.optionUniverseMembershipId !==
      applicationIdentity.optionUniverseMembershipId ||
    agentIdentity.optionContractCount !== applicationIdentity.optionContractCount
  ) {
    return comparison("DIFFERENT_SNAPSHOT_MEMBERSHIP")
  }
  if (
    agentIdentity.underlyingSnapshotId !== applicationIdentity.underlyingSnapshotId ||
    agentIdentity.optionUniverseSnapshotId !== applicationIdentity.optionUniverseSnapshotId
  ) {
    return comparison("COMPARISON_NOT_REPRESENTABLE")
  }
  const checks = options.identicalInputChecks
  if (checks === undefined) return comparison("COMPARISON_NOT_REPRESENTABLE")
  for (const [stage, mismatch] of [
    ["feature", "IDENTICAL_INPUT_FEATURE_MISMATCH"],
    ["filter", "IDENTICAL_INPUT_FILTER_MISMATCH"],
    ["ranking", "IDENTICAL_INPUT_RANKING_MISMATCH"],
    ["candidate", "IDENTICAL_INPUT_CANDIDATE_MISMATCH"],
  ] as const) {
    if (checks[stage] === "UNAVAILABLE") {
      return comparison("COMPARISON_NOT_REPRESENTABLE", true)
    }
    if (checks[stage] === "MISMATCH") return comparison(mismatch, true)
  }
  return comparison("IDENTICAL_INPUT_MATCH", true)
}

export function createResearchScreeningAuditV1(options: Readonly<{
  application: ApplicationResearchScreeningAuditV1
  agent: AgentResearchScreeningAuditV1
  trustedAgentInputIdentity?: ResearchScreeningAuditInputIdentityV1
  identicalInputChecks?: IdenticalInputParityChecksV1
}>): ResearchScreeningAuditV1 {
  return researchScreeningAuditV1Schema.parse({
    auditVersion: RESEARCH_SCREENING_AUDIT_VERSION,
    application: options.application,
    agent: options.agent,
    ...(options.trustedAgentInputIdentity === undefined
      ? {}
      : { trustedAgentInputIdentity: options.trustedAgentInputIdentity }),
    comparison: classifyResearchScreeningComparisonV1(options),
  })
}
