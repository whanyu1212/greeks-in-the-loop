import { describe, expect, it, vi } from "vitest"

import { NOOP_RESEARCH_CYCLE_TRACE } from "../src/observability/research-telemetry.js"
import type { ShadowRiskResultV1 } from "../src/risk/shadow-risk-v1.js"
import type { ResearchCycleOutcomeSink } from "../src/research/research-cycle-outcome-v1.js"
import { createResearchCycleStageReports } from "../src/research/research-cycle-stage-reporting.js"
import {
  recordResearchCycleOutcome,
  type ResearchCycleTerminalResolution,
} from "../src/research/research-cycle-terminal.js"
import type { ResearchInvocationV1 } from "../src/research/research-invocation-v1.js"

const researchInvocation: ResearchInvocationV1 = {
  invocationVersion: "1.0.0",
  agentName: "research",
  cycleMode: "STANDARD",
  promptVersion: "1.3.0",
  skillName: "spy-debit-spread-research",
  skillVersion: "1.1.0",
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

const context = (record: ResearchCycleOutcomeSink["record"]) => ({
  sink: { record },
  signal: new AbortController().signal,
  researchInvocation,
  trace: NOOP_RESEARCH_CYCLE_TRACE,
  stages: createResearchCycleStageReports(),
})

describe("recordResearchCycleOutcome", () => {
  it("requires shadow risk for a derived intent", async () => {
    const record = vi.fn<ResearchCycleOutcomeSink["record"]>()
    const resolution = {
      outcome: {
        outcomeVersion: "1.0.0",
        status: "INTENT_DERIVED",
        decision: {},
        intent: {},
      },
      metadata: {},
    } as unknown as ResearchCycleTerminalResolution

    await expect(
      recordResearchCycleOutcome(resolution, context(record)),
    ).rejects.toThrow("Derived intent outcome requires shadow risk")
    expect(record).not.toHaveBeenCalled()
  })

  it("forbids shadow risk for a non-derived outcome", async () => {
    const record = vi.fn<ResearchCycleOutcomeSink["record"]>()
    const resolution = {
      outcome: {
        outcomeVersion: "1.0.0",
        status: "VALIDATED_NO_ACTION",
        decision: {
          contractVersion: "1.0.0",
          strategyVersion: "1.1.0",
          outcome: "NO_ACTION",
          reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
        },
      },
      metadata: { shadowRisk: {} as ShadowRiskResultV1 },
    } as unknown as ResearchCycleTerminalResolution

    await expect(
      recordResearchCycleOutcome(resolution, context(record)),
    ).rejects.toThrow("Shadow risk requires a derived intent outcome")
    expect(record).not.toHaveBeenCalled()
  })
})
