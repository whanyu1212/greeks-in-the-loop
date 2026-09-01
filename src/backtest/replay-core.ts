import { z } from "zod"

import type { TradeIntentV3 } from "../contracts/trade-intent-v3.js"

const nonnegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const instant = (value: string) => Date.parse(value)
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER)

const safeIntegerToBigInt = (value: number, label: string): bigint => {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`)
  return BigInt(value)
}

const bigintToSafeInteger = (value: bigint, label: string): number => {
  if (value < MIN_SAFE_INTEGER_BIGINT || value > MAX_SAFE_INTEGER_BIGINT) {
    throw new Error(`${label} exceeds the safe integer range`)
  }
  return Number(value)
}

export const replayMonitorCycleSchema = z
  .object({
    decidedAt: timestamp,
    marketOpen: z.boolean(),
    lateFill: z.boolean(),
    dte: z.number().int().min(0).max(365),
    minutesToClose: z.number().int().min(0).max(1_440),
    staleMinutes: z.number().int().min(0).max(1_440),
    markHalfCentsPerShare: nonnegativeSafeInteger.optional(),
    completedDailyCloseMicros: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    sma20Micros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    holdingSessionIndex: z.number().int().min(1).max(365),
  })
  .strict()

export const replayMonitorCyclesSchema = z
  .array(replayMonitorCycleSchema)
  .min(1)
  .max(10_000)
  .superRefine((cycles, context) => {
    let lateFillLatched = false
    for (let index = 0; index < cycles.length; index += 1) {
      if (lateFillLatched && !cycles[index]!.lateFill) {
        context.addIssue({
          code: "custom",
          path: [index, "lateFill"],
          message: "Late-fill protection must remain latched across monitor cycles",
        })
      }
      lateFillLatched ||= cycles[index]!.lateFill
    }
    for (let index = 1; index < cycles.length; index += 1) {
      if (instant(cycles[index]!.decidedAt) > instant(cycles[index - 1]!.decidedAt)) continue
      context.addIssue({
        code: "custom",
        path: [index, "decidedAt"],
        message: "Monitor cycle timestamps must be strictly increasing",
      })
    }
  })

export type ReplayMonitorCycle = Readonly<z.infer<typeof replayMonitorCycleSchema>>
export type ReplayExitReason =
  | "LATE_FILL"
  | "EXPIRATION"
  | "STALE_DATA"
  | "STOP_LOSS"
  | "PROFIT_TARGET"
  | "TREND_INVALIDATION"
  | "MAX_HOLDING_PERIOD"
  | "END_OF_REPLAY"
export type ReplayExecution = Readonly<{
  entrySlippageHalfCentsPerShare: number
  exitSlippageHalfCentsPerShare: number
  commissionCentsPerContract: number
}>

export const replayExecutionSchema = z
  .object({
    entrySlippageHalfCentsPerShare: nonnegativeSafeInteger,
    exitSlippageHalfCentsPerShare: nonnegativeSafeInteger,
    commissionCentsPerContract: nonnegativeSafeInteger,
  })
  .strict()

const exitReason = (
  intent: TradeIntentV3,
  cycle: ReplayMonitorCycle,
): ReplayExitReason | undefined => {
  if (!cycle.marketOpen) return undefined
  if (cycle.lateFill) return "LATE_FILL"
  if (cycle.dte < 3 || (cycle.dte === 3 && cycle.minutesToClose <= 60)) {
    return "EXPIRATION"
  }
  if (cycle.staleMinutes >= 5) return "STALE_DATA"
  if (
    cycle.markHalfCentsPerShare !== undefined &&
    cycle.markHalfCentsPerShare <= intent.stopLossMarkHalfCentsPerShare
  ) {
    return "STOP_LOSS"
  }
  if (
    cycle.markHalfCentsPerShare !== undefined &&
    cycle.markHalfCentsPerShare >= intent.profitTargetMarkHalfCentsPerShare
  ) {
    return "PROFIT_TARGET"
  }
  if (
    cycle.completedDailyCloseMicros !== undefined &&
    cycle.sma20Micros !== undefined &&
    (intent.direction === "BULLISH"
      ? cycle.completedDailyCloseMicros <= cycle.sma20Micros
      : cycle.completedDailyCloseMicros >= cycle.sma20Micros)
  ) {
    return "TREND_INVALIDATION"
  }
  if (
    cycle.holdingSessionIndex > 5 ||
    (cycle.holdingSessionIndex === 5 && cycle.minutesToClose <= 30)
  ) {
    return "MAX_HOLDING_PERIOD"
  }
  return undefined
}

export type ReplayScenarioSimulation =
  | Readonly<{
      outcome: "EXIT_UNPRICED"
      exitReason: ReplayExitReason
      exitDecidedAt: string
      entryFillHalfCentsPerShare: number
      pnlCents: null
    }>
  | Readonly<{
      outcome: "CLOSED"
      exitReason: ReplayExitReason
      exitDecidedAt: string
      entryFillHalfCentsPerShare: number
      exitFillHalfCentsPerShare: number
      pnlCents: number
    }>

/** Applies the frozen monitor priority and execution model to one entered spread. */
export function simulateReplayScenario(
  intent: TradeIntentV3,
  monitorCycles: readonly ReplayMonitorCycle[],
  execution: ReplayExecution,
): ReplayScenarioSimulation {
  const triggered = monitorCycles.find((cycle) => exitReason(intent, cycle))
  const finalCycle =
    triggered ??
    monitorCycles.filter(({ marketOpen }) => marketOpen).at(-1) ??
    { ...monitorCycles.at(-1)!, markHalfCentsPerShare: undefined }
  const reason =
    triggered === undefined ? "END_OF_REPLAY" : exitReason(intent, triggered)!
  const entryMark = safeIntegerToBigInt(
    intent.entryLimitCentsPerShare,
    "Replay entry mark",
  ) * 2n
  if (finalCycle.markHalfCentsPerShare === undefined) {
    return {
      outcome: "EXIT_UNPRICED",
      exitReason: reason,
      exitDecidedAt: finalCycle.decidedAt,
      entryFillHalfCentsPerShare: bigintToSafeInteger(entryMark, "Replay entry fill"),
      pnlCents: null,
    }
  }
  const exitMark = safeIntegerToBigInt(
    finalCycle.markHalfCentsPerShare,
    "Replay exit mark",
  ) - safeIntegerToBigInt(
    execution.exitSlippageHalfCentsPerShare,
    "Replay exit slippage",
  )
  const fill = exitMark > 0n ? exitMark : 0n
  const pnlCents =
    (fill - entryMark) * 50n -
    safeIntegerToBigInt(
      execution.entrySlippageHalfCentsPerShare,
      "Replay entry slippage",
    ) * 50n -
    safeIntegerToBigInt(
      execution.commissionCentsPerContract,
      "Replay commission",
    ) * 4n
  return {
    outcome: "CLOSED",
    exitReason: reason,
    exitDecidedAt: finalCycle.decidedAt,
    entryFillHalfCentsPerShare: bigintToSafeInteger(entryMark, "Replay entry fill"),
    exitFillHalfCentsPerShare: bigintToSafeInteger(fill, "Replay exit fill"),
    pnlCents: bigintToSafeInteger(pnlCents, "Replay P&L"),
  }
}

/** Aggregates replay cents without allowing number arithmetic to round money. */
export function aggregateReplayCents(
  initialEquityCents: number,
  pnlCents: readonly (number | null)[],
) {
  const initialEquity = safeIntegerToBigInt(
    initialEquityCents,
    "Replay initial equity",
  )
  if (initialEquity <= 0n) throw new Error("Replay initial equity must be positive")
  let totalPnl = 0n
  let equity = initialEquity
  let peakEquity = equity
  let maxDrawdown = 0n
  for (const pnl of pnlCents) {
    const value = safeIntegerToBigInt(pnl ?? 0, "Replay P&L")
    totalPnl += value
    equity += value
    if (equity > peakEquity) peakEquity = equity
    const drawdown = peakEquity - equity
    if (drawdown > maxDrawdown) maxDrawdown = drawdown
  }
  return {
    totalPnlCents: bigintToSafeInteger(totalPnl, "Replay total P&L"),
    finalEquityCents: bigintToSafeInteger(equity, "Replay final equity"),
    returnBps: bigintToSafeInteger(
      (totalPnl * 10_000n) / initialEquity,
      "Replay return",
    ),
    maxDrawdownCents: bigintToSafeInteger(maxDrawdown, "Replay maximum drawdown"),
  }
}
