import { z } from "zod"

import {
  evaluateTradeIntentRiskV1,
  riskEvaluationInputV1Schema,
} from "../risk/risk-evaluation-v1.js"
import {
  aggregateReplayCents,
  replayExecutionSchema,
  replayMonitorCyclesSchema,
  simulateReplayScenario,
} from "./replay-core.js"

export const BACKTEST_REPLAY_VERSION = "3.0.0" as const

const scenarioSchema = z
  .object({
    scenarioId: z.string().trim().min(1).max(128),
    riskInput: riskEvaluationInputV1Schema,
    monitorCycles: replayMonitorCyclesSchema,
  })
  .strict()
  .superRefine(({ riskInput, monitorCycles }, context) => {
    const evaluatedAt = Date.parse(riskInput.intent.evaluatedAt)
    const maximumMark = riskInput.intent.widthCentsPerShare * 2
    monitorCycles.forEach((cycle, index) => {
      if (Date.parse(cycle.decidedAt) < evaluatedAt) {
        context.addIssue({
          code: "custom",
          path: ["monitorCycles", index, "decidedAt"],
          message: "Monitor cycles cannot predate intent evaluation",
        })
      }
      if (
        cycle.markHalfCentsPerShare !== undefined &&
        cycle.markHalfCentsPerShare > maximumMark
      ) {
        context.addIssue({
          code: "custom",
          path: ["monitorCycles", index, "markHalfCentsPerShare"],
          message: "Monitor marks cannot exceed the spread width",
        })
      }
    })
  })

const replayInputSchema = z
  .object({
    replayVersion: z.literal(BACKTEST_REPLAY_VERSION),
    initialEquityCents: z.number().int().positive().safe(),
    execution: replayExecutionSchema,
    scenarios: z.array(scenarioSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine(({ scenarios }, context) => {
    const scenarioIds = new Set<string>()
    scenarios.forEach(({ scenarioId }, index) => {
      if (scenarioIds.has(scenarioId)) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", index, "scenarioId"],
          message: "Replay scenario IDs must be unique",
        })
      }
      scenarioIds.add(scenarioId)
    })
  })

export function runBacktestReplay(input: unknown) {
  const replay = replayInputSchema.parse(input)
  const scenarios = replay.scenarios.map((scenario) => {
    const risk = evaluateTradeIntentRiskV1(scenario.riskInput)
    const simulation = risk.outcome === "APPROVED"
      ? simulateReplayScenario(
          scenario.riskInput.intent,
          scenario.monitorCycles,
          replay.execution,
        )
      : null
    return { scenarioId: scenario.scenarioId, risk, simulation }
  })
  return {
    replayVersion: BACKTEST_REPLAY_VERSION,
    scenarios,
    aggregate: aggregateReplayCents(
      replay.initialEquityCents,
      scenarios.map(({ simulation }) => simulation?.pnlCents ?? null),
    ),
  }
}
