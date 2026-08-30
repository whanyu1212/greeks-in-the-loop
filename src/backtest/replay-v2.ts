import { z } from "zod"

import {
  validateResearchSnapshotPairV1,
} from "../contracts/research-market-snapshot-builders-v1.js"
import {
  RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION,
  RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION,
  optionUniverseSnapshotV1Schema,
  underlyingSessionSnapshotV1Schema,
  type OptionUniverseContractV1,
  type OptionUniverseSnapshotV1,
  type UnderlyingSessionSnapshotV1,
} from "../contracts/research-market-snapshot-v1.js"
import {
  RESEARCH_DECISION_CONTRACT_VERSION,
} from "../contracts/research-decision-v1.js"
import {
  TRADE_INTENT_CONTRACT_VERSION,
  tradeIntentV1Schema,
  type TradeIntentV1,
} from "../contracts/trade-intent-v1.js"
import {
  evaluateTradeIntentRiskV1,
  RISK_EVALUATION_VERSION,
  RISK_RULE_VERSION,
  riskEvaluationInputV1Schema,
  type RiskEvaluationInputV1,
} from "../risk/risk-evaluation-v1.js"
import { parseAlpacaOptionSymbol } from "../shared/alpaca-option-identity.js"
import { canonicalJson, canonicalJsonSha256 } from "../shared/canonical-json.js"
import { evaluateResearchEligibility } from "../scheduling/research-eligibility.js"
import {
  DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID,
  DEBIT_VERTICAL_CANDIDATE_VERSION,
  DIRECTIONAL_TREND_FEATURE_COMPONENT_ID,
  DIRECTIONAL_TREND_FEATURE_VERSION,
  screenSpyDirectionalDebitVerticalForManifestV1,
  type DebitVerticalCandidateV1,
} from "../strategy/directional-debit-vertical-v1.js"
import {
  decodeBacktestDatasetManifest,
  isBacktestDatasetDefinitionV2,
  type MarketSessionRecord,
} from "./dataset.js"
import {
  parseBacktestDatasetRecordV2,
  type BacktestDatasetDefinitionV2,
  type BacktestDatasetRecordV2,
} from "./dataset-v2.js"
import {
  aggregateReplayCents,
  replayMonitorCyclesSchema,
  simulateReplayScenario,
  type ReplayMonitorCycle,
} from "./replay-core.js"
import {
  BACKTEST_EXECUTION_COMPONENT_ID,
  BACKTEST_EXECUTION_COMPONENT_VERSION,
  BACKTEST_EXECUTION_MODEL_V2_VERSION,
  BACKTEST_EXIT_POLICY_COMPONENT_ID,
  BACKTEST_EXIT_POLICY_COMPONENT_VERSION,
  BACKTEST_REPLAY_SCENARIO_V2_VERSION,
  BACKTEST_REPLAY_V2_VERSION,
} from "./replay-identity.js"
import {
  deriveHistoricalBarProxyCyclesV1,
  validateReplayMonitorCyclesV1,
} from "./replay-v1.js"

const INITIAL_EQUITY_CENTS = 10_000_000
const SUPPORTED_REPLAY_V2_STRATEGY_MANIFEST = {
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
      componentId: "simulateReplayScenario",
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
    kind: "BACKTEST_REPLAY_V2",
    replayVersion: "2.0.0",
    executionModelVersion: "1.0.0",
    datasetVersion: "1.0.0",
    normalizationVersion: "1.0.0",
  },
} as const
const nonnegativeSafeInteger = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

const scenarioIdentityFields = {
  scenarioVersion: z.literal(BACKTEST_REPLAY_SCENARIO_V2_VERSION),
  scenarioId: z.string().regex(/^[a-f0-9]{64}$/u),
  datasetId: z.string().regex(/^[a-f0-9]{64}$/u),
  symbol: z.string().regex(/^[A-Z0-9]{1,6}$/u),
} as const

const scenarioIdMatches = (
  scenario: { scenarioId: string },
  context: z.core.$RefinementCtx,
) => {
  const { scenarioId, ...content } = scenario
  if (scenarioId !== computeBacktestReplayScenarioIdV2(content)) {
    context.addIssue({
      code: "custom",
      path: ["scenarioId"],
      message: "Replay scenario ID does not match immutable content",
    })
  }
}

