import { describe, expect, it } from "vitest"

import type { PreliminaryResearchV1 } from "../src/contracts/preliminary-research-v1.js"
import type { ProposedTradeDecisionV1 } from "../src/contracts/research-decision-v1.js"
import type { ResearchReportV2 } from "../src/contracts/research-report-v2.js"
import { deriveTradeIntentV1 } from "../src/contracts/trade-intent-v1.js"
import {
  evaluateResearchRunV1,
  researchRunEvaluationV1Schema,
} from "../src/evaluation/research-run-evaluation-v1.js"
import type { ResearchRunV1 } from "../src/research/research-artifact.js"

const preliminaryResearch = (): PreliminaryResearchV1 => ({
  contractVersion: "1.0.0",
  strategyVersion: "1.0.0",
  outcome: "PRELIMINARY_RESEARCH",
  targetSessionDate: "2026-08-26",
  direction: "UNDETERMINED",
  thesis: "private-thesis-marker",
  invalidation: ["private-invalidation-marker"],
  evidence: [
    {
      claimId: "prior-close",
      kind: "SOURCED_FACT",
      claim: "private-fact-marker",
      provider: "ALPACA",
      temporalClass: "PRIOR_CLOSE",
      observedAt: "2026-08-25T20:00:00.000Z",
      locator: "private-locator-marker",
    },
    {
      claimId: "derived-view",
      kind: "INFERENCE",
      claim: "private-inference-marker",
      basedOn: ["prior-close"],
    },
  ],
  requiresRefresh: true,
})

const reportFor = (research: PreliminaryResearchV1): ResearchReportV2 => ({
  reportVersion: "2.0.0",
  result: research,
  analysis: {
    provenance: "AGENT_REPORTED",
    asOf: "2026-08-26T12:04:00.000Z",
    accountChecks: {
      verification: "AGENT_REPORTED",
      observedAt: "2026-08-26T12:01:00.000Z",
      accountStatus: "ACTIVE",
      optionsTradingApproved: true,
      conflictingStrategyExposure: false,
    },
    marketRegime: {
      verification: "AGENT_REPORTED",
      temporalClass: "PRIOR_CLOSE",
      observedAt: "2026-08-25T20:00:00.000Z",
      signal: "UNAVAILABLE",
      dailySessionCount: 50,
      intradayBarCount: 0,
    },
    externalContext: [
      {
        sourceId: "exa-source",
        provider: "EXA",
        verification: "AGENT_REPORTED",
        title: "private-title-marker",
        url: "https://private.example/secret-path",
        publishedAt: "2026-08-26T10:00:00.000Z",
        retrievedAt: "2026-08-26T12:02:00.000Z",
        summary: "private-summary-marker",
        relevance: "NEUTRAL",
      },
    ],
    supportingFactors: ["private-support-marker"],
    contradictingFactors: ["private-contradiction-marker"],
    conflicts: ["private-conflict-marker"],
  },
})

const preliminaryRun = (): ResearchRunV1 => {
  const research = preliminaryResearch()
  return {
    runVersion: "1.0.0",
    cycle: {
      cycleId: "cycle-evaluation-1",
      cycleNumber: 1,
      correlationId: "correlation-evaluation-1",
      sessionId: "session-evaluation-1",
      startedAt: "2026-08-26T12:00:00.000Z",
      completedAt: "2026-08-26T12:05:00.000Z",
      sessionDate: "2026-08-26",
    },
    initialEligibility: {
      evaluatedAt: "2026-08-26T11:59:59.000Z",
      sessionDate: "2026-08-26",
      researchEligible: true,
      tradeIntentEligible: false,
      reason: "OUTSIDE_TRADE_INTENT_WINDOW",
    },
    evidenceSnapshots: [],
    preliminaryResearch: research,
    researchReport: reportFor(research),
    outcome: {
      outcomeVersion: "1.0.0",
      status: "PRELIMINARY_RESEARCH_RETAINED",
      research,
    },
    ledger: {
      firstSequence: 1,
      lastSequence: 4,
      terminalEventId: "terminal-evaluation-1",
    },
  }
}

const noActionRun = (): ResearchRunV1 => {
  const {
    preliminaryResearch: _preliminaryResearch,
    researchReport: _researchReport,
    ...base
  } = preliminaryRun()
  const decision = {
    contractVersion: "1.0.0" as const,
    strategyVersion: "1.0.0" as const,
    outcome: "NO_ACTION" as const,
    reasonCodes: ["SIGNAL_NOT_ACTIONABLE" as const],
    evidence: [],
  }
  return {
    ...base,
    validatedDecision: decision,
    outcome: {
      outcomeVersion: "1.0.0",
      status: "VALIDATED_NO_ACTION",
      decision,
    },
  }
}

