import { z } from "zod"

import {
  researchSnapshotIdV1Schema,
  researchSnapshotUtcTimestampV1Schema,
} from "./research-market-snapshot-v1.js"
import {
  RESEARCH_MODEL_IDENTITY,
} from "../research/research-invocation-v1.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import {
  alpacaOptionSymbolSchema,
  parseAlpacaOptionSymbol,
} from "../shared/alpaca-option-identity.js"
import {
  DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
  DEBIT_VERTICAL_CANDIDATE_CONTRACT_VERSION,
  DEBIT_VERTICAL_CANDIDATE_VERSION,
  computeDebitVerticalCandidateIdV1,
  DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
  DIRECTIONAL_TREND_FEATURE_VERSION,
  type SpyDebitVerticalScreeningResultV1,
} from "../strategy/directional-debit-vertical-v1.js"
import {
  checkStrategyManifestCompatibility,
  type StrategyComponentManifestV1,
} from "../strategy/strategy-registry.js"

export const RESEARCH_PLAN_VERSION = "1.0.0" as const
export const QUALITATIVE_RESEARCH_SKILL_NAME =
  "options-qualitative-research" as const
export const QUALITATIVE_RESEARCH_SKILL_VERSION = "1.0.0" as const

export const MAX_RESEARCH_PLAN_QUESTIONS = 8
export const MAX_RESEARCH_PLAN_ISSUANCE_DELAY_MS = 60_000
export const MAX_RESEARCH_PLAN_DURATION_MS = 10 * 60_000
export const MAX_QUALITATIVE_TOOL_CALLS = 32
export const MAX_QUALITATIVE_EXA_CALLS = 4
export const MAX_QUALITATIVE_FMP_CALLS = 3

const boundedIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const boundedVersion = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
const boundedQuestion = z.string().trim().min(1).max(500)
const underlyingSymbol = z.string().regex(/^[A-Z0-9]{1,6}$/u)

