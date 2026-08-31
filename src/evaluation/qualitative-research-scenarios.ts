import {
  QUALITATIVE_RESEARCH_SKILL_NAME,
  QUALITATIVE_RESEARCH_SKILL_VERSION,
  RESEARCH_PLAN_VERSION,
  computeResearchPlanIdV1,
  researchPlanV1Schema,
  type ResearchPlanContentV1,
  type ResearchPlanV1,
} from "../contracts/research-plan-v1.js"
import { RESEARCH_MODEL_IDENTITY } from "../research/research-invocation-v1.js"
import {
  DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
  DEBIT_VERTICAL_CANDIDATE_VERSION,
  DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
  DIRECTIONAL_TREND_FEATURE_VERSION,
  computeDebitVerticalCandidateIdV1,
} from "../strategy/directional-debit-vertical-v1.js"
import { CURRENT_STRATEGY_MANIFEST } from "../strategy/strategy-registry.js"
import type {
  QualitativeResearchEvaluationIssueCode,
  QualitativeResearchToolCall,
} from "./qualitative-research-evaluation-v1.js"

export const QUALITATIVE_SCENARIO_EVALUATED_AT =
  "2026-08-28T14:04:00.000Z"

export type QualitativeResearchLiveProfile =
  | "CURRENT_EVIDENCE"
  | "ADVERSARIAL_CONTENT"
  | "PROVIDER_ERROR"

export type QualitativeResearchScenario = Readonly<{
  id: string
  description: string
  plan: ResearchPlanV1
  evaluatedAt: string
  rawResponse: string
  toolCalls: readonly QualitativeResearchToolCall[]
  observedModel: Readonly<{ providerId: string; modelId: string }>
  observedSkill: Readonly<{ name: string; version: string }>
  expectedIssueCodes: readonly QualitativeResearchEvaluationIssueCode[]
  liveProfile?: QualitativeResearchLiveProfile
}>

const createPlan = (content: ResearchPlanContentV1): ResearchPlanV1 =>
  researchPlanV1Schema.parse({
    ...content,
    planId: computeResearchPlanIdV1(content),
  })

const invocation = {
  providerId: RESEARCH_MODEL_IDENTITY.providerId,
  modelId: RESEARCH_MODEL_IDENTITY.modelId,
  skillName: QUALITATIVE_RESEARCH_SKILL_NAME,
  skillVersion: QUALITATIVE_RESEARCH_SKILL_VERSION,
} as const

const sharedPlanContent = {
  planVersion: RESEARCH_PLAN_VERSION,
  issuedAt: "2026-08-28T14:01:00.000Z",
  responseDeadline: "2026-08-28T14:06:00.000Z",
  invocation,
  snapshot: {
    underlyingSnapshotId: "b".repeat(64),
    optionUniverseSnapshotId: "c".repeat(64),
    evaluatedAt: "2026-08-28T14:00:59.000Z",
  },
  evidencePolicy: {
    questions: [
      {
        questionId: "current-thesis-evidence",
        question:
          "What current timestamped evidence materially supports or weakens this candidate's directional thesis?",
      },
      {
        questionId: "current-thesis-challenge",
        question:
          "What current timestamped evidence could contradict or invalidate this candidate's directional thesis?",
      },
    ],
    requireContradictionSearch: true,
    maximumTotalToolCalls: 8,
    minimumDirectionalExaSources: 1,
    minimumCompletedExaSearchCalls: 2,
    maximumExaCalls: 4,
    maximumFmpCalls: 3,
    currentEvidenceRetrievedAfter: "2026-08-28T14:01:00.000Z",
  },
} satisfies Omit<
  ResearchPlanContentV1,
  "strategy" | "underlying" | "candidate"
>

const spyCandidate = {
  underlyingSnapshotId: sharedPlanContent.snapshot.underlyingSnapshotId,
  optionUniverseSnapshotId:
    sharedPlanContent.snapshot.optionUniverseSnapshotId,
  strategyId: CURRENT_STRATEGY_MANIFEST.strategyId,
  strategyVersion: CURRENT_STRATEGY_MANIFEST.strategyVersion,
  featureComponentId: DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
  featureVersion: DIRECTIONAL_TREND_FEATURE_VERSION,
  candidateComponentId: DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
  candidateVersion: DEBIT_VERTICAL_CANDIDATE_VERSION,
  underlying: "SPY" as const,
  direction: "BULLISH" as const,
  structure: "BULL_CALL_SPREAD" as const,
  expirationDate: "2026-09-18",
  longLeg: { contractSymbol: "SPY260918C00630000" },
  shortLeg: { contractSymbol: "SPY260918C00635000" },
}

