import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { ResearchRunV1 } from "../src/research/run/artifact.js"
import type { ShadowRiskStateProvenanceV1 } from "../src/risk/shadow-risk-v1.js"
import {
  buildResearchRunPresentation,
  writeResearchRunArtifacts,
} from "../src/research/run/presentation.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const noActionRun = (): ResearchRunV1 => {
  const decision = {
    contractVersion: "3.0.0" as const,
    outcome: "NO_ACTION" as const,
    reasonCodes: ["SIGNAL_NOT_ACTIONABLE" as const],
    evidence: [{
      claimId: "mixed-regime",
      kind: "SOURCED_FACT" as const,
      claim: "The retained market regime signal was mixed.",
      provider: "ALPACA" as const,
      temporalClass: "LIVE" as const,
      observedAt: "2026-08-27T15:36:45.000Z",
      locator: "analysis.marketRegime.signal",
    }],
  }
  return {
    runVersion: "6.0.0",
    cycle: {
      cycleId: "cycle-presentation-1",
      cycleNumber: 3,
      correlationId: "correlation-presentation-1",
      sessionId: "session-presentation-1",
      sessionDate: "2026-08-27",
      startedAt: "2026-08-27T15:35:59.000Z",
      completedAt: "2026-08-27T15:37:39.000Z",
    },
    initialEligibility: {
      evaluatedAt: "2026-08-27T15:35:58.000Z",
      sessionDate: "2026-08-27",
      sessionOpen: "2026-08-27T13:30:00.000Z",
      sessionClose: "2026-08-27T20:00:00.000Z",
      researchEligible: true,
      tradeIntentEligible: false,
      reason: "OUTSIDE_TRADE_INTENT_WINDOW",
    },
    evidenceSnapshots: [],
    symbolScreen: {
      screenVersion: "1.0.0",
      policyVersion: "1.0.0",
      mode: "SHADOW",
      evaluatedAt: "2026-08-27T15:35:59.000Z",
      universeSnapshotId: `option-universe-v2-${"a".repeat(64)}`,
      results: [{
        rank: 1,
        underlying: "SPY",
        actionability: "WATCH",
        direction: "NEUTRAL",
        reasonCodes: ["SESSION_MOVE_BELOW_THRESHOLD"],
        evidence: { sessionPercentChange: 0.2 },
      }],
    },
    researchReport: {
      reportVersion: "6.0.0",
      result: decision,
      analysis: {
        provenance: "AGENT_REPORTED",
        asOf: "2026-08-27T15:37:00.000Z",
        accountChecks: {
          verification: "AGENT_REPORTED",
          observedAt: "2026-08-27T15:36:30.000Z",
          accountStatus: "ACTIVE",
          optionsTradingApproved: true,
          conflictingStrategyExposure: false,
        },
        marketRegimes: [{
          verification: "AGENT_REPORTED",
          temporalClass: "LIVE",
          observedAt: "2026-08-27T15:36:45.000Z",
          signal: "MIXED",
          underlying: "SPY",
          dailyClose: 765.94,
          sma20: 766.58,
          sma50: 752.86,
          spotMidpoint: 770.07,
          dailySessionCount: 50,
          intradayBarCount: 126,
        }],
        symbolEvaluations: [],
        optionSurfaces: [],
        candidateEvaluations: [],
        symbolIndicators: [
          {
            underlying: "SPY",
            throughSessionDate: "2026-08-26",
            return5d: 0.01,
            return20d: 0.03,
            relativeStrengthRank20d: 1,
            realizedVolatility20: 0.16,
            completedSessionVolumeRatio20: 1.1,
          },
          {
            underlying: "QQQ",
            throughSessionDate: "2026-08-26",
            return5d: 0,
            return20d: 0.02,
            relativeStrengthRank20d: 2,
            realizedVolatility20: 0.2,
            completedSessionVolumeRatio20: 0.9,
          },
          {
            underlying: "IWM",
            throughSessionDate: "2026-08-26",
            return5d: -0.01,
            return20d: -0.02,
            relativeStrengthRank20d: 3,
            realizedVolatility20: 0.24,
            completedSessionVolumeRatio20: 1.2,
          },
        ],
        externalContext: [
          {
            sourceId: "exa-context",
            provider: "EXA",
            verification: "AGENT_REPORTED",
            title: "Inflation [context]",
            url: "https://example.com/research",
            publishedAt: "2026-08-27T14:00:00.000Z",
            retrievedAt: "2026-08-27T15:36:50.000Z",
            summary: "A bounded external summary.",
            relevance: "NEUTRAL",
          },
        ],
        supportingFactors: ["Close remained above the 50-session average."],
        contradictingFactors: [
          "<script>alert(`unsafe`)</script> | \u001b]0;owned\u0007\u009b31m Signal remained mixed.",
        ],
        conflicts: [],
      },
    },
    validatedDecision: decision,
    outcome: {
      outcomeVersion: "3.0.0",
      status: "VALIDATED_NO_ACTION",
      decision,
    },
    ledger: {
      firstSequence: 12,
      lastSequence: 15,
      terminalEventId: "terminal-presentation-1",
    },
  }
}

