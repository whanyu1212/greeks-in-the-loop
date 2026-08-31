import { describe, expect, it } from "vitest"

import {
  computeResearchPlanIdV1,
  researchPlanV1Schema,
  type ResearchPlanContentV1,
} from "../src/contracts/research-plan-v1.js"
import { evaluateQualitativeResearchV1 } from "../src/evaluation/qualitative-research-evaluation-v1.js"
import {
  diaQualitativeResearchPlan,
  qualitativeResearchScenarios,
} from "../src/evaluation/qualitative-research-scenarios.js"

describe("plan-driven qualitative research scenarios", () => {
  it("keeps scenario identity unique and covers SPY plus a synthetic non-SPY plan", () => {
    const ids = qualitativeResearchScenarios.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(qualitativeResearchScenarios.map(({ plan }) => plan.underlying)))
      .toEqual(new Set(["SPY", "DIA"]))
    for (const { plan } of qualitativeResearchScenarios) {
      expect(researchPlanV1Schema.safeParse(plan).success).toBe(true)
    }
  })

  for (const scenario of qualitativeResearchScenarios) {
    it(scenario.id, () => {
      const evaluation = evaluateQualitativeResearchV1({
        plan: scenario.plan,
        rawResponse: scenario.rawResponse,
        toolCalls: scenario.toolCalls,
        observedModel: scenario.observedModel,
        observedSkill: scenario.observedSkill,
        evaluatedAt: scenario.evaluatedAt,
      })

      expect(evaluation.planId).toBe(scenario.plan.planId)
      expect(evaluation.issueCodes).toEqual(scenario.expectedIssueCodes)
      expect(evaluation.status).toBe(
        scenario.expectedIssueCodes.length === 0 ? "PASS" : "FAIL",
      )
    })
  }

  it("rejects plan content paired with its previous identity", () => {
    expect(
      researchPlanV1Schema.safeParse({
        ...diaQualitativeResearchPlan,
        responseDeadline: "2026-08-28T14:05:00.000Z",
      }).success,
    ).toBe(false)
  })

  it("rejects a rehashed non-SPY plan containing a SPY option leg", () => {
    const { planId: _planId, ...content } = diaQualitativeResearchPlan
    const mixedContent: ResearchPlanContentV1 = {
      ...content,
      candidate: {
        ...content.candidate,
        longContractSymbol: "SPY260918P00400000",
      },
    }

    expect(
      researchPlanV1Schema.safeParse({
        ...mixedContent,
        planId: computeResearchPlanIdV1(mixedContent),
      }).success,
    ).toBe(false)
  })
})
