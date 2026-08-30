import { describe, expect, it } from "vitest"

import {
  qualitativeResearchResponseV1Schema,
  validateQualitativeResearchResponseV1,
} from "../src/contracts/qualitative-research-response-v1.js"
import {
  createQualitativeResponseV1,
  createResearchPlanV1,
  PLAN_EVALUATED_AT,
} from "./fixtures/research-plan-v1.js"

const issueCodes = (
  result: ReturnType<typeof validateQualitativeResearchResponseV1>,
) => result.success ? [] : result.issues.map(({ code }) => code)

describe("QualitativeResearchResponseV1", () => {
  it.each(["CONTINUE", "VETO"] as const)(
    "accepts a fresh reference-only %s response",
    (disposition) => {
      const plan = createResearchPlanV1()
      const response = createQualitativeResponseV1(plan, disposition)

      expect(
        validateQualitativeResearchResponseV1(
          response,
          plan,
          PLAN_EVALUATED_AT,
        ),
      ).toEqual({ success: true, data: response })
    },
  )

  it("rejects financial candidate fields at the trust boundary", () => {
    const response = {
      ...createQualitativeResponseV1(),
      price: 2.5,
      greeks: { delta: 0.5 },
      dte: 21,
      rank: [0],
      quantity: 1,
      riskApproval: true,
      orderType: "LIMIT",
    }

    expect(qualitativeResearchResponseV1Schema.safeParse(response).success).toBe(
      false,
    )
  })

  it("rejects duplicate question references within one evidence item", () => {
    const response = createQualitativeResponseV1()
    expect(
      qualitativeResearchResponseV1Schema.safeParse({
        ...response,
        externalEvidence: [{
          ...response.externalEvidence[0],
          questionIds: [
            "current-thesis-evidence",
            "current-thesis-evidence",
          ],
        }],
      }).success,
    ).toBe(false)
  })

  it("fails closed on cross-plan, candidate, and snapshot references", () => {
    const plan = createResearchPlanV1()
    const response = {
      ...createQualitativeResponseV1(plan),
      planId: "d".repeat(64),
      candidateId: "e".repeat(64),
      underlyingSnapshotId: "f".repeat(64),
      optionUniverseSnapshotId: "0".repeat(64),
    }

    expect(
      issueCodes(
        validateQualitativeResearchResponseV1(
          response,
          plan,
          PLAN_EVALUATED_AT,
        ),
      ),
    ).toEqual([
      "PLAN_ID_MISMATCH",
      "CANDIDATE_ID_MISMATCH",
      "UNDERLYING_SNAPSHOT_ID_MISMATCH",
      "OPTION_UNIVERSE_SNAPSHOT_ID_MISMATCH",
    ])
  })

  it("rejects stale, future, unknown-question, and duplicate evidence", () => {
    const plan = createResearchPlanV1()
    const response = createQualitativeResponseV1(plan)
    const duplicate = {
      ...response.externalEvidence[0],
      sourceId: "duplicate-source",
      url: `${response.externalEvidence[0]!.url}?utm_source=copy#top`,
      retrievedAt: "2026-08-28T14:05:00.000Z",
      questionIds: ["unknown-question"],
    }
    const result = validateQualitativeResearchResponseV1(
      {
        ...response,
        externalEvidence: [
          {
            ...response.externalEvidence[0],
            retrievedAt: "2026-08-28T14:00:00.000Z",
          },
          duplicate,
        ],
      },
      plan,
      PLAN_EVALUATED_AT,
    )

    expect(issueCodes(result)).toEqual([
      "EVIDENCE_BEFORE_FRESHNESS_FLOOR",
      "UNKNOWN_QUESTION_REFERENCE",
      "EVIDENCE_FROM_FUTURE",
      "DUPLICATE_EXTERNAL_SOURCE",
    ])
  })

  it("rejects duplicate FMP observations independently of source labels", () => {
    const plan = createResearchPlanV1()
    const response = createQualitativeResponseV1(plan)
    const fmpSource = {
      provider: "FMP" as const,
      sourceId: "fmp-one",
      verification: "AGENT_REPORTED" as const,
      dataset: "economic-calendar",
      observedAt: "2026-08-28T13:30:00.000Z",
      retrievedAt: "2026-08-28T14:02:00.000Z",
      summary: "Current macro observation.",
      relevance: "NEUTRAL" as const,
      questionIds: ["current-thesis-evidence"],
    }
    const result = validateQualitativeResearchResponseV1(
      {
        ...response,
        externalEvidence: [
          ...response.externalEvidence,
          fmpSource,
          { ...fmpSource, sourceId: "fmp-two" },
        ],
      },
      plan,
      PLAN_EVALUATED_AT,
    )

    expect(issueCodes(result)).toEqual(["DUPLICATE_EXTERNAL_SOURCE"])
  })

  it("requires declared Exa evidence, contradiction search, and veto on conflicts before continuing", () => {
    const plan = createResearchPlanV1()
    const response = createQualitativeResponseV1(plan)
    const result = validateQualitativeResearchResponseV1(
      {
        ...response,
        contradictionSearchPerformed: false,
        externalEvidence: [],
        conflicts: ["Current sources materially disagree."],
      },
      plan,
      PLAN_EVALUATED_AT,
    )

    expect(issueCodes(result)).toEqual([
      "REQUIRED_EXA_EVIDENCE_MISSING",
      "CONTRADICTION_SEARCH_REQUIRED",
      "UNRESOLVED_CONFLICT_CONTINUED",
    ])
  })

  it("allows a fail-closed veto when required evidence cannot be obtained", () => {
    const plan = createResearchPlanV1()
    const response = {
      ...createQualitativeResponseV1(plan, "VETO"),
      contradictionSearchPerformed: false,
      externalEvidence: [],
      conflicts: ["Required current evidence could not be established."],
    }

    expect(
      validateQualitativeResearchResponseV1(
        response,
        plan,
        PLAN_EVALUATED_AT,
      ),
    ).toEqual({ success: true, data: response })
  })

  it("rejects an expired or tampered plan before trusting response prose", () => {
    const plan = createResearchPlanV1()
    expect(
      issueCodes(
        validateQualitativeResearchResponseV1(
          createQualitativeResponseV1(plan),
          plan,
          "2026-08-28T14:07:00.000Z",
        ),
      ),
    ).toEqual(["PLAN_EXPIRED"])

    expect(
      issueCodes(
        validateQualitativeResearchResponseV1(
          createQualitativeResponseV1(plan),
          { ...plan, planId: "d".repeat(64) },
          PLAN_EVALUATED_AT,
        ),
      ),
    ).toEqual(["PLAN_INVALID"])
  })
})