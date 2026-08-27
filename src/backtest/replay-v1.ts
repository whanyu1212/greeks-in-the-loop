import { z } from "zod"

import {
  tradeIntentV1Schema,
  type TradeIntentV1,
} from "../contracts/trade-intent-v1.js"
import {
  evaluateTradeIntentRiskV1,
  riskEvaluationInputV1Schema,
  type RiskEvaluationV1,
} from "../risk/risk-evaluation-v1.js"
import { newYorkDate, newYorkLocalTime } from "../scheduling/research-eligibility.js"
import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import {
  backtestDatasetManifestV1Schema,
  type BacktestDatasetRecordV1,
  type MarketSessionRecordV1,
  type OptionBarRecordV1,
  type UnderlyingBarRecordV1,
} from "./dataset-v1.js"

export const BACKTEST_REPLAY_VERSION = "1.0.0" as const
export const BACKTEST_EXECUTION_MODEL_VERSION = "1.0.0" as const
const INITIAL_EQUITY_CENTS = 10_000_000

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const nonnegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.iso.datetime({ offset: true, precision: 3 })
const instant = (value: string) => Date.parse(value)

const signalSnapshotSchema = z
  .object({
    sessionDate: z.iso.date(),
    observedAt: timestamp,
    precedingSessionDates: z.array(z.iso.date()).length(50),
    completedDailyBars: z
      .array(
        z
          .object({
            sessionDate: z.iso.date(),
            closeMicros: positiveSafeInteger,
          })
          .strict(),
      )
      .length(50),
    completedMinuteBars: z
      .array(
        z
          .object({
            startedAt: timestamp,
            vwapMicros: positiveSafeInteger,
            volume: positiveSafeInteger,
          })
          .strict(),
      )
      .min(1)
      .max(390),
    underlyingQuote: z
      .object({
        feed: z.literal("IEX"),
        providerTimestamp: timestamp,
        bidMicros: positiveSafeInteger,
        askMicros: positiveSafeInteger,
      })
      .strict(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.underlyingQuote.askMicros < snapshot.underlyingQuote.bidMicros) {
      context.addIssue({
        code: "custom",
        path: ["underlyingQuote", "askMicros"],
        message: "Underlying ask cannot be below bid",
      })
    }
    if (newYorkDate(new Date(snapshot.observedAt)) !== snapshot.sessionDate) {
      context.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: "Signal observation must belong to its New York session date",
      })
    }
    const quoteAge = instant(snapshot.observedAt) -
      instant(snapshot.underlyingQuote.providerTimestamp)
    if (
      quoteAge < 0 ||
      quoteAge > 60_000 ||
      newYorkDate(new Date(snapshot.underlyingQuote.providerTimestamp)) !== snapshot.sessionDate
    ) {
      context.addIssue({
        code: "custom",
        path: ["underlyingQuote", "providerTimestamp"],
        message: "Exact underlying IEX quote must be current-session and fresh",
      })
    }
    const sessionOpen = newYorkLocalTime(snapshot.sessionDate, "09:30").getTime()
    const expectedMinuteCount = Math.floor((instant(snapshot.observedAt) - sessionOpen) / 60_000)
    if (
      expectedMinuteCount < 1 ||
      expectedMinuteCount > 390 ||
      snapshot.completedMinuteBars.length !== expectedMinuteCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedMinuteBars"],
        message: "Signal snapshot must contain every completed regular-session minute",
      })
    }
    for (let index = 0; index < snapshot.completedMinuteBars.length; index += 1) {
      if (instant(snapshot.completedMinuteBars[index]!.startedAt) === sessionOpen + index * 60_000) {
        continue
      }
      context.addIssue({
        code: "custom",
        path: ["completedMinuteBars", index, "startedAt"],
        message: "Signal minute bars must be unique, complete, and chronological",
      })
    }
    for (let index = 0; index < snapshot.completedDailyBars.length; index += 1) {
      const date = snapshot.completedDailyBars[index]!.sessionDate
      const expectedDate = snapshot.precedingSessionDates[index]
      const previous = snapshot.precedingSessionDates[index - 1]
      if (
        date === expectedDate &&
        date < snapshot.sessionDate &&
        (previous === undefined || expectedDate! > previous)
      ) continue
      context.addIssue({
        code: "custom",
        path: ["completedDailyBars", index, "sessionDate"],
        message: "Signal daily bars must map one-to-one to 50 unique preceding sessions",
      })
    }
  })

