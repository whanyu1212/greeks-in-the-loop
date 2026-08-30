import {
  buildSpyResearchPlanV1,
  type ResearchPlanV1,
} from "../../src/contracts/research-plan-v1.js"
import {
  computeDebitVerticalCandidateIdV1,
  type DebitVerticalCandidateV1,
  type SpyDebitVerticalScreeningResultV1,
} from "../../src/strategy/directional-debit-vertical-v1.js"
import { CURRENT_STRATEGY_MANIFEST } from "../../src/strategy/strategy-registry.js"

export const PLAN_ISSUED_AT = "2026-08-28T14:01:00.000Z"
export const PLAN_DEADLINE = "2026-08-28T14:06:00.000Z"
export const PLAN_EVALUATED_AT = "2026-08-28T14:04:00.000Z"

export const createSelectedCandidateV1 = (): DebitVerticalCandidateV1 => {
  const content: Omit<DebitVerticalCandidateV1, "candidateId"> = {
  contractVersion: "1.0.0",
  underlyingSnapshotId: "b".repeat(64),
  optionUniverseSnapshotId: "c".repeat(64),
  strategyId: CURRENT_STRATEGY_MANIFEST.strategyId,
  strategyVersion: CURRENT_STRATEGY_MANIFEST.strategyVersion,
  featureComponentId: "calculateDirectionalTrendFeaturesV1",
  featureVersion: "1.0.0",
  candidateComponentId: "screenSpyDirectionalDebitVerticalV1",
  candidateVersion: "1.0.0",
  underlying: "SPY",
  direction: "BULLISH",
  structure: "BULL_CALL_SPREAD",
  expirationDate: "2026-09-18",
  dte: 21,
  longLeg: {
    role: "LONG",
    contractSymbol: "SPY260918C00630000",
    strikeCentsPerShare: 63_000,
    deltaMillionths: 500_000,
  },
  shortLeg: {
    role: "SHORT",
    contractSymbol: "SPY260918C00635000",
    strikeCentsPerShare: 63_500,
    deltaMillionths: 300_000,
  },
  economics: {
    entryLimitCentsPerShare: 250,
    widthCentsPerShare: 500,
    maxLossCentsPerContract: 25_000,
    maxProfitCentsPerContract: 25_000,
    stopLossMarkHalfCentsPerShare: 250,
    profitTargetMarkHalfCentsPerShare: 750,
  },
  rank: [
    0,
    0,
    500,
    "2026-09-18",
    "SPY260918C00630000",
    "SPY260918C00635000",
  ],
  }
  return {
    ...content,
    candidateId: computeDebitVerticalCandidateIdV1(content),
  }
}

export const createSelectedScreeningResultV1 = (): Extract<
  SpyDebitVerticalScreeningResultV1,
  { status: "SELECTED" }
> => ({
  status: "SELECTED",
  features: {
    dailyCloseMicrosPerShare: 636_000_000,
    sma20: {
      numeratorMicrosPerShare: "12600000000",
      denominator: 20,
    },
    sma50: {
      numeratorMicrosPerShare: "31000000000",
      denominator: 50,
    },
    sessionVwap: {
      numeratorMicrosVolume: "1900000000",
      denominatorVolume: "3",
    },
    underlyingMidpoint: {
      numeratorMicrosPerShare: "1272020000",
      denominator: 2,
    },
    direction: "BULLISH",
  },
  selectedCandidate: createSelectedCandidateV1(),
  eligibleCandidateCount: 1,
})

export const createResearchPlanV1 = (): ResearchPlanV1 =>
  buildSpyResearchPlanV1({
    manifest: CURRENT_STRATEGY_MANIFEST,
    screening: createSelectedScreeningResultV1(),
    snapshotEvaluatedAt: "2026-08-28T14:00:59.000Z",
    issuedAt: PLAN_ISSUED_AT,
    responseDeadline: PLAN_DEADLINE,
  })

export const createQualitativeResponseV1 = (
  plan = createResearchPlanV1(),
  disposition: "CONTINUE" | "VETO" = "CONTINUE",
) => ({
  responseVersion: "1.0.0" as const,
  planId: plan.planId,
  candidateId: plan.candidate.candidateId,
  underlyingSnapshotId: plan.snapshot.underlyingSnapshotId,
  optionUniverseSnapshotId: plan.snapshot.optionUniverseSnapshotId,
  provenance: "AGENT_REPORTED" as const,
  disposition,
  thesis: "Current primary-source context supports continued evaluation.",
  invalidation: ["Veto if the current catalyst is materially contradicted."],
  contradictionSearchPerformed: true,
  externalEvidence: [
    {
      provider: "EXA" as const,
      sourceId: "current-primary-source",
      verification: "AGENT_REPORTED" as const,
      title: "Current primary source",
      url: "https://example.com/current-primary-source",
      publishedAt: "2026-08-28T13:30:00.000Z",
      retrievedAt: "2026-08-28T14:02:00.000Z",
      summary: "Current evidence relevant to the declared thesis question.",
      relevance: "SUPPORTS" as const,
      questionIds: ["current-thesis-evidence"],
    },
  ],
  supportingFactors: ["Current evidence supports continued evaluation."],
  contradictingFactors: [],
  conflicts: [],
})