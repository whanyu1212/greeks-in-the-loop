import { describe, expect, it } from "vitest"

import {
  agentResearchScreeningAuditV1Schema,
  applicationResearchScreeningAuditV1Schema,
  classifyResearchScreeningComparisonV1,
  createApplicationCaptureUnavailableAuditV1,
  createApplicationResearchScreeningAuditV1,
  createApplicationScreeningUnavailableAuditV1,
  createResearchScreeningAuditInputIdentityV1,
  createResearchScreeningAuditV1,
  debitVerticalScreeningDiagnosticsV1Schema,
  projectResearchReportV2ForScreeningAudit,
  RESEARCH_SCREENING_COMPARISON_CLASSES,
  researchScreeningAuditInputIdentityV1Schema,
  researchScreeningAuditV1Schema,
  type AgentResearchScreeningAuditV1,
  type IdenticalInputParityChecksV1,
  type ResearchScreeningAuditInputIdentityV1,
} from "../src/contracts/research-screening-audit-v1.js"
import {
  computeDebitVerticalCandidateIdV1,
  screenSpyDirectionalDebitVerticalV1,
  screenSpyDirectionalDebitVerticalWithAuditV1,
} from "../src/strategy/directional-debit-vertical-v1.js"
import {
  auditResearchInvocationV1,
  createAuditContractV1,
  createAuditResearchReportV2,
  createAuditSnapshotPairV1,
  createEligibleAuditContractsV1,
  createHistoricalAuditSnapshotPairV1,
} from "./fixtures/research-screening-audit-v1.js"

const MATCHES: IdenticalInputParityChecksV1 = {
  feature: "MATCH",
  filter: "MATCH",
  ranking: "MATCH",
  candidate: "MATCH",
}

const failureCount = (
  audited: ReturnType<typeof screenSpyDirectionalDebitVerticalWithAuditV1>,
  reason: string,
) => audited.diagnostics.firstFailureCounts.find(
  (failure) => failure.reason === reason,
)?.count

const selectedApplication = () => {
  const pair = createAuditSnapshotPairV1()
  return {
    pair,
    application: createApplicationResearchScreeningAuditV1({
      pair,
      audited: screenSpyDirectionalDebitVerticalWithAuditV1(pair),
      captureDurationMs: 250,
      screeningDurationMs: 5,
    }),
  }
}

const availableAgent = () => projectResearchReportV2ForScreeningAudit(
  createAuditResearchReportV2(),
  auditResearchInvocationV1,
)

