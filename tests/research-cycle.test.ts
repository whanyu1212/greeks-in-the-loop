import { describe, expect, it, vi } from "vitest"

import type { TradeIntentDerivationResult } from "../src/contracts/trade-intent-v2.js"
import type { ProposedTradeDecisionV2 } from "../src/contracts/research-decision-v2.js"
import type { OptionQuoteProvider } from "../src/market-data/alpaca-option-quotes.js"
import type { ResearchCycleTrace } from "../src/observability/research-telemetry.js"
import type { ResearchEligibilityV1 } from "../src/scheduling/research-eligibility.js"
import { MAX_LEDGER_EVENT_PAYLOAD_BYTES } from "../src/event-ledger/ledger-event-v1.js"
import {
  MAX_RESEARCH_RESPONSE_BYTES,
  processResearchCycle,
  PROPOSAL_QUOTE_SNAPSHOT_REF,
} from "../src/research/research-cycle.js"
import { createConsoleResearchCycleOutcomeSink } from "../src/research/research-cycle-outcome-v1.js"
import type {
  ResearchCycleOutcomeSink,
  ResearchCycleOutcomeV1,
  ResearchCycleTerminalRecordV1,
} from "../src/research/research-cycle-outcome-v1.js"
import type { ResearchInvocationV1 } from "../src/research/research-invocation-v1.js"

const noAction = {
  contractVersion: "2.0.0",
  outcome: "NO_ACTION",
  reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
  evidence: [{
    claimId: "mixed-regime",
    kind: "SOURCED_FACT",
    claim: "The retained market regime signal was mixed.",
    provider: "ALPACA",
    temporalClass: "LIVE",
    observedAt: "2026-08-25T14:30:00.000Z",
    locator: "analysis.marketRegime.signal",
  }],
} as const

const previousSessionDates = ["2026-08-21", "2026-08-24"] as const