const exactScenarioSchema = z
  .object({
    ...scenarioIdentityFields,
    fidelity: z.literal("EXACT_SNAPSHOT"),
    underlying: underlyingSessionSnapshotV1Schema,
    optionUniverse: optionUniverseSnapshotV1Schema,
    riskEvaluationInput: riskEvaluationInputV1Schema.optional(),
    monitorCycles: replayMonitorCyclesSchema,
  })
  .strict()
  .superRefine(scenarioIdMatches)

const proxyScenarioSchema = z
  .object({
    ...scenarioIdentityFields,
    fidelity: z.literal("HISTORICAL_BAR_PROXY"),
    retainedIntent: tradeIntentV1Schema,
    monitorCycles: replayMonitorCyclesSchema.optional(),
  })
  .strict()
  .superRefine(scenarioIdMatches)

export const backtestReplayScenarioV2Schema = z.discriminatedUnion("fidelity", [
  exactScenarioSchema,
  proxyScenarioSchema,
])

export type BacktestReplayScenarioV2 = Readonly<
  z.infer<typeof backtestReplayScenarioV2Schema>
>
export type BacktestReplayScenarioV2Content = Omit<
  BacktestReplayScenarioV2,
  "scenarioId"
>

/** Content-derived scenario identity, independent of scenario-file ordering. */
export const computeBacktestReplayScenarioIdV2 = (content: unknown) =>
  canonicalJsonSha256({
    domain: "backtest-replay-scenario-v2",
    content,
  })

export const backtestReplayInputV2Schema = z
  .object({
    replayVersion: z.literal(BACKTEST_REPLAY_V2_VERSION),
    execution: z
      .object({
        modelVersion: z.literal(BACKTEST_EXECUTION_MODEL_V2_VERSION),
        componentId: z.literal(BACKTEST_EXECUTION_COMPONENT_ID),
        componentVersion: z.literal(BACKTEST_EXECUTION_COMPONENT_VERSION),
        entrySlippageHalfCentsPerShare: nonnegativeSafeInteger,
        exitSlippageHalfCentsPerShare: nonnegativeSafeInteger,
        commissionCentsPerContract: nonnegativeSafeInteger,
      })
      .strict(),
    scenarios: z.array(backtestReplayScenarioV2Schema).min(1).max(10_000),
  })
  .strict()
  .superRefine(({ scenarios }, context) => {
    const ids = new Set<string>()
    scenarios.forEach(({ scenarioId }, index) => {
      if (ids.has(scenarioId)) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", index, "scenarioId"],
          message: "Replay scenario IDs must be unique",
        })
      }
      ids.add(scenarioId)
    })
  })

export type BacktestReplayInputV2 = Readonly<
  z.infer<typeof backtestReplayInputV2Schema>
>

type ReplayV2Resolution = Readonly<{
  screen: typeof screenSpyDirectionalDebitVerticalForManifestV1
  evaluateRisk: typeof evaluateTradeIntentRiskV1
  simulate: typeof simulateReplayScenario
}>

