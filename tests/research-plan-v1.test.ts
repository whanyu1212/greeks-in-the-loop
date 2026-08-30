import { describe, expect, it } from "vitest"

import {
  buildSpyResearchPlanV1,
  computeResearchPlanIdV1,
  researchPlanV1Schema,
} from "../src/contracts/research-plan-v1.js"
import { CURRENT_STRATEGY_MANIFEST } from "../src/strategy/strategy-registry.js"
import {
  createResearchPlanV1,
  createSelectedScreeningResultV1,
  PLAN_DEADLINE,
  PLAN_ISSUED_AT,
} from "./fixtures/research-plan-v1.js"

describe("ResearchPlanV1", () => {
  it("builds one deterministic deeply immutable plan", () => {
    const first = createResearchPlanV1()
    const second = createResearchPlanV1()

    expect(first).toEqual(second)
    expect(first.planId).toHaveLength(64)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.candidate)).toBe(true)
    expect(Object.isFrozen(first.evidencePolicy.questions)).toBe(true)

    const { planId, ...content } = first
    expect(planId).toBe(computeResearchPlanIdV1(content))
  })

  it("binds deterministic component and candidate identity without financial values", () => {
    const plan = createResearchPlanV1()

    expect(plan.strategy).toMatchObject({
      featureComponentId: "calculateDirectionalTrendFeaturesV1",
      candidateComponentId: "screenSpyDirectionalDebitVerticalV1",
    })
    expect(plan.candidate).toEqual({
      candidateId: plan.candidate.candidateId,
      underlyingSnapshotId: "b".repeat(64),
      optionUniverseSnapshotId: "c".repeat(64),
      direction: "BULLISH",
      structure: "BULL_CALL_SPREAD",
      expirationDate: "2026-09-18",
      longContractSymbol: "SPY260918C00630000",
      shortContractSymbol: "SPY260918C00635000",
    })
    for (const forbidden of [
      "economics",
      "rank",
      "dte",
      "delta",
      "price",
      "quantity",
      "account",
      "risk",
    ]) {
      expect(JSON.stringify(plan.candidate).toLowerCase()).not.toContain(forbidden)
    }
  })

  it("rejects unknown fields, identity tampering, and cross-snapshot candidates", () => {
    const plan = createResearchPlanV1()

    expect(
      researchPlanV1Schema.safeParse({ ...plan, extra: true }).success,
    ).toBe(false)
    expect(
      researchPlanV1Schema.safeParse({
        ...plan,
        planId: "d".repeat(64),
      }).success,
    ).toBe(false)
    expect(
      researchPlanV1Schema.safeParse({
        ...plan,
        candidate: {
          ...plan.candidate,
          underlyingSnapshotId: "d".repeat(64),
        },
      }).success,
    ).toBe(false)

    const { planId: _planId, ...content } = plan
    const forged = {
      ...content,
      candidate: {
        ...content.candidate,
        candidateId: "d".repeat(64),
      },
    }
    expect(
      researchPlanV1Schema.safeParse({
        ...forged,
        planId: computeResearchPlanIdV1(forged),
      }).success,
    ).toBe(false)
  })

  it("bounds snapshot-to-plan issuance and plan duration", () => {
    const plan = createResearchPlanV1()
    const { planId: _planId, ...content } = plan
    for (const changed of [
      {
        ...content,
        snapshot: {
          ...content.snapshot,
          evaluatedAt: "2026-08-28T13:59:59.000Z",
        },
      },
      {
        ...content,
        responseDeadline: "2026-08-28T14:11:00.001Z",
      },
    ]) {
      expect(
        researchPlanV1Schema.safeParse({
          ...changed,
          planId: computeResearchPlanIdV1(changed),
        }).success,
      ).toBe(false)
    }
  })

  it("rejects forged candidate identity and accepts a structurally current manifest", () => {
    const screening = createSelectedScreeningResultV1()
    expect(() =>
      buildSpyResearchPlanV1({
        manifest: CURRENT_STRATEGY_MANIFEST,
        screening: {
          ...screening,
          selectedCandidate: {
            ...screening.selectedCandidate,
            candidateId: "d".repeat(64),
          },
        },
        snapshotEvaluatedAt: "2026-08-28T14:00:59.000Z",
        issuedAt: PLAN_ISSUED_AT,
        responseDeadline: PLAN_DEADLINE,
      })
    ).toThrow("does not match the strategy manifest")

    expect(
      buildSpyResearchPlanV1({
        manifest: structuredClone(CURRENT_STRATEGY_MANIFEST),
        screening,
        snapshotEvaluatedAt: "2026-08-28T14:00:59.000Z",
        issuedAt: PLAN_ISSUED_AT,
        responseDeadline: PLAN_DEADLINE,
      }),
    ).toEqual(createResearchPlanV1())
  })

  it("decodes embedded historical invocation identity independently of current pins", () => {
    const plan = createResearchPlanV1()
    const { planId: _planId, ...content } = plan
    const historical = {
      ...content,
      invocation: {
        ...content.invocation,
        modelId: "historical-model",
        skillVersion: "0.9.0",
      },
    }

    expect(
      researchPlanV1Schema.safeParse({
        ...historical,
        planId: computeResearchPlanIdV1(historical),
      }).success,
    ).toBe(true)
  })

  it("rejects selected screening metadata that disagrees with its candidate", () => {
    const screening = createSelectedScreeningResultV1()
    expect(() =>
      buildSpyResearchPlanV1({
        manifest: CURRENT_STRATEGY_MANIFEST,
        screening: {
          ...screening,
          eligibleCandidateCount: 0,
          features: {
            ...screening.features,
            direction: "BEARISH",
          },
        },
        snapshotEvaluatedAt: "2026-08-28T14:00:59.000Z",
        issuedAt: PLAN_ISSUED_AT,
        responseDeadline: PLAN_DEADLINE,
      })
    ).toThrow("does not match the strategy manifest")
  })

  it("rejects OCC identity that disagrees with the bounded candidate fields", () => {
    const plan = createResearchPlanV1()
    const { planId: _planId, ...content } = plan
    const mismatched = {
      ...content,
      candidate: {
        ...content.candidate,
        longContractSymbol: "SPY260918P00630000",
      },
    }

    expect(
      researchPlanV1Schema.safeParse({
        ...mismatched,
        planId: computeResearchPlanIdV1(mismatched),
      }).success,
    ).toBe(false)
  })
})