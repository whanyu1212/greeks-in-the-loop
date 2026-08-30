import { z } from "zod"

import {
  aggregateReplayCents,
  replayMonitorCyclesSchema,
  simulateReplayScenario,
  type ReplayExitReason,
  type ReplayMonitorCycle,
} from "./replay-core.js"
import {
  tradeIntentV1Schema,
  type TradeIntentV1,
} from "../contracts/trade-intent-v1.js"
import type { ResearchSnapshotStrategyManifestV1 } from "../contracts/research-market-snapshot-v1.js"
import {
  evaluateTradeIntentRiskV1,
  RISK_EVALUATION_VERSION,
  RISK_RULE_VERSION,
  riskEvaluationInputV1Schema,
  type RiskEvaluationV1,
} from "../risk/risk-evaluation-v1.js"
import { newYorkDate, newYorkLocalTime } from "../scheduling/research-eligibility.js"
import { canonicalJson, canonicalJsonSha256 } from "../shared/canonical-json.js"
import { parseAlpacaOptionSymbol } from "../shared/alpaca-option-identity.js"
import {
  calculateDirectionalTrendFeaturesV1,
  compareDebitVerticalCandidateRanksV1,
  createDebitVerticalCandidateRankV1,
  DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
  DEBIT_VERTICAL_CANDIDATE_VERSION,
  DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
  DIRECTIONAL_TREND_FEATURE_VERSION,
} from "../strategy/directional-debit-vertical-v1.js"
import {
  BACKTEST_DATASET_VERSION,
  BACKTEST_NORMALIZATION_VERSION,
} from "./dataset-v1.js"
import {
  BACKTEST_EXECUTION_MODEL_VERSION,
  BACKTEST_REPLAY_VERSION,
} from "./replay-identity.js"
import {
  decodeBacktestDatasetManifest,
  isBacktestDatasetDefinitionV2,
  parseBacktestDatasetRecord,
  type BacktestDatasetRecord,
  type MarketSessionRecord,
  type OptionBarRecord,
  type UnderlyingBarRecord,
} from "./dataset.js"
export {
  BACKTEST_EXECUTION_MODEL_VERSION,
  BACKTEST_REPLAY_VERSION,
} from "./replay-identity.js"

const INITIAL_EQUITY_CENTS = 10_000_000

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key as keyof T])
  }
  return Object.freeze(value)
}

/** Immutable #83-era manifest admitted by retained Replay V1 only. */
export const RETAINED_REPLAY_V1_STRATEGY_MANIFEST = deepFreeze({
  manifestVersion: "1.0.0",
  strategyId: "spy-directional-debit-vertical",
  strategyVersion: "1.1.0",
  underlying: "SPY",
  components: {
    universePolicy: {
      componentId: "validateSpyOptionUniverseV1",
      componentVersion: "1.0.0",
    },
    featureCalculation: {
      componentId: "spy-debit-spread-research",
      componentVersion: "1.2.0",
      authority: "RESEARCH_SKILL_POLICY",
    },
    candidateGenerationRanking: {
      componentId: "spy-debit-spread-research",
      componentVersion: "1.2.0",
      authority: "RESEARCH_SKILL_POLICY",
    },
    intentDerivation: {
      componentId: "deriveTradeIntentV1",
      componentVersion: "1.0.0",
    },
    riskRule: {
      componentId: "evaluateTradeIntentRiskV1",
      componentVersion: "1.0.0",
      evaluationVersion: "1.0.0",
    },
    exitPolicy: {
      componentId: "runBacktestReplayV1",
      componentVersion: "1.0.0",
      availability: "REPLAY_ONLY",
    },
  },
  researchPlanCompatibility: {
    kind: "LEGACY_RESEARCH_INVOCATION_V1",
    invocationVersion: "1.3.0",
    agentName: "research",
    promptVersion: "1.4.1",
    skillName: "spy-debit-spread-research",
    skillVersion: "1.2.0",
    decisionContractVersion: "1.0.0",
    reportVersion: "2.0.0",
  },
  replayCompatibility: {
    kind: "BACKTEST_REPLAY_V1",
    replayVersion: "1.0.0",
    executionModelVersion: "1.0.0",
    datasetVersion: "1.0.0",
    normalizationVersion: "1.0.0",
  },
} as const satisfies ResearchSnapshotStrategyManifestV1)

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
            feed: z.literal("IEX"),
            adjustment: z.literal("all"),
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
            feed: z.literal("IEX"),
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