/** Resolves only the immutable V2 tuple; it never consults the current registry. */
export const resolveBacktestReplayComponentsV2 = (
  definition: BacktestDatasetDefinitionV2,
  replay: BacktestReplayInputV2,
  exactScenarios: readonly Extract<
    BacktestReplayScenarioV2,
    { fidelity: "EXACT_SNAPSHOT" }
  >[],
): ReplayV2Resolution => {
  const compatibility = definition.strategyManifest.replayCompatibility
  const components = definition.replayComponents
  if (
    canonicalJson(definition.strategyManifest) !==
      canonicalJson(SUPPORTED_REPLAY_V2_STRATEGY_MANIFEST) ||
    components.featureCalculation.componentId !==
      DIRECTIONAL_TREND_FEATURE_COMPONENT_ID ||
    components.featureCalculation.componentVersion !==
      DIRECTIONAL_TREND_FEATURE_VERSION ||
    components.candidateGenerationRanking.componentId !==
      DEBIT_VERTICAL_CANDIDATE_COMPONENT_ID ||
    components.candidateGenerationRanking.componentVersion !==
      DEBIT_VERTICAL_CANDIDATE_VERSION ||
    components.riskRule.componentId !== "evaluateTradeIntentRiskV1" ||
    components.riskRule.componentVersion !== RISK_RULE_VERSION ||
    components.riskRule.evaluationVersion !== RISK_EVALUATION_VERSION ||
    components.exitPolicy.componentId !== BACKTEST_EXIT_POLICY_COMPONENT_ID ||
    components.exitPolicy.componentVersion !==
      BACKTEST_EXIT_POLICY_COMPONENT_VERSION ||
    definition.strategyManifest.components.exitPolicy.componentId !==
      BACKTEST_EXIT_POLICY_COMPONENT_ID ||
    definition.strategyManifest.components.exitPolicy.componentVersion !==
      BACKTEST_EXIT_POLICY_COMPONENT_VERSION ||
    definition.strategyManifest.components.exitPolicy.availability !==
      "REPLAY_ONLY" ||
    compatibility.kind !== "BACKTEST_REPLAY_V2" ||
    compatibility.replayVersion !== BACKTEST_REPLAY_V2_VERSION ||
    compatibility.executionModelVersion !==
      BACKTEST_EXECUTION_MODEL_V2_VERSION ||
    definition.datasetVersion !== compatibility.datasetVersion ||
    definition.normalizationVersion !== compatibility.normalizationVersion ||
    replay.replayVersion !== compatibility.replayVersion ||
    replay.execution.modelVersion !== compatibility.executionModelVersion ||
    replay.execution.componentId !== BACKTEST_EXECUTION_COMPONENT_ID ||
    replay.execution.componentVersion !== BACKTEST_EXECUTION_COMPONENT_VERSION ||
    exactScenarios.some(
      ({ underlying, optionUniverse }) =>
        underlying.contractVersion !== RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION ||
        underlying.normalizationVersion !==
          RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION ||
        optionUniverse.contractVersion !== RESEARCH_MARKET_SNAPSHOT_CONTRACT_VERSION ||
        optionUniverse.normalizationVersion !==
          RESEARCH_MARKET_SNAPSHOT_NORMALIZATION_VERSION,
    )
  ) {
    throw new Error("Backtest Replay V2 identity is incompatible with the dataset")
  }
  return {
    screen: screenSpyDirectionalDebitVerticalForManifestV1,
    evaluateRisk: evaluateTradeIntentRiskV1,
    simulate: simulateReplayScenario,
  }
}

const exactOptionContract = (
  optionUniverse: { contracts: readonly OptionUniverseContractV1[] },
  symbol: string,
) => {
  const contract = optionUniverse.contracts.find(
    ({ contractSymbol }) => contractSymbol === symbol,
  )
  if (contract === undefined) {
    throw new Error("Selected candidate is absent from its option-universe snapshot")
  }
  return contract
}