const researchInvocation: ResearchInvocationV1 = {
  invocationVersion: "3.0.0",
  agentName: "research",
  cycleMode: "STANDARD",
  promptVersion: "1.3.0",
  decisionContractVersion: "2.0.0",
  reportVersion: "3.0.0",
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

const expectRecords = (
  actual: readonly ResearchCycleTerminalRecordV1[],
  expected: readonly Record<string, unknown>[],
) => expect(actual).toEqual(expected.map((record) => ({
  researchInvocation,
  ...record,
})))

const proposal = {
  contractVersion: "2.0.0",
  outcome: "PROPOSE_TRADE",
  direction: "BULLISH",
  thesis: "Daily and intraday direction agree.",
  candidate: {
    underlying: "SPY",
    structure: "BULL_CALL_SPREAD",
    expiration: "2026-09-18",
    longLeg: {
      contractSymbol: "SPY260918C00650000",
      strike: 650,
    },
    shortLeg: {
      contractSymbol: "SPY260918C00655000",
      strike: 655,
    },
  },
  invalidation: ["Reject if refreshed evidence changes the candidate."],
  evidence: [
    {
      claimId: "fact-1",
      kind: "SOURCED_FACT",
      claim: "The exact proposed legs were confirmed.",
      snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
    },
  ],
} as const

const preliminary = {
  contractVersion: "2.0.0",
  outcome: "PRELIMINARY_RESEARCH",
  targetSessionDate: "2026-08-25",
  direction: "BULLISH",
  thesis: "Prior-close evidence supports refreshing a bullish setup after open.",
  invalidation: ["Reject if live evidence reverses the signal."],
  evidence: [
    {
      claimId: "prior-close",
      kind: "SOURCED_FACT",
      claim: "The prior session closed above its trend average.",
      provider: "ALPACA",
      temporalClass: "PRIOR_CLOSE",
      observedAt: "2026-08-24T20:00:00.000Z",
    },
  ],
  requiresRefresh: true,
} as const

type ReportFixtureResult = Readonly<{
  outcome: "NO_ACTION" | "PROPOSE_TRADE" | "PRELIMINARY_RESEARCH"
  direction?: "BULLISH" | "BEARISH" | "UNDETERMINED"
  candidate?: Readonly<{
    longLeg: Readonly<{ contractSymbol: string }>
    shortLeg: Readonly<{ contractSymbol: string }>
  }>
}>

const researchReport = <T extends ReportFixtureResult>(result: T) => ({
  reportVersion: "3.0.0" as const,
  result,
  analysis: {
    provenance: "AGENT_REPORTED" as const,
    asOf: result.outcome === "PRELIMINARY_RESEARCH"
      ? "2026-08-25T11:59:00.000Z"
      : "2026-08-25T14:30:45.000Z",
    accountChecks: {
      verification: "AGENT_REPORTED" as const,
      observedAt: result.outcome === "PRELIMINARY_RESEARCH"
        ? "2026-08-25T11:55:00.000Z"
        : "2026-08-25T14:30:00.000Z",
      accountStatus: "ACTIVE" as const,
      optionsTradingApproved: true,
      conflictingStrategyExposure: false,
    },
    marketRegime: {
      verification: "AGENT_REPORTED" as const,
      temporalClass: result.outcome === "PRELIMINARY_RESEARCH"
        ? "PRIOR_CLOSE" as const
        : "LIVE" as const,
      observedAt: result.outcome === "PRELIMINARY_RESEARCH"
        ? "2026-08-24T20:00:00.000Z"
        : "2026-08-25T14:30:30.000Z",
      signal: result.outcome === "PROPOSE_TRADE"
        ? result.direction
        : "MIXED" as const,
      dailyClose: 650,
      sma20: 645,
      sma50: 640,
      sessionVwap: 648,
      spotMidpoint: 651,
      dailySessionCount: 50,
      intradayBarCount: result.outcome === "PRELIMINARY_RESEARCH" ? 0 : 60,
    },
    ...(result.outcome === "PROPOSE_TRADE"
      ? {
          candidateEvaluation: {
            verification: "AGENT_REPORTED" as const,
            observedAt: "2026-08-25T14:30:30.000Z",
            dte: 24,
            legs: [
              {
                role: "LONG" as const,
                contractSymbol: result.candidate!.longLeg.contractSymbol,
                delta: 0.52,
                impliedVolatility: 0.2,
                gamma: 0.02,
                theta: -0.1,
                vega: 0.15,
                volume: 200,
                openInterest: 1_000,
                openInterestDate: "2026-08-25",
              },
              {
                role: "SHORT" as const,
                contractSymbol: result.candidate!.shortLeg.contractSymbol,
                delta: 0.28,
                impliedVolatility: 0.19,
                gamma: 0.015,
                theta: -0.08,
                vega: 0.12,
                volume: 180,
                openInterest: 900,
                openInterestDate: "2026-08-25",
              },
            ],
          },
        }
      : {}),
    externalContext: [
      {
        sourceId: "exa-1",
        provider: "EXA" as const,
        verification: "AGENT_REPORTED" as const,
        title: "Current SPY market context",
        url: "https://example.com/spy-context",
        publishedAt: result.outcome === "PRELIMINARY_RESEARCH"
          ? "2026-08-25T10:00:00.000Z"
          : "2026-08-25T13:00:00.000Z",
        retrievedAt: result.outcome === "PRELIMINARY_RESEARCH"
          ? "2026-08-25T11:58:00.000Z"
          : "2026-08-25T14:30:00.000Z",
        summary: "Current context was checked for material catalysts.",
        relevance: "NEUTRAL" as const,
      },
    ],
    supportingFactors: [],
    contradictingFactors: [],
    conflicts: [],
  },
})

const serializeReport = <T extends ReportFixtureResult>(result: T) =>
  JSON.stringify(researchReport(result))

const quoteSnapshot = {
  evaluatedAt: "2026-08-25T14:31:00.000Z",
  snapshotMetadata: {
    provider: "ALPACA",
    source: "options-snapshots-indicative",
    retrievedAt: "2026-08-25T14:31:00.000Z",
    freshUntil: "2026-08-25T14:31:30.000Z",
  },
  longQuote: {
    contractSymbol: proposal.candidate.longLeg.contractSymbol,
    feed: "INDICATIVE",
    bidCentsPerShare: 220,
    askCentsPerShare: 223,
    providerTimestamp: "2026-08-25T14:30:30.000000000Z",
  },
  shortQuote: {
    contractSymbol: proposal.candidate.shortLeg.contractSymbol,
    feed: "INDICATIVE",
    bidCentsPerShare: 120,
    askCentsPerShare: 121,
    providerTimestamp: "2026-08-25T14:30:31.000000000Z",
  },
} as const

const setup = () => {
  const outcomes: ResearchCycleOutcomeV1[] = []
  const records: ResearchCycleTerminalRecordV1[] = []
  const record = vi.fn<ResearchCycleOutcomeSink["record"]>(
    async (terminalRecord, signal) => {
      signal.throwIfAborted()
      records.push(terminalRecord)
      outcomes.push(terminalRecord.outcome)
    },
  )
  const outcomeSink: ResearchCycleOutcomeSink = { record }
  const confirmQuotes = vi.fn<OptionQuoteProvider["confirmQuotes"]>(
    async () => ({
      success: true,
      snapshot: quoteSnapshot,
    }),
  )
  const quoteProvider: OptionQuoteProvider = { confirmQuotes }
  const evaluateShadowRisk = vi.fn(async () => ({
    decision: {
      decisionVersion: "1.0.0" as const,
      mode: "SHADOW" as const,
      evaluationVersion: "1.0.0" as const,
      ruleVersion: "1.0.0" as const,
      stage: "STATE_CAPTURE_FAILED" as const,
      outcome: "REJECTED" as const,
      evaluatedAt: null,
      captureReasonCodes: ["CAPTURE_INTERNAL_INVALID" as const],
    },
    breakerTransitions: [],
  }))
  const shadowRiskEvaluator = { evaluate: evaluateShadowRisk }
  const getEligibility = vi.fn<() => ResearchEligibilityV1>(() => ({
    evaluatedAt: "2026-08-25T14:31:00.000Z",
    sessionDate: "2026-08-25",
    researchEligible: true,
    tradeIntentEligible: true,
    tradeIntentWindow: {
      slotStartedAt: "2026-08-25T14:30:00.000Z",
      deadline: "2026-08-25T14:35:00.000Z",
    },
    previousSessionDates,
  }))
  const deriveIntent = vi.fn<
    (
      decision: ProposedTradeDecisionV2,
      context: Parameters<
        NonNullable<
          Parameters<typeof processResearchCycle>[0]["deriveIntent"]
        >
      >[1],
    ) => TradeIntentDerivationResult
  >(() => ({
    success: true,
    intent: {
      contractVersion: "2.0.0",
      decisionContractVersion: "2.0.0",
      direction: "BULLISH",
      structure: "BULL_CALL_SPREAD",
      expiration: "2026-09-18",
      longContractSymbol: proposal.candidate.longLeg.contractSymbol,
      shortContractSymbol: proposal.candidate.shortLeg.contractSymbol,
      quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
      evaluatedAt: quoteSnapshot.evaluatedAt,
      longQuote: quoteSnapshot.longQuote,
      shortQuote: quoteSnapshot.shortQuote,
      entryLimitCentsPerShare: 101,
      widthCentsPerShare: 500,
      maxLossCentsPerContract: 10_100,
      maxProfitCentsPerContract: 39_900,
      stopLossMarkHalfCentsPerShare: 101,
      profitTargetMarkHalfCentsPerShare: 601,
    },
  }))

  return {
    researchInvocation,
    cycleStartedAt: "2026-08-25T11:45:00.000Z",
    outcomes,
    records,
    outcomeSink,
    record,
    quoteProvider,
    shadowRiskEvaluator,
    evaluateShadowRisk,
    confirmQuotes,
    deriveIntent,
    getEligibility,
  }
}

describe("processResearchCycle", () => {
  it("retains anytime research without confirming quotes or deriving an intent", async () => {
    const dependencies = setup()
    dependencies.getEligibility.mockReturnValue({
      evaluatedAt: "2026-08-25T12:00:00.000Z",
      sessionDate: "2026-08-25",
      researchEligible: true,
      tradeIntentEligible: false,
      researchMode: "DRY_RUN",
      reason: "DRY_RUN_RESEARCH_ONLY",
    })

    const result = await processResearchCycle({
      rawResponse: serializeReport(preliminary),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "PRELIMINARY_RESEARCH_RETAINED",
      research: preliminary,
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [],
        preliminaryResearch: preliminary,
        researchReport: result.researchReport,
      },
    ])
  })

  it("rejects preliminary research for a different target session", async () => {
    const dependencies = setup()
    const result = await processResearchCycle({
      rawResponse: serializeReport({
        ...preliminary,
        targetSessionDate: "2026-08-26",
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{ code: "CONTEXT_INVALID", path: ["targetSessionDate"] }],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
  })

  it("rejects an ineligible proposal before quote confirmation", async () => {
    const dependencies = setup()
    dependencies.getEligibility.mockReturnValue({
      evaluatedAt: "2026-08-25T12:00:00.000Z",
      sessionDate: "2026-08-25",
      researchEligible: true,
      tradeIntentEligible: false,
      researchMode: "DRY_RUN",
      reason: "DRY_RUN_RESEARCH_ONLY",
    })

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "INTENT_DERIVATION_REJECTED",
      reasons: ["MARKET_WINDOW_INELIGIBLE"],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("rejects a proposal backed by a non-live market regime", async () => {
    const dependencies = setup()
    const report = researchReport(proposal)
    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...report,
        analysis: {
          ...report.analysis,
          marketRegime: {
            ...report.analysis.marketRegime,
            temporalClass: "PRIOR_CLOSE",
          },
        },
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "SCHEMA_INVALID",
          path: ["analysis", "marketRegime", "temporalClass"],
        },
      ],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("rejects a stale market regime even when it is labeled live", async () => {
    const dependencies = setup()
    const report = researchReport(proposal)
    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...report,
        analysis: {
          ...report.analysis,
          marketRegime: {
            ...report.analysis.marketRegime,
            observedAt: "2026-08-25T13:00:00.000Z",
          },
          candidateEvaluation: {
            ...report.analysis.candidateEvaluation,
            observedAt: "2026-08-25T13:00:00.000Z",
          },
        },
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "CONTEXT_INVALID",
          path: ["analysis", "marketRegime", "observedAt"],
        },
      ],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("rejects stale proposal account checks", async () => {
    const dependencies = setup()
    const report = researchReport(proposal)
    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...report,
        analysis: {
          ...report.analysis,
          accountChecks: {
            ...report.analysis.accountChecks,
            observedAt: "2026-08-25T13:00:00.000Z",
          },
        },
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "CONTEXT_INVALID",
          path: ["analysis", "accountChecks", "observedAt"],
        },
      ],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
  })

  it("requires complete daily and intraday histories for proposals", async () => {
    const report = researchReport(proposal)
    for (const marketRegime of [
      { ...report.analysis.marketRegime, dailySessionCount: 49 },
      { ...report.analysis.marketRegime, intradayBarCount: 59 },
    ]) {
      const dependencies = setup()
      const result = await processResearchCycle({
        rawResponse: JSON.stringify({
          ...report,
          analysis: { ...report.analysis, marketRegime },
        }),
        signal: new AbortController().signal,
        ...dependencies,
      })

      expect(result.outcome.status).toBe("DECISION_REJECTED")
      expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    }
  })

  it("requires candidate DTE, delta, volume, and open-interest prefilters", async () => {
    const report = researchReport(proposal)
    const evaluation = report.analysis.candidateEvaluation!
    const longLeg = evaluation.legs[0]
    const shortLeg = evaluation.legs[1]
    const invalidEvaluations = [
      { ...evaluation, dte: 13 },
      { ...evaluation, legs: [{ ...longLeg, delta: 0.44 }, shortLeg] },
      { ...evaluation, legs: [longLeg, { ...shortLeg, delta: 0.36 }] },
      { ...evaluation, legs: [{ ...longLeg, volume: 99 }, shortLeg] },
      { ...evaluation, legs: [longLeg, { ...shortLeg, openInterest: 499 }] },
    ]

    for (const candidateEvaluation of invalidEvaluations) {
      const dependencies = setup()
      const result = await processResearchCycle({
        rawResponse: JSON.stringify({
          ...report,
          analysis: { ...report.analysis, candidateEvaluation },
        }),
        signal: new AbortController().signal,
        ...dependencies,
      })

      expect(result.outcome.status).toBe("DECISION_REJECTED")
      expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    }
  })

  it("verifies retained DTE against the application session date", async () => {
    const dependencies = setup()
    const report = researchReport(proposal)
    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...report,
        analysis: {
          ...report.analysis,
          candidateEvaluation: {
            ...report.analysis.candidateEvaluation,
            dte: 20,
          },
        },
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "CONTEXT_INVALID",
          path: ["analysis", "candidateEvaluation", "dte"],
        },
      ],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
  })

  it.each(["2026-08-20", "2026-08-26"])(
    "rejects open interest dated outside the current or two prior sessions: %s",
    async (openInterestDate) => {
      const dependencies = setup()
      const report = researchReport(proposal)
      const candidateEvaluation = report.analysis.candidateEvaluation!
      const result = await processResearchCycle({
        rawResponse: JSON.stringify({
          ...report,
          analysis: {
            ...report.analysis,
            candidateEvaluation: {
              ...candidateEvaluation,
              legs: [
                { ...candidateEvaluation.legs[0], openInterestDate },
                candidateEvaluation.legs[1],
              ],
            },
          },
        }),
        signal: new AbortController().signal,
        ...dependencies,
      })

      expect(result.outcome).toMatchObject({
        status: "DECISION_REJECTED",
        issues: [
          {
            code: "CONTEXT_INVALID",
            path: [
              "analysis",
              "candidateEvaluation",
              "legs",
              0,
              "openInterestDate",
            ],
          },
        ],
      })
      expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    },
  )

  it("rejects Exa evidence retrieved before the application-owned cycle start", async () => {
    const dependencies = setup()
    const report = researchReport(proposal)
    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...report,
        analysis: {
          ...report.analysis,
          externalContext: report.analysis.externalContext.map((item) => ({
            ...item,
            publishedAt: "2026-08-25T10:00:00.000Z",
            retrievedAt: "2026-08-25T11:44:59.999Z",
          })),
        },
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "CONTEXT_INVALID",
          path: ["analysis", "externalContext"],
        },
      ],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
  })

  it("rechecks market-regime freshness after quote confirmation", async () => {
    const dependencies = setup()
    dependencies.confirmQuotes.mockResolvedValue({
      success: true,
      snapshot: {
        ...quoteSnapshot,
        evaluatedAt: "2026-08-25T14:31:31.000Z",
        snapshotMetadata: {
          ...quoteSnapshot.snapshotMetadata,
          retrievedAt: "2026-08-25T14:31:31.000Z",
          freshUntil: "2026-08-25T14:32:01.000Z",
        },
        longQuote: {
          ...quoteSnapshot.longQuote,
          providerTimestamp: "2026-08-25T14:31:30.000000000Z",
        },
        shortQuote: {
          ...quoteSnapshot.shortQuote,
          providerTimestamp: "2026-08-25T14:31:31.000000000Z",
        },
      },
    })

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "CONTEXT_INVALID",
          path: ["analysis", "marketRegime", "observedAt"],
        },
      ],
    })
    expect(dependencies.confirmQuotes).toHaveBeenCalledOnce()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("rejects a proposal whose retained metrics contradict its signal", async () => {
    const dependencies = setup()
    const report = researchReport(proposal)
    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...report,
        analysis: {
          ...report.analysis,
          marketRegime: {
            ...report.analysis.marketRegime,
            dailyClose: 630,
          },
        },
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [
        {
          code: "SCHEMA_INVALID",
          path: ["analysis", "marketRegime", "signal"],
        },
      ],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it.each([
    { accountStatus: "INACTIVE" },
    { optionsTradingApproved: false },
    { conflictingStrategyExposure: true },
  ])("rejects a proposal with ineligible account checks: %o", async (override) => {
    const dependencies = setup()
    const report = researchReport(proposal)
    const result = await processResearchCycle({
      rawResponse: JSON.stringify({
        ...report,
        analysis: {
          ...report.analysis,
          accountChecks: {
            ...report.analysis.accountChecks,
            ...override,
          },
        },
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({ status: "DECISION_REJECTED" })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("rechecks eligibility after quotes and refuses late intent derivation", async () => {
    const dependencies = setup()
    dependencies.getEligibility
      .mockReturnValueOnce({
        evaluatedAt: "2026-08-25T14:30:59.999Z",
        sessionDate: "2026-08-25",
        researchEligible: true,
        tradeIntentEligible: true,
        previousSessionDates,
      })
      .mockReturnValueOnce({
        evaluatedAt: "2026-08-25T14:31:00.000Z",
        sessionDate: "2026-08-25",
        researchEligible: true,
        tradeIntentEligible: false,
        previousSessionDates,
        reason: "OUTSIDE_TRADE_INTENT_WINDOW",
      })

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "INTENT_DERIVATION_REJECTED",
      reasons: ["MARKET_WINDOW_INELIGIBLE"],
    })
    expect(dependencies.confirmQuotes).toHaveBeenCalledOnce()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("records a valid minimal NO_ACTION without quotes or derivation", async () => {
    const dependencies = setup()
    const operations: string[] = []
    const trace: ResearchCycleTrace = {
      identify: () => undefined,
      recordOpenCodeResult: () => undefined,
      setOutcome: () => undefined,
      run: async (operation, work) => {
        operations.push(operation)
        return work()
      },
    }

    const result = await processResearchCycle({
      rawResponse: serializeReport(noAction),
      signal: new AbortController().signal,
      now: () => new Date("2026-08-25T14:31:00.000Z"),
      trace,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "VALIDATED_NO_ACTION",
      decision: {
        ...noAction,
      },
    })
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expect(operations).toEqual([
      "research.report.parse",
      "research.decision.validate",
      "ledger.cycle.terminalize",
    ])
    expect(dependencies.outcomes).toEqual([result.outcome])
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [],
        validatedDecision: noAction,
        researchReport: result.researchReport,
      },
    ])
  })

  it.each([
    "not-json",
    "```json\n{}\n```",
    `report\n${serializeReport(noAction)}`,
  ])("rejects malformed or mixed response without raw payload: %s", async (rawResponse) => {
    const dependencies = setup()
    const secretMarker = "must-not-be-recorded"

    const result = await processResearchCycle({
      rawResponse: `${rawResponse}${secretMarker}`,
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "DECISION_REJECTED",
      issues: [{ code: "MALFORMED_JSON", path: [] }],
    })
    expect(JSON.stringify(result)).not.toContain(secretMarker)
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [],
        researchReport: result.researchReport,
      },
    ])
  })

  it("rejects oversized UTF-8 output before parsing or quote confirmation", async () => {
    const dependencies = setup()
    const secretMarker = "must-not-be-recorded"
    const rawResponse =
      "é".repeat(MAX_RESEARCH_RESPONSE_BYTES / 2) + secretMarker

    const result = await processResearchCycle({
      rawResponse,
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "DECISION_REJECTED",
      issues: [{ code: "RESPONSE_TOO_LARGE", path: [] }],
    })
    expect(Buffer.byteLength(rawResponse, "utf8")).toBeGreaterThan(
      MAX_RESEARCH_RESPONSE_BYTES,
    )
    expect(rawResponse.length).toBeLessThan(MAX_RESEARCH_RESPONSE_BYTES)
    expect(JSON.stringify(result)).not.toContain(secretMarker)
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("rejects a normalized decision that would exceed the ledger payload bound", async () => {
    const dependencies = setup()
    const largeProposal = {
      ...proposal,
      thesis: "x",
      invalidation: Array.from({ length: 16 }, () => "x"),
      evidence: Array.from({ length: 30 }, (_, index) => ({
        ...proposal.evidence[0],
        claimId: `fact-${index}`,
        claim: "x",
      })),
    }
    const textFields = [
      () => largeProposal.thesis,
      ...largeProposal.invalidation.map((_, index) => () =>
        largeProposal.invalidation[index]!,
      ),
      ...largeProposal.evidence.map((_, index) => () =>
        largeProposal.evidence[index]!.claim,
      ),
    ]
    const setTextFields = [
      (value: string) => {
        largeProposal.thesis = value
      },
      ...largeProposal.invalidation.map((_, index) => (value: string) => {
        largeProposal.invalidation[index] = value
      }),
      ...largeProposal.evidence.map((_, index) => (value: string) => {
        largeProposal.evidence[index]!.claim = value
      }),
    ]
    const targetBytes = MAX_LEDGER_EVENT_PAYLOAD_BYTES - 6
    const largeReport = researchReport(largeProposal)
    let remaining = targetBytes - Buffer.byteLength(JSON.stringify(largeReport), "utf8")
    for (const [index, readText] of textFields.entries()) {
      if (remaining <= 0) break
      const current = readText()
      const added = Math.min(2_000 - current.length, remaining)
      setTextFields[index]!(current + "x".repeat(added))
      remaining -= added
    }
    const rawResponse = JSON.stringify(largeReport)

    expect(remaining).toBe(0)
    expect(Buffer.byteLength(rawResponse, "utf8")).toBe(targetBytes)
    expect(
      Buffer.byteLength(
        JSON.stringify({ researchReport: JSON.parse(rawResponse) }),
        "utf8",
      ),
    ).toBeGreaterThan(MAX_LEDGER_EVENT_PAYLOAD_BYTES)

    const result = await processResearchCycle({
      rawResponse,
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "DECISION_REJECTED",
      issues: [{ code: "RESPONSE_TOO_LARGE", path: [] }],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.record).toHaveBeenCalledWith(
      {
        outcome: result.outcome,
        evidenceSnapshots: [],
        researchInvocation,
      },
      expect.any(AbortSignal),
    )
  })

  it("rejects schema-invalid output before quote confirmation", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: serializeReport({
        ...proposal,
        entryLimit: 1.01,
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome.status).toBe("DECISION_REJECTED")
    if (result.outcome.status !== "DECISION_REJECTED") {
      throw new Error("Expected decision rejection")
    }
    expect(result.outcome.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SCHEMA_INVALID",
          schemaCategory: expect.any(String),
        }),
      ]),
    )
    expect(JSON.stringify(result.outcome)).not.toContain("1.01")
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [],
        researchReport: result.researchReport,
      },
    ])
  })

  it("caps recorded schema issues at the ledger schema maximum", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: serializeReport({
        ...noAction,
        evidence: Array.from({ length: 64 }, () => ({})),
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({ status: "DECISION_REJECTED" })
    if (result.outcome.status !== "DECISION_REJECTED") {
      throw new Error("Expected decision rejection")
    }
    expect(result.outcome.issues.length).toBeGreaterThan(0)
    expect(result.outcome.issues.length).toBeLessThanOrEqual(64)
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [],
        researchReport: result.researchReport,
      },
    ])
  })

  it("rejects proposal-snapshot evidence on NO_ACTION", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: serializeReport({
        ...noAction,
        evidence: [proposal.evidence[0]],
      }),
      signal: new AbortController().signal,
      now: () => new Date("2026-08-25T14:31:00.000Z"),
      ...dependencies,
    })

    expect(result.outcome.status).toBe("DECISION_REJECTED")
    if (result.outcome.status !== "DECISION_REJECTED") {
      throw new Error("Expected decision rejection")
    }
    expect(result.outcome.issues).toContainEqual({
      code: "SCHEMA_INVALID",
      path: ["result", "evidence", 0],
      schemaCategory: "UNRECOGNIZED_FIELD",
    })
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("rejects invalid evidence topology before a failing provider can mask it", async () => {
    const dependencies = setup()
    dependencies.confirmQuotes.mockResolvedValue({
      success: false,
      reasons: ["QUOTE_REQUEST_FAILED"],
    })

    const result = await processResearchCycle({
      rawResponse: serializeReport({
        ...proposal,
        evidence: [proposal.evidence[0], { ...proposal.evidence[0] }],
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{ code: "DUPLICATE_CLAIM_ID" }],
    })
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("fetches only the exact proposed symbols", async () => {
    const dependencies = setup()

    await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(dependencies.quoteProvider.confirmQuotes).toHaveBeenCalledWith({
      longContractSymbol: proposal.candidate.longLeg.contractSymbol,
      shortContractSymbol: proposal.candidate.shortLeg.contractSymbol,
      signal: expect.any(AbortSignal),
    })
  })

  it("rejects an already-aborted cycle before parsing or recording", async () => {
    const dependencies = setup()
    const abortReason = new DOMException("Timed out", "TimeoutError")

    await expect(
      processResearchCycle({
        rawResponse: serializeReport(noAction),
        signal: AbortSignal.abort(abortReason),
        ...dependencies,
      }),
    ).rejects.toBe(abortReason)
    expect(dependencies.record).not.toHaveBeenCalled()
    expect(dependencies.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("does not record when cancellation happens immediately before the sink", async () => {
    const dependencies = setup()
    const controller = new AbortController()
    const abortReason = new DOMException("Timed out", "TimeoutError")
    dependencies.record.mockImplementation(async (_outcome, signal) => {
      controller.abort(abortReason)
      signal.throwIfAborted()
    })

    await expect(
      processResearchCycle({
        rawResponse: serializeReport(noAction),
        signal: controller.signal,
        ...dependencies,
      }),
    ).rejects.toBe(abortReason)
    expect(dependencies.outcomes).toEqual([])
  })

  it("propagates quote cancellation without recording an outcome", async () => {
    const dependencies = setup()
    const abortReason = new DOMException("Timed out", "TimeoutError")
    dependencies.confirmQuotes.mockRejectedValue(abortReason)

    await expect(
      processResearchCycle({
        rawResponse: serializeReport(proposal),
        signal: AbortSignal.abort(abortReason),
        ...dependencies,
      }),
    ).rejects.toBe(abortReason)
    expect(dependencies.record).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("propagates cancellation while quote confirmation is in flight", async () => {
    const dependencies = setup()
    const controller = new AbortController()
    const abortReason = new DOMException("Timed out", "TimeoutError")
    let markQuoteStarted!: () => void
    const quoteStarted = new Promise<void>((resolve) => {
      markQuoteStarted = resolve
    })
    dependencies.confirmQuotes.mockImplementation(({ signal }) =>
      new Promise<never>((_resolve, reject) => {
        markQuoteStarted()
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        })
      }),
    )

    const processing = processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: controller.signal,
      ...dependencies,
    })
    await quoteStarted
    controller.abort(abortReason)

    await expect(processing).rejects.toBe(abortReason)
    expect(dependencies.confirmQuotes).toHaveBeenCalledOnce()
    expect(dependencies.record).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("records quote failures as derivation rejection without a decision", async () => {
    const dependencies = setup()
    dependencies.confirmQuotes.mockResolvedValue({
      success: false,
      reasons: ["QUOTE_STALE"],
    })

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "INTENT_DERIVATION_REJECTED",
      reasons: ["QUOTE_STALE"],
    })
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [],
        researchReport: result.researchReport,
      },
    ])
  })

  it("rejects an unknown proposal snapshot before derivation", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: serializeReport({
        ...proposal,
        evidence: [
          {
            ...proposal.evidence[0],
            snapshotRef: "agent-invented-snapshot",
          },
        ],
      }),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{ code: "UNKNOWN_SNAPSHOT" }],
    })
    expect(dependencies.quoteProvider.confirmQuotes).not.toHaveBeenCalled()
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
  })

  it("records a validated proposal and deterministic intent", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      outcomeVersion: "1.0.0",
      status: "INTENT_DERIVED",
      decision: proposal,
      intent: {
        quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
      },
    })
    expect(dependencies.deriveIntent).toHaveBeenCalledOnce()
    expect(dependencies.outcomes).toEqual([result.outcome])
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [
          {
            snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
            ...quoteSnapshot.snapshotMetadata,
            temporalClass: "LIVE",
          },
        ],
        validatedDecision: proposal,
        researchReport: result.researchReport,
        shadowRisk: result.shadowRisk,
      },
    ])
  })

  it("reports bounded stage outputs without research prose or quote prices", async () => {
    const dependencies = setup()
    const stageEvents: Array<{
      stage: string
      status: string
      details: Record<string, unknown>
    }> = []

    await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
      stageReporter: {
        report(stage, status, details = {}) {
          stageEvents.push({ stage, status, details: { ...details } })
        },
      },
    })

    expect(stageEvents.map(({ stage }) => stage)).toEqual([
      "research.report",
      "quotes.confirm",
      "decision.validate",
      "intent.derive",
      "risk.evaluate",
      "ledger.commit",
      "cycle.outcome",
    ])
    const serialized = JSON.stringify(stageEvents)
    expect(serialized).not.toContain(proposal.thesis)
    expect(serialized).not.toContain("bidCentsPerShare")
    expect(serialized).not.toContain("askCentsPerShare")
  })

  it("chains an anytime shadow proposal into deterministic risk", async () => {
    const dependencies = setup()
    dependencies.getEligibility.mockReturnValue({
      evaluatedAt: "2026-08-25T14:31:00.000Z",
      sessionDate: "2026-08-25",
      researchEligible: true,
      tradeIntentEligible: true,
      tradeIntentWindow: {
        slotStartedAt: "2026-08-25T14:31:00.000Z",
        deadline: "2026-08-26T14:31:00.000Z",
      },
      previousSessionDates,
      researchMode: "DRY_RUN",
    })

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome.status).toBe("INTENT_DERIVED")
    expect(dependencies.evaluateShadowRisk).toHaveBeenCalledOnce()
    expect(dependencies.evaluateShadowRisk).toHaveBeenCalledWith(
      expect.objectContaining({
        captureEligibility: expect.objectContaining({
          researchMode: "DRY_RUN",
          tradeIntentEligible: true,
        }),
      }),
    )
  })

  it("integrates the real deterministic deriver", async () => {
    const dependencies = setup()

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      cycleStartedAt: dependencies.cycleStartedAt,
      signal: new AbortController().signal,
      quoteProvider: dependencies.quoteProvider,
      shadowRiskEvaluator: dependencies.shadowRiskEvaluator,
      outcomeSink: dependencies.outcomeSink,
      getEligibility: dependencies.getEligibility,
      researchInvocation,
    })

    expect(result.outcome).toMatchObject({
      status: "INTENT_DERIVED",
      intent: {
        entryLimitCentsPerShare: 101,
        widthCentsPerShare: 500,
        maxLossCentsPerContract: 10_100,
        maxProfitCentsPerContract: 39_900,
      },
    })
  })

  it("blocks stale trusted metadata before derivation", async () => {
    const dependencies = setup()
    dependencies.confirmQuotes.mockResolvedValue({
      success: true,
      snapshot: {
        ...quoteSnapshot,
        snapshotMetadata: {
          ...quoteSnapshot.snapshotMetadata,
          retrievedAt: "2026-08-25T14:30:30.000Z",
          freshUntil: "2026-08-25T14:30:59.999Z",
        },
      },
    })

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "DECISION_REJECTED",
      issues: [{ code: "STALE_SNAPSHOT" }],
    })
    expect(dependencies.deriveIntent).not.toHaveBeenCalled()
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [
          {
            snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
            ...quoteSnapshot.snapshotMetadata,
            retrievedAt: "2026-08-25T14:30:30.000Z",
            freshUntil: "2026-08-25T14:30:59.999Z",
            temporalClass: "LIVE",
          },
        ],
        researchReport: result.researchReport,
      },
    ])
  })

  it("records bounded pure-derivation rejection reasons", async () => {
    const dependencies = setup()
    dependencies.deriveIntent.mockReturnValue({
      success: false,
      reasons: ["NON_POSITIVE_NET_DEBIT"],
    })

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toEqual({
      outcomeVersion: "1.0.0",
      status: "INTENT_DERIVATION_REJECTED",
      reasons: ["NON_POSITIVE_NET_DEBIT"],
    })
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [
          {
            snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
            ...quoteSnapshot.snapshotMetadata,
            temporalClass: "LIVE",
          },
        ],
        validatedDecision: proposal,
        researchReport: result.researchReport,
      },
    ])
  })

  it("caps recorded derivation reasons at the ledger schema maximum", async () => {
    const dependencies = setup()
    dependencies.deriveIntent.mockReturnValue({
      success: false,
      reasons: Array.from(
        { length: 65 },
        () => "NON_POSITIVE_NET_DEBIT" as const,
      ),
    })

    const result = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...dependencies,
    })

    expect(result.outcome).toMatchObject({
      status: "INTENT_DERIVATION_REJECTED",
    })
    if (result.outcome.status !== "INTENT_DERIVATION_REJECTED") {
      throw new Error("Expected intent derivation rejection")
    }
    expect(result.outcome.reasons).toHaveLength(64)
    expectRecords(dependencies.records, [
      {
        outcome: result.outcome,
        evidenceSnapshots: [
          {
            snapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
            ...quoteSnapshot.snapshotMetadata,
            temporalClass: "LIVE",
          },
        ],
        validatedDecision: proposal,
        researchReport: result.researchReport,
      },
    ])
  })

  it("prints only the outcome from a terminal record", async () => {
    const write = vi.fn<(line: string) => void>()
    const sink = createConsoleResearchCycleOutcomeSink(write)
    const decision: Extract<
      ResearchCycleOutcomeV1,
      { status: "VALIDATED_NO_ACTION" }
    >["decision"] = {
      ...noAction,
      reasonCodes: [...noAction.reasonCodes],
      evidence: [...noAction.evidence],
    }
    const outcome = {
      outcomeVersion: "1.0.0",
      status: "VALIDATED_NO_ACTION",
      decision,
    } satisfies ResearchCycleOutcomeV1

    await sink.record(
      {
        outcome,
        evidenceSnapshots: [],
        researchInvocation,
        validatedDecision: decision,
      },
      new AbortController().signal,
    )

    expect(write).toHaveBeenCalledWith(JSON.stringify(outcome))
  })

  it("awaits the outcome sink before completing", async () => {
    const dependencies = setup()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    dependencies.record.mockImplementation(async () => blocked)

    let completed = false
    const processing = processResearchCycle({
      rawResponse: serializeReport(noAction),
      signal: new AbortController().signal,
      ...dependencies,
    }).then(() => {
      completed = true
    })

    await Promise.resolve()
    expect(completed).toBe(false)
    release()
    await processing
    expect(completed).toBe(true)
  })

  it("propagates sink failures to the scheduler", async () => {
    const dependencies = setup()
    dependencies.record.mockImplementation(async () => {
      throw new Error("sink unavailable")
    })

    await expect(
      processResearchCycle({
        rawResponse: serializeReport(noAction),
        signal: new AbortController().signal,
        ...dependencies,
      }),
    ).rejects.toThrow("sink unavailable")
  })

  it("keeps the reserved quote alias invocation-local across overlapping cycles", async () => {
    const secondProposal = {
      ...proposal,
      candidate: {
        ...proposal.candidate,
        longLeg: {
          contractSymbol: "SPY260918C00660000",
          strike: 660,
        },
        shortLeg: {
          contractSymbol: "SPY260918C00665000",
          strike: 665,
        },
      },
    } as const
    const first = setup()
    const second = setup()
    const secondSnapshot = {
      ...quoteSnapshot,
      evaluatedAt: "2026-08-25T14:31:30.000Z",
      snapshotMetadata: {
        ...quoteSnapshot.snapshotMetadata,
        retrievedAt: "2026-08-25T14:31:30.000Z",
        freshUntil: "2026-08-25T14:32:00.000Z",
      },
      longQuote: {
        ...quoteSnapshot.longQuote,
        contractSymbol: secondProposal.candidate.longLeg.contractSymbol,
        providerTimestamp: "2026-08-25T14:31:29.000000000Z",
      },
      shortQuote: {
        ...quoteSnapshot.shortQuote,
        contractSymbol: secondProposal.candidate.shortLeg.contractSymbol,
        providerTimestamp: "2026-08-25T14:31:30.000000000Z",
      },
    } as const
    second.confirmQuotes.mockResolvedValue({
      success: true,
      snapshot: secondSnapshot,
    })

    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    first.confirmQuotes.mockImplementation(async () => {
      await firstBlocked
      return { success: true, snapshot: quoteSnapshot }
    })

    const firstProcessing = processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...first,
    })
    const secondResult = await processResearchCycle({
      rawResponse: serializeReport(secondProposal),
      signal: new AbortController().signal,
      ...second,
    })
    releaseFirst()
    const firstResult = await firstProcessing

    expect(second.deriveIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: secondProposal.candidate,
      }),
      expect.objectContaining({
        quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
        longQuote: secondSnapshot.longQuote,
        shortQuote: secondSnapshot.shortQuote,
      }),
    )
    expect(first.deriveIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: proposal.candidate,
      }),
      expect.objectContaining({
        quoteSnapshotRef: PROPOSAL_QUOTE_SNAPSHOT_REF,
        longQuote: quoteSnapshot.longQuote,
        shortQuote: quoteSnapshot.shortQuote,
      }),
    )
    expect(firstResult.outcome.status).toBe("INTENT_DERIVED")
    expect(secondResult.outcome.status).toBe("INTENT_DERIVED")
  })

  it("produces identical outcomes for fixed inputs", async () => {
    const first = setup()
    const second = setup()

    const firstResult = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...first,
    })
    const secondResult = await processResearchCycle({
      rawResponse: serializeReport(proposal),
      signal: new AbortController().signal,
      ...second,
    })

    expect(secondResult).toEqual(firstResult)
  })
})