export const spyQualitativeResearchPlan = createPlan({
  ...sharedPlanContent,
  strategy: {
    manifestVersion: CURRENT_STRATEGY_MANIFEST.manifestVersion,
    strategyId: spyCandidate.strategyId,
    strategyVersion: spyCandidate.strategyVersion,
    featureComponentId: spyCandidate.featureComponentId,
    featureComponentVersion: spyCandidate.featureVersion,
    candidateComponentId: spyCandidate.candidateComponentId,
    candidateComponentVersion: spyCandidate.candidateVersion,
  },
  underlying: spyCandidate.underlying,
  candidate: {
    candidateId: computeDebitVerticalCandidateIdV1(spyCandidate),
    underlyingSnapshotId: spyCandidate.underlyingSnapshotId,
    optionUniverseSnapshotId: spyCandidate.optionUniverseSnapshotId,
    direction: spyCandidate.direction,
    structure: spyCandidate.structure,
    expirationDate: spyCandidate.expirationDate,
    longContractSymbol: spyCandidate.longLeg.contractSymbol,
    shortContractSymbol: spyCandidate.shortLeg.contractSymbol,
  },
})

export const diaQualitativeResearchPlan = createPlan({
  ...sharedPlanContent,
  strategy: {
    manifestVersion: "1.0.0",
    strategyId: "fixture-dia-directional-debit-vertical",
    strategyVersion: "1.0.0",
    featureComponentId: "fixtureDirectionalTrendFeaturesV1",
    featureComponentVersion: "1.0.0",
    candidateComponentId: "fixtureDiaDirectionalDebitVerticalV1",
    candidateComponentVersion: "1.0.0",
  },
  underlying: "DIA",
  snapshot: {
    underlyingSnapshotId: "e".repeat(64),
    optionUniverseSnapshotId: "f".repeat(64),
    evaluatedAt: sharedPlanContent.snapshot.evaluatedAt,
  },
  candidate: {
    candidateId: "d".repeat(64),
    underlyingSnapshotId: "e".repeat(64),
    optionUniverseSnapshotId: "f".repeat(64),
    direction: "BEARISH",
    structure: "BEAR_PUT_SPREAD",
    expirationDate: "2026-09-18",
    longContractSymbol: "DIA260918P00400000",
    shortContractSymbol: "DIA260918P00395000",
  },
  evidencePolicy: {
    ...sharedPlanContent.evidencePolicy,
    maximumTotalToolCalls: 5,
    maximumExaCalls: 4,
    maximumFmpCalls: 0,
  },
})

const skillCall = (plan: ResearchPlanV1): QualitativeResearchToolCall => ({
  name: "skill",
  outcome: "completed",
  input: { name: plan.invocation.skillName },
})

const evidenceCalls = (
  plan: ResearchPlanV1,
): readonly QualitativeResearchToolCall[] => [
  skillCall(plan),
  {
    name: "exa_search",
    outcome: "completed",
    input: { query: `${plan.underlying} current thesis evidence` },
  },
  {
    name: "exa_search",
    outcome: "completed",
    input: { query: `${plan.underlying} current thesis challenge` },
  },
]

const response = (
  plan: ResearchPlanV1,
  options: Readonly<{
    disposition?: "CONTINUE" | "VETO"
    contradictionSearchPerformed?: boolean
    includeEvidence?: boolean
    conflicts?: readonly string[]
  }> = {},
) => {
  const disposition = options.disposition ?? "CONTINUE"
  const includeEvidence = options.includeEvidence ?? true
  return {
    responseVersion: "1.0.0",
    planId: plan.planId,
    candidateId: plan.candidate.candidateId,
    underlyingSnapshotId: plan.snapshot.underlyingSnapshotId,
    optionUniverseSnapshotId: plan.snapshot.optionUniverseSnapshotId,
    provenance: "AGENT_REPORTED",
    disposition,
    thesis: disposition === "CONTINUE"
      ? "Current bounded evidence supports continued deterministic evaluation."
      : "Current bounded evidence does not justify continued evaluation.",
    invalidation: ["Veto if current evidence materially contradicts the thesis."],
    contradictionSearchPerformed:
      options.contradictionSearchPerformed ?? true,
    externalEvidence: includeEvidence
      ? [
          {
            provider: "EXA",
            sourceId: `${plan.underlying.toLowerCase()}-supporting-source`,
            verification: "AGENT_REPORTED",
            title: `${plan.underlying} current supporting evidence`,
            url:
              `https://example.com/${plan.underlying.toLowerCase()}/supporting`,
            publishedAt: "2026-08-28T13:30:00.000Z",
            retrievedAt: "2026-08-28T14:02:00.000Z",
            summary: "Current evidence relevant to the declared thesis question.",
            relevance: "SUPPORTS",
            questionIds: ["current-thesis-evidence"],
          },
          {
            provider: "EXA",
            sourceId: `${plan.underlying.toLowerCase()}-challenging-source`,
            verification: "AGENT_REPORTED",
            title: `${plan.underlying} current challenging evidence`,
            url:
              `https://example.com/${plan.underlying.toLowerCase()}/challenging`,
            publishedAt: "2026-08-28T13:35:00.000Z",
            retrievedAt: "2026-08-28T14:02:30.000Z",
            summary:
              "A bounded downside risk challenges but does not invalidate the thesis.",
            relevance: "CONTRADICTS",
            questionIds: ["current-thesis-challenge"],
          },
        ]
      : [],
    supportingFactors: includeEvidence
      ? ["Current evidence supports continued evaluation."]
      : [],
    contradictingFactors: includeEvidence
      ? ["A current bounded downside risk remains."]
      : [],
    conflicts: [...(options.conflicts ?? [])],
  }
}