const boundRiskEvaluationInput = (
  candidate: DebitVerticalCandidateV1,
  underlying: UnderlyingSessionSnapshotV1,
  optionUniverse: OptionUniverseSnapshotV1,
  input: RiskEvaluationInputV1,
): RiskEvaluationInputV1 => {
  const long = exactOptionContract(optionUniverse, candidate.longLeg.contractSymbol)
  const short = exactOptionContract(optionUniverse, candidate.shortLeg.contractSymbol)
  const leg = (
    role: "LONG" | "SHORT",
    contract: OptionUniverseContractV1,
  ) => ({
    role,
    contractSymbol: contract.contractSymbol,
    active: contract.active,
    tradable: contract.tradable,
    exerciseStyle: contract.exerciseStyle,
    multiplier: contract.multiplier,
    delta: contract.greeks.deltaMillionths / 1_000_000,
    impliedVolatility: contract.greeks.impliedVolatilityMillionths / 1_000_000,
    gamma: contract.greeks.gammaMillionths / 1_000_000,
    theta: contract.greeks.thetaMillionths / 1_000_000,
    vega: contract.greeks.vegaMillionths / 1_000_000,
    volume: contract.currentSessionVolume.contracts,
    volumeDate: contract.currentSessionVolume.sessionDate,
    openInterest: contract.openInterest.contracts,
    openInterestDate: contract.openInterest.asOfDate,
  })
  const eligibility = evaluateResearchEligibility({
    evaluatedAt: new Date(underlying.times.evaluatedAt),
    session: {
      date: underlying.session.date,
      open: underlying.session.openAt,
      close: underlying.session.closeAt,
      previousSessionDates: underlying.session.previousSessionDates.slice(-2),
    },
  })
  if (eligibility.tradeIntentWindow?.slotStartedAt !== underlying.times.slotStartedAt) {
    throw new Error("Risk eligibility timing does not match the selected snapshot")
  }
  if (canonicalJson(input.context.eligibility) !== canonicalJson(eligibility)) {
    throw new Error("Risk eligibility does not match the selected snapshot")
  }
  return riskEvaluationInputV1Schema.parse({
    ...input,
    intent: {
      contractVersion: TRADE_INTENT_CONTRACT_VERSION,
      decisionContractVersion: RESEARCH_DECISION_CONTRACT_VERSION,
      strategyVersion: candidate.strategyVersion,
      direction: candidate.direction,
      structure: candidate.structure,
      expiration: candidate.expirationDate,
      longContractSymbol: candidate.longLeg.contractSymbol,
      shortContractSymbol: candidate.shortLeg.contractSymbol,
      quoteSnapshotRef: optionUniverse.snapshotId,
      evaluatedAt: underlying.times.evaluatedAt,
      longQuote: {
        contractSymbol: long.contractSymbol,
        feed: "INDICATIVE",
        bidCentsPerShare: long.quote.bidCentsPerShare,
        askCentsPerShare: long.quote.askCentsPerShare,
        providerTimestamp: long.quote.providerTimestamp,
      },
      shortQuote: {
        contractSymbol: short.contractSymbol,
        feed: "INDICATIVE",
        bidCentsPerShare: short.quote.bidCentsPerShare,
        askCentsPerShare: short.quote.askCentsPerShare,
        providerTimestamp: short.quote.providerTimestamp,
      },
      ...candidate.economics,
    },
    context: {
      ...input.context,
      eligibility,
      contracts: {
        ...input.context.contracts,
        slotStartedAt: underlying.times.slotStartedAt,
        observedAt: underlying.times.evaluatedAt,
        legs: [leg("LONG", long), leg("SHORT", short)],
      },
    },
  })
}

const assertScenarioIdentity = (
  scenario: BacktestReplayScenarioV2,
  definition: BacktestDatasetDefinitionV2,
) => {
  if (
    scenario.datasetId !== definition.datasetId ||
    scenario.symbol !== definition.symbol
  ) {
    throw new Error(`Scenario ${scenario.scenarioId} does not match the dataset identity`)
  }
}

const assertIntentSymbol = (
  scenarioId: string,
  intent: TradeIntentV1,
  definition: BacktestDatasetDefinitionV2,
) => {
  const long = parseAlpacaOptionSymbol(intent.longContractSymbol)
  const short = parseAlpacaOptionSymbol(intent.shortContractSymbol)
  if (
    !long.success ||
    !short.success ||
    long.identity.root !== definition.symbol ||
    short.identity.root !== definition.symbol
  ) {
    throw new Error(`Scenario ${scenarioId} intent does not match the dataset symbol`)
  }
}

const proxyMonitorCycles = (
  scenario: Extract<BacktestReplayScenarioV2, { fidelity: "HISTORICAL_BAR_PROXY" }>,
  definition: BacktestDatasetDefinitionV2,
  records: readonly BacktestDatasetRecordV2[],
): readonly ReplayMonitorCycle[] => {
  const { retainedIntent } = scenario
  if (scenario.monitorCycles === undefined) {
    if (
      !definition.optionSymbols.includes(retainedIntent.longContractSymbol) ||
      !definition.optionSymbols.includes(retainedIntent.shortContractSymbol)
    ) {
      throw new Error(`Scenario ${scenario.scenarioId} references option symbols absent from the dataset`)
    }
    const entrySession = records.find(
      (record): record is MarketSessionRecord =>
        record.recordType === "MARKET_SESSION" &&
        Date.parse(retainedIntent.evaluatedAt) >= Date.parse(record.open) &&
        Date.parse(retainedIntent.evaluatedAt) <= Date.parse(record.close),
    )
    if (
      entrySession === undefined ||
      entrySession.date < definition.fromDate ||
      entrySession.date > definition.toDate
    ) {
      throw new Error(`Scenario ${scenario.scenarioId} entry session is outside the dataset interval`)
    }
  }
  const monitorCycles = scenario.monitorCycles ??
    deriveHistoricalBarProxyCyclesV1(records, retainedIntent)
  validateReplayMonitorCyclesV1(
    records,
    scenario.scenarioId,
    retainedIntent,
    monitorCycles,
    scenario.monitorCycles !== undefined,
  )
  return monitorCycles
}

