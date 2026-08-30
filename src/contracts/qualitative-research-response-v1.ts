import { z } from "zod"

import {
  MAX_RESEARCH_PLAN_QUESTIONS,
  researchPlanV1Schema,
} from "./research-plan-v1.js"
import {
  researchSnapshotIdV1Schema,
  researchSnapshotUtcTimestampV1Schema,
} from "./research-market-snapshot-v1.js"
import { canonicalExternalUrl } from "../shared/canonical-external-url.js"
import { safeSchemaDiagnostics, type SchemaViolationCategory } from "../shared/schema-diagnostics.js"

export const QUALITATIVE_RESEARCH_RESPONSE_VERSION = "1.0.0" as const
export const MAX_QUALITATIVE_EXTERNAL_SOURCES = 8

const boundedIdentifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const boundedText = z.string().trim().min(1).max(2_000)
const httpUrl = z
  .url()
  .max(2_048)
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === "https:" || protocol === "http:"
  }, "External evidence must use an HTTP(S) URL")

const sourceFields = {
  sourceId: boundedIdentifier,
  verification: z.literal("AGENT_REPORTED"),
  summary: boundedText,
  relevance: z.enum(["SUPPORTS", "CONTRADICTS", "NEUTRAL"]),
  questionIds: z
    .array(boundedIdentifier)
    .min(1)
    .max(MAX_RESEARCH_PLAN_QUESTIONS),
} as const

const exaEvidenceV1Schema = z
  .object({
    provider: z.literal("EXA"),
    ...sourceFields,
    title: z.string().trim().min(1).max(500),
    url: httpUrl,
    publishedAt: researchSnapshotUtcTimestampV1Schema,
    retrievedAt: researchSnapshotUtcTimestampV1Schema,
  })
  .strict()
  .refine(
    ({ publishedAt, retrievedAt }) =>
      Date.parse(publishedAt) <= Date.parse(retrievedAt),
    {
      path: ["publishedAt"],
      message: "Exa publication time cannot follow retrieval time",
    },
  )

const fmpEvidenceV1Schema = z
  .object({
    provider: z.literal("FMP"),
    ...sourceFields,
    dataset: z.string().trim().min(1).max(128),
    observedAt: researchSnapshotUtcTimestampV1Schema,
    retrievedAt: researchSnapshotUtcTimestampV1Schema,
  })
  .strict()
  .refine(
    ({ observedAt, retrievedAt }) =>
      Date.parse(observedAt) <= Date.parse(retrievedAt),
    {
      path: ["observedAt"],
      message: "FMP observation time cannot follow retrieval time",
    },
  )

const externalEvidenceV1Schema = z.discriminatedUnion("provider", [
  exaEvidenceV1Schema,
  fmpEvidenceV1Schema,
])

export const qualitativeResearchResponseV1Schema = z
  .object({
    responseVersion: z.literal(QUALITATIVE_RESEARCH_RESPONSE_VERSION),
    planId: researchSnapshotIdV1Schema,
    candidateId: researchSnapshotIdV1Schema,
    underlyingSnapshotId: researchSnapshotIdV1Schema,
    optionUniverseSnapshotId: researchSnapshotIdV1Schema,
    provenance: z.literal("AGENT_REPORTED"),
    disposition: z.enum(["CONTINUE", "VETO"]),
    thesis: boundedText,
    invalidation: z.array(boundedText).min(1).max(16),
    contradictionSearchPerformed: z.boolean(),
    externalEvidence: z
      .array(externalEvidenceV1Schema)
      .max(MAX_QUALITATIVE_EXTERNAL_SOURCES),
    supportingFactors: z.array(boundedText).max(12),
    contradictingFactors: z.array(boundedText).max(12),
    conflicts: z.array(boundedText).max(12),
  })
  .strict()
  .superRefine((response, refinement) => {
    response.externalEvidence.forEach((source, sourceIndex) => {
      if (new Set(source.questionIds).size !== source.questionIds.length) {
        refinement.addIssue({
          code: "custom",
          path: ["externalEvidence", sourceIndex, "questionIds"],
          message: "Evidence question references must be unique",
        })
      }
    })
  })

export type QualitativeResearchResponseV1 = Readonly<
  z.infer<typeof qualitativeResearchResponseV1Schema>
>

export const QUALITATIVE_RESEARCH_RESPONSE_VALIDATION_CODES = Object.freeze([
  "PLAN_INVALID",
  "RESPONSE_SCHEMA_INVALID",
  "EVALUATION_TIME_INVALID",
  "PLAN_EXPIRED",
  "PLAN_ID_MISMATCH",
  "CANDIDATE_ID_MISMATCH",
  "UNDERLYING_SNAPSHOT_ID_MISMATCH",
  "OPTION_UNIVERSE_SNAPSHOT_ID_MISMATCH",
  "UNKNOWN_QUESTION_REFERENCE",
  "DUPLICATE_SOURCE_ID",
  "DUPLICATE_EXTERNAL_SOURCE",
  "EVIDENCE_BEFORE_FRESHNESS_FLOOR",
  "EVIDENCE_FROM_FUTURE",
  "REQUIRED_EXA_EVIDENCE_MISSING",
  "CONTRADICTION_SEARCH_REQUIRED",
  "UNRESOLVED_CONFLICT_CONTINUED",
] as const)

export type QualitativeResearchResponseValidationCode =
  (typeof QUALITATIVE_RESEARCH_RESPONSE_VALIDATION_CODES)[number]