describe("research screening audit V1", () => {
  it("preserves the existing selected result while adding canonical counts", () => {
    const contracts = [
      ...createEligibleAuditContractsV1(),
      createAuditContractV1({
        expirationDate: "2026-09-11",
        strikeCentsPerShare: 62_000,
      }),
      createAuditContractV1({
        expirationDate: "2026-09-11",
        strikeCentsPerShare: 62_500,
        quote: {
          providerTimestamp: "2026-08-28T14:00:45.000Z",
          bidCentsPerShare: 150,
          askCentsPerShare: 160,
        },
        greeks: {
          deltaMillionths: 300_000,
          gammaMillionths: 20_000,
          thetaMillionths: -100_000,
          vegaMillionths: 150_000,
          impliedVolatilityMillionths: 200_000,
        },
      }),
    ]
    const pair = createAuditSnapshotPairV1({ contracts })
    const audited = screenSpyDirectionalDebitVerticalWithAuditV1(pair)

    expect(audited.result).toEqual(screenSpyDirectionalDebitVerticalV1(pair))
    expect(audited.result).toMatchObject({
      status: "SELECTED",
      eligibleCandidateCount: 2,
      selectedCandidate: {
        candidateId: "926f907fb4be051b2908251bbcf73b30ecbe5c98561b8f8788f30dad57c7d2f5",
        candidateVersion: "1.0.0",
      },
    })
    expect(audited.diagnostics).toMatchObject({
      diagnosticsVersion: "1.0.0",
      inputContractCount: 4,
      contractRoleEvaluationCount: 8,
      eligibleLongContractCount: 2,
      eligibleShortContractCount: 2,
      spreadPairEvaluationCount: 4,
      eligibleCandidateCount: 2,
    })
    expect(failureCount(audited, "NOT_RANK_ONE")).toBe(1)
    expect([
      audited,
      audited.result,
      audited.diagnostics,
      audited.diagnostics.firstFailureCounts,
    ].every(Object.isFrozen)).toBe(true)
  })

  it.each([
    [
      "manifest compatibility",
      () => createHistoricalAuditSnapshotPairV1(),
      "STRATEGY_MANIFEST_INCOMPATIBLE",
    ],
    [
      "neutral feature",
      () => createAuditSnapshotPairV1({
        mutateUnderlying(input) {
          input.underlyingQuote.bidMicrosPerShare = 635_190_000
          input.underlyingQuote.askMicrosPerShare = 635_200_000
        },
      }),
      "FEATURE_SIGNAL_NOT_ACTIONABLE",
    ],
    [
      "market freshness",
      () => createAuditSnapshotPairV1({
        mutateUnderlying(input) {
          input.times.evaluatedAt = "2026-08-28T14:01:31.000Z"
        },
      }),
      "UNDERLYING_QUOTE_STALE",
    ],
    [
      "candidate eligibility",
      () => createAuditSnapshotPairV1({
        contracts: [createAuditContractV1({
          strikeCentsPerShare: 63_000,
          tradable: false,
        })],
      }),
      "CONTRACT_NOT_TRADABLE",
    ],
  ])("preserves the %s no-action family", (_label, buildPair, reason) => {
    const pair = buildPair()
    const audited = screenSpyDirectionalDebitVerticalWithAuditV1(pair)
    expect(audited.result).toEqual(screenSpyDirectionalDebitVerticalV1(pair))
    expect(audited.result.status).toBe("NO_ACTION")
    expect(failureCount(audited, reason)).toBeGreaterThan(0)
    const application = createApplicationResearchScreeningAuditV1({
      pair,
      audited,
      captureDurationMs: 1,
      screeningDurationMs: 1,
    })
    expect(application.status).toBe("SCREENED")
    if (reason === "CONTRACT_NOT_TRADABLE" &&
      application.status === "SCREENED" &&
      application.result.status === "NO_ACTION") {
      expect(applicationResearchScreeningAuditV1Schema.safeParse({
        ...application,
        result: { ...application.result, reason: "SIGNAL_NOT_ACTIONABLE" },
      }).success).toBe(false)
    }
  })

  it.each([
    [
      "ELIGIBILITY",
      [createAuditContractV1({ strikeCentsPerShare: 63_000, tradable: false })],
    ],
    [
      "LIQUIDITY",
      [createAuditContractV1({
        strikeCentsPerShare: 63_000,
        currentSessionVolume: {
          sessionDate: "2026-08-28",
          providerTimestamp: "2026-08-28T14:00:00.000Z",
          contracts: 99,
        },
      })],
    ],
    [
      "ECONOMICS",
      [
        createAuditContractV1({
          strikeCentsPerShare: 63_000,
          quote: {
            providerTimestamp: "2026-08-28T14:00:45.000Z",
            bidCentsPerShare: 500,
            askCentsPerShare: 510,
          },
        }),
        createAuditContractV1({
          strikeCentsPerShare: 63_500,
          quote: {
            providerTimestamp: "2026-08-28T14:00:45.000Z",
            bidCentsPerShare: 190,
            askCentsPerShare: 200,
          },
          greeks: {
            deltaMillionths: 300_000,
            gammaMillionths: 20_000,
            thetaMillionths: -100_000,
            vegaMillionths: 150_000,
            impliedVolatilityMillionths: 200_000,
          },
        }),
      ],
    ],
  ])("retains a bounded %s first failure", (stage, contracts) => {
    const audited = screenSpyDirectionalDebitVerticalWithAuditV1(
      createAuditSnapshotPairV1({ contracts }),
    )
    expect(audited.diagnostics.firstFailureCounts).toContainEqual(
      expect.objectContaining({ stage }),
    )
  })

  it("rejects a contract claimed eligible for both disjoint leg roles", () => {
    expect(debitVerticalScreeningDiagnosticsV1Schema.safeParse({
      diagnosticsVersion: "1.0.0",
      underlyingSnapshotId: "a".repeat(64),
      optionUniverseSnapshotId: "b".repeat(64),
      inputContractCount: 1,
      contractRoleEvaluationCount: 2,
      eligibleLongContractCount: 1,
      eligibleShortContractCount: 1,
      spreadPairEvaluationCount: 1,
      eligibleCandidateCount: 1,
      firstFailureCounts: [],
    }).success).toBe(false)
  })

  it("canonicalizes capture failure reasons", () => {
    const audit = createApplicationCaptureUnavailableAuditV1([
      "PROVIDER_RATE_LIMITED",
      "REQUEST_TIMED_OUT",
      "REQUEST_TIMED_OUT",
    ], 1)
    expect(audit).toMatchObject({
      status: "CAPTURE_UNAVAILABLE",
      reasons: ["REQUEST_TIMED_OUT", "PROVIDER_RATE_LIMITED"],
    })
    if (audit.status !== "CAPTURE_UNAVAILABLE") return
    for (const reasons of [
      ["REQUEST_TIMED_OUT", "REQUEST_TIMED_OUT"],
      [...audit.reasons].reverse(),
    ]) {
      expect(applicationResearchScreeningAuditV1Schema.safeParse({
        ...audit,
        reasons,
      }).success).toBe(false)
    }
  })

  it("caps retained option counts at the snapshot contract limit", () => {
    expect(researchScreeningAuditInputIdentityV1Schema.safeParse({
      authority: "APPLICATION",
      evaluatedAt: "2026-08-28T14:01:00.000Z",
      underlyingSnapshotId: "a".repeat(64),
      optionUniverseSnapshotId: "b".repeat(64),
      optionUniverseMembershipId: "c".repeat(64),
      optionContractCount: 10_001,
    }).success).toBe(false)
    expect(debitVerticalScreeningDiagnosticsV1Schema.safeParse({
      diagnosticsVersion: "1.0.0",
      underlyingSnapshotId: "a".repeat(64),
      optionUniverseSnapshotId: "b".repeat(64),
      inputContractCount: 10_001,
      contractRoleEvaluationCount: 20_002,
      eligibleLongContractCount: 0,
      eligibleShortContractCount: 0,
      spreadPairEvaluationCount: 0,
      eligibleCandidateCount: 0,
      firstFailureCounts: [{
        stage: "ELIGIBILITY",
        reason: "OPTION_TYPE_MISMATCH",
        count: 20_002,
      }],
    }).success).toBe(false)
  })

  it("makes diagnostics independent of provider contract ordering", () => {
    const contracts = createEligibleAuditContractsV1()
    const baseline = screenSpyDirectionalDebitVerticalWithAuditV1(
      createAuditSnapshotPairV1({ contracts }),
    )
    const reordered = screenSpyDirectionalDebitVerticalWithAuditV1(
      createAuditSnapshotPairV1({ contracts: [...contracts].reverse() }),
    )
    expect(reordered).toEqual(baseline)
    expect(createResearchScreeningAuditInputIdentityV1(
      createAuditSnapshotPairV1({ contracts: [...contracts].reverse() }),
    )).toEqual(createResearchScreeningAuditInputIdentityV1(
      createAuditSnapshotPairV1({ contracts }),
    ))
  })

  it("projects only bounded agent identity, evidence, and candidate fields", () => {
    const report = createAuditResearchReportV2()
    const projected = projectResearchReportV2ForScreeningAudit(
      report,
      auditResearchInvocationV1,
    )
    expect(projected).toMatchObject({
      status: "AVAILABLE",
      invocation: {
        invocationVersion: "1.3.0",
        providerId: "openai",
        modelId: "gpt-5.6-sol",
      },
      terminalClass: "PROPOSE_TRADE",
      proposalCandidate: {
        direction: "BULLISH",
        expiration: "2026-09-18",
        longContractSymbol: "SPY260918C00630000",
        shortContractSymbol: "SPY260918C00635000",
      },
    })
    if (projected.status !== "AVAILABLE") return
    const retained = JSON.stringify(projected)
    for (const excluded of [
      "Model prose",
      "More model prose",
      "financial claim",
      "example.com",
      "private-path",
      "dailyClose",
      "delta",
      "strike",
      "summary",
    ]) expect(retained).not.toContain(excluded)
    expect(agentResearchScreeningAuditV1Schema.safeParse({
      ...projected,
      thesis: "not allowed",
    }).success).toBe(false)
    expect(agentResearchScreeningAuditV1Schema.safeParse({
      ...projected,
      proposalCandidate: {
        ...projected.proposalCandidate!,
        direction: "BEARISH",
        structure: "BEAR_PUT_SPREAD",
      },
    }).success).toBe(false)
    expect(agentResearchScreeningAuditV1Schema.safeParse({
      ...projected,
      invocation: { ...projected.invocation, modelId: "drifted-model" },
    }).success).toBe(false)
    for (const evidenceReferences of [
      [{
        kind: "OBSERVATION",
        claimId: "future-observation",
        provider: "ALPACA",
        observedAt: "2026-08-28T14:01:01.000Z",
      }],
      [{
        kind: "EXTERNAL",
        sourceId: "reversed-external",
        provider: "EXA",
        observedAt: "2026-08-28T14:00:01.000Z",
        retrievedAt: "2026-08-28T14:00:00.000Z",
      }],
      [{
        kind: "EXTERNAL",
        sourceId: "future-retrieval",
        provider: "FMP",
        observedAt: "2026-08-28T14:00:00.000Z",
        retrievedAt: "2026-08-28T14:01:01.000Z",
      }],
    ]) {
      expect(agentResearchScreeningAuditV1Schema.safeParse({
        ...projected,
        evidenceReferences,
      }).success).toBe(false)
    }
    expect(agentResearchScreeningAuditV1Schema.safeParse({
      ...projected,
      terminalClass: "NO_ACTION",
      noActionReasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
    }).success).toBe(false)
    for (const noActionReasonCodes of [
      [],
      ["UNBOUNDED_REASON"],
      ["SIGNAL_NOT_ACTIONABLE", "SIGNAL_NOT_ACTIONABLE"],
      ["NO_ELIGIBLE_SPREAD", "SIGNAL_NOT_ACTIONABLE"],
    ]) {
      expect(agentResearchScreeningAuditV1Schema.safeParse({
        ...projected,
        terminalClass: "NO_ACTION",
        noActionReasonCodes,
        proposalCandidate: undefined,
      }).success).toBe(false)
    }
    const noActionReport = {
      ...report,
      result: {
        contractVersion: "1.0.0",
        strategyVersion: "1.1.0",
        outcome: "NO_ACTION",
        reasonCodes: [
          "NO_ELIGIBLE_SPREAD",
          "SIGNAL_NOT_ACTIONABLE",
          "SIGNAL_NOT_ACTIONABLE",
        ],
        evidence: report.result.evidence,
      },
    } as typeof report
    expect(projectResearchReportV2ForScreeningAudit(
      noActionReport,
      auditResearchInvocationV1,
    )).toMatchObject({
      noActionReasonCodes: ["SIGNAL_NOT_ACTIONABLE", "NO_ELIGIBLE_SPREAD"],
    })
  })

  it("binds application results and deterministic components to one snapshot pair", () => {
    const first = createAuditSnapshotPairV1()
    const second = createAuditSnapshotPairV1({
      mutateUnderlying(input) {
        input.underlyingQuote.bidMicrosPerShare += 1
      },
    })
    expect(() => createApplicationResearchScreeningAuditV1({
      pair: first,
      audited: screenSpyDirectionalDebitVerticalWithAuditV1(second),
      captureDurationMs: 1,
      screeningDurationMs: 1,
    })).toThrow("Audited screening result does not match its snapshot pair")

    const application = createApplicationResearchScreeningAuditV1({
      pair: first,
      audited: screenSpyDirectionalDebitVerticalWithAuditV1(first),
      captureDurationMs: 1,
      screeningDurationMs: 1,
    })
    expect(application).toMatchObject({
      strategy: {
        featureComponentId: "calculateDirectionalTrendFeaturesV1",
        featureVersion: "1.0.0",
        candidateComponentId: "screenSpyDirectionalDebitVerticalV1",
        candidateVersion: "1.0.0",
      },
    })
    if (application.status !== "SCREENED" ||
      application.result.status !== "SELECTED") return
    expect(computeDebitVerticalCandidateIdV1({
      underlyingSnapshotId: application.inputIdentity.underlyingSnapshotId,
      optionUniverseSnapshotId:
        application.inputIdentity.optionUniverseSnapshotId,
      ...application.strategy,
      underlying: "SPY",
      direction: application.result.direction,
      structure: application.result.structure,
      expirationDate: application.result.expirationDate,
      longLeg: { contractSymbol: application.result.longContractSymbol },
      shortLeg: { contractSymbol: application.result.shortContractSymbol },
    })).toBe(application.result.candidateId)
    for (const result of [
      { ...application.result, dte: 20 },
      { ...application.result, widthCentsPerShare: 100 },
    ]) {
      expect(applicationResearchScreeningAuditV1Schema.safeParse({
        ...application,
        result,
      }).success).toBe(false)
    }
    const reidentify = (
      result: typeof application.result,
    ): typeof application.result => ({
      ...result,
      candidateId: computeDebitVerticalCandidateIdV1({
        underlyingSnapshotId: application.inputIdentity.underlyingSnapshotId,
        optionUniverseSnapshotId:
          application.inputIdentity.optionUniverseSnapshotId,
        ...application.strategy,
        underlying: "SPY",
        direction: result.direction,
        structure: result.structure,
        expirationDate: result.expirationDate,
        longLeg: { contractSymbol: result.longContractSymbol },
        shortLeg: { contractSymbol: result.shortContractSymbol },
      }),
    })
    for (const result of [
      reidentify({
        ...application.result,
        direction: "BEARISH",
        structure: "BEAR_PUT_SPREAD",
      }),
      reidentify({ ...application.result, expirationDate: "2026-09-19" }),
      reidentify({
        ...application.result,
        shortContractSymbol: application.result.longContractSymbol,
      }),
      reidentify({
        ...application.result,
        longContractSymbol: application.result.shortContractSymbol,
        shortContractSymbol: application.result.longContractSymbol,
      }),
      reidentify({
        ...application.result,
        longContractSymbol: "SPY260918C00640000",
        shortContractSymbol: "SPY260918C00645000",
        widthCentsPerShare: 500,
      }),
    ]) {
      expect(applicationResearchScreeningAuditV1Schema.safeParse({
        ...application,
        result,
      }).success).toBe(false)
    }
    const incompatibleStrategy = {
      ...application.strategy,
      strategyVersion: "9.9.9",
    }
    expect(applicationResearchScreeningAuditV1Schema.safeParse({
      ...application,
      strategy: incompatibleStrategy,
      result: {
        ...application.result,
        candidateId: computeDebitVerticalCandidateIdV1({
          underlyingSnapshotId: application.inputIdentity.underlyingSnapshotId,
          optionUniverseSnapshotId:
            application.inputIdentity.optionUniverseSnapshotId,
          ...incompatibleStrategy,
          underlying: "SPY",
          direction: application.result.direction,
          structure: application.result.structure,
          expirationDate: application.result.expirationDate,
          longLeg: { contractSymbol: application.result.longContractSymbol },
          shortLeg: { contractSymbol: application.result.shortContractSymbol },
        }),
      },
    }).success).toBe(false)
    expect(applicationResearchScreeningAuditV1Schema.safeParse({
      ...application,
      diagnostics: {
        ...application.diagnostics,
        contractRoleEvaluationCount: 0,
        eligibleLongContractCount: 0,
        eligibleShortContractCount: 0,
        spreadPairEvaluationCount: 0,
        firstFailureCounts: [],
      },
    }).success).toBe(false)
  })

  it("classifies every comparison class with fail-closed precedence", () => {
    const { pair, application } = selectedApplication()
    const agent = availableAgent()
    const identity = createResearchScreeningAuditInputIdentityV1(pair)
    const changed = (
      overrides: Partial<ResearchScreeningAuditInputIdentityV1>,
    ): ResearchScreeningAuditInputIdentityV1 => ({ ...identity, ...overrides })
    const mismatch = (
      field: keyof IdenticalInputParityChecksV1,
    ): IdenticalInputParityChecksV1 => ({ ...MATCHES, [field]: "MISMATCH" })
    const drift: AgentResearchScreeningAuditV1 = {
      status: "MODEL_IDENTITY_DRIFT",
      invocationVersion: "1.3.0",
      reason: "MODEL_DRIFT",
      expected: "gpt-5.6-sol",
      observed: "different-model",
    }
    expect(agentResearchScreeningAuditV1Schema.safeParse(drift).success).toBe(true)
    for (const invalid of [
      { ...drift, expected: "invented-model" },
      { ...drift, observed: drift.expected },
      { ...drift, invocationVersion: "1.1.0" },
    ]) expect(agentResearchScreeningAuditV1Schema.safeParse(invalid).success).toBe(false)
    const unavailable: AgentResearchScreeningAuditV1 = {
      status: "UNAVAILABLE",
      reason: "INVOCATION_FAILED",
    }
    const unavailableApplication = createApplicationCaptureUnavailableAuditV1(
      ["REQUEST_TIMED_OUT"],
      500,
    )
    const screeningUnavailable = createApplicationScreeningUnavailableAuditV1({
      pair,
      captureDurationMs: 250,
      screeningDurationMs: 1,
      reason: "UNEXPECTED_FAILURE",
    })
    const cases = [
      ["IDENTICAL_INPUT_MATCH", application, agent, identity, MATCHES],
      ["IDENTICAL_INPUT_FEATURE_MISMATCH", application, agent, identity, mismatch("feature")],
      ["IDENTICAL_INPUT_FILTER_MISMATCH", application, agent, identity, mismatch("filter")],
      ["IDENTICAL_INPUT_RANKING_MISMATCH", application, agent, identity, mismatch("ranking")],
      ["IDENTICAL_INPUT_CANDIDATE_MISMATCH", application, agent, identity, mismatch("candidate")],
      ["DIFFERENT_SNAPSHOT_TIME", application, agent, changed({ evaluatedAt: "2026-08-28T14:01:01.000Z" }), undefined],
      ["DIFFERENT_SNAPSHOT_MEMBERSHIP", application, agent, changed({ optionUniverseMembershipId: "f".repeat(64) }), undefined],
      ["APPLICATION_CAPTURE_UNAVAILABLE", unavailableApplication, agent, undefined, undefined],
      ["APPLICATION_SCREENING_UNAVAILABLE", screeningUnavailable, agent, undefined, undefined],
      ["AGENT_RESULT_UNAVAILABLE", application, unavailable, undefined, undefined],
      ["MODEL_IDENTITY_DRIFT", application, drift, undefined, undefined],
      ["COMPARISON_NOT_REPRESENTABLE", application, agent, undefined, undefined],
    ] as const

    expect(cases.map(([, app, result, trusted, checks]) =>
      classifyResearchScreeningComparisonV1({
        application: app,
        agent: result,
        ...(trusted === undefined ? {} : { trustedAgentInputIdentity: trusted }),
        ...(checks === undefined ? {} : { identicalInputChecks: checks }),
      }).class,
    )).toEqual(RESEARCH_SCREENING_COMPARISON_CLASSES)

    expect(classifyResearchScreeningComparisonV1({
      application,
      agent,
      trustedAgentInputIdentity: identity,
      identicalInputChecks: {
        feature: "MATCH",
        filter: "UNAVAILABLE",
        ranking: "MISMATCH",
        candidate: "MISMATCH",
      },
    }).class).toBe("COMPARISON_NOT_REPRESENTABLE")
    const unequalIdentity = classifyResearchScreeningComparisonV1({
      application,
      agent,
      trustedAgentInputIdentity: changed({ underlyingSnapshotId: "e".repeat(64) }),
      identicalInputChecks: MATCHES,
    })
    expect(unequalIdentity.class).toBe("COMPARISON_NOT_REPRESENTABLE")
    expect(unequalIdentity.identicalInputChecks).toBeUndefined()

    const complete = createResearchScreeningAuditV1({
      application,
      agent,
      trustedAgentInputIdentity: identity,
      identicalInputChecks: MATCHES,
    })
    expect(complete.comparison.class).toBe("IDENTICAL_INPUT_MATCH")
    expect(researchScreeningAuditV1Schema.safeParse({
      ...complete,
      comparison: {
        ...complete.comparison,
        class: "IDENTICAL_INPUT_CANDIDATE_MISMATCH",
      },
    }).success).toBe(false)
  })
})