const researchPlanContentV1Schema = z
  .object({
    planVersion: z.literal(RESEARCH_PLAN_VERSION),
    issuedAt: researchSnapshotUtcTimestampV1Schema,
    responseDeadline: researchSnapshotUtcTimestampV1Schema,
    invocation: z
      .object({
        providerId: boundedIdentifier,
        modelId: boundedIdentifier,
        skillName: boundedIdentifier,
        skillVersion: boundedVersion,
      })
      .strict(),
    strategy: z
      .object({
        manifestVersion: boundedVersion,
        strategyId: boundedIdentifier,
        strategyVersion: boundedVersion,
        featureComponentId: boundedIdentifier,
        featureComponentVersion: boundedVersion,
        candidateComponentId: boundedIdentifier,
        candidateComponentVersion: boundedVersion,
      })
      .strict(),
    underlying: underlyingSymbol,
    snapshot: z
      .object({
        underlyingSnapshotId: researchSnapshotIdV1Schema,
        optionUniverseSnapshotId: researchSnapshotIdV1Schema,
        evaluatedAt: researchSnapshotUtcTimestampV1Schema,
      })
      .strict(),
    candidate: z
      .object({
        candidateId: researchSnapshotIdV1Schema,
        underlyingSnapshotId: researchSnapshotIdV1Schema,
        optionUniverseSnapshotId: researchSnapshotIdV1Schema,
        direction: z.enum(["BULLISH", "BEARISH"]),
        structure: z.enum(["BULL_CALL_SPREAD", "BEAR_PUT_SPREAD"]),
        expirationDate: z.iso.date(),
        longContractSymbol: alpacaOptionSymbolSchema,
        shortContractSymbol: alpacaOptionSymbolSchema,
      })
      .strict(),
    evidencePolicy: z
      .object({
        questions: z
          .array(
            z
              .object({
                questionId: boundedIdentifier,
                question: boundedQuestion,
              })
              .strict(),
          )
          .min(1)
          .max(MAX_RESEARCH_PLAN_QUESTIONS),
        requireContradictionSearch: z.boolean(),
        maximumTotalToolCalls: z
          .number()
          .int()
          .positive()
          .max(MAX_QUALITATIVE_TOOL_CALLS),
        minimumDirectionalExaSources: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_QUALITATIVE_EXA_CALLS),
        minimumCompletedExaCalls: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_QUALITATIVE_EXA_CALLS),
        maximumExaCalls: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_QUALITATIVE_EXA_CALLS),
        maximumFmpCalls: z
          .number()
          .int()
          .nonnegative()
          .max(MAX_QUALITATIVE_FMP_CALLS),
        currentEvidenceRetrievedAfter: researchSnapshotUtcTimestampV1Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, refinement) => {
    const snapshotEvaluatedAt = Date.parse(plan.snapshot.evaluatedAt)
    const issuedAt = Date.parse(plan.issuedAt)
    const responseDeadline = Date.parse(plan.responseDeadline)
    if (
      snapshotEvaluatedAt > issuedAt ||
      issuedAt - snapshotEvaluatedAt > MAX_RESEARCH_PLAN_ISSUANCE_DELAY_MS ||
      issuedAt >= responseDeadline ||
      responseDeadline - issuedAt > MAX_RESEARCH_PLAN_DURATION_MS
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["responseDeadline"],
        message: "Snapshot, issuance, and deadline bounds are invalid",
      })
    }
    if (
      Date.parse(plan.evidencePolicy.currentEvidenceRetrievedAfter) <
        Date.parse(plan.issuedAt) ||
      Date.parse(plan.evidencePolicy.currentEvidenceRetrievedAfter) >
        Date.parse(plan.responseDeadline)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["evidencePolicy", "currentEvidenceRetrievedAfter"],
        message: "Evidence freshness floor must fall within the plan window",
      })
    }
    if (
      plan.candidate.underlyingSnapshotId !==
        plan.snapshot.underlyingSnapshotId ||
      plan.candidate.optionUniverseSnapshotId !==
        plan.snapshot.optionUniverseSnapshotId
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "Candidate snapshot references must match the plan snapshot",
      })
    }
    const expectedStructure =
      plan.candidate.direction === "BULLISH"
        ? "BULL_CALL_SPREAD"
        : "BEAR_PUT_SPREAD"
    if (plan.candidate.structure !== expectedStructure) {
      refinement.addIssue({
        code: "custom",
        path: ["candidate", "structure"],
        message: "Candidate structure must match its direction",
      })
    }
    const longIdentity = parseAlpacaOptionSymbol(
      plan.candidate.longContractSymbol,
    )
    const shortIdentity = parseAlpacaOptionSymbol(
      plan.candidate.shortContractSymbol,
    )
    const expectedOptionType =
      plan.candidate.structure === "BULL_CALL_SPREAD" ? "C" : "P"
    if (
      !longIdentity.success ||
      !shortIdentity.success ||
      longIdentity.identity.root !== plan.underlying ||
      shortIdentity.identity.root !== plan.underlying ||
      longIdentity.identity.expiration !== plan.candidate.expirationDate ||
      shortIdentity.identity.expiration !== plan.candidate.expirationDate ||
      longIdentity.identity.optionType !== expectedOptionType ||
      shortIdentity.identity.optionType !== expectedOptionType ||
      longIdentity.identity.brokerSymbol === shortIdentity.identity.brokerSymbol ||
      (expectedOptionType === "C"
        ? longIdentity.identity.strikeThousandthsPerShare >=
          shortIdentity.identity.strikeThousandthsPerShare
        : longIdentity.identity.strikeThousandthsPerShare <=
          shortIdentity.identity.strikeThousandthsPerShare)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "Candidate OCC identity does not match the plan",
      })
    }

    if (
      plan.strategy.candidateComponentId ===
        DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID &&
      plan.strategy.candidateComponentVersion ===
        DEBIT_VERTICAL_CANDIDATE_VERSION &&
      plan.underlying === "SPY" &&
      plan.candidate.candidateId !==
        computeDebitVerticalCandidateIdV1({
          underlyingSnapshotId: plan.snapshot.underlyingSnapshotId,
          optionUniverseSnapshotId: plan.snapshot.optionUniverseSnapshotId,
          strategyId: plan.strategy.strategyId,
          strategyVersion: plan.strategy.strategyVersion,
          featureComponentId: plan.strategy.featureComponentId,
          featureVersion: plan.strategy.featureComponentVersion,
          candidateComponentId: plan.strategy.candidateComponentId,
          candidateVersion: plan.strategy.candidateComponentVersion,
          underlying: plan.underlying,
          direction: plan.candidate.direction,
          structure: plan.candidate.structure,
          expirationDate: plan.candidate.expirationDate,
          longLeg: { contractSymbol: plan.candidate.longContractSymbol },
          shortLeg: { contractSymbol: plan.candidate.shortContractSymbol },
        })
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["candidate", "candidateId"],
        message: "Candidate identity does not match its deterministic content",
      })
    }

    const questionIds = plan.evidencePolicy.questions.map(
      ({ questionId }) => questionId,
    )
    if (new Set(questionIds).size !== questionIds.length) {
      refinement.addIssue({
        code: "custom",
        path: ["evidencePolicy", "questions"],
        message: "Research plan question identifiers must be unique",
      })
    }
    if (
      plan.evidencePolicy.minimumCompletedExaCalls + 1 >
        plan.evidencePolicy.maximumTotalToolCalls
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["evidencePolicy", "maximumTotalToolCalls"],
        message: "Total tool budget cannot satisfy required skill and Exa calls",
      })
    }
    if (
      plan.evidencePolicy.minimumDirectionalExaSources >
        plan.evidencePolicy.maximumExaCalls ||
      plan.evidencePolicy.minimumCompletedExaCalls >
        plan.evidencePolicy.maximumExaCalls ||
      (plan.evidencePolicy.requireContradictionSearch &&
        plan.evidencePolicy.minimumCompletedExaCalls < 2)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["evidencePolicy", "maximumExaCalls"],
        message: "Exa budget cannot satisfy the declared evidence policy",
      })
    }
  })

export type ResearchPlanContentV1 = Readonly<
  z.infer<typeof researchPlanContentV1Schema>
>