export type QualitativeResearchResponseValidationIssue = Readonly<{
  code: QualitativeResearchResponseValidationCode
  path: readonly (string | number)[]
  schemaCategory?: SchemaViolationCategory
}>

export type QualitativeResearchResponseValidationResult =
  | Readonly<{
      success: true
      data: QualitativeResearchResponseV1
    }>
  | Readonly<{
      success: false
      issues: readonly QualitativeResearchResponseValidationIssue[]
    }>

/** Validates one untrusted qualitative response against its immutable plan. */
export function validateQualitativeResearchResponseV1(
  input: unknown,
  planInput: unknown,
  evaluatedAt: string,
): QualitativeResearchResponseValidationResult {
  const plan = researchPlanV1Schema.safeParse(planInput)
  if (!plan.success) {
    return {
      success: false,
      issues: [{ code: "PLAN_INVALID", path: [] }],
    }
  }
  const response = qualitativeResearchResponseV1Schema.safeParse(input)
  if (!response.success) {
    return {
      success: false,
      issues: safeSchemaDiagnostics(response.error.issues, input).map(
        (issue) => ({
          code: "RESPONSE_SCHEMA_INVALID" as const,
          path: issue.path,
          schemaCategory: issue.schemaCategory,
        }),
      ),
    }
  }

  const issues: QualitativeResearchResponseValidationIssue[] = []
  const add = (
    code: QualitativeResearchResponseValidationCode,
    path: readonly (string | number)[],
  ) => issues.push({ code, path })

  const evaluated = Date.parse(evaluatedAt)
  if (
    !Number.isFinite(evaluated) ||
    evaluated < Date.parse(plan.data.issuedAt)
  ) {
    add("EVALUATION_TIME_INVALID", ["evaluatedAt"])
  } else if (evaluated > Date.parse(plan.data.responseDeadline)) {
    add("PLAN_EXPIRED", ["responseDeadline"])
  }

  const identityChecks = [
    ["planId", response.data.planId, plan.data.planId, "PLAN_ID_MISMATCH"],
    [
      "candidateId",
      response.data.candidateId,
      plan.data.candidate.candidateId,
      "CANDIDATE_ID_MISMATCH",
    ],
    [
      "underlyingSnapshotId",
      response.data.underlyingSnapshotId,
      plan.data.snapshot.underlyingSnapshotId,
      "UNDERLYING_SNAPSHOT_ID_MISMATCH",
    ],
    [
      "optionUniverseSnapshotId",
      response.data.optionUniverseSnapshotId,
      plan.data.snapshot.optionUniverseSnapshotId,
      "OPTION_UNIVERSE_SNAPSHOT_ID_MISMATCH",
    ],
  ] as const
  for (const [field, actual, expected, code] of identityChecks) {
    if (actual !== expected) add(code, [field])
  }

  const questionIds = new Set(
    plan.data.evidencePolicy.questions.map(({ questionId }) => questionId),
  )
  const sourceIds = new Set<string>()
  const externalSourceIdentities = new Set<string>()
  response.data.externalEvidence.forEach((source, index) => {
    if (sourceIds.has(source.sourceId)) {
      add("DUPLICATE_SOURCE_ID", ["externalEvidence", index, "sourceId"])
    }
    sourceIds.add(source.sourceId)

    for (const [questionIndex, questionId] of source.questionIds.entries()) {
      if (!questionIds.has(questionId)) {
        add("UNKNOWN_QUESTION_REFERENCE", [
          "externalEvidence",
          index,
          "questionIds",
          questionIndex,
        ])
      }
    }

    const retrieved = Date.parse(source.retrievedAt)
    if (
      retrieved <
      Date.parse(plan.data.evidencePolicy.currentEvidenceRetrievedAfter)
    ) {
      add("EVIDENCE_BEFORE_FRESHNESS_FLOOR", [
        "externalEvidence",
        index,
        "retrievedAt",
      ])
    }
    if (!Number.isFinite(evaluated) || retrieved > evaluated) {
      add("EVIDENCE_FROM_FUTURE", [
        "externalEvidence",
        index,
        "retrievedAt",
      ])
    }

    const sourceIdentity =
      source.provider === "EXA"
        ? `EXA:${canonicalExternalUrl(source.url)}`
        : `FMP:${source.dataset}:${source.observedAt}`
    if (externalSourceIdentities.has(sourceIdentity)) {
      add("DUPLICATE_EXTERNAL_SOURCE", [
        "externalEvidence",
        index,
        source.provider === "EXA" ? "url" : "dataset",
      ])
    }
    externalSourceIdentities.add(sourceIdentity)
  })

  const directionalExaSourceCount = response.data.externalEvidence.filter(
    ({ provider, relevance }) =>
      provider === "EXA" && relevance !== "NEUTRAL",
  ).length
  if (
    response.data.disposition === "CONTINUE" &&
    directionalExaSourceCount <
      plan.data.evidencePolicy.minimumDirectionalExaSources
  ) {
    add("REQUIRED_EXA_EVIDENCE_MISSING", ["externalEvidence"])
  }
  if (
    response.data.disposition === "CONTINUE" &&
    plan.data.evidencePolicy.requireContradictionSearch &&
    !response.data.contradictionSearchPerformed
  ) {
    add("CONTRADICTION_SEARCH_REQUIRED", ["contradictionSearchPerformed"])
  }
  if (
    response.data.disposition === "CONTINUE" &&
    response.data.conflicts.length > 0
  ) {
    add("UNRESOLVED_CONFLICT_CONTINUED", ["conflicts"])
  }

  return issues.length === 0
    ? { success: true, data: response.data }
    : { success: false, issues }
}