const monitorCycleSchema = z
  .object({
    decidedAt: timestamp,
    marketOpen: z.boolean(),
    lateFill: z.boolean(),
    dte: z.number().int().min(0).max(365),
    minutesToClose: z.number().int().min(0).max(1_440),
    staleMinutes: z.number().int().min(0).max(1_440),
    markHalfCentsPerShare: nonnegativeSafeInteger.optional(),
    completedDailyCloseMicros: positiveSafeInteger.optional(),
    sma20Micros: positiveSafeInteger.optional(),
    holdingSessionIndex: z.number().int().min(1).max(365),
  })
  .strict()

const monitorCyclesSchema = z
  .array(monitorCycleSchema)
  .min(1)
  .max(10_000)
  .superRefine((cycles, context) => {
    for (let index = 1; index < cycles.length; index += 1) {
      if (instant(cycles[index]!.decidedAt) > instant(cycles[index - 1]!.decidedAt)) continue
      context.addIssue({
        code: "custom",
        path: [index, "decidedAt"],
        message: "Monitor cycle timestamps must be strictly increasing",
      })
    }
  })

const commonScenarioFields = {
  scenarioId: z.string().min(1).max(128),
} as const

const exactScenarioSchema = z
  .object({
    ...commonScenarioFields,
    monitorCycles: monitorCyclesSchema,
    fidelity: z.literal("EXACT_SNAPSHOT"),
    signal: signalSnapshotSchema,
    candidates: z.array(riskEvaluationInputV1Schema).min(1).max(10_000),
  })
  .strict()
  .superRefine((scenario, context) => {
    for (let index = 0; index < scenario.candidates.length; index += 1) {
      const eligibility = scenario.candidates[index]!.context.eligibility
      if (
        instant(scenario.candidates[index]!.intent.evaluatedAt) !== instant(scenario.signal.observedAt) ||
        eligibility.sessionDate !== scenario.signal.sessionDate
      ) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index],
          message: "Exact candidates must share the signal snapshot instant and session",
        })
      }
      const previousSessionDates = eligibility.previousSessionDates ?? []
      const retainedPreviousSessions = scenario.signal.completedDailyBars
        .slice(-previousSessionDates.length)
      for (let priorIndex = 0; priorIndex < previousSessionDates.length; priorIndex += 1) {
        if (
          retainedPreviousSessions[priorIndex]?.sessionDate === previousSessionDates[priorIndex]
        ) continue
        context.addIssue({
          code: "custom",
          path: ["signal", "completedDailyBars"],
          message: "Exact daily bars must match the application-owned preceding sessions",
        })
        break
      }
    }
  })

const proxyScenarioSchema = z
  .object({
    ...commonScenarioFields,
    monitorCycles: monitorCyclesSchema.optional(),
    fidelity: z.literal("HISTORICAL_BAR_PROXY"),
    retainedIntent: tradeIntentV1Schema,
  })
  .strict()

export const backtestReplayScenarioV1Schema = z.discriminatedUnion("fidelity", [
  exactScenarioSchema,
  proxyScenarioSchema,
])

export const backtestReplayInputV1Schema = z
  .object({
    replayVersion: z.literal(BACKTEST_REPLAY_VERSION),
    execution: z
      .object({
        modelVersion: z.literal(BACKTEST_EXECUTION_MODEL_VERSION),
        entrySlippageHalfCentsPerShare: nonnegativeSafeInteger,
        exitSlippageHalfCentsPerShare: nonnegativeSafeInteger,
        commissionCentsPerContract: nonnegativeSafeInteger,
      })
      .strict(),
    scenarios: z.array(backtestReplayScenarioV1Schema).min(1).max(10_000),
  })
  .strict()