const derivedIntentRun = (): ResearchRunV1 => {
  const {
    preliminaryResearch: _preliminaryResearch,
    researchReport: _researchReport,
    ...base
  } = preliminaryRun()
  const decision: ProposedTradeDecisionV1 = {
    contractVersion: "1.0.0",
    strategyVersion: "1.0.0",
    outcome: "PROPOSE_TRADE",
    direction: "BULLISH",
    thesis: "private-proposal-marker",
    candidate: {
      underlying: "SPY",
      structure: "BULL_CALL_SPREAD",
      expiration: "2026-09-18",
      longLeg: {
        contractSymbol: "SPY260918C00600000",
        strike: 600,
      },
      shortLeg: {
        contractSymbol: "SPY260918C00610000",
        strike: 610,
      },
    },
    invalidation: ["private-proposal-invalidation"],
    evidence: [
      {
        claimId: "quote-fact",
        kind: "SOURCED_FACT",
        claim: "private-proposal-fact",
        snapshotRef: "quote-snapshot",
      },
    ],
  }
  const derived = deriveTradeIntentV1(decision, {
    quoteSnapshotRef: "quote-snapshot",
    evaluatedAt: "2026-08-26T14:04:00.000Z",
    longQuote: {
      contractSymbol: "SPY260918C00600000",
      feed: "INDICATIVE",
      bidCentsPerShare: 100,
      askCentsPerShare: 110,
      providerTimestamp: "2026-08-26T14:03:59.000Z",
    },
    shortQuote: {
      contractSymbol: "SPY260918C00610000",
      feed: "INDICATIVE",
      bidCentsPerShare: 50,
      askCentsPerShare: 60,
      providerTimestamp: "2026-08-26T14:03:59.000Z",
    },
  })
  if (!derived.success) throw new Error("Expected valid derived-intent fixture")

  return {
    ...base,
    cycle: {
      ...base.cycle,
      startedAt: "2026-08-26T14:00:00.000Z",
      completedAt: "2026-08-26T14:05:00.000Z",
    },
    initialEligibility: {
      evaluatedAt: "2026-08-26T14:00:30.000Z",
      sessionDate: "2026-08-26",
      researchEligible: true,
      tradeIntentEligible: true,
      tradeIntentWindow: {
        slotStartedAt: "2026-08-26T14:00:00.000Z",
        deadline: "2026-08-26T14:05:00.000Z",
      },
    },
    evidenceSnapshots: [
      {
        snapshotRef: "quote-snapshot",
        provider: "ALPACA",
        source: "option-quotes",
        retrievedAt: "2026-08-26T14:03:59.000Z",
        freshUntil: "2026-08-26T14:04:59.000Z",
        temporalClass: "LIVE",
      },
    ],
    validatedDecision: decision,
    outcome: {
      outcomeVersion: "1.0.0",
      status: "INTENT_DERIVED",
      decision,
      intent: derived.intent,
    },
  }
}

