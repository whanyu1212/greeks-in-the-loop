import { createHash } from "node:crypto"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { ResearchReportV6 } from "../src/contracts/research-report-v6.js"
import {
  projectResearchRunV1,
  type ResearchRunV1,
  writeResearchRunArtifact,
} from "../src/research/run/artifact.js"
import type { StoredLedgerEventV4 } from "../src/event-ledger/ledger-event-v1.js"
import type { ResearchCycleOutcomeV3 } from "../src/research/cycle/outcome.js"

const researchInvocation = {
  invocationVersion: "3.0.0" as const,
  agentName: "research",
  cycleMode: "DRY_RUN" as const,
  promptVersion: "1.3.0",
  decisionContractVersion: "3.0.0",
  reportVersion: "6.0.0",
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

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("research cycle artifact", () => {
  it("selects shadow risk by causal intent identity and retains its breaker transitions", () => {
    const base = {
      eventVersion: "4.0.0",
      occurredAt: "2026-08-27T14:30:00.000Z",
      recordedAt: "2026-08-27T14:30:00.001Z",
      correlationId: "correlation-risk",
      cycleId: "cycle-risk",
      sessionId: "session-risk",
    }
    const events = [
      {
        ...base,
        sequence: 1,
        eventId: "risk-start",
        eventType: "RESEARCH_CYCLE_STARTED",
        payload: { cycleNumber: 1, sessionDate: "2026-08-27" },
      },
      {
        ...base,
        sequence: 2,
        eventId: "risk-decision-source",
        causationEventId: "risk-start",
        eventType: "RESEARCH_DECISION_VALIDATED",
        payload: {
          decision: {
            contractVersion: "3.0.0",
            outcome: "PROPOSE_TRADES",
            proposals: [],
          },
        },
      },
      {
        ...base,
        sequence: 3,
        eventId: "risk-intent",
        causationEventId: "risk-decision-source",
        eventType: "TRADE_INTENT_DERIVED",
        payload: { intent: { underlying: "SPY" } },
      },
      {
        ...base,
        sequence: 4,
        eventId: "risk-result",
        causationEventId: "risk-intent",
        eventType: "RISK_SHADOW_DECISION_RECORDED",
        payload: {
          decision: {
            decisionVersion: "1.0.0",
            mode: "SHADOW",
            evaluationVersion: "1.0.0",
            ruleVersion: "1.0.0",
            stage: "STATE_CAPTURE_FAILED",
            outcome: "REJECTED",
            evaluatedAt: null,
            captureReasonCodes: ["ACCOUNT_REQUEST_FAILED"],
          },
        },
      },
      {
        ...base,
        sequence: 5,
        eventId: "risk-intent-selected",
        causationEventId: "risk-result",
        eventType: "TRADE_INTENT_DERIVED",
        payload: { intent: { underlying: "QQQ" } },
      },
      {
        ...base,
        sequence: 6,
        eventId: "risk-result-selected",
        causationEventId: "risk-intent-selected",
        eventType: "RISK_SHADOW_DECISION_RECORDED",
        payload: {
          decision: {
            decisionVersion: "1.0.0",
            mode: "SHADOW",
            evaluationVersion: "1.0.0",
            ruleVersion: "1.0.0",
            stage: "STATE_CAPTURE_FAILED",
            outcome: "REJECTED",
            evaluatedAt: null,
            captureReasonCodes: ["CAPTURE_INTERNAL_INVALID"],
          },
        },
      },
      {
        ...base,
        sequence: 7,
        eventId: "risk-breaker",
        causationEventId: "risk-result-selected",
        eventType: "RISK_BREAKER_LATCHED",
        payload: {
          stateVersion: "1.0.0",
          tradingDate: "2026-08-27",
          observedAt: "2026-08-27T14:30:00.000Z",
          breaker: "DAILY",
        },
      },
      {
        ...base,
        sequence: 8,
        eventId: "risk-plan",
        causationEventId: "risk-breaker",
        eventType: "PORTFOLIO_SHADOW_PLAN_RECORDED",
        payload: { proposalCount: 2, selectedUnderlyings: ["QQQ"] },
      },
      {
        ...base,
        sequence: 9,
        eventId: "risk-completed",
        causationEventId: "risk-plan",
        eventType: "RESEARCH_CYCLE_COMPLETED",
        payload: { status: "PORTFOLIO_EVALUATED" },
      },
    ] as unknown as StoredLedgerEventV4[]

    expect(projectResearchRunV1(events)).toMatchObject({
      runVersion: "6.0.0",
      shadowRisk: {
        decision: {
          stage: "STATE_CAPTURE_FAILED",
          outcome: "REJECTED",
          captureReasonCodes: ["CAPTURE_INTERNAL_INVALID"],
        },
        breakerTransitions: [{ breaker: "DAILY" }],
      },
      outcome: {
        status: "PORTFOLIO_EVALUATED",
        selectedUnderlyings: ["QQQ"],
      },
    })
  })

  it("projects the complete run from the committed ledger timeline", () => {
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
        observedAt: "2026-08-26T12:00:00.000Z",
      }],
    }
    const base = {
      eventVersion: "4.0.0" as const,
      occurredAt: "2026-08-26T12:00:00.000Z",
      recordedAt: "2026-08-26T12:00:00.001Z",
      correlationId: "correlation-1",
      cycleId: "cycle-1",
      sessionId: "session-1",
    }
    const events: StoredLedgerEventV4[] = [
      {
        ...base,
        sequence: 2,
        eventId: "event-start",
        eventType: "RESEARCH_CYCLE_STARTED",
        payload: {
          cycleNumber: 1,
          sessionDate: "2026-08-26",
          initialEligibility: {
            evaluatedAt: "2026-08-26T12:00:00.000Z",
            sessionDate: "2026-08-26",
            researchEligible: true,
            tradeIntentEligible: false,
            researchMode: "DRY_RUN",
            reason: "DRY_RUN_RESEARCH_ONLY",
          },
        },
      },
      {
        ...base,
        sequence: 3,
        eventId: "event-symbol-screen",
        causationEventId: "event-start",
        eventType: "RESEARCH_SYMBOL_SCREEN_RECORDED",
        payload: {
          screen: {
            screenVersion: "1.0.0",
            policyVersion: "1.0.0",
            mode: "SHADOW",
            evaluatedAt: "2026-08-26T12:00:00.000Z",
            universeSnapshotId: `option-universe-v2-${"a".repeat(64)}`,
            results: [],
          },
        },
      },
      {
        ...base,
        sequence: 4,
        eventId: "event-decision",
        causationEventId: "event-symbol-screen",
        eventType: "RESEARCH_DECISION_VALIDATED",
        payload: { decision },
      },
      {
        ...base,
        sequence: 5,
        eventId: "event-completed",
        causationEventId: "event-decision",
        eventType: "RESEARCH_CYCLE_COMPLETED",
        payload: { status: "VALIDATED_NO_ACTION" },
      },
    ]

    expect(projectResearchRunV1(events)).toMatchObject({
      runVersion: "6.0.0",
      cycle: {
        cycleId: "cycle-1",
        cycleNumber: 1,
        sessionDate: "2026-08-26",
      },
      initialEligibility: {
        researchEligible: true,
        researchMode: "DRY_RUN",
        reason: "DRY_RUN_RESEARCH_ONLY",
      },
      validatedDecision: decision,
      symbolScreen: {
        screenVersion: "1.0.0",
        policyVersion: "1.0.0",
        mode: "SHADOW",
      },
      outcome: { status: "VALIDATED_NO_ACTION", decision },
      ledger: {
        firstSequence: 2,
        lastSequence: 5,
        terminalEventId: "event-completed",
      },
    })

    const [start, ...remainingEvents] = events
    if (start?.eventType !== "RESEARCH_CYCLE_STARTED") {
      throw new Error("Expected a cycle-start fixture")
    }
    const legacyRun = projectResearchRunV1([
      {
        ...start,
        payload: { cycleNumber: start.payload.cycleNumber },
      },
      ...remainingEvents,
    ])
    expect(legacyRun.cycle.sessionDate).toBe("2026-08-26")
    expect(legacyRun.initialEligibility).toBeUndefined()

    const currentEvents = events.map((event) =>
      event.eventType === "RESEARCH_CYCLE_COMPLETED"
        ? {
            ...event,
            payload: { ...event.payload, researchInvocation },
          }
        : event,
    ) as StoredLedgerEventV4[]
    const currentRun = projectResearchRunV1(currentEvents)
    expect(currentRun).toMatchObject({
      runVersion: "6.0.0",
      researchInvocation,
    })
    const latestInvocation = {
      ...researchInvocation,
      invocationVersion: "3.0.0" as const,
      promptVersion: "1.4.0",
    }
    const latestEvents = events.map((event) =>
      event.eventType === "RESEARCH_CYCLE_COMPLETED"
        ? {
            ...event,
            payload: { ...event.payload, researchInvocation: latestInvocation },
          }
        : event,
    ) as StoredLedgerEventV4[]
    expect(projectResearchRunV1(latestEvents)).toMatchObject({
      runVersion: "6.0.0",
      researchInvocation: latestInvocation,
    })
  })

  it("writes the full validated outcome to a unique inspection-only JSON file", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-artifact-test-"))
    temporaryDirectories.push(root)
    const outcome: ResearchCycleOutcomeV3 = {
      outcomeVersion: "3.0.0",
      status: "VALIDATED_NO_ACTION",
      decision: {
        contractVersion: "3.0.0",
        outcome: "NO_ACTION",
        reasonCodes: ["MARKET_WINDOW_INELIGIBLE"],
        evidence: [
          {
            claimId: "prior-close",
            kind: "SOURCED_FACT",
            claim: "The latest observation is from the prior close.",
            provider: "ALPACA",
            temporalClass: "PRIOR_CLOSE",
            observedAt: "2026-08-25T20:00:00.000Z",
          },
        ],
      },
    }
    const researchReport: ResearchReportV6 = {
      reportVersion: "6.0.0",
      result: outcome.decision,
      analysis: {
        provenance: "AGENT_REPORTED",
        asOf: "2026-08-26T12:00:00.000Z",
        accountChecks: {
          verification: "AGENT_REPORTED",
          observedAt: "2026-08-26T11:55:00.000Z",
          accountStatus: "ACTIVE",
          optionsTradingApproved: true,
          conflictingStrategyExposure: false,
        },
        marketRegimes: [{
          verification: "AGENT_REPORTED",
          temporalClass: "PRIOR_CLOSE",
          observedAt: "2026-08-25T20:00:00.000Z",
          signal: "UNAVAILABLE",
          underlying: "SPY",
          dailySessionCount: 50,
          intradayBarCount: 0,
        }],
        symbolEvaluations: [],
        optionSurfaces: [],
        candidateEvaluations: [],
        externalContext: [
          {
            sourceId: "exa-1",
            provider: "EXA",
            verification: "AGENT_REPORTED",
            title: "Current market context",
            url: "https://example.com/context",
            publishedAt: "2026-08-26T10:00:00.000Z",
            retrievedAt: "2026-08-26T11:58:00.000Z",
            summary: "A timestamped Exa result was reviewed.",
            relevance: "NEUTRAL",
          },
        ],
        supportingFactors: [],
        contradictingFactors: [],
        conflicts: [],
      },
    }

    const run: ResearchRunV1 = {
      runVersion: "6.0.0",
      cycle: {
        cycleId: "cycle-1",
        cycleNumber: 1,
        correlationId: "correlation-1",
        sessionId: "session-1",
        sessionDate: "2026-08-26",
        startedAt: "2026-08-26T12:00:00.000Z",
        completedAt: "2026-08-26T12:05:00.000Z",
      },
      evidenceSnapshots: [],
      outcome,
      researchReport,
      validatedDecision: outcome.decision,
      ledger: {
        firstSequence: 2,
        lastSequence: 5,
        terminalEventId: "event-5",
      },
    }
    const path = await writeResearchRunArtifact({
      run,
      root,
    })

    expect(path).toBe(join(root, "2026-08-26", "cycle-1-cycle-1.json"))
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...run,
    })
    expect(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ).toBe("f478d5d6cc6e42059bcc7d0bd01c47ad6b9221d6a07d71a891b8b1be8608cf57")
    expect(statSync(path).mode & 0o777).toBe(0o600)

    chmodSync(path, 0o644)
    await writeResearchRunArtifact({ run, root, overwrite: true })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("does not overwrite an existing cycle artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-artifact-test-"))
    temporaryDirectories.push(root)
    const outcome: ResearchCycleOutcomeV3 = {
      outcomeVersion: "3.0.0",
      status: "VALIDATED_NO_ACTION",
      decision: {
        contractVersion: "3.0.0",
        outcome: "NO_ACTION",
        reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
        evidence: [{
          claimId: "mixed-regime",
          kind: "SOURCED_FACT",
          claim: "The retained market regime signal was mixed.",
          provider: "ALPACA",
          temporalClass: "LIVE",
          observedAt: "2026-08-26T12:00:00.000Z",
        }],
      },
    }
    const run: ResearchRunV1 = {
      runVersion: "6.0.0",
      cycle: {
        cycleId: "cycle-1",
        cycleNumber: 1,
        correlationId: "correlation-1",
        sessionId: "session-1",
        sessionDate: "2026-08-26",
        startedAt: "2026-08-26T12:00:00.000Z",
        completedAt: "2026-08-26T12:05:00.000Z",
      },
      evidenceSnapshots: [],
      outcome,
      validatedDecision: outcome.decision,
      ledger: {
        firstSequence: 2,
        lastSequence: 4,
        terminalEventId: "event-4",
      },
    }
    const options = {
      run,
      root,
    }

    await writeResearchRunArtifact(options)
    await expect(writeResearchRunArtifact(options)).rejects.toThrow()
  })
})