export type BacktestReplayInputV1 = Readonly<z.infer<typeof backtestReplayInputV1Schema>>
export type BacktestSignalDirectionV1 = "BULLISH" | "BEARISH" | "NO_ACTION"
export type BacktestExitReasonV1 =
  | "LATE_FILL"
  | "EXPIRATION"
  | "STALE_DATA"
  | "STOP_LOSS"
  | "PROFIT_TARGET"
  | "TREND_INVALIDATION"
  | "MAX_HOLDING_PERIOD"
  | "END_OF_REPLAY"

const mean = (values: readonly number[]) =>
  values.reduce((total, value) => total + value, 0) / values.length

/** Replays the strategy's strict daily-regime and session-VWAP signal. */
export const evaluateBacktestSignalV1 = (
  input: z.infer<typeof signalSnapshotSchema>,
): Readonly<{
  direction: BacktestSignalDirectionV1
  dailyCloseMicros: number
  sma20Micros: number
  sma50Micros: number
  sessionVwapMicros: number
  spotMidpointMicros: number
}> => {
  const parsed = signalSnapshotSchema.parse(input)
  const dailyClosesMicros = parsed.completedDailyBars.map(({ closeMicros }) => closeMicros)
  const dailyCloseMicros = dailyClosesMicros.at(-1)!
  const last20 = dailyClosesMicros.slice(-20)
  const sma20Micros = mean(last20)
  const sma50Micros = mean(dailyClosesMicros)
  const volume = parsed.completedMinuteBars.reduce((total, bar) => total + bar.volume, 0)
  const weightedVwap = parsed.completedMinuteBars.reduce(
    (total, bar) => total + BigInt(bar.vwapMicros) * BigInt(bar.volume),
    0n,
  )
  const exactVolume = parsed.completedMinuteBars.reduce(
    (total, bar) => total + BigInt(bar.volume),
    0n,
  )
  const sessionVwapMicros = Number(weightedVwap) / volume
  const spotMidpointMicros =
    (parsed.underlyingQuote.bidMicros + parsed.underlyingQuote.askMicros) / 2
  const close = BigInt(dailyCloseMicros)
  const sum20 = last20.reduce((total, value) => total + BigInt(value), 0n)
  const sum50 = dailyClosesMicros.reduce(
    (total, value) => total + BigInt(value),
    0n,
  )
  const spotTwice = BigInt(parsed.underlyingQuote.bidMicros) +
    BigInt(parsed.underlyingQuote.askMicros)
  const direction =
    close * 20n > sum20 &&
    sum20 * 50n > sum50 * 20n &&
    spotTwice * exactVolume > weightedVwap * 2n
      ? "BULLISH"
      : close * 20n < sum20 &&
          sum20 * 50n < sum50 * 20n &&
          spotTwice * exactVolume < weightedVwap * 2n
        ? "BEARISH"
        : "NO_ACTION"
  return {
    direction,
    dailyCloseMicros,
    sma20Micros,
    sma50Micros,
    sessionVwapMicros,
    spotMidpointMicros,
  }
}

const daysBetween = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
  86_400_000

const candidateTuple = (input: z.infer<typeof riskEvaluationInputV1Schema>) => {
  const { intent, context } = input
  const long = context.contracts.legs.find(({ role }) => role === "LONG")!
  const short = context.contracts.legs.find(({ role }) => role === "SHORT")!
  return [
    Math.abs(daysBetween(context.eligibility.sessionDate!, intent.expiration) - 21),
    Math.abs(Math.abs(long.delta) - 0.5) + Math.abs(Math.abs(short.delta) - 0.3),
    intent.widthCentsPerShare,
    intent.expiration,
    intent.longContractSymbol,
    intent.shortContractSymbol,
  ] as const
}