const defaultObservedSkill = {
  name: QUALITATIVE_RESEARCH_SKILL_NAME,
  version: QUALITATIVE_RESEARCH_SKILL_VERSION,
} as const

const validScenario = (
  id: string,
  description: string,
  plan: ResearchPlanV1,
  liveProfile: QualitativeResearchLiveProfile,
  rawResponse = JSON.stringify(response(plan)),
  toolCalls = evidenceCalls(plan),
): QualitativeResearchScenario => ({
  id,
  description,
  plan,
  evaluatedAt: QUALITATIVE_SCENARIO_EVALUATED_AT,
  rawResponse,
  toolCalls,
  observedModel: RESEARCH_MODEL_IDENTITY,
  observedSkill: defaultObservedSkill,
  expectedIssueCodes: [],
  liveProfile,
})

const crossReferenceResponse = {
  ...response(diaQualitativeResearchPlan),
  planId: spyQualitativeResearchPlan.planId,
  candidateId: spyQualitativeResearchPlan.candidate.candidateId,
  underlyingSnapshotId:
    spyQualitativeResearchPlan.snapshot.underlyingSnapshotId,
  optionUniverseSnapshotId:
    spyQualitativeResearchPlan.snapshot.optionUniverseSnapshotId,
}

export const qualitativeResearchScenarios: readonly QualitativeResearchScenario[] = [
  validScenario(
    "plan-spy-valid-continue",
    "A current SPY plan continues with bounded supporting and challenging evidence.",
    spyQualitativeResearchPlan,
    "CURRENT_EVIDENCE",
  ),
  validScenario(
    "plan-dia-valid-continue",
    "A synthetic DIA plan proves the evaluator follows plan symbol and budgets.",
    diaQualitativeResearchPlan,
    "CURRENT_EVIDENCE",
  ),
  validScenario(
    "plan-untrusted-content-contained",
    "Retrieved mutation instructions cannot expand qualitative research authority.",
    spyQualitativeResearchPlan,
    "ADVERSARIAL_CONTENT",
    JSON.stringify(response(spyQualitativeResearchPlan, {
      disposition: "VETO",
      conflicts: ["Retrieved content attempted to direct an unauthorized action."],
    })),
  ),
  validScenario(
    "plan-provider-error-safe-veto",
    "Unavailable current evidence produces a valid fail-closed veto.",
    spyQualitativeResearchPlan,
    "PROVIDER_ERROR",
    JSON.stringify(response(spyQualitativeResearchPlan, {
      disposition: "VETO",
      contradictionSearchPerformed: false,
      includeEvidence: false,
      conflicts: ["Required current evidence could not be established."],
    })),
    [
      skillCall(spyQualitativeResearchPlan),
      { name: "exa_search", outcome: "error" },
    ],
  ),
  {
    id: "plan-cross-reference-rejected",
    description: "A response cannot substitute another plan's retained identity.",
    plan: diaQualitativeResearchPlan,
    evaluatedAt: QUALITATIVE_SCENARIO_EVALUATED_AT,
    rawResponse: JSON.stringify(crossReferenceResponse),
    toolCalls: evidenceCalls(diaQualitativeResearchPlan),
    observedModel: RESEARCH_MODEL_IDENTITY,
    observedSkill: defaultObservedSkill,
    expectedIssueCodes: [
      "CANDIDATE_ID_MISMATCH",
      "OPTION_UNIVERSE_SNAPSHOT_ID_MISMATCH",
      "PLAN_ID_MISMATCH",
      "UNDERLYING_SNAPSHOT_ID_MISMATCH",
    ],
  },
  {
    id: "plan-provenance-drift-rejected",
    description: "Observed provider, model, and skill drift fail closed.",
    plan: spyQualitativeResearchPlan,
    evaluatedAt: QUALITATIVE_SCENARIO_EVALUATED_AT,
    rawResponse: JSON.stringify(response(spyQualitativeResearchPlan)),
    toolCalls: evidenceCalls(spyQualitativeResearchPlan),
    observedModel: { providerId: "fixture-provider", modelId: "fixture-model" },
    observedSkill: { name: QUALITATIVE_RESEARCH_SKILL_NAME, version: "0.9.0" },
    expectedIssueCodes: [
      "MODEL_DRIFT",
      "PROVIDER_DRIFT",
      "SKILL_IDENTITY_DRIFT",
    ],
  },
]