const commonScenarioFields = {
  scenarioId: z.string().min(1).max(128),
} as const

const exactScenarioSchema = z
  .object({
    ...commonScenarioFields,
    monitorCycles: replayMonitorCyclesSchema,
    fidelity: z.literal("EXACT_SNAPSHOT"),
    signal: signalSnapshotSchema,
    candidates: z.array(riskEvaluationInputV1Schema).min(1).max(10_000),
  })
  .strict()
  .superRefine((scenario, context) => {
    const sharedApprovalContext = canonicalJson({
      eligibility: scenario.candidates[0]!.context.eligibility,
      account: scenario.candidates[0]!.context.account,
      portfolio: scenario.candidates[0]!.context.portfolio,
    })
    for (let index = 0; index < scenario.candidates.length; index += 1) {
      const candidate = scenario.candidates[index]!
      const eligibility = candidate.context.eligibility
      if (canonicalJson({
        eligibility,
        account: candidate.context.account,
        portfolio: candidate.context.portfolio,
      }) !== sharedApprovalContext) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "context"],
          message: "Exact candidates must share one application approval context",
        })
      }
      if (
        instant(candidate.intent.evaluatedAt) !== instant(scenario.signal.observedAt) ||
        eligibility.sessionDate !== scenario.signal.sessionDate
      ) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index],
          message: "Exact candidates must share the signal snapshot instant and session",
        })
      }
      const approvalQuoteAge = instant(eligibility.evaluatedAt) -
        instant(scenario.signal.underlyingQuote.providerTimestamp)
      if (approvalQuoteAge < 0 || approvalQuoteAge > 60_000) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "context", "eligibility", "evaluatedAt"],
          message: "Exact underlying IEX quote must remain fresh at candidate approval",
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
    monitorCycles: replayMonitorCyclesSchema.optional(),
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
export type BacktestExitReasonV1 = ReplayExitReason

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
  const result = calculateDirectionalTrendFeaturesV1({
    completedDailyClosesMicrosPerShare: parsed.completedDailyBars.map(
      ({ closeMicros }) => closeMicros,
    ),
    completedMinuteBars: parsed.completedMinuteBars.map(
      ({ vwapMicros, volume }) => ({
        vwapMicrosPerShare: vwapMicros,
        volume,
      }),
    ),
    underlyingBidMicrosPerShare: parsed.underlyingQuote.bidMicros,
    underlyingAskMicrosPerShare: parsed.underlyingQuote.askMicros,
  })
  if (!result.success) throw new Error("Backtest signal input is invalid")
  const { features } = result
  return {
    direction: features.direction,
    dailyCloseMicros: features.dailyCloseMicrosPerShare,
    sma20Micros:
      Number(features.sma20.numeratorMicrosPerShare) /
      features.sma20.denominator,
    sma50Micros:
      Number(features.sma50.numeratorMicrosPerShare) /
      features.sma50.denominator,
    sessionVwapMicros:
      Number(features.sessionVwap.numeratorMicrosVolume) /
      Number(features.sessionVwap.denominatorVolume),
    spotMidpointMicros:
      Number(features.underlyingMidpoint.numeratorMicrosPerShare) /
      features.underlyingMidpoint.denominator,
  }
}

const daysBetween = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
  86_400_000

const exactReplayDeltaMillionths = (delta: number) => {
  const scaled = delta * 1_000_000
  const normalized = Math.round(scaled)
  if (
    !Number.isSafeInteger(normalized) ||
    Math.abs(scaled - normalized) > 1e-6
  ) {
    throw new Error("Exact replay candidate deltas require six-decimal precision")
  }
  return normalized
}

const candidateTuple = (input: z.infer<typeof riskEvaluationInputV1Schema>) => {
  const { intent, context } = input
  const long = context.contracts.legs.find(({ role }) => role === "LONG")!
  const short = context.contracts.legs.find(({ role }) => role === "SHORT")!
  return createDebitVerticalCandidateRankV1({
    dte: daysBetween(context.eligibility.sessionDate!, intent.expiration),
    longDeltaMillionths: exactReplayDeltaMillionths(long.delta),
    shortDeltaMillionths: exactReplayDeltaMillionths(short.delta),
    widthCentsPerShare: intent.widthCentsPerShare,
    expirationDate: intent.expiration,
    longContractSymbol: intent.longContractSymbol,
    shortContractSymbol: intent.shortContractSymbol,
  })
}