const derivedIntent = {
  contractVersion: "3.0.0",
  decisionContractVersion: "3.0.0",
  underlying: "SPY",
  direction: "BULLISH",
  structure: "BULL_CALL_SPREAD",
  expiration: "2026-09-18",
  longContractSymbol: "SPY260918C00650000",
  shortContractSymbol: "SPY260918C00655000",
  quoteSnapshotRef: "alpaca-proposal-quotes-v1",
  evaluatedAt: "2026-08-27T15:37:20.000Z",
  longQuote: {
    contractSymbol: "SPY260918C00650000",
    feed: "INDICATIVE",
    bidCentsPerShare: 220,
    askCentsPerShare: 223,
    providerTimestamp: "2026-08-27T15:37:19.000Z",
  },
  shortQuote: {
    contractSymbol: "SPY260918C00655000",
    feed: "INDICATIVE",
    bidCentsPerShare: 120,
    askCentsPerShare: 121,
    providerTimestamp: "2026-08-27T15:37:19.000Z",
  },
  entryLimitCentsPerShare: 101,
  widthCentsPerShare: 500,
  maxLossCentsPerContract: 10_100,
  maxProfitCentsPerContract: 39_900,
  stopLossMarkHalfCentsPerShare: 101,
  profitTargetMarkHalfCentsPerShare: 601,
} as const