export const computeResearchPlanIdV1 = (content: ResearchPlanContentV1) =>
  canonicalJsonSha256({
    domain: "research-plan-v1",
    content,
  })

export const researchPlanV1Schema = researchPlanContentV1Schema
  .extend({ planId: researchSnapshotIdV1Schema })
  .strict()
  .superRefine((plan, refinement) => {
    const { planId: _planId, ...content } = plan
    if (plan.planId !== computeResearchPlanIdV1(content)) {
      refinement.addIssue({
        code: "custom",
        path: ["planId"],
        message: "Research plan identity does not match its content",
      })
    }
  })

export type ResearchPlanV1 = Readonly<z.infer<typeof researchPlanV1Schema>>

const CURRENT_SPY_EVIDENCE_QUESTIONS = Object.freeze([
  Object.freeze({
    questionId: "current-thesis-evidence",
    question:
      "What current timestamped evidence materially supports or weakens the selected candidate's directional thesis?",
  }),
  Object.freeze({
    questionId: "current-thesis-challenge",
    question:
      "What current timestamped evidence could contradict or invalidate the selected candidate's directional thesis?",
  }),
] as const)

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
  return Object.freeze(value)
}

export type BuildSpyResearchPlanV1Input = Readonly<{
  manifest: StrategyComponentManifestV1
  screening: Extract<SpyDebitVerticalScreeningResultV1, { status: "SELECTED" }>
  snapshotEvaluatedAt: string
  issuedAt: string
  responseDeadline: string
}>

/** Builds the immutable qualitative-research plan for one selected SPY candidate. */
export function buildSpyResearchPlanV1({
  manifest,
  screening,
  snapshotEvaluatedAt,
  issuedAt,
  responseDeadline,
}: BuildSpyResearchPlanV1Input): ResearchPlanV1 {
  const candidate = screening.selectedCandidate
  const manifestResolution = checkStrategyManifestCompatibility(manifest)
  const { candidateId: _candidateId, ...candidateContent } = candidate
  if (
    !manifestResolution.success ||
    candidate.candidateId !==
      computeDebitVerticalCandidateIdV1(candidateContent) ||
    screening.eligibleCandidateCount < 1 ||
    screening.features.direction !== candidate.direction ||
    manifest.strategyId !== candidate.strategyId ||
    manifest.strategyVersion !== candidate.strategyVersion ||
    manifest.underlying !== candidate.underlying ||
    candidate.contractVersion !== DEBIT_VERTICAL_CANDIDATE_CONTRACT_VERSION ||
    candidate.featureComponentId !== DIRECTIONAL_TREND_FEATURE_COMPONENT_ID ||
    candidate.featureVersion !== DIRECTIONAL_TREND_FEATURE_VERSION ||
    candidate.candidateComponentId !==
      DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID ||
    candidate.candidateVersion !== DEBIT_VERTICAL_CANDIDATE_VERSION
  ) {
    throw new Error("Selected candidate does not match the strategy manifest")
  }

  const content = researchPlanContentV1Schema.parse({
    planVersion: RESEARCH_PLAN_VERSION,
    issuedAt,
    responseDeadline,
    invocation: {
      providerId: RESEARCH_MODEL_IDENTITY.providerId,
      modelId: RESEARCH_MODEL_IDENTITY.modelId,
      skillName: QUALITATIVE_RESEARCH_SKILL_NAME,
      skillVersion: QUALITATIVE_RESEARCH_SKILL_VERSION,
    },
    strategy: {
      manifestVersion: manifest.manifestVersion,
      strategyId: manifest.strategyId,
      strategyVersion: manifest.strategyVersion,
      featureComponentId: candidate.featureComponentId,
      featureComponentVersion: candidate.featureVersion,
      candidateComponentId: candidate.candidateComponentId,
      candidateComponentVersion: candidate.candidateVersion,
    },
    underlying: candidate.underlying,
    snapshot: {
      underlyingSnapshotId: candidate.underlyingSnapshotId,
      optionUniverseSnapshotId: candidate.optionUniverseSnapshotId,
      evaluatedAt: snapshotEvaluatedAt,
    },
    candidate: {
      candidateId: candidate.candidateId,
      underlyingSnapshotId: candidate.underlyingSnapshotId,
      optionUniverseSnapshotId: candidate.optionUniverseSnapshotId,
      direction: candidate.direction,
      structure: candidate.structure,
      expirationDate: candidate.expirationDate,
      longContractSymbol: candidate.longLeg.contractSymbol,
      shortContractSymbol: candidate.shortLeg.contractSymbol,
    },
    evidencePolicy: {
      questions: CURRENT_SPY_EVIDENCE_QUESTIONS,
      requireContradictionSearch: true,
      maximumTotalToolCalls: 8,
      minimumDirectionalExaSources: 1,
      minimumCompletedExaCalls: 2,
      maximumExaCalls: 4,
      maximumFmpCalls: 3,
      currentEvidenceRetrievedAfter: issuedAt,
    },
  })

  return deepFreeze(
    researchPlanV1Schema.parse({
      ...content,
      planId: computeResearchPlanIdV1(content),
    }),
  )
}