const sessionForTimestamp = (
  sessions: readonly MarketSessionRecord[],
  value: string,
) => sessions.find(({ open, close }) => instant(value) >= instant(open) && instant(value) <= instant(close))

const minuteBarCompletedAt = (timestamp: string) =>
  new Date(Date.parse(timestamp) + 60_000).toISOString()

/** Derives conservative proxy marks from synchronized option minute bars. */
export function deriveHistoricalBarProxyCyclesV1(
  records: readonly BacktestDatasetRecord[],
  intent: TradeIntentV1,
) {
  const sessions = records
    .filter((record): record is MarketSessionRecord => record.recordType === "MARKET_SESSION")
    .sort((left, right) => instant(left.open) - instant(right.open))
  const dailyBars = records
    .filter(
      (record): record is UnderlyingBarRecord =>
        record.recordType === "UNDERLYING_BAR" && record.timeframe === "1DAY",
    )
    .sort((left, right) => instant(left.timestamp) - instant(right.timestamp))
  const dailyBarsBySessionDate = new Map<string, UnderlyingBarRecord[]>()
  for (const bar of dailyBars) {
    const sessionDate = newYorkDate(new Date(bar.timestamp))
    const retained = dailyBarsBySessionDate.get(sessionDate) ?? []
    retained.push(bar)
    dailyBarsBySessionDate.set(sessionDate, retained)
  }
  const minuteBars = records.filter(
    (record): record is OptionBarRecord =>
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
        contractSymbol === intent.longContractSymbol &&
        instant(minuteBarCompletedAt(value)) >= instant(intent.evaluatedAt),
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

  let previousCycle: ReplayMonitorCycle | undefined
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

/** Applies the retained-calendar checks shared by explicit and proxy monitor cycles. */
export function validateReplayMonitorCyclesV1(
  records: readonly BacktestDatasetRecord[],
  scenarioId: string,
  intent: TradeIntentV1,
  monitorCycles: readonly ReplayMonitorCycle[],
  explicitlySupplied: boolean,
): void {
  if (monitorCycles.length === 0) {
    throw new Error(`Scenario ${scenarioId} has no synchronized replay marks`)
  }
  if (monitorCycles.some(({ decidedAt }) => instant(decidedAt) < instant(intent.evaluatedAt))) {
    throw new Error(`Scenario ${scenarioId} has a monitor cycle before intent evaluation`)
  }
  const sessions = records
    .filter((record): record is MarketSessionRecord => record.recordType === "MARKET_SESSION")
    .sort((left, right) => instant(left.open) - instant(right.open))
  if (explicitlySupplied) {
    const entrySessionIndex = sessions.findIndex(({ open, close }) =>
      instant(intent.evaluatedAt) >= instant(open) && instant(intent.evaluatedAt) <= instant(close))
    if (entrySessionIndex < 0) {
      throw new Error(`Scenario ${scenarioId} entry session is absent from the replay calendar`)
    }
    if (monitorCycles.some(({ decidedAt, holdingSessionIndex }) => {
      const cycleSessionIndex = sessions.findIndex(
        ({ date }) => date === newYorkDate(new Date(decidedAt)),
      )
      return cycleSessionIndex < entrySessionIndex ||
        holdingSessionIndex !== cycleSessionIndex - entrySessionIndex + 1
    })) {
      throw new Error(`Scenario ${scenarioId} has an incorrect holding session index`)
    }
    if (monitorCycles.some(({ decidedAt, minutesToClose }) => {
      const session = sessions.find(
        ({ date }) => date === newYorkDate(new Date(decidedAt)),
      )
      return session === undefined || minutesToClose !== Math.max(
        0,
        Math.floor((instant(session.close) - instant(decidedAt)) / 60_000),
      )
    })) {
      throw new Error(`Scenario ${scenarioId} has incorrect minutes to session close`)
    }
    if (monitorCycles.some(({ decidedAt, marketOpen }) => {
      if (!marketOpen) return false
      const session = sessions.find(
        ({ date }) => date === newYorkDate(new Date(decidedAt)),
      )!
      return instant(decidedAt) < instant(session.open) ||
        instant(decidedAt) > instant(session.close)
    })) {
      throw new Error(`Scenario ${scenarioId} has an open cycle outside session hours`)
    }
    const dailyBarsBySessionDate = new Map<string, UnderlyingBarRecord[]>()
    for (const record of records) {
      if (record.recordType !== "UNDERLYING_BAR" || record.timeframe !== "1DAY") continue
      const date = newYorkDate(new Date(record.timestamp))
      const retained = dailyBarsBySessionDate.get(date) ?? []
      retained.push(record)
      dailyBarsBySessionDate.set(date, retained)
    }
    if (monitorCycles.some((cycle) => {
      const hasClose = cycle.completedDailyCloseMicros !== undefined
      const hasSma = cycle.sma20Micros !== undefined
      if (!hasClose && !hasSma) return false
      if (!hasClose || !hasSma) return true
      const cycleSessionIndex = sessions.findIndex(
        ({ date }) => date === newYorkDate(new Date(cycle.decidedAt)),
      )
      const trendBars = sessions
        .slice(0, cycleSessionIndex)
        .slice(-20)
        .flatMap(({ date }) => {
          const bars = dailyBarsBySessionDate.get(date)
          return bars?.length === 1 ? bars : []
        })
      return trendBars.length !== 20 ||
        cycle.completedDailyCloseMicros !== trendBars.at(-1)!.closeMicros ||
        cycle.sma20Micros !== mean(trendBars.map(({ closeMicros }) => closeMicros))
    })) {
      throw new Error(`Scenario ${scenarioId} has invalid trend evidence`)
    }
  }
  if (monitorCycles.some(({ decidedAt, dte }) =>
    dte !== daysBetween(newYorkDate(new Date(decidedAt)), intent.expiration))) {
    throw new Error(`Scenario ${scenarioId} has a monitor cycle with incorrect DTE`)
  }
  if (monitorCycles.some(({ markHalfCentsPerShare }) =>
    markHalfCentsPerShare !== undefined &&
    markHalfCentsPerShare > intent.widthCentsPerShare * 2)) {
    throw new Error(`Scenario ${scenarioId} has a mark above the spread width`)
  }
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
    rank: candidateTuple(input),
  }))
  const approved = evaluated
    .filter(
      (candidate) =>
        signal.direction !== "NO_ACTION" &&
        candidate.input.intent.direction === signal.direction &&
        candidate.evaluation.outcome === "APPROVED",
    )
    .sort((left, right) =>
      compareDebitVerticalCandidateRanksV1(left.rank, right.rank),
    )
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
  records: readonly BacktestDatasetRecord[] = [],
) {
  const manifest = decodeBacktestDatasetManifest(manifestInput)
  if (!manifest.complete) throw new Error("Backtest dataset must be complete")
  records = records.map((record) =>
    parseBacktestDatasetRecord(manifest.definition, record)
  )
  const replay = backtestReplayInputV1Schema.parse(replayInput)
  if (isBacktestDatasetDefinitionV2(manifest.definition)) {
    if (
      canonicalJson(manifest.definition.strategyManifest) !==
        canonicalJson(RETAINED_REPLAY_V1_STRATEGY_MANIFEST) ||
      manifest.definition.datasetVersion !== BACKTEST_DATASET_VERSION ||
      manifest.definition.normalizationVersion !==
        BACKTEST_NORMALIZATION_VERSION ||
      manifest.definition.replayComponents.featureCalculation.componentId !==
        DIRECTIONAL_TREND_FEATURE_COMPONENT_ID ||
      manifest.definition.replayComponents.featureCalculation
        .componentVersion !== DIRECTIONAL_TREND_FEATURE_VERSION ||
      manifest.definition.replayComponents.candidateGenerationRanking
        .componentId !== DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID ||
      manifest.definition.replayComponents.candidateGenerationRanking
        .componentVersion !== DEBIT_VERTICAL_CANDIDATE_VERSION ||
      manifest.definition.replayComponents.riskRule.componentId !==
        "evaluateTradeIntentRiskV1" ||
      manifest.definition.replayComponents.riskRule.componentVersion !==
        RISK_RULE_VERSION ||
      manifest.definition.replayComponents.riskRule.evaluationVersion !==
        RISK_EVALUATION_VERSION ||
      manifest.definition.replayComponents.exitPolicy.componentId !==
        "runBacktestReplayV1" ||
      manifest.definition.replayComponents.exitPolicy.componentVersion !==
        BACKTEST_REPLAY_VERSION ||
      replay.replayVersion !==
        manifest.definition.strategyManifest.replayCompatibility.replayVersion ||
      replay.execution.modelVersion !==
        manifest.definition.strategyManifest.replayCompatibility
          .executionModelVersion
    ) {
      throw new Error("Backtest replay identity is incompatible with the dataset")
    }
    const scenarioIntents = replay.scenarios.flatMap((scenario) =>
      scenario.fidelity === "HISTORICAL_BAR_PROXY"
        ? [scenario.retainedIntent]
        : scenario.candidates.map(({ intent }) => intent)
    )
    if (
      scenarioIntents.some((intent) => {
        const long = parseAlpacaOptionSymbol(intent.longContractSymbol)
        const short = parseAlpacaOptionSymbol(intent.shortContractSymbol)
        return (
          !long.success ||
          !short.success ||
          long.identity.root !== manifest.definition.symbol ||
          short.identity.root !== manifest.definition.symbol
        )
      })
    ) {
      throw new Error("Backtest scenario identity is incompatible with the dataset")
    }
  }
  const sessions = records
    .filter((record): record is MarketSessionRecord => record.recordType === "MARKET_SESSION")
    .sort((left, right) => instant(left.open) - instant(right.open))
  const scenarioResults = replay.scenarios.map((scenario) => {
    if (scenario.fidelity === "EXACT_SNAPSHOT") {
      const signalSessionIndex = sessions.findIndex(
        ({ date }) => date === scenario.signal.sessionDate,
      )
      const expectedDates = sessions
        .slice(0, signalSessionIndex)
        .slice(-50)
        .map(({ date }) => date)
      if (
        signalSessionIndex < 0 ||
        canonicalJson(expectedDates) !== canonicalJson(scenario.signal.precedingSessionDates)
      ) {
        throw new Error(`Scenario ${scenario.scenarioId} exact daily bars do not match the replay calendar`)
      }
    }
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
    if (scenario.fidelity === "HISTORICAL_BAR_PROXY" && scenario.monitorCycles === undefined) {
      if (
        !manifest.definition.optionSymbols.includes(selected.intent.longContractSymbol) ||
        !manifest.definition.optionSymbols.includes(selected.intent.shortContractSymbol)
      ) {
        throw new Error(`Scenario ${scenario.scenarioId} references option symbols absent from the dataset`)
      }
      const entrySession = records.find(
        (record): record is MarketSessionRecord =>
          record.recordType === "MARKET_SESSION" &&
          instant(selected.intent!.evaluatedAt) >= instant(record.open) &&
          instant(selected.intent!.evaluatedAt) <= instant(record.close),
      )
      if (
        entrySession === undefined ||
        entrySession.date < manifest.definition.fromDate ||
        entrySession.date > manifest.definition.toDate
      ) {
        throw new Error(`Scenario ${scenario.scenarioId} entry session is outside the dataset interval`)
      }
    }
    const monitorCycles: readonly ReplayMonitorCycle[] =
      scenario.fidelity === "HISTORICAL_BAR_PROXY" && scenario.monitorCycles === undefined
        ? deriveHistoricalBarProxyCyclesV1(records, selected.intent)
        : scenario.monitorCycles!
    validateReplayMonitorCyclesV1(
      records,
      scenario.scenarioId,
      selected.intent,
      monitorCycles,
      scenario.monitorCycles !== undefined,
    )
    const simulation = simulateReplayScenario(
      selected.intent,
      monitorCycles,
      replay.execution,
    )
    return Object.assign(
      {
        scenarioId: scenario.scenarioId,
        fidelity: scenario.fidelity,
        signalDirection: selected.signalDirection,
        riskStatus: selected.riskStatus,
        riskEvaluations: selected.riskEvaluations,
        outcome: simulation.outcome,
        intent: selected.intent,
      },
      simulation,
    )
  })
  const entered = scenarioResults.filter((result) => result.outcome !== "NO_ENTRY")
  const closed = scenarioResults.filter((result) => result.outcome === "CLOSED")
  const {
    totalPnlCents,
    finalEquityCents: equityCents,
    returnBps,
    maxDrawdownCents,
  } = aggregateReplayCents(
    INITIAL_EQUITY_CENTS,
    scenarioResults.map(({ pnlCents }) => pnlCents),
  )
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
    returnBps,
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