/** Runs immutable V2 scenarios without consulting mutable runtime strategy state. */
export function runBacktestReplayV2(
  manifestInput: unknown,
  replayInput: unknown,
  records: readonly unknown[] = [],
) {
  const manifest = decodeBacktestDatasetManifest(manifestInput)
  if (!isBacktestDatasetDefinitionV2(manifest.definition)) {
    throw new Error("Backtest Replay V2 requires a Dataset V2 definition")
  }
  if (!manifest.complete) throw new Error("Backtest dataset must be complete")
  const definition = manifest.definition
  const replay = backtestReplayInputV2Schema.parse(replayInput)
  const parsedRecords = records.map((record) =>
    parseBacktestDatasetRecordV2(definition, record)
  )
  const resolution = resolveBacktestReplayComponentsV2(
    definition,
    replay,
    replay.scenarios.filter(
      (scenario): scenario is Extract<
        BacktestReplayScenarioV2,
        { fidelity: "EXACT_SNAPSHOT" }
      > => scenario.fidelity === "EXACT_SNAPSHOT",
    ),
  )

  const scenarioResults = replay.scenarios.map((scenario) => {
    assertScenarioIdentity(scenario, definition)
    if (scenario.fidelity === "HISTORICAL_BAR_PROXY") {
      assertIntentSymbol(scenario.scenarioId, scenario.retainedIntent, definition)
      const monitorCycles = proxyMonitorCycles(scenario, definition, parsedRecords)
      const simulation = resolution.simulate(
        scenario.retainedIntent,
        monitorCycles,
        replay.execution,
      )
      return Object.assign(
        {
          scenarioId: scenario.scenarioId,
          scenarioVersion: scenario.scenarioVersion,
          datasetId: scenario.datasetId,
          symbol: scenario.symbol,
          fidelity: scenario.fidelity,
          signalDirection: "NOT_EVALUABLE" as const,
          riskStatus: "NOT_EVALUABLE" as const,
          screening: { status: "NOT_EVALUABLE" as const },
          risk: { status: "NOT_EVALUABLE" as const },
          riskEvaluations: [],
          intent: scenario.retainedIntent,
          outcome: simulation.outcome,
        },
        simulation,
      )
    }

    const pair = validateResearchSnapshotPairV1(
      scenario.underlying,
      scenario.optionUniverse,
    )
    if (!pair.success) {
      throw new Error(`Scenario ${scenario.scenarioId} has an invalid snapshot pair`)
    }
    if (
      canonicalJson(pair.underlying.strategyManifest) !==
      canonicalJson(definition.strategyManifest)
    ) {
      throw new Error(`Scenario ${scenario.scenarioId} strategy manifest does not match the dataset`)
    }
    const snapshot = {
      underlyingSnapshotId: pair.underlying.snapshotId,
      optionUniverseSnapshotId: pair.optionUniverse.snapshotId,
      contractVersion: pair.underlying.contractVersion,
      normalizationVersion: pair.underlying.normalizationVersion,
    }
    const screening = resolution.screen(pair, definition.strategyManifest)
    if (screening.status === "NO_ACTION") {
      if (scenario.riskEvaluationInput !== undefined) {
        throw new Error(`Scenario ${scenario.scenarioId} supplies risk input without a selected candidate`)
      }
      return {
        scenarioId: scenario.scenarioId,
        scenarioVersion: scenario.scenarioVersion,
        datasetId: scenario.datasetId,
        symbol: scenario.symbol,
        fidelity: scenario.fidelity,
        snapshot,
        screening,
        signalDirection:
          "features" in screening ? screening.features.direction : "NO_ACTION",
        riskStatus: "NOT_EVALUATED" as const,
        risk: { status: "NOT_EVALUATED" as const },
        riskEvaluations: [],
        outcome: "NO_ENTRY" as const,
        pnlCents: 0,
      }
    }
    if (scenario.riskEvaluationInput === undefined) {
      throw new Error(`Scenario ${scenario.scenarioId} is missing risk input for its selected candidate`)
    }
    const boundInput = boundRiskEvaluationInput(
      screening.selectedCandidate,
      pair.underlying,
      pair.optionUniverse,
      scenario.riskEvaluationInput,
    )
    if (canonicalJson(scenario.riskEvaluationInput) !== canonicalJson(boundInput)) {
      throw new Error(`Scenario ${scenario.scenarioId} risk input is not bound to the selected candidate`)
    }
    const evaluation = resolution.evaluateRisk(boundInput)
    const selected = {
      scenarioId: scenario.scenarioId,
      scenarioVersion: scenario.scenarioVersion,
      datasetId: scenario.datasetId,
      symbol: scenario.symbol,
      fidelity: scenario.fidelity,
      snapshot,
      screening,
      candidate: screening.selectedCandidate,
      signalDirection: screening.features.direction,
      riskStatus: evaluation.outcome,
      risk: {
        status: evaluation.outcome,
        input: boundInput,
        evaluation,
      },
      riskEvaluations: [evaluation],
      intent: boundInput.intent,
    }
    if (evaluation.outcome === "REJECTED") {
      return {
        ...selected,
        outcome: "NO_ENTRY" as const,
        pnlCents: 0,
      }
    }
    const monitorCycles = scenario.monitorCycles
    validateReplayMonitorCyclesV1(
      parsedRecords,
      scenario.scenarioId,
      boundInput.intent,
      monitorCycles,
      true,
    )
    const simulation = resolution.simulate(
      boundInput.intent,
      monitorCycles,
      replay.execution,
    )
    return Object.assign({ ...selected, outcome: simulation.outcome }, simulation)
  })

  const entered = scenarioResults.filter(({ outcome }) => outcome !== "NO_ENTRY")
  const closed = scenarioResults.filter(({ outcome }) => outcome === "CLOSED")
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
    replayVersion: BACKTEST_REPLAY_V2_VERSION,
    datasetId: definition.datasetId,
    datasetChecksum: manifest.checksum,
    strategyManifest: definition.strategyManifest,
    resolvedComponents: {
      featureCalculation: definition.replayComponents.featureCalculation,
      candidateGenerationRanking:
        definition.replayComponents.candidateGenerationRanking,
      riskRule: definition.replayComponents.riskRule,
      exitPolicy: definition.replayComponents.exitPolicy,
      execution: {
        componentId: BACKTEST_EXECUTION_COMPONENT_ID,
        componentVersion: BACKTEST_EXECUTION_COMPONENT_VERSION,
        modelVersion: replay.execution.modelVersion,
      },
    },
    execution: replay.execution,
    scenarioCount: scenarioResults.length,
    tradeCount: entered.length,
    pricedTradeCount: closed.length,
    unpricedExitCount: scenarioResults.filter(
      ({ outcome }) => outcome === "EXIT_UNPRICED",
    ).length,
    exactScenarioCount: scenarioResults.filter(
      ({ fidelity }) => fidelity === "EXACT_SNAPSHOT",
    ).length,
    proxyScenarioCount: scenarioResults.filter(
      ({ fidelity }) => fidelity === "HISTORICAL_BAR_PROXY",
    ).length,
    initialEquityCents: INITIAL_EQUITY_CENTS,
    finalEquityCents: equityCents,
    totalPnlCents,
    returnBps,
    maxDrawdownCents,
    hitRateBps:
      closed.length === 0
        ? 0
        : Math.floor(
            (closed.filter(({ pnlCents }) => pnlCents !== null && pnlCents > 0).length * 10_000) /
              closed.length,
          ),
    riskRejectionCounts,
    results: scenarioResults,
  }
  return {
    ...reportWithoutChecksum,
    checksum: canonicalJsonSha256(reportWithoutChecksum),
  }
}
