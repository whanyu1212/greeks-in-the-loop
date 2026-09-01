import { describe, expect, it, vi } from "vitest"

import { NOOP_RESEARCH_CYCLE_TRACE } from "../src/observability/research-telemetry.js"
import type { ResearchCycleOutcomeSink } from "../src/research/cycle/outcome.js"
import { createResearchCycleStageReports } from "../src/research/cycle/stage-reporting.js"
import {
  MAX_TERMINAL_REJECTION_DETAILS,
  recordResearchCycleOutcome,
} from "../src/research/cycle/terminal.js"
import type { ResearchInvocationV1 } from "../src/research/invocation.js"
import type { SymbolScreenResultV1 } from "../src/research/symbol-screen.js"

const symbolScreen: SymbolScreenResultV1 = {
  screenVersion: "1.0.0",
  policyVersion: "1.0.0",
  mode: "SHADOW",
  evaluatedAt: "2026-08-25T14:30:00.000Z",
  universeSnapshotId: `option-universe-v2-${"a".repeat(64)}`,
  results: [],
}

const researchInvocation: ResearchInvocationV1 = {
  invocationVersion: "6.0.0",
  agentName: "research",
  cycleMode: "STANDARD",
  promptVersion: "6.0.0",
  decisionContractVersion: "3.0.0",
  reportVersion: "6.0.0",
  providerId: "openai",
  modelId: "gpt-5.6-sol",
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

const context = (record: ResearchCycleOutcomeSink["record"]) => ({
  sink: { record },
  signal: new AbortController().signal,
  researchInvocation,
  symbolScreen,
  trace: NOOP_RESEARCH_CYCLE_TRACE,
  stages: createResearchCycleStageReports(),
})

describe("recordResearchCycleOutcome", () => {
  it("records a validated no-action outcome once", async () => {
    const record = vi.fn<ResearchCycleOutcomeSink["record"]>(async () => {})
    const processed = await recordResearchCycleOutcome({
      outcome: {
        outcomeVersion: "3.0.0",
        status: "VALIDATED_NO_ACTION",
        decision: {
          contractVersion: "3.0.0",
          outcome: "NO_ACTION",
          reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
          evidence: [{
            claimId: "fact",
            kind: "SOURCED_FACT",
            claim: "The measured signal was mixed.",
            provider: "ALPACA",
            temporalClass: "LIVE",
            observedAt: "2026-08-25T14:30:00.000Z",
          }],
        },
      },
    }, context(record))

    expect(record).toHaveBeenCalledOnce()
    expect(processed).toMatchObject({
      outcome: { status: "VALIDATED_NO_ACTION" },
      report: "Research cycle outcome: VALIDATED_NO_ACTION",
    })
    expect(processed.shadowRisks).toBeUndefined()
  })

  it("bounds terminal schema diagnostics before persistence", async () => {
    const record = vi.fn<ResearchCycleOutcomeSink["record"]>(async () => {})
    const issues = Array.from(
      { length: MAX_TERMINAL_REJECTION_DETAILS + 5 },
      (_, index) => ({ code: "SCHEMA_INVALID" as const, path: ["field", index] }),
    )
    const processed = await recordResearchCycleOutcome({
      outcome: {
        outcomeVersion: "3.0.0",
        status: "DECISION_REJECTED",
        issues,
      },
    }, context(record))

    expect(processed.outcome.status).toBe("DECISION_REJECTED")
    if (processed.outcome.status !== "DECISION_REJECTED") return
    expect(processed.outcome.issues).toHaveLength(MAX_TERMINAL_REJECTION_DETAILS)
    expect(record.mock.calls[0]?.[0].outcome).toEqual(processed.outcome)
  })
})
