import { describe, expect, it } from "vitest"

import type { PreliminaryResearchV1 } from "../src/contracts/preliminary-research-v1.js"
import {
  validateResearchDecisionV1,
  type ProposedTradeDecisionV1,
} from "../src/contracts/research-decision-v1.js"
import type { ResearchReportV2 } from "../src/contracts/research-report-v2.js"
import { deriveTradeIntentV1 } from "../src/contracts/trade-intent-v1.js"
import {
  evaluateResearchRunV1,
  researchRunEvaluationV1Schema,
} from "../src/evaluation/research-run-evaluation-v1.js"
import type { ResearchRunV1 } from "../src/research/research-artifact.js"
import {
  PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT,
  PROPOSAL_QUOTE_SNAPSHOT_REF,
} from "../src/research/research-cycle.js"

const preliminaryResearch = (): PreliminaryResearchV1 => ({
  contractVersion: "1.0.0",
  strategyVersion: "1.1.0",
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
  const sourceRun = preliminaryRun()
  const {
    preliminaryResearch: _preliminaryResearch,
    researchReport: _researchReport,
    ...base
  } = sourceRun
  const decision = {
    contractVersion: "1.0.0" as const,
    strategyVersion: "1.1.0" as const,
    outcome: "NO_ACTION" as const,
    reasonCodes: ["SIGNAL_NOT_ACTIONABLE" as const],
    evidence: [],
  }
  return {
    ...base,
    researchReport: {
      ...sourceRun.researchReport!,
      result: decision,
    },
    validatedDecision: decision,
    outcome: {
      outcomeVersion: "1.0.0",
      status: "VALIDATED_NO_ACTION",
      decision,
    },
  }
}

const currentInvocation = {
  invocationVersion: "1.1.0" as const,
  agentName: "research",
  cycleMode: "STANDARD" as const,
  promptVersion: "1.4.0",
  skillName: "spy-debit-spread-research",
  skillVersion: "1.2.0",
  strategyVersion: "1.1.0",
  decisionContractVersion: "1.0.0",
  reportVersion: "2.0.0",
  providerId: "test-provider",
  modelId: "test-model",
  responseError: false,
  tokens: {},
  tools: {
    totalCount: 0,
    errorCount: 0,
    incompleteCount: 0,
    omittedCount: 0,
    calls: [],
  },
}

const priorInvocation = {
  ...currentInvocation,
  invocationVersion: "1.0.0" as const,
  promptVersion: "1.3.0",
  skillVersion: "1.1.0",
}

const derivedIntentRun = (): ResearchRunV1 => {
  const {
    preliminaryResearch: _preliminaryResearch,
    researchReport: _researchReport,
    ...base
  } = preliminaryRun()
  const decision: ProposedTradeDecisionV1 = {
    contractVersion: "1.0.0",
    strategyVersion: "1.1.0",
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
        snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
      },
    ],
  }
  const derived = deriveTradeIntentV1(decision, {
    quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
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

  const researchReport: ResearchReportV2 = {
    reportVersion: "2.0.0",
    result: decision,
    analysis: {
      provenance: "AGENT_REPORTED",
      asOf: "2026-08-26T14:03:30.000Z",
      accountChecks: {
        verification: "AGENT_REPORTED",
        observedAt: "2026-08-26T14:01:00.000Z",
        accountStatus: "ACTIVE",
        optionsTradingApproved: true,
        conflictingStrategyExposure: false,
      },
      marketRegime: {
        verification: "AGENT_REPORTED",
        temporalClass: "LIVE",
        observedAt: "2026-08-26T14:03:30.000Z",
        signal: "BULLISH",
        dailyClose: 600,
        sma20: 595,
        sma50: 590,
        sessionVwap: 598,
        spotMidpoint: 600,
        dailySessionCount: 50,
        intradayBarCount: 33,
      },
      candidateEvaluation: {
        verification: "AGENT_REPORTED",
        observedAt: "2026-08-26T14:03:30.000Z",
        dte: 23,
        legs: [
          {
            role: "LONG",
            contractSymbol: "SPY260918C00600000",
            delta: 0.55,
            impliedVolatility: 0.2,
            gamma: 0.01,
            theta: -0.02,
            vega: 0.1,
            volume: 100,
            openInterest: 500,
            openInterestDate: "2026-08-25",
          },
          {
            role: "SHORT",
            contractSymbol: "SPY260918C00610000",
            delta: 0.3,
            impliedVolatility: 0.2,
            gamma: 0.01,
            theta: -0.02,
            vega: 0.1,
            volume: 100,
            openInterest: 500,
            openInterestDate: "2026-08-25",
          },
        ],
      },
      externalContext: [
        {
          sourceId: "exa-proposal-source",
          provider: "EXA",
          verification: "AGENT_REPORTED",
          title: "Proposal context",
          url: "https://example.com/proposal-context",
          publishedAt: "2026-08-26T13:00:00.000Z",
          retrievedAt: "2026-08-26T14:02:00.000Z",
          summary: "Current context supporting the proposal.",
          relevance: "SUPPORTS",
        },
      ],
      supportingFactors: ["Current regime supports the structure."],
      contradictingFactors: [],
      conflicts: [],
    },
  }

  return {
    ...base,
    cycle: {
      ...base.cycle,
      startedAt: "2026-08-26T14:00:31.000Z",
      completedAt: "2026-08-26T14:05:00.000Z",
    },
    initialEligibility: {
      evaluatedAt: "2026-08-26T14:00:30.000Z",
      sessionDate: "2026-08-26",
      sessionOpen: "2026-08-26T13:30:00.000Z",
      sessionClose: "2026-08-26T20:00:00.000Z",
      previousSessionDates: ["2026-08-24", "2026-08-25"],
      researchEligible: true,
      tradeIntentEligible: true,
      tradeIntentWindow: {
        slotStartedAt: "2026-08-26T14:00:00.000Z",
        deadline: "2026-08-26T14:10:00.000Z",
      },
    },
    evidenceSnapshots: [
      {
        snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
        provider: "ALPACA",
        source: "options-snapshots-indicative",
        retrievedAt: "2026-08-26T14:04:00.000Z",
        freshUntil: "2026-08-26T14:04:59.000Z",
        temporalClass: "LIVE",
      },
    ],
    researchReport,
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
  it("accepts the additive shadow-risk research run version", () => {
    const evaluation = evaluateResearchRunV1({
      ...noActionRun(),
      runVersion: "1.1.0",
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).not.toContain(
      "RUN_VERSION_INVALID",
    )
  })

  it("uses versioned invocation requirements for historical runs", () => {
    const historical = evaluateResearchRunV1({
      ...noActionRun(),
      runVersion: "1.1.0",
    })
    const historicalWithCurrentInvocation = evaluateResearchRunV1({
      ...noActionRun(),
      runVersion: "1.1.0",
      researchInvocation: currentInvocation,
    })

    expect(historical.dimensions.contractCompliance.issueCodes).not.toContain(
      "RUN_METADATA_INVALID",
    )
    expect(
      historicalWithCurrentInvocation.dimensions.contractCompliance.issueCodes,
    ).toContain("RUN_METADATA_INVALID")
  })

  it("requires matching invocation metadata for current runs", () => {
    const prior = evaluateResearchRunV1({
      ...noActionRun(),
      runVersion: "1.2.0",
      researchInvocation: priorInvocation,
    })
    const healthy = evaluateResearchRunV1({
      ...noActionRun(),
      runVersion: "1.3.0",
      researchInvocation: currentInvocation,
    })
    const missing = evaluateResearchRunV1({
      ...noActionRun(),
      runVersion: "1.3.0",
    })
    const mismatched = evaluateResearchRunV1({
      ...noActionRun(),
      runVersion: "1.3.0",
      researchInvocation: {
        ...currentInvocation,
        strategyVersion: "0.0.0",
      },
    })
    const { initialEligibility: _initialEligibility, ...withoutEligibility } =
      noActionRun()
    const missingEligibility = evaluateResearchRunV1({
      ...withoutEligibility,
      runVersion: "1.3.0",
      researchInvocation: currentInvocation,
    })

    expect(prior.dimensions.contractCompliance.issueCodes).not.toContain(
      "RUN_METADATA_INVALID",
    )
    expect(healthy.dimensions.contractCompliance.issueCodes).not.toContain(
      "RUN_METADATA_INVALID",
    )
    expect(missing.dimensions.contractCompliance.issueCodes).toContain(
      "RUN_METADATA_INVALID",
    )
    expect(mismatched.dimensions.contractCompliance.issueCodes).toContain(
      "RUN_METADATA_INVALID",
    )
    expect(missingEligibility.dimensions.contractCompliance.issueCodes).toContain(
      "RUN_METADATA_INVALID",
    )
  })

  it("requires schema-valid eligibility metadata for current runs", () => {
    const source = noActionRun()
    const evaluation = evaluateResearchRunV1({
      ...source,
      runVersion: "1.3.0",
      researchInvocation: currentInvocation,
      initialEligibility: {
        ...source.initialEligibility!,
        evaluatedAt: "not-a-time",
      },
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "RUN_METADATA_INVALID",
    )
  })

  it("requires safe schema categories on current rejected runs", () => {
    const {
      researchReport: _researchReport,
      preliminaryResearch: _preliminaryResearch,
      ...base
    } = preliminaryRun()
    const rejected = {
      ...base,
      runVersion: "1.3.0" as const,
      researchInvocation: currentInvocation,
      outcome: {
        outcomeVersion: "1.0.0" as const,
        status: "DECISION_REJECTED" as const,
        issues: [{ code: "SCHEMA_INVALID", path: ["result"] }],
      },
    }

    const missingCategory = evaluateResearchRunV1(rejected)
    const categorized = evaluateResearchRunV1({
      ...rejected,
      outcome: {
        ...rejected.outcome,
        issues: [{
          code: "SCHEMA_INVALID",
          schemaCategory: "TYPE_MISMATCH",
          path: ["result"],
        }],
      },
    })

    expect(missingCategory.dimensions.contractCompliance.issueCodes).toContain(
      "RUN_METADATA_INVALID",
    )
    expect(categorized.dimensions.contractCompliance.issueCodes).not.toContain(
      "RUN_METADATA_INVALID",
    )
  })

  it.each([
    { agentName: "other-agent" },
    { promptVersion: "0.0.0" },
    { skillName: "other-skill" },
    { skillVersion: "0.0.0" },
  ])("rejects mismatched runtime provenance", (override) => {
    const evaluation = evaluateResearchRunV1({
      ...noActionRun(),
      runVersion: "1.3.0",
      researchInvocation: {
        ...currentInvocation,
        ...override,
      },
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "RUN_METADATA_INVALID",
    )
  })

  it("accepts the canonical rejection of a legacy strategy version", () => {
    const rejectedRun = (source: ResearchRunV1, useLegacyVersion = true) => {
      const {
        preliminaryResearch: _preliminaryResearch,
        validatedDecision: _validatedDecision,
        shadowRisk: _shadowRisk,
        ...base
      } = source
      return {
        ...base,
        runVersion: "1.3.0" as const,
        researchInvocation: currentInvocation,
        evidenceSnapshots: [],
        researchReport: {
          ...source.researchReport!,
          result: {
            ...source.researchReport!.result,
            ...(useLegacyVersion ? { strategyVersion: "1.0.0" as const } : {}),
          },
        },
        outcome: {
          outcomeVersion: "1.0.0" as const,
          status: "DECISION_REJECTED" as const,
          issues: [{
            code: "SCHEMA_INVALID",
            schemaCategory: "VALUE_NOT_ALLOWED" as const,
            path: ["result", "strategyVersion"],
          }],
        },
      }
    }
    const canonical = [preliminaryRun(), noActionRun(), derivedIntentRun()].map(
      (source) => evaluateResearchRunV1(rejectedRun(source)),
    )
    const forged = evaluateResearchRunV1(rejectedRun(noActionRun(), false))
    const wrongDiagnosticRun = rejectedRun(noActionRun())
    const wrongDiagnostic = evaluateResearchRunV1({
      ...wrongDiagnosticRun,
      outcome: {
        ...wrongDiagnosticRun.outcome,
        issues: [{
          code: "SCHEMA_INVALID",
          schemaCategory: "VALUE_NOT_ALLOWED",
          path: ["result", "contractVersion"],
        }],
      },
    })

    expect(canonical.map(({ dimensions }) => dimensions.contractCompliance)).toEqual([
      { status: "PASS", issueCodes: [] },
      { status: "PASS", issueCodes: [] },
      { status: "PASS", issueCodes: [] },
    ])
    expect(forged.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(wrongDiagnostic.dimensions.contractCompliance.issueCodes).toContain(
      "RUN_METADATA_INVALID",
    )
  })

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

  it.each([
    ["preliminary research", preliminaryRun],
    ["no action", noActionRun],
  ])("accepts healthy research-only anytime %s", (_name, fixture) => {
    const run = fixture()
    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility!,
        researchMode: "DRY_RUN_ANYTIME",
        reason: "DRY_RUN_RESEARCH_ONLY",
      },
    })

    expect(evaluation.dimensions.contractCompliance).toEqual({
      status: "PASS",
      issueCodes: [],
    })
    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "PASS",
      issueCodes: [],
    })
  })

  it("flags contradictory anytime dry-run eligibility", () => {
    const run = preliminaryRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility!,
        researchMode: "DRY_RUN_ANYTIME",
        tradeIntentEligible: true,
        reason: "DRY_RUN_RESEARCH_ONLY",
      },
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "DRY_RUN_ELIGIBILITY_CONTEXT_INVALID",
    )
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

  it("validates the preliminary target against retained session context", () => {
    const run = preliminaryRun()
    if (run.outcome.status !== "PRELIMINARY_RESEARCH_RETAINED") {
      throw new Error("Expected a preliminary-research fixture")
    }
    const research = {
      ...run.preliminaryResearch!,
      targetSessionDate: "2026-08-27",
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      preliminaryResearch: research,
      researchReport: { ...run.researchReport!, result: research },
      outcome: { ...run.outcome, research },
    })

    expect(evaluation.dimensions.temporalIntegrity).toEqual({
      status: "FAIL",
      issueCodes: ["PRELIMINARY_TARGET_SESSION_MISMATCH"],
    })
  })

  it("does not mark legacy preliminary runs without session context safe", () => {
    const run = preliminaryRun()
    const { initialEligibility: _initialEligibility, ...legacyRun } = run

    const evaluation = evaluateResearchRunV1(legacyRun)

    expect(evaluation.dimensions.temporalIntegrity).toEqual({
      status: "FAIL",
      issueCodes: ["PRELIMINARY_SESSION_CONTEXT_MISSING"],
    })
  })

  it("rejects preliminary evidence observed after cycle completion", () => {
    const run = preliminaryRun()
    if (
      run.preliminaryResearch === undefined ||
      run.outcome.status !== "PRELIMINARY_RESEARCH_RETAINED"
    ) {
      throw new Error("Expected a preliminary-research fixture")
    }
    const research: PreliminaryResearchV1 = {
      ...run.preliminaryResearch,
      evidence: run.preliminaryResearch.evidence.map((claim) =>
        claim.kind === "SOURCED_FACT"
          ? { ...claim, observedAt: "2026-08-26T12:05:01.000Z" }
          : claim,
      ),
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      preliminaryResearch: research,
      researchReport: { ...run.researchReport!, result: research },
      outcome: { ...run.outcome, research },
    })

    expect(evaluation.dimensions.temporalIntegrity.issueCodes).toContain(
      "PRELIMINARY_OBSERVATION_AFTER_CYCLE",
    )
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

  it("accepts the retained five-minute window for a legacy derived intent", () => {
    const run = derivedIntentRun()
    if (
      run.researchReport?.result.outcome !== "PROPOSE_TRADE" ||
      run.validatedDecision?.outcome !== "PROPOSE_TRADE" ||
      run.outcome.status !== "INTENT_DERIVED" ||
      run.initialEligibility?.tradeIntentWindow === undefined
    ) {
      throw new Error("Expected a derived-intent fixture")
    }
    const decision = {
      ...run.validatedDecision,
      strategyVersion: "1.0.0" as const,
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility,
        tradeIntentWindow: {
          ...run.initialEligibility.tradeIntentWindow,
          deadline: "2026-08-26T14:05:00.000Z",
        },
      },
      researchReport: {
        ...run.researchReport,
        result: decision,
      },
      validatedDecision: decision,
      outcome: {
        ...run.outcome,
        decision,
        intent: {
          ...run.outcome.intent,
          strategyVersion: "1.0.0",
        },
      },
    })

    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "PASS",
      issueCodes: [],
    })
  })

  it("rejects a legacy run outside its retained two-minute start grace", () => {
    const run = derivedIntentRun()
    if (
      run.researchReport?.result.outcome !== "PROPOSE_TRADE" ||
      run.validatedDecision?.outcome !== "PROPOSE_TRADE" ||
      run.outcome.status !== "INTENT_DERIVED" ||
      run.initialEligibility?.tradeIntentWindow === undefined
    ) {
      throw new Error("Expected a derived-intent fixture")
    }
    const decision = {
      ...run.validatedDecision,
      strategyVersion: "1.0.0" as const,
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      cycle: {
        ...run.cycle,
        startedAt: "2026-08-26T14:03:01.000Z",
      },
      initialEligibility: {
        ...run.initialEligibility,
        evaluatedAt: "2026-08-26T14:03:00.000Z",
        tradeIntentWindow: {
          ...run.initialEligibility.tradeIntentWindow,
          deadline: "2026-08-26T14:05:00.000Z",
        },
      },
      researchReport: {
        ...run.researchReport,
        result: decision,
      },
      validatedDecision: decision,
      outcome: {
        ...run.outcome,
        decision,
        intent: {
          ...run.outcome.intent,
          strategyVersion: "1.0.0",
        },
      },
    })

    expect(evaluation.dimensions.failClosedBehavior.issueCodes).toContain(
      "INTENT_ELIGIBILITY_CONTEXT_INVALID",
    )
  })

  it("treats diagnostics without a canonical candidate as not applicable", () => {
    const run = noActionRun()
    const proposal = derivedIntentRun()
    const diagnostics = proposal.researchReport?.analysis.candidateEvaluation
    if (run.researchReport === undefined || diagnostics === undefined) {
      throw new Error("Expected retained research reports")
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          candidateEvaluation: diagnostics,
        },
      },
    })

    expect(evaluation.dimensions.candidateIdentity).toEqual({
      status: "NOT_APPLICABLE",
      issueCodes: [],
    })
  })

  it("requires successful outcomes to retain their research report", () => {
    const { researchReport: _researchReport, ...run } = derivedIntentRun()

    const evaluation = evaluateResearchRunV1(run)

    expect(evaluation.dimensions.contractCompliance).toEqual({
      status: "FAIL",
      issueCodes: ["RESEARCH_REPORT_MISSING"],
    })
  })

  it("requires intent-derivation rejections to retain their report", () => {
    const {
      researchReport: _researchReport,
      preliminaryResearch: _preliminaryResearch,
      ...base
    } = preliminaryRun()
    const evaluation = evaluateResearchRunV1({
      ...base,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
    })

    expect(evaluation.dimensions.contractCompliance).toEqual({
      status: "FAIL",
      issueCodes: ["RESEARCH_REPORT_MISSING"],
    })
  })

  it("returns contract failure instead of throwing for malformed reports", () => {
    const run = preliminaryRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      researchReport: {
        reportVersion: "2.0.0",
      } as unknown as ResearchReportV2,
    })

    expect(evaluation.dimensions.contractCompliance).toEqual({
      status: "FAIL",
      issueCodes: ["REPORT_CONTRACT_INVALID"],
    })
  })

  it("rejects unreachable result and record combinations for rejected outcomes", () => {
    const noAction = noActionRun()
    const { validatedDecision: _validatedDecision, ...withoutDecision } = noAction
    const intentRejection = evaluateResearchRunV1({
      ...withoutDecision,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
    })
    const decisionRejection = evaluateResearchRunV1({
      ...noAction,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "SCHEMA_INVALID", path: ["outcome"] }],
      },
    })

    expect(intentRejection.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(decisionRejection.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
  })

  it("rejects opposite retained record types on successful outcomes", () => {
    const preliminary = preliminaryRun()
    const noAction = noActionRun()
    const derived = derivedIntentRun()
    const extraPreliminary = preliminary.preliminaryResearch
    const extraDecision = noAction.validatedDecision
    if (extraPreliminary === undefined || extraDecision === undefined) {
      throw new Error("Expected retained result fixtures")
    }
    const evaluations = [
      evaluateResearchRunV1({
        ...preliminary,
        validatedDecision: extraDecision,
      }),
      evaluateResearchRunV1({
        ...noAction,
        preliminaryResearch: extraPreliminary,
      }),
      evaluateResearchRunV1({
        ...derived,
        preliminaryResearch: extraPreliminary,
      }),
    ]

    for (const evaluation of evaluations) {
      expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
        "OUTCOME_RECORD_MISMATCH",
      )
    }
  })

  it("matches intent-rejection reasons to retained quote and proposal records", () => {
    const run = derivedIntentRun()
    const { validatedDecision: _validatedDecision, ...withoutDecision } = run
    const {
      tradeIntentWindow: _tradeIntentWindow,
      ...initiallyIneligible
    } = run.initialEligibility!
    const quoteFailure = evaluateResearchRunV1({
      ...run,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["QUOTE_REQUEST_FAILED"],
      },
    })
    const derivationFailure = evaluateResearchRunV1({
      ...run,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["NON_POSITIVE_NET_DEBIT"],
      },
    })
    const multipleDerivationFailures = evaluateResearchRunV1({
      ...run,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["NON_POSITIVE_NET_DEBIT", "ARITHMETIC_OVERFLOW"],
      },
    })
    const multipleQuoteFailures = evaluateResearchRunV1({
      ...withoutDecision,
      evidenceSnapshots: [],
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["QUOTE_REQUEST_FAILED", "QUOTE_RESPONSE_INVALID"],
      },
    })
    const ineligibleQuoteFailure = evaluateResearchRunV1({
      ...withoutDecision,
      initialEligibility: {
        ...initiallyIneligible,
        tradeIntentEligible: false,
      },
      evidenceSnapshots: [],
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["QUOTE_REQUEST_FAILED"],
      },
    })
    const ineligibleDerivationFailure = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...initiallyIneligible,
        tradeIntentEligible: false,
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["NON_POSITIVE_NET_DEBIT"],
      },
    })
    const invalidWindowDerivationFailure = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility!,
        tradeIntentWindow: {
          ...run.initialEligibility!.tradeIntentWindow!,
          deadline: "2026-08-26T14:00:00.000Z",
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["NON_POSITIVE_NET_DEBIT"],
      },
    })
    const lateCycleDerivationFailure = evaluateResearchRunV1({
      ...run,
      cycle: {
        ...run.cycle,
        startedAt: run.initialEligibility!.tradeIntentWindow!.deadline,
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["NON_POSITIVE_NET_DEBIT"],
      },
    })
    const unsupportedPrecision = evaluateResearchRunV1({
      ...run,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["STRIKE_PRECISION_UNSUPPORTED"],
      },
    })
    const unreachableDerivationReasons = [
      "DERIVATION_INPUT_INVALID",
      "QUOTE_SYMBOL_MISMATCH",
    ].map((reason) =>
      evaluateResearchRunV1({
        ...run,
        outcome: {
          outcomeVersion: "1.0.0",
          status: "INTENT_DERIVATION_REJECTED",
          reasons: [reason],
        },
      }),
    )

    expect(quoteFailure.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(derivationFailure.dimensions.contractCompliance.status).toBe("PASS")
    expect(
      multipleDerivationFailures.dimensions.contractCompliance.issueCodes,
    ).toContain("OUTCOME_RECORD_MISMATCH")
    expect(
      multipleQuoteFailures.dimensions.contractCompliance.issueCodes,
    ).toContain("OUTCOME_RECORD_MISMATCH")
    for (const evaluation of [
      ineligibleQuoteFailure,
      ineligibleDerivationFailure,
      invalidWindowDerivationFailure,
      lateCycleDerivationFailure,
      unsupportedPrecision,
      ...unreachableDerivationReasons,
    ]) {
      expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
        "OUTCOME_RECORD_MISMATCH",
      )
    }
  })

  it("requires reachable issues for report-free decision rejections", () => {
    const {
      researchReport: _researchReport,
      preliminaryResearch: _preliminaryResearch,
      ...base
    } = preliminaryRun()
    const malformed = evaluateResearchRunV1({
      ...base,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "MALFORMED_JSON", path: [] }],
      },
    })
    const arbitrary = evaluateResearchRunV1({
      ...base,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["result"] }],
      },
    })

    expect(malformed.dimensions.contractCompliance.status).toBe("PASS")
    expect(arbitrary.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
  })

  it("replays common report gates before no-action validation", () => {
    const run = noActionRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected a no-action report fixture")
    }
    const { validatedDecision: _validatedDecision, ...base } = run
    const evaluation = evaluateResearchRunV1({
      ...base,
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          asOf: "2026-08-26T12:06:00.000Z",
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["analysis", "asOf"] }],
      },
    })
    const unobservableProcessingBoundary = evaluateResearchRunV1({
      ...base,
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          asOf: "2026-08-26T12:04:30.000Z",
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["analysis", "asOf"] }],
      },
    })

    expect(evaluation.dimensions.contractCompliance).toEqual({
      status: "PASS",
      issueCodes: [],
    })
    expect(
      unobservableProcessingBoundary.dimensions.contractCompliance.status,
    ).toBe("PASS")
  })

  it("matches the runtime bound for replayed rejection issues", () => {
    const run = derivedIntentRun()
    if (
      run.researchReport === undefined ||
      run.researchReport.result.outcome !== "PROPOSE_TRADE"
    ) {
      throw new Error("Expected a proposal report fixture")
    }
    const decision: ProposedTradeDecisionV1 = {
      ...run.researchReport.result,
      evidence: [
        {
          claimId: "missing-snapshot",
          kind: "SOURCED_FACT",
          claim: "Fact with unavailable snapshot",
          snapshotRef: "missing-snapshot",
        },
        ...Array.from({ length: 2 }, (_, claimIndex) => ({
          claimId: `inference-${claimIndex}`,
          kind: "INFERENCE" as const,
          claim: `Inference ${claimIndex}`,
          basedOn: Array.from(
            { length: 32 },
            (_, referenceIndex) => `missing-${claimIndex}-${referenceIndex}`,
          ),
        })),
      ],
    }
    const validation = validateResearchDecisionV1(
      decision,
      PROPOSAL_EVIDENCE_PREFLIGHT_CONTEXT,
    )
    if (validation.success || validation.issues.length <= 64) {
      throw new Error("Expected more than 64 preflight issues")
    }
    const {
      validatedDecision: _validatedDecision,
      evidenceSnapshots: _evidenceSnapshots,
      ...base
    } = run
    const evaluation = evaluateResearchRunV1({
      ...base,
      evidenceSnapshots: [],
      researchReport: { ...run.researchReport, result: decision },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: validation.issues.slice(0, 64),
      },
    })

    expect(evaluation.dimensions.contractCompliance).toEqual({
      status: "PASS",
      issueCodes: [],
    })
  })

  it("rejects post-quote market-window failure before the retained deadline", () => {
    const run = derivedIntentRun()
    const { validatedDecision: _validatedDecision, ...base } = run
    const evaluation = evaluateResearchRunV1({
      ...base,
      cycle: {
        ...base.cycle,
        completedAt: "2026-08-26T14:04:30.000Z",
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
    })
    const preQuoteEvaluation = evaluateResearchRunV1({
      ...base,
      cycle: {
        ...base.cycle,
        completedAt: "2026-08-26T14:04:30.000Z",
      },
      evidenceSnapshots: [],
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["MARKET_WINDOW_INELIGIBLE"],
      },
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(
      preQuoteEvaluation.dimensions.contractCompliance.issueCodes,
    ).toContain("OUTCOME_RECORD_MISMATCH")
  })

  it("rejects non-Alpaca quote provenance on post-quote rejections", () => {
    const run = derivedIntentRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      evidenceSnapshots: run.evidenceSnapshots.map((snapshot) => ({
        ...snapshot,
        provider: "EXA" as const,
        source: "unrelated-context",
      })),
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["NON_POSITIVE_NET_DEBIT"],
      },
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(evaluation.dimensions.grounding.issueCodes).toContain(
      "QUOTE_SNAPSHOT_PROVENANCE_INVALID",
    )
  })

  it("bounds rejected quote snapshots to Alpaca's freshness window", () => {
    const run = derivedIntentRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      evidenceSnapshots: run.evidenceSnapshots.map((snapshot) => ({
        ...snapshot,
        freshUntil: "2026-08-26T16:04:00.000Z",
      })),
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["NON_POSITIVE_NET_DEBIT"],
      },
    })

    expect(evaluation.dimensions.grounding.issueCodes).toContain(
      "QUOTE_SNAPSHOT_METADATA_MISMATCH",
    )
  })

  it.each(["NON_POSITIVE_NET_DEBIT", "MARKET_WINDOW_INELIGIBLE"] as const)(
    "reapplies proposal freshness checks to post-quote %s rejections",
    (reason) => {
      const run = derivedIntentRun()
      if (run.researchReport === undefined) {
        throw new Error("Expected retained research report")
      }
      const evaluation = evaluateResearchRunV1({
        ...run,
        researchReport: {
          ...run.researchReport,
          analysis: {
            ...run.researchReport.analysis,
            accountChecks: {
              ...run.researchReport.analysis.accountChecks,
              observedAt: "2026-08-26T13:58:00.000Z",
            },
          },
        },
        ...(reason === "MARKET_WINDOW_INELIGIBLE"
          ? { validatedDecision: undefined }
          : {}),
        outcome: {
          outcomeVersion: "1.0.0",
          status: "INTENT_DERIVATION_REJECTED",
          reasons: [reason],
        },
      } as ResearchRunV1)

      expect(evaluation.dimensions.temporalIntegrity.issueCodes).toContain(
        "ACCOUNT_CHECKS_STALE_AT_INTENT",
      )
    },
  )

  it("reapplies proposal freshness checks before quote failures", () => {
    const run = derivedIntentRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected retained research report")
    }
    const { validatedDecision: _validatedDecision, ...base } = run
    const evaluation = evaluateResearchRunV1({
      ...base,
      evidenceSnapshots: [],
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          accountChecks: {
            ...run.researchReport.analysis.accountChecks,
            observedAt: "2026-08-26T13:54:00.000Z",
          },
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["QUOTE_REQUEST_FAILED"],
      },
    })

    expect(evaluation.dimensions.temporalIntegrity.issueCodes).toContain(
      "ACCOUNT_CHECKS_STALE_AT_INTENT",
    )
  })

  it("validates the snapshot shape retained by decision rejections", () => {
    const run = derivedIntentRun()
    const { validatedDecision: _validatedDecision, ...base } = run
    const rejectedOutcome = {
      outcomeVersion: "1.0.0" as const,
      status: "DECISION_REJECTED" as const,
      issues: [{ code: "CONTEXT_INVALID", path: ["analysis"] }],
    }
    const unrelatedSnapshot = evaluateResearchRunV1({
      ...base,
      evidenceSnapshots: base.evidenceSnapshots.map((snapshot) => ({
        ...snapshot,
        provider: "FMP" as const,
        source: "unrelated-context",
      })),
      outcome: rejectedOutcome,
    })
    const duplicateSnapshots = evaluateResearchRunV1({
      ...base,
      evidenceSnapshots: [
        ...base.evidenceSnapshots,
        ...base.evidenceSnapshots,
      ],
      outcome: rejectedOutcome,
    })

    expect(unrelatedSnapshot.dimensions.grounding.issueCodes).toContain(
      "QUOTE_SNAPSHOT_PROVENANCE_INVALID",
    )
    expect(duplicateSnapshots.dimensions.grounding.issueCodes).toContain(
      "UNEXPECTED_SNAPSHOT_REFERENCE",
    )
  })

  it("requires proposal reports for snapshot-bearing decision rejections", () => {
    const proposalRun = derivedIntentRun()
    const noAction = noActionRun()
    if (noAction.researchReport === undefined) {
      throw new Error("Expected a no-action report fixture")
    }
    const { validatedDecision: _validatedDecision, ...proposalBase } = proposalRun
    const rejectedOutcome = {
      outcomeVersion: "1.0.0" as const,
      status: "DECISION_REJECTED" as const,
      issues: [{ code: "CONTEXT_INVALID", path: ["analysis"] }],
    }
    const { researchReport: _researchReport, ...withoutReport } = proposalBase
    const missingReport = evaluateResearchRunV1({
      ...withoutReport,
      outcome: rejectedOutcome,
    })
    const noActionReport = evaluateResearchRunV1({
      ...proposalBase,
      researchReport: noAction.researchReport,
      outcome: rejectedOutcome,
    })
    const healthyProposal = evaluateResearchRunV1({
      ...proposalBase,
      outcome: rejectedOutcome,
    })
    const staleProposalBase = {
      ...proposalBase,
      researchReport: {
        ...proposalBase.researchReport!,
        analysis: {
          ...proposalBase.researchReport!.analysis,
          accountChecks: {
            ...proposalBase.researchReport!.analysis.accountChecks,
            observedAt: "2026-08-26T13:58:00.000Z",
          },
        },
      },
    }
    const misattributedStaleProposal = evaluateResearchRunV1({
      ...staleProposalBase,
      outcome: rejectedOutcome,
    })
    const staleProposal = evaluateResearchRunV1({
      ...staleProposalBase,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "accountChecks", "observedAt"],
          },
        ],
      },
    } as ResearchRunV1)

    expect(missingReport.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(noActionReport.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(healthyProposal.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(
      misattributedStaleProposal.dimensions.contractCompliance.issueCodes,
    ).toContain("OUTCOME_RECORD_MISMATCH")
    expect(staleProposal.dimensions.contractCompliance.status).toBe("PASS")
  })

  it("rejects decision-rejected statuses for otherwise retainable reports", () => {
    const preliminary = preliminaryRun()
    const noAction = noActionRun()
    const { preliminaryResearch: _preliminaryResearch, ...preliminaryBase } =
      preliminary
    const { validatedDecision: _validatedDecision, ...noActionBase } = noAction
    const rejectedOutcome = {
      outcomeVersion: "1.0.0" as const,
      status: "DECISION_REJECTED" as const,
      issues: [{ code: "CONTEXT_INVALID", path: ["result"] }],
    }

    for (const run of [preliminaryBase, noActionBase]) {
      const evaluation = evaluateResearchRunV1({
        ...run,
        outcome: rejectedOutcome,
      })
      expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
        "OUTCOME_RECORD_MISMATCH",
      )
    }
  })

  it("keeps a semantically invalid no-action report reachable as rejected", () => {
    const run = noActionRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected a no-action report fixture")
    }
    const { validatedDecision: _validatedDecision, ...base } = run
    const invalidDecision = {
      ...run.researchReport.result,
      evidence: [
        {
          claimId: "unknown-snapshot",
          kind: "SOURCED_FACT" as const,
          claim: "Retained only to exercise rejection validation.",
          snapshotRef: "missing-snapshot",
        },
      ],
    }
    const rejectedRun = {
      ...base,
      researchReport: { ...run.researchReport, result: invalidDecision },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "UNKNOWN_SNAPSHOT",
            path: ["evidence", 0, "snapshotRef"],
          },
        ],
      },
    } as ResearchRunV1
    const evaluation = evaluateResearchRunV1(rejectedRun)
    const misattributed = evaluateResearchRunV1({
      ...rejectedRun,
      outcome: {
        ...rejectedRun.outcome,
        issues: [{ code: "UNKNOWN_SNAPSHOT", path: ["evidence"] }],
      },
    } as ResearchRunV1)
    expect(evaluation.dimensions.contractCompliance.status).toBe("PASS")
    expect(misattributed.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
  })

  it("requires exact preflight issues for snapshot-free proposal rejections", () => {
    const run = derivedIntentRun()
    if (
      run.researchReport === undefined ||
      run.researchReport.result.outcome !== "PROPOSE_TRADE"
    ) {
      throw new Error("Expected a proposal report fixture")
    }
    const firstEvidence = run.researchReport.result.evidence[0]
    if (firstEvidence === undefined) {
      throw new Error("Expected proposal evidence")
    }
    const decision: ProposedTradeDecisionV1 = {
      ...run.researchReport.result,
      evidence: [...run.researchReport.result.evidence, { ...firstEvidence }],
    }
    const {
      validatedDecision: _validatedDecision,
      evidenceSnapshots: _evidenceSnapshots,
      ...base
    } = run
    const rejectedRun = {
      ...base,
      evidenceSnapshots: [],
      researchReport: { ...run.researchReport, result: decision },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "DUPLICATE_CLAIM_ID",
            path: ["evidence", 1, "claimId"],
          },
        ],
      },
    } as ResearchRunV1
    const evaluation = evaluateResearchRunV1(rejectedRun)
    const misattributed = evaluateResearchRunV1({
      ...rejectedRun,
      outcome: {
        ...rejectedRun.outcome,
        issues: [{ code: "DUPLICATE_CLAIM_ID", path: ["evidence"] }],
      },
    } as ResearchRunV1)
    const snapshotBearing = evaluateResearchRunV1({
      ...rejectedRun,
      evidenceSnapshots: run.evidenceSnapshots,
    })

    expect(evaluation.dimensions.contractCompliance.status).toBe("PASS")
    expect(misattributed.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(snapshotBearing.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
  })

  it("requires exact provable pre-quote issues for proposal rejections", () => {
    const run = derivedIntentRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected a proposal report fixture")
    }
    const {
      validatedDecision: _validatedDecision,
      evidenceSnapshots: _evidenceSnapshots,
      ...base
    } = run
    const rejectedRun = {
      ...base,
      cycle: { ...base.cycle, completedAt: "2026-08-26T14:04:00.000Z" },
      evidenceSnapshots: [],
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          accountChecks: {
            ...run.researchReport.analysis.accountChecks,
            observedAt: "2026-08-26T13:58:00.000Z",
          },
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "accountChecks", "observedAt"],
          },
        ],
      },
    } as ResearchRunV1
    const evaluation = evaluateResearchRunV1(rejectedRun)
    const misattributed = evaluateResearchRunV1({
      ...rejectedRun,
      outcome: {
        ...rejectedRun.outcome,
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "marketRegime", "observedAt"],
          },
        ],
      },
    } as ResearchRunV1)
    const laterMarketStaleness = evaluateResearchRunV1({
      ...rejectedRun,
      cycle: run.cycle,
      outcome: {
        ...rejectedRun.outcome,
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "marketRegime", "observedAt"],
          },
        ],
      },
    } as ResearchRunV1)

    expect(evaluation.dimensions.contractCompliance.status).toBe("PASS")
    expect(misattributed.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(laterMarketStaleness.dimensions.contractCompliance.status).toBe(
      "PASS",
    )
  })

  it("checks trade eligibility before proposal freshness rejections", () => {
    const run = derivedIntentRun()
    if (run.researchReport === undefined || run.initialEligibility === undefined) {
      throw new Error("Expected a proposal report and eligibility fixture")
    }
    const {
      validatedDecision: _validatedDecision,
      evidenceSnapshots: _evidenceSnapshots,
      ...base
    } = run
    const {
      tradeIntentWindow: _tradeIntentWindow,
      ...initiallyIneligible
    } = run.initialEligibility
    const evaluation = evaluateResearchRunV1({
      ...base,
      initialEligibility: {
        ...initiallyIneligible,
        tradeIntentEligible: false,
      },
      evidenceSnapshots: [],
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          accountChecks: {
            ...run.researchReport.analysis.accountChecks,
            observedAt: "2026-08-26T13:58:00.000Z",
          },
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "accountChecks", "observedAt"],
          },
        ],
      },
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
  })

  it("bounds all-pass snapshot-free proposal rejections to plausible freshness", () => {
    const run = derivedIntentRun()
    const {
      validatedDecision: _validatedDecision,
      evidenceSnapshots: _evidenceSnapshots,
      ...base
    } = run
    const arbitraryRejection = evaluateResearchRunV1({
      ...base,
      evidenceSnapshots: [],
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["result"] }],
      },
    })
    const plausibleLaterStaleness = evaluateResearchRunV1({
      ...base,
      evidenceSnapshots: [],
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "marketRegime", "observedAt"],
          },
        ],
      },
    })
    const prematureMarketStaleness = evaluateResearchRunV1({
      ...base,
      cycle: { ...base.cycle, completedAt: "2026-08-26T14:04:00.000Z" },
      evidenceSnapshots: [],
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "marketRegime", "observedAt"],
          },
        ],
      },
    })
    const unreachableAccountStaleness = evaluateResearchRunV1({
      ...base,
      evidenceSnapshots: [],
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: ["analysis", "accountChecks", "observedAt"],
          },
        ],
      },
    })

    expect(arbitraryRejection.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
    expect(plausibleLaterStaleness.dimensions.contractCompliance.status).toBe(
      "PASS",
    )
    for (const evaluation of [
      prematureMarketStaleness,
      unreachableAccountStaleness,
    ]) {
      expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
        "OUTCOME_RECORD_MISMATCH",
      )
    }
  })

  it("requires exact issues for rejected preliminary reports", () => {
    const run = preliminaryRun()
    if (
      run.preliminaryResearch === undefined ||
      run.researchReport === undefined
    ) {
      throw new Error("Expected a preliminary report fixture")
    }
    const { preliminaryResearch: _preliminaryResearch, ...base } = run
    const research: PreliminaryResearchV1 = {
      ...run.preliminaryResearch,
      targetSessionDate: "2026-08-27",
    }
    const rejectedRun = {
      ...base,
      researchReport: { ...run.researchReport, result: research },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["targetSessionDate"] }],
      },
    } as ResearchRunV1
    const evaluation = evaluateResearchRunV1(rejectedRun)
    const misattributed = evaluateResearchRunV1({
      ...rejectedRun,
      outcome: {
        ...rejectedRun.outcome,
        issues: [{ code: "CONTEXT_INVALID", path: ["evidence"] }],
      },
    } as ResearchRunV1)

    expect(evaluation.dimensions.contractCompliance.status).toBe("PASS")
    expect(misattributed.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
  })

  it("allows preliminary rejection when eligibility expires during processing", () => {
    const run = preliminaryRun()
    const { preliminaryResearch: _preliminaryResearch, ...base } = run
    const evaluation = evaluateResearchRunV1({
      ...base,
      cycle: {
        ...base.cycle,
        completedAt: "2026-08-26T20:05:00.000Z",
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["targetSessionDate"] }],
      },
    })

    expect(evaluation.dimensions.contractCompliance.status).toBe("PASS")
  })

  it("allows anytime preliminary rejection after New York date rollover", () => {
    const run = preliminaryRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected a preliminary report fixture")
    }
    const { preliminaryResearch: _preliminaryResearch, ...base } = run
    const evaluation = evaluateResearchRunV1({
      ...base,
      cycle: {
        ...base.cycle,
        startedAt: "2026-08-27T03:58:00.000Z",
        completedAt: "2026-08-27T04:01:00.000Z",
      },
      initialEligibility: {
        ...base.initialEligibility!,
        evaluatedAt: "2026-08-27T03:57:59.000Z",
        researchMode: "DRY_RUN_ANYTIME",
        reason: "DRY_RUN_RESEARCH_ONLY",
      },
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          asOf: "2026-08-27T03:59:30.000Z",
          externalContext: run.researchReport.analysis.externalContext.map(
            (source) => ({
              ...source,
              retrievedAt: "2026-08-27T03:59:00.000Z",
            }),
          ),
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["targetSessionDate"] }],
      },
    })

    expect(evaluation.dimensions.contractCompliance.status).toBe("PASS")
  })

  it("rejects anytime preliminary rejection before New York date rollover", () => {
    const run = preliminaryRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected a preliminary report fixture")
    }
    const { preliminaryResearch: _preliminaryResearch, ...base } = run
    const evaluation = evaluateResearchRunV1({
      ...base,
      cycle: {
        ...base.cycle,
        startedAt: "2026-08-26T20:01:00.000Z",
        completedAt: "2026-08-26T20:05:00.000Z",
      },
      initialEligibility: {
        ...base.initialEligibility!,
        evaluatedAt: "2026-08-26T20:00:59.000Z",
        researchMode: "DRY_RUN_ANYTIME",
        reason: "DRY_RUN_RESEARCH_ONLY",
      },
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          asOf: "2026-08-26T20:04:00.000Z",
          externalContext: run.researchReport.analysis.externalContext.map(
            (source) => ({
              ...source,
              retrievedAt: "2026-08-26T20:02:00.000Z",
            }),
          ),
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["targetSessionDate"] }],
      },
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
  })

  it("rejects a preliminary observation no later than report processing", () => {
    const run = preliminaryRun()
    if (
      run.preliminaryResearch === undefined ||
      run.researchReport === undefined
    ) {
      throw new Error("Expected a preliminary report fixture")
    }
    const { preliminaryResearch: _preliminaryResearch, ...base } = run
    const research: PreliminaryResearchV1 = {
      ...run.preliminaryResearch,
      evidence: run.preliminaryResearch.evidence.map((claim) =>
        claim.kind === "SOURCED_FACT"
          ? { ...claim, observedAt: "2026-08-26T12:04:30.000Z" }
          : claim,
      ),
    }
    const evaluation = evaluateResearchRunV1({
      ...base,
      researchReport: {
        ...run.researchReport,
        result: research,
        analysis: {
          ...run.researchReport.analysis,
          asOf: "2026-08-26T12:04:30.000Z",
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [
          { code: "CONTEXT_INVALID", path: ["evidence", 0, "observedAt"] },
        ],
      },
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
  })

  it("rejects preliminary eligibility failure before retained session close", () => {
    const run = preliminaryRun()
    const { preliminaryResearch: _preliminaryResearch, ...base } = run
    const evaluation = evaluateResearchRunV1({
      ...base,
      initialEligibility: {
        ...base.initialEligibility!,
        sessionClose: "2026-08-26T20:00:00.000Z",
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "CONTEXT_INVALID", path: ["targetSessionDate"] }],
      },
    })

    expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
      "OUTCOME_RECORD_MISMATCH",
    )
  })

  it("returns contract failure instead of throwing for malformed retained results", () => {
    const {
      researchReport: _researchReport,
      validatedDecision,
      ...withoutReport
    } = noActionRun()
    const runs = [
      {
        ...preliminaryRun(),
        preliminaryResearch: null,
      },
      {
        ...noActionRun(),
        validatedDecision: 7,
      },
      {
        ...withoutReport,
        validatedDecision: { ...validatedDecision, evidence: [null] },
      },
    ] as unknown as ResearchRunV1[]

    for (const run of runs) {
      const evaluation = evaluateResearchRunV1(run)
      expect(evaluation.dimensions.contractCompliance.issueCodes).toContain(
        "OUTCOME_CONTRACT_INVALID",
      )
    }
  })

  it("rejects sourced snapshot evidence on a validated no-action run", () => {
    const run = noActionRun()
    if (
      run.researchReport === undefined ||
      run.validatedDecision?.outcome !== "NO_ACTION" ||
      run.outcome.status !== "VALIDATED_NO_ACTION"
    ) {
      throw new Error("Expected a validated no-action fixture")
    }
    const decision = {
      ...run.validatedDecision,
      evidence: [
        {
          claimId: "no-action-snapshot-fact",
          kind: "SOURCED_FACT" as const,
          claim: "private-no-action-fact",
          snapshotRef: "no-action-snapshot",
        },
      ],
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      evidenceSnapshots: [
        {
          snapshotRef: "no-action-snapshot",
          provider: "ALPACA",
          source: "retained-no-action-source",
          retrievedAt: "2026-08-26T12:02:00.000Z",
          freshUntil: "2026-08-26T12:05:00.000Z",
          temporalClass: "LIVE",
        },
      ],
      researchReport: { ...run.researchReport, result: decision },
      validatedDecision: decision,
      outcome: { ...run.outcome, decision },
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: [
        "NO_ACTION_SOURCED_EVIDENCE",
        "UNEXPECTED_SNAPSHOT_REFERENCE",
      ],
    })
  })

  it("rejects snapshots on preliminary and no-action outcomes", () => {
    for (const run of [preliminaryRun(), noActionRun()]) {
      const evaluation = evaluateResearchRunV1({
        ...run,
        evidenceSnapshots: [
          {
            snapshotRef: "unexpected-snapshot",
            provider: "EXA",
            source: "web-search",
            retrievedAt: "2026-08-26T12:02:00.000Z",
            freshUntil: "2026-08-26T12:05:00.000Z",
            temporalClass: "LIVE",
          },
        ],
      })

      expect(evaluation.dimensions.grounding).toEqual({
        status: "FAIL",
        issueCodes: ["UNEXPECTED_SNAPSHOT_REFERENCE"],
      })
    }
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
      issueCodes: [
        "QUOTE_SNAPSHOT_PROVENANCE_INVALID",
        "UNKNOWN_SNAPSHOT_REFERENCE",
      ],
    })
  })

  it("rejects quote snapshot metadata with unrelated provenance", () => {
    const run = derivedIntentRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      evidenceSnapshots: run.evidenceSnapshots.map((snapshot) => ({
        ...snapshot,
        provider: "EXA" as const,
        source: "web-search",
      })),
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: ["QUOTE_SNAPSHOT_PROVENANCE_INVALID"],
    })
  })

  it("rejects duplicate retained snapshot references", () => {
    const run = derivedIntentRun()
    const canonicalSnapshot = run.evidenceSnapshots[0]
    if (canonicalSnapshot === undefined) {
      throw new Error("Expected retained quote snapshot")
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      evidenceSnapshots: [
        {
          ...canonicalSnapshot,
          provider: "EXA",
          source: "conflicting-duplicate",
        },
        canonicalSnapshot,
      ],
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: ["DUPLICATE_SNAPSHOT_REFERENCE"],
    })
  })

  it("rejects extra retained snapshots on a derived-intent run", () => {
    const run = derivedIntentRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      evidenceSnapshots: [
        ...run.evidenceSnapshots,
        {
          snapshotRef: "unreferenced-extra-snapshot",
          provider: "EXA",
          source: "web-search",
          retrievedAt: "2026-08-26T14:02:00.000Z",
          freshUntil: "2026-08-26T14:05:00.000Z",
          temporalClass: "LIVE",
        },
      ],
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: ["UNEXPECTED_SNAPSHOT_REFERENCE"],
    })
  })

  it.each([
    {
      name: "stale",
      retrievedAt: "2026-08-26T14:03:59.000Z",
      freshUntil: "2026-08-26T14:03:59.999Z",
      issueCode: "STALE_SNAPSHOT" as const,
    },
    {
      name: "from the future",
      retrievedAt: "2026-08-26T14:04:01.000Z",
      freshUntil: "2026-08-26T14:04:59.000Z",
      issueCode: "SNAPSHOT_FROM_FUTURE" as const,
    },
  ])("reports a referenced snapshot that is $name", (snapshot) => {
    const run = derivedIntentRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      evidenceSnapshots: run.evidenceSnapshots.map((retained) => ({
        ...retained,
        retrievedAt: snapshot.retrievedAt,
        freshUntil: snapshot.freshUntil,
      })),
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: [snapshot.issueCode],
    })
  })

  it.each([
    {
      name: "was retrieved before quote evaluation",
      retrievedAt: "2026-08-26T14:03:58.000Z",
      freshUntil: "2026-08-26T14:04:59.000Z",
    },
    {
      name: "has an unrelated freshness deadline",
      retrievedAt: "2026-08-26T14:04:00.000Z",
      freshUntil: "2026-08-26T14:05:00.000Z",
    },
  ])("rejects quote metadata that $name", (snapshot) => {
    const run = derivedIntentRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      evidenceSnapshots: run.evidenceSnapshots.map((retained) => ({
        ...retained,
        retrievedAt: snapshot.retrievedAt,
        freshUntil: snapshot.freshUntil,
      })),
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: ["QUOTE_SNAPSHOT_METADATA_MISMATCH"],
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

  it("rejects derived analysis recorded after intent evaluation", () => {
    const run = derivedIntentRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected retained research report")
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          asOf: "2026-08-26T14:04:01.000Z",
        },
      },
    })

    expect(evaluation.dimensions.temporalIntegrity).toEqual({
      status: "FAIL",
      issueCodes: ["REPORT_AS_OF_AFTER_INTENT"],
    })
  })

  it("reapplies proposal observation freshness at intent evaluation", () => {
    const run = derivedIntentRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected retained research report")
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          accountChecks: {
            ...run.researchReport.analysis.accountChecks,
            observedAt: "2026-08-26T13:58:59.999Z",
          },
          marketRegime: {
            ...run.researchReport.analysis.marketRegime,
            observedAt: "2026-08-26T14:02:59.999Z",
            intradayBarCount: 32,
          },
          candidateEvaluation: {
            ...run.researchReport.analysis.candidateEvaluation!,
            observedAt: "2026-08-26T14:02:59.999Z",
          },
        },
      },
    })

    expect(evaluation.dimensions.temporalIntegrity).toEqual({
      status: "FAIL",
      issueCodes: [
        "ACCOUNT_CHECKS_STALE_AT_INTENT",
        "MARKET_REGIME_STALE_AT_INTENT",
      ],
    })
  })

  it("recomputes proposal intraday bars from the retained observation time", () => {
    const run = derivedIntentRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected retained research report")
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          marketRegime: {
            ...run.researchReport.analysis.marketRegime,
            intradayBarCount: 32,
          },
        },
      },
    })

    expect(evaluation.dimensions.temporalIntegrity).toEqual({
      status: "FAIL",
      issueCodes: ["INTRADAY_BAR_COUNT_MISMATCH"],
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

  it("rejects duplicate evidence claim identifiers for a derived intent", () => {
    const run = derivedIntentRun()
    if (
      run.researchReport === undefined ||
      run.validatedDecision?.outcome !== "PROPOSE_TRADE" ||
      run.outcome.status !== "INTENT_DERIVED"
    ) {
      throw new Error("Expected a derived-intent fixture")
    }
    const firstEvidence = run.validatedDecision.evidence[0]
    if (firstEvidence === undefined) {
      throw new Error("Expected retained evidence")
    }
    const duplicatedEvidence = [
      ...run.validatedDecision.evidence,
      { ...firstEvidence },
    ]
    const decision: ProposedTradeDecisionV1 = {
      ...run.validatedDecision,
      evidence: duplicatedEvidence,
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      researchReport: {
        ...run.researchReport,
        result: decision,
      },
      validatedDecision: decision,
      outcome: {
        ...run.outcome,
        decision,
      },
    })
    const rejectedEvaluation = evaluateResearchRunV1({
      ...run,
      researchReport: {
        ...run.researchReport,
        result: decision,
      },
      validatedDecision: decision,
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["NON_POSITIVE_NET_DEBIT"],
      },
    })

    expect(evaluation.dimensions.grounding).toEqual({
      status: "FAIL",
      issueCodes: ["DUPLICATE_CLAIM_ID"],
    })
    expect(rejectedEvaluation.dimensions.grounding.issueCodes).toContain(
      "DUPLICATE_CLAIM_ID",
    )
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

  it("validates candidate DTE against session date and expiration", () => {
    const run = derivedIntentRun()
    if (run.researchReport?.analysis.candidateEvaluation === undefined) {
      throw new Error("Expected retained candidate evaluation")
    }
    const evaluation = evaluateResearchRunV1({
      ...run,
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          candidateEvaluation: {
            ...run.researchReport.analysis.candidateEvaluation,
            dte: 22,
          },
        },
      },
    })

    expect(evaluation.dimensions.candidateIdentity).toEqual({
      status: "FAIL",
      issueCodes: ["CANDIDATE_DTE_MISMATCH"],
    })
  })

  it.each([
    {
      name: "missing prior sessions",
      previousSessionDates: undefined,
      openInterestDate: "2026-08-25",
    },
    {
      name: "stale leg date",
      previousSessionDates: ["2026-08-24", "2026-08-25"],
      openInterestDate: "2026-08-21",
    },
    {
      name: "duplicate prior sessions",
      previousSessionDates: ["2026-08-25", "2026-08-25"],
      openInterestDate: "2026-08-25",
    },
    {
      name: "non-prior session date",
      previousSessionDates: ["2026-08-25", "2026-08-26"],
      openInterestDate: "2026-08-25",
    },
    {
      name: "out-of-order prior sessions",
      previousSessionDates: ["2026-08-25", "2026-08-24"],
      openInterestDate: "2026-08-24",
    },
  ])("rejects $name in retained open-interest history", (fixture) => {
    const run = derivedIntentRun()
    if (
      run.initialEligibility === undefined ||
      run.researchReport?.analysis.candidateEvaluation === undefined
    ) {
      throw new Error("Expected retained proposal history")
    }
    const candidateEvaluation = run.researchReport.analysis.candidateEvaluation
    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility,
        previousSessionDates: fixture.previousSessionDates,
      },
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          candidateEvaluation: {
            ...candidateEvaluation,
            legs: candidateEvaluation.legs.map(
              (leg) => ({
                ...leg,
                openInterestDate: fixture.openInterestDate,
              }),
            ) as typeof candidateEvaluation.legs,
          },
        },
      },
    })

    expect(evaluation.dimensions.candidateIdentity).toEqual({
      status: "FAIL",
      issueCodes: ["OPEN_INTEREST_HISTORY_INVALID"],
    })
  })

  it("validates retained history before a quote-confirmation rejection", () => {
    const run = derivedIntentRun()
    if (run.researchReport?.analysis.candidateEvaluation === undefined) {
      throw new Error("Expected retained proposal history")
    }
    const { validatedDecision: _validatedDecision, ...base } = run
    const candidateEvaluation = run.researchReport.analysis.candidateEvaluation
    const evaluation = evaluateResearchRunV1({
      ...base,
      evidenceSnapshots: [],
      researchReport: {
        ...run.researchReport,
        analysis: {
          ...run.researchReport.analysis,
          candidateEvaluation: {
            ...candidateEvaluation,
            legs: candidateEvaluation.legs.map((leg) => ({
              ...leg,
              openInterestDate: "2026-08-21",
            })) as typeof candidateEvaluation.legs,
          },
        },
      },
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVATION_REJECTED",
        reasons: ["QUOTE_REQUEST_FAILED"],
      },
    })

    expect(evaluation.dimensions.candidateIdentity.issueCodes).toContain(
      "OPEN_INTEREST_HISTORY_INVALID",
    )
  })

  it("requires candidate diagnostics after proposal history validation", () => {
    const run = derivedIntentRun()
    if (run.researchReport === undefined) {
      throw new Error("Expected retained research report")
    }
    const { candidateEvaluation: _candidateEvaluation, ...analysis } =
      run.researchReport.analysis
    const reportWithoutDiagnostics = {
      ...run.researchReport,
      analysis,
    }
    const { validatedDecision: _validatedDecision, ...quoteFailureBase } = run
    const evaluations = [
      evaluateResearchRunV1({
        ...run,
        researchReport: reportWithoutDiagnostics,
      }),
      evaluateResearchRunV1({
        ...run,
        researchReport: reportWithoutDiagnostics,
        outcome: {
          outcomeVersion: "1.0.0",
          status: "INTENT_DERIVATION_REJECTED",
          reasons: ["NON_POSITIVE_NET_DEBIT"],
        },
      }),
      evaluateResearchRunV1({
        ...quoteFailureBase,
        evidenceSnapshots: [],
        researchReport: reportWithoutDiagnostics,
        outcome: {
          outcomeVersion: "1.0.0",
          status: "INTENT_DERIVATION_REJECTED",
          reasons: ["QUOTE_REQUEST_FAILED"],
        },
      }),
    ]

    for (const evaluation of evaluations) {
      expect(evaluation.dimensions.candidateIdentity.issueCodes).toContain(
        "OPEN_INTEREST_HISTORY_INVALID",
      )
    }
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

    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility!,
        researchMode: "DRY_RUN_ANYTIME",
        reason: "DRY_RUN_RESEARCH_ONLY",
      },
      outcome: invalidOutcome,
    })

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
      evaluatedAt: "2026-08-26T14:10:00.000Z",
      longQuote: {
        ...run.outcome.intent.longQuote,
        providerTimestamp: "2026-08-26T14:09:59.000Z",
      },
      shortQuote: {
        ...run.outcome.intent.shortQuote,
        providerTimestamp: "2026-08-26T14:09:59.000Z",
      },
    }
    const researchReport = {
      ...run.researchReport!,
      analysis: {
        ...run.researchReport!.analysis,
        asOf: "2026-08-26T14:09:30.000Z",
        marketRegime: {
          ...run.researchReport!.analysis.marketRegime,
          observedAt: "2026-08-26T14:09:30.000Z",
        },
        candidateEvaluation: {
          ...run.researchReport!.analysis.candidateEvaluation!,
          observedAt: "2026-08-26T14:09:30.000Z",
        },
      },
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      researchReport,
      outcome: { ...run.outcome, intent },
    })

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

  it("requires the cycle and eligibility session dates to match", () => {
    const run = derivedIntentRun()
    const evaluation = evaluateResearchRunV1({
      ...run,
      cycle: { ...run.cycle, sessionDate: "2026-08-27" },
    })

    expect(evaluation.dimensions.failClosedBehavior.issueCodes).toContain(
      "INTENT_ELIGIBILITY_CONTEXT_INVALID",
    )
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

  it("rejects initial eligibility recorded after the cycle starts", () => {
    const run = derivedIntentRun()
    if (run.initialEligibility === undefined) {
      throw new Error("Expected retained eligibility")
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility,
        evaluatedAt: "2026-08-26T14:00:32.000Z",
      },
    })

    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "FAIL",
      issueCodes: ["INTENT_ELIGIBILITY_CONTEXT_INVALID"],
    })
  })

  it("uses the retained session close for the entry cutoff", () => {
    const run = derivedIntentRun()
    if (run.initialEligibility === undefined) {
      throw new Error("Expected retained eligibility")
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility,
        sessionClose: "2026-08-26T15:00:00.000Z",
      },
    })

    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "FAIL",
      issueCodes: ["INTENT_ELIGIBILITY_CONTEXT_INVALID"],
    })
  })

  it("requires eligibility evaluation at or after the retained session open", () => {
    const run = derivedIntentRun()
    if (run.initialEligibility === undefined) {
      throw new Error("Expected retained eligibility")
    }

    const evaluation = evaluateResearchRunV1({
      ...run,
      initialEligibility: {
        ...run.initialEligibility,
        sessionOpen: "2026-08-26T14:00:31.000Z",
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
        startedAt: "2026-08-26T19:00:31.000Z",
        completedAt: "2026-08-26T19:05:00.000Z",
      },
      initialEligibility: {
        ...run.initialEligibility,
        evaluatedAt: "2026-08-26T19:00:30.000Z",
        sessionClose: "2026-08-26T20:00:00.000Z",
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

    expect(evaluation.dimensions.failClosedBehavior).toEqual({
      status: "FAIL",
      issueCodes: ["INTENT_ELIGIBILITY_CONTEXT_INVALID"],
    })
  })
})