const compareTuples = (left: readonly (number | string)[], right: readonly (number | string)[]) => {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (a < b) return -1
    if (a > b) return 1
  }
  return 0
}

const exitReason = (
  intent: TradeIntentV1,
  cycle: z.infer<typeof monitorCycleSchema>,
): BacktestExitReasonV1 | undefined => {
  if (!cycle.marketOpen) return undefined
  if (cycle.lateFill) return "LATE_FILL"
  if (
    (cycle.dte < 3 || (cycle.dte === 3 && cycle.minutesToClose <= 60))
  ) return "EXPIRATION"
  if (cycle.staleMinutes >= 5) return "STALE_DATA"
  if (
    cycle.markHalfCentsPerShare !== undefined &&
    cycle.markHalfCentsPerShare <= intent.stopLossMarkHalfCentsPerShare
  ) return "STOP_LOSS"
  if (
    cycle.markHalfCentsPerShare !== undefined &&
    cycle.markHalfCentsPerShare >= intent.profitTargetMarkHalfCentsPerShare
  ) return "PROFIT_TARGET"
  if (
    cycle.completedDailyCloseMicros !== undefined &&
    cycle.sma20Micros !== undefined &&
    (intent.direction === "BULLISH"
      ? cycle.completedDailyCloseMicros <= cycle.sma20Micros
      : cycle.completedDailyCloseMicros >= cycle.sma20Micros)
  ) return "TREND_INVALIDATION"
  if (
    (cycle.holdingSessionIndex > 5 ||
      (cycle.holdingSessionIndex === 5 && cycle.minutesToClose <= 30))
  ) return "MAX_HOLDING_PERIOD"
  return undefined
}

const sessionForTimestamp = (
  sessions: readonly MarketSessionRecordV1[],
  value: string,
) => sessions.find(({ open, close }) => instant(value) >= instant(open) && instant(value) <= instant(close))

const minuteBarCompletedAt = (timestamp: string) =>
  new Date(Date.parse(timestamp) + 60_000).toISOString()