const intentRun = (): ResearchRunV1 => {
  const source = noActionRun()
  if (source.researchReport?.reportVersion !== "6.0.0") {
    throw new Error("Expected a legacy report fixture")
  }
  const legacyReport = source.researchReport
  const decision = {
    contractVersion: "3.0.0" as const,
    outcome: "PROPOSE_TRADES" as const,
    proposals: [{
      priority: 1,
      direction: "BULLISH" as const,
      thesis: "Trend and intraday confirmation align.",
      candidate: {
        underlying: "SPY" as const,
        structure: "BULL_CALL_SPREAD" as const,
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
      evidence: [{
        claimId: "quote-fact",
        kind: "SOURCED_FACT" as const,
        claim: "The candidate was confirmed against the quote snapshot.",
        snapshotRef: "alpaca-proposal-quotes-v1",
      }],
    }],
  }
  return {
    ...source,
    evidenceSnapshots: [{
      snapshotRef: "alpaca-proposal-quotes-v1",
      provider: "ALPACA",
      source: "options-snapshots-indicative",
      retrievedAt: "2026-08-27T15:37:20.000Z",
      freshUntil: "2026-08-27T15:38:19.000Z",
      temporalClass: "LIVE",
    }],
    researchReport: {
      ...legacyReport,
      result: decision,
      analysis: {
        ...legacyReport.analysis,
        marketRegimes: [{
          ...legacyReport.analysis.marketRegimes[0]!,
          signal: "BULLISH",
          dailyClose: 770,
          sma20: 765,
          sma50: 750,
          sessionVwap: 768,
          spotMidpoint: 770,
        }],
        symbolEvaluations: [{
          underlying: "SPY",
          disposition: "PROPOSE",
          direction: "BULLISH",
          summary: "Retained for deep research.",
        }],
        candidateEvaluations: [{
          verification: "AGENT_REPORTED",
          observedAt: "2026-08-27T15:37:00.000Z",
          underlying: "SPY",
          expiration: "2026-09-18",
          dte: 22,
          legs: [
            {
              role: "LONG",
              contractSymbol: "SPY260918C00650000",
              delta: 0.52,
              impliedVolatility: 0.2,
              gamma: 0.02,
              theta: -0.1,
              vega: 0.15,
              volume: 200,
              openInterest: 1_000,
              openInterestDate: "2026-08-27",
            },
            {
              role: "SHORT",
              contractSymbol: "SPY260918C00655000",
              delta: 0.28,
              impliedVolatility: 0.19,
              gamma: 0.015,
              theta: -0.08,
              vega: 0.12,
              volume: 180,
              openInterest: 900,
              openInterestDate: "2026-08-27",
            },
          ],
        }],
      },
    },
    validatedDecision: decision,
    outcome: {
      outcomeVersion: "3.0.0",
      status: "PORTFOLIO_EVALUATED",
      decision,
      intents: [derivedIntent],
      selectedUnderlyings: ["SPY"],
    },
  }
}

describe("research run presentation", () => {
  it("renders a deterministic operator brief with escaped retained prose", () => {
    const first = buildResearchRunPresentation(noActionRun())
    const second = buildResearchRunPresentation(noActionRun())

    expect(second).toEqual(first)
    expect(first.actionability).toBe("NO_ACTION")
    expect(first.audit.failCount).toBe(0)
    expect(first.markdown.split("\n").slice(0, 18)).toEqual([
      "# Research Cycle 3 - 2026-08-27",
      "",
      "> Derived operator view. SQLite is authoritative and the canonical JSON is the portable machine record. No order was submitted.",
      "",
      "## At a Glance",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Outcome | VALIDATED\\_NO\\_ACTION |",
      "| Actionability | NO\\_ACTION |",
      "| Cycle mode | STANDARD |",
      "| Started | 2026-08-27T15:35:59.000Z |",
      "| Completed | 2026-08-27T15:37:39.000Z |",
      "| Duration | 100.0 seconds |",
      "",
      "## Decision",
      "",
      "**Result:** NO_ACTION",
    ])
    expect(first.markdown).toContain("## Offline Audit")
    expect(first.markdown).toContain("## Universe Indicator Context")
    expect(first.markdown).toContain("## Deterministic Symbol Screen")
    expect(first.markdown).toContain("| SPY actionability | WATCH |")
    expect(first.markdown).toContain(
      "| SPY agent disposition | UNAVAILABLE |",
    )
    expect(first.markdown).toContain("SPY 20-day return | 3.00%")
    expect(first.markdown).toContain(
      "mixed-regime \\[ALPACA LIVE, 2026-08-27T15:36:45.000Z\\]: The retained market regime signal was mixed.",
    )
    expect(first.markdown).toContain("Inflation \\[context\\]")
    expect(first.markdown).not.toContain("<script>")
    expect(first.markdown).toContain("\\<script\\>")
    expect(first.markdown).not.toContain("\u001b")
    expect(first.markdown).not.toContain("\u0007")
    expect(first.markdown).not.toContain("\u009b")
    expect(first.markdown).not.toContain("session-presentation-1")
  })

  it("maps every terminal outcome to non-executing actionability", () => {
    const source = noActionRun()
    const decisionRejected = {
      ...source,
      outcome: {
        outcomeVersion: "3.0.0",
        status: "DECISION_REJECTED",
        issues: [{ code: "SCHEMA_INVALID", path: ["result"] }],
      },
    } as ResearchRunV1
    expect(buildResearchRunPresentation(decisionRejected).actionability).toBe(
      "REJECTED",
    )
    const intent = buildResearchRunPresentation(intentRun())
    expect(intent.actionability).toBe(
      "NON_EXECUTING_INTENT",
    )
    expect(intent.markdown).toContain("| Maximum loss | $101.00 per contract |")
    expect(intent.markdown).toContain("| Stop-loss mark | $0.505 per share |")
    expect(intent.markdown).toContain(
      "**Agent-reported spread Greeks (long minus short):**",
    )
    expect(intent.markdown).toContain("| Net delta | 0.24 |")
  })

  it("presents the selected proposal and intent when priority two wins", () => {
    const source = intentRun()
    if (
      source.validatedDecision?.outcome !== "PROPOSE_TRADES" ||
      source.validatedDecision.contractVersion !== "3.0.0" ||
      source.researchReport?.result.outcome !== "PROPOSE_TRADES" ||
      source.researchReport.reportVersion !== "6.0.0" ||
      source.outcome.status !== "PORTFOLIO_EVALUATED" ||
      source.outcome.outcomeVersion !== "3.0.0"
    ) {
      throw new Error("Expected a portfolio fixture")
    }
    const firstProposal = source.validatedDecision.proposals[0]!
    const secondProposal = {
      ...firstProposal,
      priority: 2,
      thesis: "QQQ has the better refreshed execution quality.",
      candidate: {
        ...firstProposal.candidate,
        underlying: "QQQ",
        longLeg: {
          contractSymbol: "QQQ260918C00650000",
          strike: 650,
        },
        shortLeg: {
          contractSymbol: "QQQ260918C00655000",
          strike: 655,
        },
      },
      evidence: [{
        ...firstProposal.evidence[0]!,
        claimId: "qqq-quote-fact",
        snapshotRef: "alpaca-proposal-quotes-v1-qqq",
      }],
    }
    const secondIntent = {
      ...source.outcome.intents[0]!,
      underlying: "QQQ",
      longContractSymbol: "QQQ260918C00650000",
      shortContractSymbol: "QQQ260918C00655000",
      quoteSnapshotRef: "alpaca-proposal-quotes-v1-qqq",
      longQuote: {
        ...source.outcome.intents[0]!.longQuote,
        contractSymbol: "QQQ260918C00650000",
      },
      shortQuote: {
        ...source.outcome.intents[0]!.shortQuote,
        contractSymbol: "QQQ260918C00655000",
      },
    }
    const decision = {
      ...source.validatedDecision,
      proposals: [firstProposal, secondProposal],
    }
    const firstDiagnostics = source.researchReport.analysis.candidateEvaluations[0]!
    const run: ResearchRunV1 = {
      ...source,
      researchReport: {
        ...source.researchReport,
        result: decision,
        analysis: {
          ...source.researchReport.analysis,
          candidateEvaluations: [
            firstDiagnostics,
            {
              ...firstDiagnostics,
              underlying: "QQQ",
              legs: firstDiagnostics.legs.map((leg) => ({
                ...leg,
                contractSymbol: leg.role === "LONG"
                  ? "QQQ260918C00650000"
                  : "QQQ260918C00655000",
              })),
            },
          ],
        },
      },
      validatedDecision: decision,
      outcome: {
        ...source.outcome,
        decision,
        intents: [source.outcome.intents[0]!, secondIntent],
        selectedUnderlyings: ["QQQ"],
      },
    }

    const presentation = buildResearchRunPresentation(run)

    expect(presentation.markdown).toContain("| Underlying | QQQ |")
    expect(presentation.markdown).toContain(
      "| Quote snapshot | alpaca-proposal-quotes-v1-qqq |",
    )
    expect(presentation.markdown).toContain(
      "| LONG open interest | 1000 |",
    )
  })

  it.each([
    ["STATE_CAPTURE_FAILED", "SHADOW_REJECTED", "ACCOUNT_REQUEST_FAILED"],
    ["INTENT_REFRESH_FAILED", "SHADOW_REJECTED", "QUOTE_STALE"],
    ["EVALUATED_APPROVED", "SHADOW_APPROVED_NON_EXECUTING", undefined],
    ["EVALUATED_REJECTED", "SHADOW_REJECTED", "MAX_LOSS_EXCEEDED"],
  ] as const)("renders the %s shadow-risk branch", (variant, expected, reason) => {
    const source = intentRun()
    const stateProvenance: ShadowRiskStateProvenanceV1 = {
      capturedAt: "2026-08-27T15:37:21.000Z",
      accountObservedAt: "2026-08-27T15:37:21.000Z",
      portfolioObservedAt: "2026-08-27T15:37:21.000Z",
      contractsObservedAt: "2026-08-27T15:37:21.000Z",
      quoteSnapshot: {
        provider: "ALPACA",
        source: "options-snapshots-indicative",
        retrievedAt: "2026-08-27T15:37:20.000Z",
        freshUntil: "2026-08-27T15:38:19.000Z",
      },
      reconciliationReasonCodes: [],
    }
    const common = {
      decisionVersion: "1.0.0",
      mode: "SHADOW",
      evaluationVersion: "1.0.0",
      ruleVersion: "1.0.0",
    } as const
    const riskEvaluatedIntent = {
      ...derivedIntent,
      quoteSnapshotRef: "alpaca-shadow-risk-quotes-v1",
      evaluatedAt: "2026-08-27T15:37:21.000Z",
      longQuote: {
        ...derivedIntent.longQuote,
        bidCentsPerShare: 230,
        askCentsPerShare: 233,
      },
      entryLimitCentsPerShare: 111,
      maxLossCentsPerContract: 11_100,
      maxProfitCentsPerContract: 38_900,
      stopLossMarkHalfCentsPerShare: 111,
      profitTargetMarkHalfCentsPerShare: 611,
    }
    const decision = variant === "STATE_CAPTURE_FAILED"
      ? {
          ...common,
          stage: "STATE_CAPTURE_FAILED" as const,
          outcome: "REJECTED" as const,
          evaluatedAt: null,
          captureReasonCodes: ["ACCOUNT_REQUEST_FAILED" as const],
        }
      : variant === "INTENT_REFRESH_FAILED"
        ? {
            ...common,
            stage: "INTENT_REFRESH_FAILED" as const,
            outcome: "REJECTED" as const,
            evaluatedAt: "2026-08-27T15:37:21.000Z",
            derivationReasonCodes: ["QUOTE_STALE"],
            stateProvenance,
          }
        : {
            ...common,
            stage: "EVALUATED" as const,
            outcome: variant === "EVALUATED_APPROVED"
              ? "APPROVED" as const
              : "REJECTED" as const,
            evaluatedIntent: riskEvaluatedIntent,
            stateProvenance,
            evaluation: variant === "EVALUATED_APPROVED"
              ? {
                  evaluationVersion: "1.0.0" as const,
                  ruleVersion: "1.0.0" as const,
                  outcome: "APPROVED" as const,
                  evaluatedAt: "2026-08-27T15:37:21.000Z",
                  approvedQuantity: 1 as const,
                  maxLossCents: 10_100,
                  projectedBuyingPowerCents: 1_000_000,
                  spreadGreeks: {
                    calculation: "LONG_MINUS_SHORT" as const,
                    netDelta: 0.24,
                    netGamma: 0.005,
                    netTheta: -0.02,
                    netVega: 0.03,
                  },
                }
              : {
                  evaluationVersion: "1.0.0" as const,
                  ruleVersion: "1.0.0" as const,
                  outcome: "REJECTED" as const,
                  evaluatedAt: "2026-08-27T15:37:21.000Z",
                  reasonCodes: ["MAX_LOSS_EXCEEDED" as const],
                  spreadGreeks: {
                    calculation: "LONG_MINUS_SHORT" as const,
                    netDelta: 0.24,
                    netGamma: 0.005,
                    netTheta: -0.02,
                    netVega: 0.03,
                  },
                },
          }
    const presentation = buildResearchRunPresentation({
      ...source,
      shadowRisk: { decision, breakerTransitions: [] },
    })

    expect(presentation.actionability).toBe(expected)
    const escapedStage = (
      variant.startsWith("EVALUATED") ? "EVALUATED" : variant
    ).replaceAll("_", "\\_")
    expect(presentation.markdown).toContain(`| Stage | ${escapedStage} |`)
    if (reason !== undefined) {
      expect(presentation.markdown).toContain(reason.replaceAll("_", "\\_"))
    }
    if (variant.startsWith("EVALUATED")) {
      expect(presentation.markdown).toContain(
        "| Basis | SHADOW\\_RISK\\_REFRESH |",
      )
      expect(presentation.markdown).toContain(
        "| Maximum loss | $111.00 per contract |",
      )
      expect(presentation.markdown).not.toContain(
        "| Maximum loss | $101.00 per contract |",
      )
      expect(presentation.markdown).toContain("| Verified net delta | 0.24 |")
    }
  })

  it("writes private paired artifacts and enforces overwrite behavior", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-presentation-test-"))
    temporaryDirectories.push(root)
    const options = { run: noActionRun(), root }

    const first = await writeResearchRunArtifacts(options)
    expect(first.jsonPath).toBe(
      join(root, "2026-08-27", "cycle-3-cycle-presentation-1.json"),
    )
    expect(first.markdownPath).toBe(
      join(root, "2026-08-27", "cycle-3-cycle-presentation-1.md"),
    )
    expect(JSON.parse(readFileSync(first.jsonPath, "utf8"))).toEqual(
      noActionRun(),
    )
    expect(readFileSync(first.markdownPath, "utf8")).toBe(
      first.presentation.markdown,
    )
    expect(statSync(first.jsonPath).mode & 0o777).toBe(0o600)
    expect(statSync(first.markdownPath).mode & 0o777).toBe(0o600)
    await expect(writeResearchRunArtifacts(options)).rejects.toThrow()

    const originalJson = readFileSync(first.jsonPath, "utf8")
    const originalMarkdown = readFileSync(first.markdownPath, "utf8")
    const invalidPresentation = {
      ...first.presentation,
      markdown: 1 as unknown as string,
    }
    await expect(
      writeResearchRunArtifacts({
        ...options,
        overwrite: true,
        presentation: invalidPresentation,
      }),
    ).rejects.toThrow()
    expect(readFileSync(first.jsonPath, "utf8")).toBe(originalJson)
    expect(readFileSync(first.markdownPath, "utf8")).toBe(originalMarkdown)

    chmodSync(first.jsonPath, 0o644)
    chmodSync(first.markdownPath, 0o644)
    await writeResearchRunArtifacts({ ...options, overwrite: true })
    expect(statSync(first.jsonPath).mode & 0o777).toBe(0o600)
    expect(statSync(first.markdownPath).mode & 0o777).toBe(0o600)
  })

  it("rolls back new JSON without deleting pre-existing Markdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-presentation-test-"))
    temporaryDirectories.push(root)
    const options = { run: noActionRun(), root }
    const directory = join(root, "2026-08-27")
    const baseName = "cycle-3-cycle-presentation-1"
    const jsonPath = join(directory, `${baseName}.json`)
    const markdownPath = join(directory, `${baseName}.md`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(markdownPath, "existing brief\n", "utf8")

    await expect(writeResearchRunArtifacts(options)).rejects.toThrow()
    expect(existsSync(jsonPath)).toBe(false)
    expect(readFileSync(markdownPath, "utf8")).toBe("existing brief\n")

    rmSync(markdownPath)
    const retried = await writeResearchRunArtifacts(options)
    expect(retried).toMatchObject({ jsonPath, markdownPath })
  })
})
