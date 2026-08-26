import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { ResearchReportV2 } from "../src/contracts/research-report-v2.js"
import { writeResearchCycleArtifact } from "../src/research/research-artifact.js"
import type { ResearchCycleOutcomeV1 } from "../src/research/research-cycle-outcome-v1.js"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("research cycle artifact", () => {
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

    const path = await writeResearchCycleArtifact({
      cycleId: "cycle-1",
      cycleNumber: 1,
      sessionDate: "2026-08-26",
      outcome,
      researchReport,
      root,
      now: () => new Date("2026-08-26T12:05:00.000Z"),
    })

    expect(path).toBe(join(root, "2026-08-26", "cycle-1-cycle-1.json"))
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      artifactVersion: "1.0.0",
      generatedAt: "2026-08-26T12:05:00.000Z",
      sessionDate: "2026-08-26",
      cycleId: "cycle-1",
      cycleNumber: 1,
      outcome,
      researchReport,
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
    const options = {
      cycleId: "cycle-1",
      cycleNumber: 1,
      sessionDate: "2026-08-26",
      outcome,
      root,
    }

    await writeResearchCycleArtifact(options)
    await expect(writeResearchCycleArtifact(options)).rejects.toThrow()
  })
})