/** Derives conservative proxy marks from synchronized option minute bars. */
export function deriveHistoricalBarProxyCyclesV1(
  records: readonly BacktestDatasetRecordV1[],
  intent: TradeIntentV1,
) {
  const sessions = records
    .filter((record): record is MarketSessionRecordV1 => record.recordType === "MARKET_SESSION")
    .sort((left, right) => instant(left.open) - instant(right.open))
  const dailyBars = records
    .filter(
      (record): record is UnderlyingBarRecordV1 =>
        record.recordType === "UNDERLYING_BAR" && record.timeframe === "1DAY",
    )
    .sort((left, right) => instant(left.timestamp) - instant(right.timestamp))
  const dailyBarsBySessionDate = new Map<string, UnderlyingBarRecordV1[]>()
  for (const bar of dailyBars) {
    const sessionDate = newYorkDate(new Date(bar.timestamp))
    const retained = dailyBarsBySessionDate.get(sessionDate) ?? []
    retained.push(bar)
    dailyBarsBySessionDate.set(sessionDate, retained)
  }
  const minuteBars = records.filter(
    (record): record is OptionBarRecordV1 =>
      record.recordType === "OPTION_BAR" && record.timeframe === "1MINUTE",
  )
  const shortByTimestamp = new Map(
    minuteBars
      .filter(({ contractSymbol }) => contractSymbol === intent.shortContractSymbol)
      .map((bar) => [instant(bar.timestamp), bar]),
  )
  const matchingEntrySession = sessions.findIndex(
    ({ open, close }) =>
      instant(intent.evaluatedAt) >= instant(open) && instant(intent.evaluatedAt) <= instant(close),
  )
  if (matchingEntrySession < 0) return []
  const entrySessionIndex = matchingEntrySession
  const cycles = minuteBars
    .filter(
      ({ contractSymbol, timestamp: value }) =>
        contractSymbol === intent.longContractSymbol && instant(value) >= instant(intent.evaluatedAt),
    )
    .flatMap((longBar) => {
      const shortBar = shortByTimestamp.get(instant(longBar.timestamp))
      const decidedAt = minuteBarCompletedAt(longBar.timestamp)
      const session = sessionForTimestamp(sessions, decidedAt)
      if (shortBar === undefined || session === undefined) return []
      const sessionIndex = sessions.indexOf(session)
      if (sessionIndex < entrySessionIndex) return []
      const trendBars = sessions
        .slice(0, sessionIndex)
        .slice(-20)
        .flatMap(({ date }) => {
          const bars = dailyBarsBySessionDate.get(date)
          return bars?.length === 1 ? bars : []
        })
      const spreadMicros = longBar.lowMicros - shortBar.highMicros
      const markHalfCentsPerShare = Math.min(
        intent.widthCentsPerShare * 2,
        Math.max(0, Math.floor(spreadMicros / 5_000)),
      )
      const completedDailyCloseMicros = trendBars.at(-1)?.closeMicros
      const sma20Micros =
        trendBars.length === 20
          ? mean(trendBars.map(({ closeMicros }) => closeMicros))
          : undefined
      return [{
        decidedAt,
        marketOpen: true,
        lateFill: false,
        dte: daysBetween(session.date, intent.expiration),
        minutesToClose: Math.max(
          0,
          Math.floor((Date.parse(session.close) - Date.parse(decidedAt)) / 60_000),
        ),
        staleMinutes: 0,
        markHalfCentsPerShare,
        ...(completedDailyCloseMicros === undefined || sma20Micros === undefined
          ? {}
          : { completedDailyCloseMicros, sma20Micros }),
        holdingSessionIndex: sessionIndex - entrySessionIndex + 1,
      }]
    })
    .sort((left, right) => instant(left.decidedAt) - instant(right.decidedAt))

  let previousCycle: (typeof cycles)[number] | undefined
  const observedCycles = cycles.map((cycle) => {
    const session = sessionForTimestamp(sessions, cycle.decidedAt)!
    const previousSession = previousCycle === undefined
      ? undefined
      : sessionForTimestamp(sessions, previousCycle.decidedAt)
    const unavailableSince = previousSession?.date === session.date
      ? previousCycle!.decidedAt
      : session.date === sessions[entrySessionIndex]!.date
        ? intent.evaluatedAt
        : session.open
    const staleMinutes = Math.max(
      0,
      Math.floor((Date.parse(cycle.decidedAt) - Date.parse(unavailableSince)) / 60_000),
    )
    previousCycle = cycle
    return { ...cycle, staleMinutes }
  })
  const lastCycle = observedCycles.at(-1)
  const lastSessionIndex = lastCycle === undefined
    ? entrySessionIndex
    : sessions.findIndex(({ date }) =>
        date === sessionForTimestamp(sessions, lastCycle.decidedAt)?.date)
  for (let sessionIndex = lastSessionIndex; sessionIndex < sessions.length; sessionIndex += 1) {
    const session = sessions[sessionIndex]!
    const unavailableSince = sessionIndex === lastSessionIndex
      ? lastCycle?.decidedAt ?? intent.evaluatedAt
      : session.open
    const staleAt = instant(unavailableSince) + 5 * 60_000
    if (staleAt > instant(session.close)) continue
    return [...observedCycles, {
      decidedAt: new Date(staleAt).toISOString(),
      marketOpen: true,
      lateFill: false,
      dte: daysBetween(session.date, intent.expiration),
      minutesToClose: Math.floor((instant(session.close) - staleAt) / 60_000),
      staleMinutes: 5,
      markHalfCentsPerShare: undefined,
      holdingSessionIndex: sessionIndex - entrySessionIndex + 1,
    }]
  }
  return observedCycles
}

