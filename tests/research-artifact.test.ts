import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { ResearchReportV2 } from "../src/contracts/research-report-v2.js"
import {
  projectResearchRunV1,
  type ResearchRunV1,
  writeResearchRunArtifact,
} from "../src/research/research-artifact.js"
import type { StoredLedgerEventV1 } from "../src/event-ledger/ledger-event-v1.js"
import type { ResearchCycleOutcomeV1 } from "../src/research/research-cycle-outcome-v1.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("research cycle artifact", () => {
  it("projects the complete run from the committed ledger timeline", () => {
    const decision = {
      contractVersion: "1.0.0" as const,
      strategyVersion: "1.0.0" as const,
      outcome: "NO_ACTION" as const,
      reasonCodes: ["SIGNAL_NOT_ACTIONABLE" as const],
      evidence: [],
    }
    const base = {
      eventVersion: "1.0.0" as const,
      occurredAt: "2026-08-26T12:00:00.000Z",
      recordedAt: "2026-08-26T12:00:00.001Z",
      correlationId: "correlation-1",
      cycleId: "cycle-1",
      sessionId: "session-1",
    }
    const events: StoredLedgerEventV1[] = [
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
            researchMode: "DRY_RUN_ANYTIME",
            reason: "DRY_RUN_RESEARCH_ONLY",
          },
        },
      },
      {
        ...base,
        sequence: 3,
        eventId: "event-decision",
        causationEventId: "event-start",
        eventType: "RESEARCH_DECISION_VALIDATED",
        payload: { decision },
      },
      {
        ...base,
        sequence: 4,
        eventId: "event-completed",
        causationEventId: "event-decision",
        eventType: "RESEARCH_CYCLE_COMPLETED",
        payload: { status: "VALIDATED_NO_ACTION" },
      },
    ]

    expect(projectResearchRunV1(events)).toMatchObject({
      runVersion: "1.0.0",
      cycle: {
        cycleId: "cycle-1",
        cycleNumber: 1,
        sessionDate: "2026-08-26",
      },
      initialEligibility: {
        researchEligible: true,
        researchMode: "DRY_RUN_ANYTIME",
        reason: "DRY_RUN_RESEARCH_ONLY",
      },
      validatedDecision: decision,
      outcome: { status: "VALIDATED_NO_ACTION", decision },
      ledger: {
        firstSequence: 2,
        lastSequence: 4,
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
  })

  it("writes the full validated outcome to a unique inspection-only JSON file", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-artifact-test-"))
    temporaryDirectories.push(root)
    const outcome: ResearchCycleOutcomeV1 = {
      outcomeVersion: "1.0.0",
      status: "PRELIMINARY_RESEARCH_RETAINED",
      research: {
        contractVersion: "1.0.0",
        strategyVersion: "1.0.0",
        outcome: "PRELIMINARY_RESEARCH",
        targetSessionDate: "2026-08-26",
        direction: "UNDETERMINED",
        thesis: "Full validated thesis.",
        invalidation: ["Refresh after the regular session opens."],
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
        requiresRefresh: true,
      },
    }
    const researchReport: ResearchReportV2 = {
      reportVersion: "2.0.0",
      result: outcome.research,
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
      runVersion: "1.0.0",
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
      preliminaryResearch: outcome.research,
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
  })

  it("does not overwrite an existing cycle artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-artifact-test-"))
    temporaryDirectories.push(root)
    const outcome: ResearchCycleOutcomeV1 = {
      outcomeVersion: "1.0.0",
      status: "VALIDATED_NO_ACTION",
      decision: {
        contractVersion: "1.0.0",
        strategyVersion: "1.0.0",
        outcome: "NO_ACTION",
        reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
        evidence: [],
      },
    }
    const run: ResearchRunV1 = {
      runVersion: "1.0.0",
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
