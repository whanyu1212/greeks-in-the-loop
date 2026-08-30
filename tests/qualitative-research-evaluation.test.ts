import { describe, expect, it } from "vitest"

import { computeResearchPlanIdV1 } from "../src/contracts/research-plan-v1.js"
import { evaluateQualitativeResearchV1 } from "../src/evaluation/qualitative-research-evaluation-v1.js"
import {
  createQualitativeResponseV1,
  createResearchPlanV1,
  PLAN_EVALUATED_AT,
} from "./fixtures/research-plan-v1.js"

const validToolCalls = () => [
  {
    name: "skill",
    outcome: "completed" as const,
    input: { name: "options-qualitative-research" },
  },
  {
    name: "exa_search",
    outcome: "completed" as const,
    input: { query: "current thesis evidence" },
  },
  {
    name: "exa_search",
    outcome: "completed" as const,
    input: { query: "current thesis contradiction" },
  },
]

const evaluate = (
  overrides: Partial<Parameters<typeof evaluateQualitativeResearchV1>[0]> = {},
) => {
  const plan = createResearchPlanV1()
  return evaluateQualitativeResearchV1({
    plan,
    rawResponse: JSON.stringify(createQualitativeResponseV1(plan)),
    toolCalls: validToolCalls(),
    observedModel: plan.invocation,
    observedSkill: {
      name: plan.invocation.skillName,
      version: plan.invocation.skillVersion,
    },
    evaluatedAt: PLAN_EVALUATED_AT,
    ...overrides,
  })
}

describe("plan-driven qualitative research evaluation", () => {
  it("passes a reference-valid response within plan budgets", () => {
    expect(evaluate()).toEqual({
      evaluationVersion: "1.0.0",
      planId: createResearchPlanV1().planId,
      status: "PASS",
      issueCodes: [],
      metrics: {
        toolCallCount: 3,
        exaCallCount: 2,
        fmpCallCount: 0,
      },
    })
  })

  it("reads tool budgets and contradiction requirements from the plan", () => {
    const plan = createResearchPlanV1()
    const result = evaluate({
      plan,
      toolCalls: [
        {
          name: "skill",
          outcome: "completed",
          input: { name: "options-qualitative-research" },
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          name: "exa_search",
          outcome: "completed" as const,
          input: { query: `exa-${index}` },
        })),
        ...Array.from({ length: 4 }, (_, index) => ({
          name: "fmp_news",
          outcome: "completed" as const,
          input: { query: `fmp-${index}` },
        })),
      ],
    })

    expect(result.status).toBe("FAIL")
    expect(result.issueCodes).toEqual([
      "EXA_TOOL_BUDGET_EXCEEDED",
      "FMP_TOOL_BUDGET_EXCEEDED",
      "TOTAL_TOOL_BUDGET_EXCEEDED",
    ])
  })

  it("reads the minimum completed Exa requirement from the plan", () => {
    const original = createResearchPlanV1()
    const { planId: _planId, ...content } = original
    const changed = {
      ...content,
      evidencePolicy: {
        ...content.evidencePolicy,
        minimumCompletedExaSearchCalls: 3,
      },
    }
    const plan = {
      ...changed,
      planId: computeResearchPlanIdV1(changed),
    }

    expect(
      evaluate({
        plan,
        rawResponse: JSON.stringify(createQualitativeResponseV1(plan)),
      }).issueCodes,
    ).toEqual(["CONTRADICTION_SEARCH_TOOL_MISSING"])
  })

  it("requires distinct completed Exa search requests for contradiction search", () => {
    const duplicate = {
      name: "exa_search",
      outcome: "completed" as const,
      input: { query: "same query" },
    }
    for (const toolCalls of [
      [
        {
          name: "skill",
          outcome: "completed" as const,
          input: { name: "options-qualitative-research" },
        },
        duplicate,
        duplicate,
      ],
      [
        {
          name: "skill",
          outcome: "completed" as const,
          input: { name: "options-qualitative-research" },
        },
        {
          name: "exa_fetch",
          outcome: "completed" as const,
          input: { url: "https://example.com/one" },
        },
        {
          name: "exa_fetch",
          outcome: "completed" as const,
          input: { url: "https://example.com/two" },
        },
      ],
    ]) {
      expect(evaluate({ toolCalls }).issueCodes).toEqual([
        "CONTRADICTION_SEARCH_TOOL_MISSING",
      ])
    }
  })

  it("rejects observed skill identity drift even when the tool-selected name matches", () => {
    const original = createResearchPlanV1()
    const { planId: _planId, ...content } = original
    const historical = {
      ...content,
      invocation: {
        ...content.invocation,
        skillVersion: "0.9.0",
      },
    }
    const plan = {
      ...historical,
      planId: computeResearchPlanIdV1(historical),
    }

    expect(
      evaluate({
        plan,
        rawResponse: JSON.stringify(createQualitativeResponseV1(plan)),
      }).issueCodes,
    ).toEqual(["SKILL_IDENTITY_DRIFT"])
  })

  it("detects forbidden tools, skill substitution, missing challenge search, and model drift", () => {
    const plan = createResearchPlanV1()
    const result = evaluate({
      plan,
      toolCalls: [
        {
          name: "skill",
          outcome: "completed",
          input: { name: "spy-debit-spread-research" },
        },
        { name: "exa_search", outcome: "completed" },
        { name: "alpaca_get_option_chain", outcome: "completed" },
      ],
      observedModel: { providerId: "other", modelId: "other" },
    })

    expect(result.issueCodes).toEqual([
      "CONTRADICTION_SEARCH_TOOL_MISSING",
      "FORBIDDEN_TOOL_USED",
      "MODEL_DRIFT",
      "PROVIDER_DRIFT",
      "SKILL_CALL_INVALID",
    ])
  })

  it("combines response identity failures with deterministic tool checks", () => {
    const plan = createResearchPlanV1()
    const result = evaluate({
      plan,
      rawResponse: JSON.stringify({
        ...createQualitativeResponseV1(plan),
        candidateId: "d".repeat(64),
      }),
    })

    expect(result.issueCodes).toEqual(["CANDIDATE_ID_MISMATCH"])
  })

  it("allows a fail-closed veto only when it reports the challenge search did not complete", () => {
    const plan = createResearchPlanV1()
    const response = {
      ...createQualitativeResponseV1(plan, "VETO"),
      contradictionSearchPerformed: false,
      externalEvidence: [],
      conflicts: ["Required current evidence could not be established."],
    }
    const toolCalls = [
      {
        name: "skill",
        outcome: "completed" as const,
        input: { name: "options-qualitative-research" },
      },
      { name: "exa_search", outcome: "error" as const },
    ]

    const safeVeto = evaluate({
      plan,
      rawResponse: JSON.stringify(response),
      toolCalls,
    })
    expect(safeVeto.status).toBe("PASS")
    expect(safeVeto.issueCodes).toEqual([])

    expect(
      evaluate({
        plan,
        rawResponse: JSON.stringify({
          ...response,
          contradictionSearchPerformed: true,
        }),
        toolCalls,
      }).issueCodes,
    ).toEqual(["CONTRADICTION_SEARCH_TOOL_MISSING"])
  })

  it("reports malformed output without trusting it", () => {
    expect(evaluate({ rawResponse: "{" }).issueCodes).toEqual([
      "MALFORMED_JSON",
    ])
  })
})