type SelectedIntent = Readonly<{
  intent?: TradeIntentV1
  riskStatus: "APPROVED" | "REJECTED" | "NOT_EVALUABLE"
  riskEvaluations: readonly RiskEvaluationV1[]
  signalDirection: BacktestSignalDirectionV1 | "NOT_EVALUABLE"
}>

const selectIntent = (
  scenario: z.infer<typeof backtestReplayScenarioV1Schema>,
): SelectedIntent => {
  if (scenario.fidelity === "HISTORICAL_BAR_PROXY") {
    return {
      intent: scenario.retainedIntent,
      riskStatus: "NOT_EVALUABLE",
      riskEvaluations: [],
      signalDirection: "NOT_EVALUABLE",
    }
  }
  const signal = evaluateBacktestSignalV1(scenario.signal)
  const evaluated = scenario.candidates.map((input) => ({
    input,
    evaluation: evaluateTradeIntentRiskV1(input),
  }))
  const approved = evaluated
    .filter(
      (candidate) =>
        signal.direction !== "NO_ACTION" &&
        candidate.input.intent.direction === signal.direction &&
        candidate.evaluation.outcome === "APPROVED",
    )
    .sort((left, right) => compareTuples(candidateTuple(left.input), candidateTuple(right.input)))
  return {
    ...(approved[0] === undefined ? {} : { intent: approved[0].input.intent }),
    riskStatus: approved.length > 0 ? "APPROVED" : "REJECTED",
    riskEvaluations: evaluated.map(({ evaluation }) => evaluation),
    signalDirection: signal.direction,
  }
}