describe("research run evaluation", () => {
  it("evaluates a healthy preliminary run deterministically", () => {
    const run = preliminaryRun()
    const first = evaluateResearchRunV1(run)
    const second = evaluateResearchRunV1(run)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(researchRunEvaluationV1Schema.safeParse(first).success).toBe(true)
    expect(first.dimensions).toEqual({
      contractCompliance: { status: "PASS", issueCodes: [] },
      temporalIntegrity: { status: "PASS", issueCodes: [] },
      grounding: { status: "PASS", issueCodes: [] },
      candidateIdentity: { status: "NOT_APPLICABLE", issueCodes: [] },
      failClosedBehavior: { status: "PASS", issueCodes: [] },
    })
    expect(first.metrics).toEqual({
      sourcedFactCount: 1,
      inferenceCount: 1,
      groundedInferenceCount: 1,
      snapshotReferenceCount: 0,
      exaSourceCount: 1,
      fmpSourceCount: 0,
    })
  })

  it("never copies retained research content into evaluation output", () => {
    const serialized = JSON.stringify(evaluateResearchRunV1(preliminaryRun()))

    for (const marker of [
      "private-thesis-marker",
      "private-invalidation-marker",
      "private-fact-marker",
      "private-inference-marker",
      "private-locator-marker",
      "private-title-marker",
      "private.example",
      "private-summary-marker",
      "private-support-marker",
      "private-contradiction-marker",
      "private-conflict-marker",
    ]) {
      expect(serialized).not.toContain(marker)
    }
  })

  it("evaluates valid no-action and derived-intent outcomes", () => {
    const noAction = evaluateResearchRunV1(noActionRun())
    const derived = evaluateResearchRunV1(derivedIntentRun())

    expect(noAction.dimensions.contractCompliance.status).toBe("PASS")
    expect(noAction.dimensions.candidateIdentity.status).toBe("NOT_APPLICABLE")
    expect(derived.dimensions).toEqual({
      contractCompliance: { status: "PASS", issueCodes: [] },
      temporalIntegrity: { status: "PASS", issueCodes: [] },
      grounding: { status: "PASS", issueCodes: [] },
      candidateIdentity: { status: "PASS", issueCodes: [] },
      failClosedBehavior: { status: "PASS", issueCodes: [] },
    })
  })

  it("reports decision references to unknown snapshots", () => {
    const run = derivedIntentRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      evidenceSnapshots: [],
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: ["UNKNOWN_SNAPSHOT_REFERENCE"],
    })
    const serialized = JSON.stringify(evaluateResearchRunV1(run))
    expect(serialized).not.toContain("private-proposal-marker")
    expect(serialized).not.toContain("SPY260918C00600000")
  })

  it("reports an intent quote reference to an unknown snapshot", () => {
    const run = derivedIntentRun()
    if (run.outcome.status !== "INTENT_DERIVED") {
      throw new Error("Expected a derived-intent fixture")
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      outcome: {
        ...run.outcome,
        intent: {
          ...run.outcome.intent,
          quoteSnapshotRef: "missing-intent-snapshot",
        },
      },
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: ["UNKNOWN_SNAPSHOT_REFERENCE"],
    })
  })

  it("reports report and source timestamps outside the cycle", () => {
    const run = preliminaryRun()
    const report = {
      ...run.researchReport!,
      analysis: {
        ...run.researchReport!.analysis,
        asOf: "2026-08-26T12:06:00.000Z",
        externalContext: run.researchReport!.analysis.externalContext.map(
          (source) => ({
            ...source,
            retrievedAt: "2026-08-26T12:05:30.000Z",
          }),
        ),
      },
    }

    const evaluation = evaluateResearchRunV1({ ...run, researchReport: report })

    expect(evaluation.dimensions.temporalIntegrity).toEqual({
      status: "FAIL",
      issueCodes: [
        "REPORT_AS_OF_OUTSIDE_CYCLE",
        "SOURCE_RETRIEVAL_OUTSIDE_CYCLE",
      ],
    })
  })

  it("reports inference references that do not resolve to sourced facts", () => {
    const run = preliminaryRun()
    const research = {
      ...run.preliminaryResearch!,
      evidence: run.preliminaryResearch!.evidence.map((claim) =>
        claim.kind === "INFERENCE" ? { ...claim, basedOn: ["missing-fact"] } : claim,
      ),
    } as PreliminaryResearchV1

    const evaluation = evaluateResearchRunV1({
      ...run,
      preliminaryResearch: research,
      researchReport: { ...run.researchReport!, result: research },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "PRELIMINARY_RESEARCH_RETAINED",
        research,
      },
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: ["UNGROUNDED_INFERENCE"],
    })
  })

  it("detects candidate identity drift between retained records", () => {
    const run = preliminaryRun()
    const research: PreliminaryResearchV1 = {
      ...run.preliminaryResearch!,
      direction: "BULLISH",
      candidate: {
        underlying: "SPY",
        structure: "BULL_CALL_SPREAD",
        expiration: "2026-09-18",
        longLeg: {
          contractSymbol: "SPY260918C00600000",
          strike: 600,
        },
        shortLeg: {
          contractSymbol: "SPY260918C00610000",
          strike: 610,
        },
      },
    }
    const report: ResearchReportV2 = {
      ...reportFor(research),
      analysis: {
        ...reportFor(research).analysis,
        candidateEvaluation: {
          verification: "AGENT_REPORTED",
          observedAt: "2026-08-26T12:01:00.000Z",
          dte: 23,
          legs: [
            {
              role: "LONG",
              contractSymbol: "SPY260918C00590000",
              delta: 0.5,
              impliedVolatility: 0.2,
              gamma: 0.01,
              theta: -0.05,
              vega: 0.1,
              volume: 100,
              openInterest: 500,
              openInterestDate: "2026-08-26",
            },
            {
              role: "SHORT",
              contractSymbol: "SPY260918C00620000",
              delta: 0.25,
              impliedVolatility: 0.2,
              gamma: 0.01,
              theta: -0.05,
              vega: 0.1,
              volume: 100,
              openInterest: 500,
              openInterestDate: "2026-08-26",
            },
          ],
        },
      },
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      preliminaryResearch: research,
      researchReport: report,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "PRELIMINARY_RESEARCH_RETAINED",
        research,
      },
    })

    expect(evaluation.dimensions.candidateIdentity).toEqual({
      status: "FAIL",
      issueCodes: ["CANDIDATE_IDENTITY_MISMATCH"],
    })
  })

  it("fails closed when an ineligible cycle claims to derive an intent", () => {
    const run = preliminaryRun()
    const invalidOutcome = {
      outcomeVersion: "1.0.0",
      status: "INTENT_DERIVED",
      decision: {},
      intent: {
        evaluatedAt: "2026-08-26T12:04:00.000Z",
        direction: "BULLISH",
        structure: "BULL_CALL_SPREAD",
        expiration: "2026-09-18",
        longContractSymbol: "SPY260918C00600000",
        shortContractSymbol: "SPY260918C00610000",
      },
    } as unknown as ResearchRunV1["outcome"]

    const evaluation = evaluateResearchRunV1({ ...run, outcome: invalidOutcome })

    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "FAIL",
      issueCodes: [
        "INELIGIBLE_CYCLE_DERIVED_INTENT",
        "INTENT_WITHOUT_VALIDATED_PROPOSAL",
      ],
    })
  })

  it("rejects an intent evaluated at the retained trade-window deadline", () => {
    const run = derivedIntentRun()
    if (run.outcome.status !== "INTENT_DERIVED") {
      throw new Error("Expected a derived-intent fixture")
    }
    const intent = {
      ...run.outcome.intent,
      evaluatedAt: "2026-08-26T14:05:00.000Z",
      longQuote: {
        ...run.outcome.intent.longQuote,
        providerTimestamp: "2026-08-26T14:04:59.000Z",
      },
      shortQuote: {
        ...run.outcome.intent.shortQuote,
        providerTimestamp: "2026-08-26T14:04:59.000Z",
      },
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      outcome: { ...run.outcome, intent },
    })

    expect(evaluation.dimensions.temporalIntegrity.status).toBe("PASS")
    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "FAIL",
      issueCodes: ["INTENT_OUTSIDE_RETAINED_TRADE_WINDOW"],
    })
  })

  it("does not mark legacy intents without eligibility context as safe", () => {
    const { initialEligibility: _initialEligibility, ...legacyRun } =
      derivedIntentRun()

    const evaluation = evaluateResearchRunV1(legacyRun)

    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "FAIL",
      issueCodes: ["INTENT_ELIGIBILITY_CONTEXT_MISSING"],
    })
  })

  it("rejects eligibility evaluated outside its retained trade window", () => {
    const run = derivedIntentRun()
    if (run.initialEligibility === undefined) {
      throw new Error("Expected retained eligibility")
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility,
        evaluatedAt: "2026-08-26T13:59:59.000Z",
      },
    })

    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "FAIL",
      issueCodes: ["INTENT_ELIGIBILITY_CONTEXT_INVALID"],
    })
  })

  it("rejects a retained trade window with impossible runtime boundaries", () => {
    const run = derivedIntentRun()
    if (run.initialEligibility?.tradeIntentWindow === undefined) {
      throw new Error("Expected retained trade-intent window")
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility,
        tradeIntentWindow: {
          ...run.initialEligibility.tradeIntentWindow,
          deadline: "2026-08-26T14:06:00.000Z",
        },
      },
    })

    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "FAIL",
      issueCodes: ["INTENT_ELIGIBILITY_CONTEXT_INVALID"],
    })
  })

  it("rejects a retained trade slot outside runtime entry hours", () => {
    const run = derivedIntentRun()
    if (
      run.initialEligibility?.tradeIntentWindow === undefined ||
      run.outcome.status !== "INTENT_DERIVED"
    ) {
      throw new Error("Expected a derived-intent fixture")
    }
    const intent = {
      ...run.outcome.intent,
      evaluatedAt: "2026-08-26T19:04:00.000Z",
      longQuote: {
        ...run.outcome.intent.longQuote,
        providerTimestamp: "2026-08-26T19:03:59.000Z",
      },
      shortQuote: {
        ...run.outcome.intent.shortQuote,
        providerTimestamp: "2026-08-26T19:03:59.000Z",
      },
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      cycle: {
        ...run.cycle,
        startedAt: "2026-08-26T19:00:00.000Z",
        completedAt: "2026-08-26T19:05:00.000Z",
      },
      initialEligibility: {
        ...run.initialEligibility,
        evaluatedAt: "2026-08-26T19:00:30.000Z",
        tradeIntentWindow: {
          slotStartedAt: "2026-08-26T19:00:00.000Z",
          deadline: "2026-08-26T19:05:00.000Z",
        },
      },
      evidenceSnapshots: run.evidenceSnapshots.map((snapshot) => ({
        ...snapshot,
        retrievedAt: "2026-08-26T19:03:59.000Z",
        freshUntil: "2026-08-26T19:04:59.000Z",
      })),
      outcome: { ...run.outcome, intent },
    })

    expect(evaluation.dimensions.temporalIntegrity.status).toBe("PASS")
    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "FAIL",
      issueCodes: ["INTENT_ELIGIBILITY_CONTEXT_INVALID"],
    })
  })
})
