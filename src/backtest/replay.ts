import { z } from "zod"

import {
  evaluateTradeIntentRiskV1,
  riskEvaluationInputV1Schema,
} from "../risk/risk-evaluation-v1.js"
import { newYorkDate } from "../scheduling/research-eligibility.js"
import {
  aggregateReplayCents,
  replayExecutionSchema,
  replayMonitorCyclesSchema,
  simulateReplayScenario,
} from "./replay-core.js"

export const BACKTEST_REPLAY_VERSION = "4.0.0" as const

const replaySessionDatesSchema = z
  .array(z.iso.date())
  .min(1)
  .max(10_000)
  .superRefine((dates, context) => {
    for (let index = 1; index < dates.length; index += 1) {
      if (dates[index]! > dates[index - 1]!) continue
      context.addIssue({
        code: "custom",
        path: [index],
        message: "Replay session dates must be strictly increasing",
      })
    }
  })

const scenarioSchema = z
  .object({
    scenarioId: z.string().trim().min(1).max(128),
    riskInput: riskEvaluationInputV1Schema,
    monitorCycles: replayMonitorCyclesSchema,
  })
  .strict()
  .superRefine(({ riskInput, monitorCycles }, context) => {
    const evaluatedAt = Date.parse(riskInput.intent.evaluatedAt)
    const expirationDay = Date.parse(
      `${riskInput.intent.expiration}T00:00:00.000Z`,
    )
    const maximumMark = riskInput.intent.widthCentsPerShare * 2
    monitorCycles.forEach((cycle, index) => {
      if (Date.parse(cycle.decidedAt) < evaluatedAt) {
        context.addIssue({
          code: "custom",
          path: ["monitorCycles", index, "decidedAt"],
          message: "Monitor cycles cannot predate intent evaluation",
        })
      }
      const cycleDay = Date.parse(
        `${newYorkDate(new Date(cycle.decidedAt))}T00:00:00.000Z`,
      )
      if (cycle.dte !== (expirationDay - cycleDay) / 86_400_000) {
        context.addIssue({
          code: "custom",
          path: ["monitorCycles", index, "dte"],
          message: "Monitor cycle DTE must match its decision date and expiration",
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
    sessionDates: replaySessionDatesSchema,
    scenarios: z.array(scenarioSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine(({ scenarios, sessionDates }, context) => {
    const scenarioIds = new Set<string>()
    scenarios.forEach(({ scenarioId, riskInput, monitorCycles }, index) => {
      if (scenarioIds.has(scenarioId)) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", index, "scenarioId"],
          message: "Replay scenario IDs must be unique",
        })
      }
      scenarioIds.add(scenarioId)

      const entrySessionIndex = sessionDates.indexOf(
        newYorkDate(new Date(riskInput.intent.evaluatedAt)),
      )
      monitorCycles.forEach((cycle, cycleIndex) => {
        const cycleSessionIndex = sessionDates.indexOf(
          newYorkDate(new Date(cycle.decidedAt)),
        )
        if (
          entrySessionIndex >= 0 &&
          cycleSessionIndex >= entrySessionIndex &&
          cycle.holdingSessionIndex === cycleSessionIndex - entrySessionIndex + 1
        ) return
        context.addIssue({
          code: "custom",
          path: ["scenarios", index, "monitorCycles", cycleIndex, "holdingSessionIndex"],
          message: "Monitor cycle holding-session index must match the replay calendar",
        })
      })
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
  const hasUnpricedExit = scenarios.some(
    ({ simulation }) => simulation?.outcome === "EXIT_UNPRICED",
  )
  return {
    replayVersion: BACKTEST_REPLAY_VERSION,
    scenarios,
    aggregate: hasUnpricedExit
      ? { status: "INCOMPLETE" as const, reason: "UNPRICED_EXIT" as const }
      : {
          status: "COMPLETE" as const,
          ...aggregateReplayCents(
            replay.initialEquityCents,
            scenarios.map(({ simulation }) => simulation?.pnlCents ?? null),
          ),
        },
  }
}