/** Runs a pure, deterministic replay. No broker or network capability is accepted. */
export function runBacktestReplayV1(
  manifestInput: unknown,
  replayInput: unknown,
  records: readonly BacktestDatasetRecordV1[] = [],
) {
  const manifest = backtestDatasetManifestV1Schema.parse(manifestInput)
  if (!manifest.complete) throw new Error("Backtest dataset must be complete")
  const replay = backtestReplayInputV1Schema.parse(replayInput)
  const scenarioResults = replay.scenarios.map((scenario) => {
    const selected = selectIntent(scenario)
    if (selected.intent === undefined) {
      return {
        scenarioId: scenario.scenarioId,
        fidelity: scenario.fidelity,
        signalDirection: selected.signalDirection,
        riskStatus: selected.riskStatus,
        riskEvaluations: selected.riskEvaluations,
        outcome: "NO_ENTRY" as const,
        pnlCents: 0,
      }
    }
    const monitorCycles =
      scenario.fidelity === "HISTORICAL_BAR_PROXY" && scenario.monitorCycles === undefined
        ? deriveHistoricalBarProxyCyclesV1(records, selected.intent)
        : scenario.monitorCycles!
    if (monitorCycles.length === 0) {
      throw new Error(`Scenario ${scenario.scenarioId} has no synchronized replay marks`)
    }
    if (monitorCycles.some(({ decidedAt }) => instant(decidedAt) < instant(selected.intent!.evaluatedAt))) {
      throw new Error(`Scenario ${scenario.scenarioId} has a monitor cycle before intent evaluation`)
    }
    if (monitorCycles.some(({ markHalfCentsPerShare }) =>
      markHalfCentsPerShare !== undefined &&
      markHalfCentsPerShare > selected.intent!.widthCentsPerShare * 2)) {
      throw new Error(`Scenario ${scenario.scenarioId} has a mark above the spread width`)
    }
    const triggered = monitorCycles.find((cycle) => exitReason(selected.intent!, cycle))
    const finalCycle = triggered ?? monitorCycles.at(-1)!
    const reason = triggered === undefined ? "END_OF_REPLAY" : exitReason(selected.intent, triggered)!
    const entryMark = selected.intent.entryLimitCentsPerShare * 2
    if (finalCycle.markHalfCentsPerShare === undefined) {
      return {
        scenarioId: scenario.scenarioId,
        fidelity: scenario.fidelity,
        signalDirection: selected.signalDirection,
        riskStatus: selected.riskStatus,
        riskEvaluations: selected.riskEvaluations,
        outcome: "EXIT_UNPRICED" as const,
        intent: selected.intent,
        exitReason: reason,
        exitDecidedAt: finalCycle.decidedAt,
        entryFillHalfCentsPerShare: entryMark,
        pnlCents: null,
      }
    }
    const exitMark = Math.max(
      0,
      finalCycle.markHalfCentsPerShare - replay.execution.exitSlippageHalfCentsPerShare,
    )
    const pnlCents =
      (exitMark - entryMark) * 50 -
      replay.execution.entrySlippageHalfCentsPerShare * 50 -
      replay.execution.commissionCentsPerContract * 4
    return {
      scenarioId: scenario.scenarioId,
      fidelity: scenario.fidelity,
      signalDirection: selected.signalDirection,
      riskStatus: selected.riskStatus,
      riskEvaluations: selected.riskEvaluations,
      outcome: "CLOSED" as const,
      intent: selected.intent,
      exitReason: reason,
      exitDecidedAt: finalCycle.decidedAt,
      entryFillHalfCentsPerShare: entryMark,
      exitFillHalfCentsPerShare: exitMark,
      pnlCents,
    }
  })
  const entered = scenarioResults.filter((result) => result.outcome !== "NO_ENTRY")
  const closed = scenarioResults.filter((result) => result.outcome === "CLOSED")
  const totalPnlCents = scenarioResults.reduce(
    (total, result) => total + (result.pnlCents ?? 0),
    0,
  )
  let equityCents = INITIAL_EQUITY_CENTS
  let peakEquityCents = equityCents
  let maxDrawdownCents = 0
  for (const result of scenarioResults) {
    equityCents += result.pnlCents ?? 0
    peakEquityCents = Math.max(peakEquityCents, equityCents)
    maxDrawdownCents = Math.max(maxDrawdownCents, peakEquityCents - equityCents)
  }
  const riskRejectionCounts: Record<string, number> = {}
  for (const result of scenarioResults) {
    for (const evaluation of result.riskEvaluations) {
      if (evaluation.outcome !== "REJECTED") continue
      for (const reason of evaluation.reasonCodes) {
        riskRejectionCounts[reason] = (riskRejectionCounts[reason] ?? 0) + 1
      }
    }
  }
  const reportWithoutChecksum = {
    replayVersion: BACKTEST_REPLAY_VERSION,
    executionModelVersion: BACKTEST_EXECUTION_MODEL_VERSION,
    datasetId: manifest.definition.datasetId,
    datasetChecksum: manifest.checksum,
    scenarioCount: scenarioResults.length,
    tradeCount: entered.length,
    pricedTradeCount: closed.length,
    unpricedExitCount: scenarioResults.filter(
      ({ outcome }) => outcome === "EXIT_UNPRICED",
    ).length,
    exactScenarioCount: scenarioResults.filter(({ fidelity }) => fidelity === "EXACT_SNAPSHOT").length,
    proxyScenarioCount: scenarioResults.filter(({ fidelity }) => fidelity === "HISTORICAL_BAR_PROXY").length,
    initialEquityCents: INITIAL_EQUITY_CENTS,
    finalEquityCents: equityCents,
    totalPnlCents,
    returnBps: Math.trunc((totalPnlCents * 10_000) / INITIAL_EQUITY_CENTS),
    maxDrawdownCents,
    hitRateBps:
      closed.length === 0
        ? 0
        : Math.floor((closed.filter(({ pnlCents }) => pnlCents > 0).length * 10_000) / closed.length),
    riskRejectionCounts,
    results: scenarioResults,
  }
  return {
    ...reportWithoutChecksum,
    checksum: canonicalJsonSha256(reportWithoutChecksum),
  }
}
