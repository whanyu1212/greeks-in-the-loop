import { describe, expect, it } from "vitest"

import {
  buildOptionUniverseSnapshotV1,
  buildUnderlyingSessionSnapshotV1,
  validateResearchSnapshotPairV1,
} from "../src/contracts/research-market-snapshot-builders-v1.js"
import {
  computeBacktestDatasetIdV2,
  type BacktestDatasetDefinitionV2,
} from "../src/backtest/dataset-v2.js"
import {
  backtestReplayInputV2Schema,
  computeBacktestReplayScenarioIdV2,
  deriveBacktestReplayEligibilityV2,
  runBacktestReplayV2,
} from "../src/backtest/replay-v2.js"
import { canonicalJsonSha256 } from "../src/shared/canonical-json.js"
import { screenSpyDirectionalDebitVerticalForManifestV1 } from "../src/strategy/directional-debit-vertical-v1.js"
import {
  createBacktestDatasetDefinitionV2Fixture,
  createReplayV1StrategyManifest,
  createSyntheticStrategyManifest,
} from "./fixtures/backtest-dataset-v2.js"
import {
  createOptionUniverseSnapshotInputV1,
  createUnderlyingSnapshotInputV1,
} from "./fixtures/research-market-snapshot-v1.js"

const execution = {
  modelVersion: "1.0.0",
  componentId: "backtestExecutionModelV1",
  componentVersion: "1.0.0",
  entrySlippageHalfCentsPerShare: 0,
  exitSlippageHalfCentsPerShare: 0,
  commissionCentsPerContract: 0,
} as const

const scenario = <T extends Record<string, unknown>>(content: T) => ({
  ...content,
  scenarioId: computeBacktestReplayScenarioIdV2(content),
})

const run = (
  definition: unknown,
  scenarios: readonly unknown[],
  records: readonly unknown[] = [],
  checksum = "a".repeat(64),
  replayExecution: unknown = execution,
) =>
  runBacktestReplayV2({
    definition,
    partitions: [],
    complete: true,
    checksum,
    limitations: [],
  }, {
    replayVersion: "2.0.0",
    execution: replayExecution,
    scenarios,
  }, records)

const createNoActionSnapshots = () => {
  const underlying = buildUnderlyingSessionSnapshotV1(
    createUnderlyingSnapshotInputV1(),
  )
  if (!underlying.success) throw new Error(underlying.reasons.join(","))
  const optionUniverse = buildOptionUniverseSnapshotV1(
    underlying.snapshot,
    createOptionUniverseSnapshotInputV1(),
  )
  if (!optionUniverse.success) throw new Error(optionUniverse.reasons.join(","))
  return { underlying: underlying.snapshot, optionUniverse: optionUniverse.snapshot }
}

const createSelectedSnapshots = (withAlternate = false) => {
  const underlyingInput = createUnderlyingSnapshotInputV1()
  underlyingInput.underlyingQuote.bidMicrosPerShare = 636_000_000
  underlyingInput.underlyingQuote.askMicrosPerShare = 636_020_000
  const underlying = buildUnderlyingSessionSnapshotV1(underlyingInput)
  if (!underlying.success) throw new Error(underlying.reasons.join(","))

  const optionInput = createOptionUniverseSnapshotInputV1()
  const [first, second] = optionInput.contracts
  if (first === undefined || second === undefined) throw new Error("Missing fixture contracts")
  const contracts = [
    {
      ...first,
      contractSymbol: "SPY260918C00630000",
      expirationDate: "2026-09-18",
      optionType: "CALL" as const,
      strikeCentsPerShare: 63_000,
      quote: {
        ...first.quote,
        bidCentsPerShare: 400,
        askCentsPerShare: 410,
      },
      greeks: { ...first.greeks, deltaMillionths: 500_000 },
    },
    {
      ...second,
      contractSymbol: "SPY260918C00635000",
      expirationDate: "2026-09-18",
      optionType: "CALL" as const,
      strikeCentsPerShare: 63_500,
      active: true,
      tradable: true,
      exerciseStyle: "AMERICAN" as const,
      multiplier: 100,
      quote: {
        ...second.quote,
        bidCentsPerShare: 150,
        askCentsPerShare: 160,
      },
      greeks: { ...second.greeks, deltaMillionths: 300_000 },
      currentSessionVolume: {
        ...second.currentSessionVolume,
        contracts: 220,
      },
      openInterest: { ...second.openInterest, contracts: 1_000 },
    },
  ]
  if (withAlternate) {
    contracts.push(
      {
        ...contracts[0]!,
        contractSymbol: "SPY260911C00620000",
        expirationDate: "2026-09-11",
        strikeCentsPerShare: 62_000,
      },
      {
        ...contracts[1]!,
        contractSymbol: "SPY260911C00625000",
        expirationDate: "2026-09-11",
        strikeCentsPerShare: 62_500,
      },
    )
  }
  optionInput.requestedContractSymbols.splice(
    0,
    optionInput.requestedContractSymbols.length,
    ...contracts.map(({ contractSymbol }) => contractSymbol),
  )
  optionInput.contracts.splice(0, optionInput.contracts.length, ...contracts)
  const optionUniverse = buildOptionUniverseSnapshotV1(
    underlying.snapshot,
    optionInput,
  )
  if (!optionUniverse.success) throw new Error(optionUniverse.reasons.join(","))
  const pair = validateResearchSnapshotPairV1(
    underlying.snapshot,
    optionUniverse.snapshot,
  )
  if (!pair.success) throw new Error(pair.reason)
  const screening = screenSpyDirectionalDebitVerticalForManifestV1(
    pair,
    pair.underlying.strategyManifest,
  )
  if (screening.status !== "SELECTED") throw new Error("Fixture must select a candidate")
  return { pair, screening }
}

const createRiskInput = ({ pair, screening }: ReturnType<typeof createSelectedSnapshots>) => {
  const long = pair.optionUniverse.contracts.find(
    ({ contractSymbol }) => contractSymbol === screening.selectedCandidate.longLeg.contractSymbol,
  )
  const short = pair.optionUniverse.contracts.find(
    ({ contractSymbol }) => contractSymbol === screening.selectedCandidate.shortLeg.contractSymbol,
  )
  if (long === undefined || short === undefined) throw new Error("Missing selected contracts")
  const { underlying } = pair
  const leg = (role: "LONG" | "SHORT", contract: typeof long) => ({
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
  return {
    intent: {
      contractVersion: "1.0.0",
      decisionContractVersion: "1.0.0",
      strategyVersion: screening.selectedCandidate.strategyVersion,
      direction: screening.selectedCandidate.direction,
      structure: screening.selectedCandidate.structure,
      expiration: screening.selectedCandidate.expirationDate,
      longContractSymbol: long.contractSymbol,
      shortContractSymbol: short.contractSymbol,
      quoteSnapshotRef: pair.optionUniverse.snapshotId,
      evaluatedAt: underlying.times.evaluatedAt,
      longQuote: {
        contractSymbol: long.contractSymbol,
        feed: "INDICATIVE" as const,
        bidCentsPerShare: long.quote.bidCentsPerShare,
        askCentsPerShare: long.quote.askCentsPerShare,
        providerTimestamp: long.quote.providerTimestamp,
      },
      shortQuote: {
        contractSymbol: short.contractSymbol,
        feed: "INDICATIVE" as const,
        bidCentsPerShare: short.quote.bidCentsPerShare,
        askCentsPerShare: short.quote.askCentsPerShare,
        providerTimestamp: short.quote.providerTimestamp,
      },
      ...screening.selectedCandidate.economics,
    },
    context: {
      provenance: "APPLICATION_VERIFIED" as const,
      eligibility: {
        evaluatedAt: underlying.times.evaluatedAt,
        sessionDate: underlying.session.date,
        sessionOpen: underlying.session.openAt,
        sessionClose: underlying.session.closeAt,
        researchEligible: true,
        tradeIntentEligible: true,
        tradeIntentWindow: {
          slotStartedAt: underlying.times.slotStartedAt,
          deadline: "2026-08-28T14:10:00.000Z",
        },
        previousSessionDates: underlying.session.previousSessionDates.slice(-2),
      },
      account: {
        observedAt: "2026-08-28T14:00:00.000Z",
        status: "ACTIVE" as const,
        tradingRestricted: false,
        multilegOptionsApproved: true,
        buyingPowerCents: 20_000_000,
        equityCents: 10_000_000,
        lastEquityCents: 10_050_000,
      },
      portfolio: {
        observedAt: "2026-08-28T14:00:00.000Z",
        consistent: true,
        openStrategyPositionCount: 0,
        pendingEntryCount: 0,
        entriesSubmittedToday: 0,
        dailyBreakerActive: false,
        competitionBreakerActive: false,
      },
      contracts: {
        slotStartedAt: underlying.times.slotStartedAt,
        observedAt: underlying.times.evaluatedAt,
        legs: [leg("LONG", long), leg("SHORT", short)],
      },
    },
  }
}

const exactMonitorCycle = {
  decidedAt: "2026-08-28T14:02:00.000Z",
  marketOpen: true,
  lateFill: false,
  dte: 21,
  minutesToClose: 358,
  staleMinutes: 0,
  markHalfCentsPerShare: 750,
  holdingSessionIndex: 1,
} as const

const selectedScenario = (definition: BacktestDatasetDefinitionV2, riskInput: unknown) => {
  const { pair } = createSelectedSnapshots(true)
  return {
    scenarioVersion: "2.0.0",
    datasetId: definition.datasetId,
    symbol: definition.symbol,
    fidelity: "EXACT_SNAPSHOT" as const,
    underlying: pair.underlying,
    optionUniverse: pair.optionUniverse,
    riskEvaluationInput: riskInput,
    monitorCycles: [exactMonitorCycle],
  }
}

const noActionScenario = (definition: BacktestDatasetDefinitionV2) => {
  const { underlying, optionUniverse } = createNoActionSnapshots()
  return {
    scenarioVersion: "2.0.0",
    datasetId: definition.datasetId,
    symbol: definition.symbol,
    fidelity: "EXACT_SNAPSHOT" as const,
    underlying,
    optionUniverse,
    monitorCycles: [exactMonitorCycle],
  }
}

const exactRecords = [{
  recordType: "MARKET_SESSION" as const,
  date: "2026-08-28",
  open: "2026-08-28T13:30:00.000Z",
  close: "2026-08-28T20:00:00.000Z",
}]

type DatasetContent = Omit<BacktestDatasetDefinitionV2, "datasetId">
const reidentifyDefinition = (
  definition: BacktestDatasetDefinitionV2,
  mutate: (content: DatasetContent) => DatasetContent,
) => {
  const { datasetId: _datasetId, ...content } = structuredClone(definition)
  const changed = mutate(content)
  return {
    ...changed,
    datasetId: computeBacktestDatasetIdV2(changed),
  }
}

describe("backtest replay v2", () => {
  it("derives deterministic scenario IDs, detects mutation, and rejects wrong or duplicate IDs", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    const content = noActionScenario(definition)
    const identified = scenario(content)

    expect(computeBacktestReplayScenarioIdV2(content)).toBe(identified.scenarioId)
    expect(computeBacktestReplayScenarioIdV2({
      ...content,
      monitorCycles: [{ ...exactMonitorCycle, markHalfCentsPerShare: 749 }],
    })).not.toBe(identified.scenarioId)
    expect(backtestReplayInputV2Schema.safeParse({
      replayVersion: "2.0.0",
      execution,
      scenarios: [{ ...identified, scenarioId: "0".repeat(64) }],
    }).success).toBe(false)
    expect(backtestReplayInputV2Schema.safeParse({
      replayVersion: "2.0.0",
      execution,
      scenarios: [identified, identified],
    }).success).toBe(false)
  })

  it("requires exact no-action scenarios to omit risk input", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    const noAction = noActionScenario(definition)
    const selected = createSelectedSnapshots()
    const riskInput = createRiskInput(selected)

    expect(run(definition, [scenario(noAction)])).toMatchObject({
      results: [{
        fidelity: "EXACT_SNAPSHOT",
        screening: { status: "NO_ACTION" },
        riskStatus: "NOT_EVALUATED",
        outcome: "NO_ENTRY",
      }],
    })
    expect(() => run(definition, [scenario({
      ...noAction,
      riskEvaluationInput: riskInput,
    })])).toThrow("supplies risk input")
  })

  it("runs only the screened rank-one candidate through bound risk deterministically", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    const selected = createSelectedSnapshots(true)
    const riskInput = createRiskInput(selected)
    const content = selectedScenario(definition, riskInput)
    const report = run(definition, [scenario(content)], exactRecords)

    expect(selected.screening.eligibleCandidateCount).toBe(2)
    expect(report).toEqual(run(definition, [scenario(content)], exactRecords))
    expect(report.results[0]).toMatchObject({
      screening: { status: "SELECTED" },
      candidate: { candidateId: selected.screening.selectedCandidate.candidateId },
      riskStatus: "APPROVED",
      risk: { status: "APPROVED" },
      outcome: "CLOSED",
      exitReason: "PROFIT_TARGET",
    })
  })

  it.each([
    ["candidate legs", (risk: ReturnType<typeof createRiskInput>) => {
      const alternate = risk.context.contracts.legs.map((leg) => ({
        ...leg,
        contractSymbol: leg.role === "LONG"
          ? "SPY260911C00620000"
          : "SPY260911C00625000",
      }))
      return {
        ...risk,
        intent: {
          ...risk.intent,
          expiration: "2026-09-11",
          longContractSymbol: "SPY260911C00620000",
          shortContractSymbol: "SPY260911C00625000",
          longQuote: {
            ...risk.intent.longQuote,
            contractSymbol: "SPY260911C00620000",
          },
          shortQuote: {
            ...risk.intent.shortQuote,
            contractSymbol: "SPY260911C00625000",
          },
        },
        context: {
          ...risk.context,
          contracts: { ...risk.context.contracts, legs: alternate },
        },
      }
    }],
    ["economics", (risk: ReturnType<typeof createRiskInput>) => ({
      ...risk,
      intent: { ...risk.intent, maxProfitCentsPerContract: 1 },
    })],
    ["snapshot reference", (risk: ReturnType<typeof createRiskInput>) => ({
      ...risk,
      intent: { ...risk.intent, quoteSnapshotRef: "different-snapshot" },
    })],
    ["eligibility calendar", (risk: ReturnType<typeof createRiskInput>) => ({
      ...risk,
      context: {
        ...risk.context,
        eligibility: {
          ...risk.context.eligibility,
          previousSessionDates: risk.context.eligibility.previousSessionDates.slice(-1),
        },
      },
    })],
    ["eligibility timing", (risk: ReturnType<typeof createRiskInput>) => ({
      ...risk,
      context: {
        ...risk.context,
        eligibility: {
          ...risk.context.eligibility,
          evaluatedAt: "2026-08-28T14:00:00.000Z",
        },
      },
    })],
    ["eligibility boolean", (risk: ReturnType<typeof createRiskInput>) => ({
      ...risk,
      context: {
        ...risk.context,
        eligibility: { ...risk.context.eligibility, tradeIntentEligible: false },
      },
    })],
    ["eligibility deadline", (risk: ReturnType<typeof createRiskInput>) => ({
      ...risk,
      context: {
        ...risk.context,
        eligibility: {
          ...risk.context.eligibility,
          tradeIntentWindow: {
            ...risk.context.eligibility.tradeIntentWindow,
            deadline: "2026-08-28T14:05:00.000Z",
          },
        },
      },
    })],
    ["eligibility research mode", (risk: ReturnType<typeof createRiskInput>) => ({
      ...risk,
      context: {
        ...risk.context,
        eligibility: {
          ...risk.context.eligibility,
          researchMode: "DRY_RUN_SHADOW_ANYTIME" as const,
        },
      },
    })],
    ["eligibility reason", (risk: ReturnType<typeof createRiskInput>) => ({
      ...risk,
      context: {
        ...risk.context,
        eligibility: {
          ...risk.context.eligibility,
          reason: "OUTSIDE_TRADE_INTENT_WINDOW" as const,
        },
      },
    })],
    ["contract metrics", (risk: ReturnType<typeof createRiskInput>) => ({
      ...risk,
      context: {
        ...risk.context,
        contracts: {
          ...risk.context.contracts,
          legs: [
            { ...risk.context.contracts.legs[0]!, delta: 0.499_999 },
            risk.context.contracts.legs[1]!,
          ],
        },
      },
    })],
  ])("rejects %s substitutions instead of reranking", (_label, mutate) => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    const selected = createSelectedSnapshots(true)
    const riskInput = createRiskInput(selected)
    expect(() => run(definition, [scenario(selectedScenario(
      definition,
      mutate(riskInput),
    ))], exactRecords)).toThrow()
  })

  it("rejects sessions that open before the frozen replay premarket boundary", () => {
    const selected = createSelectedSnapshots(true)
    expect(() => deriveBacktestReplayEligibilityV2({
      ...selected.pair.underlying,
      session: {
        ...selected.pair.underlying.session,
        openAt: "2026-08-28T11:00:00.000Z",
      },
    })).toThrow("Replay market session is invalid")
  })

  it("returns no entry for a risk rejection without falling back", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    const selected = createSelectedSnapshots(true)
    const riskInput = createRiskInput(selected)
    riskInput.context.account.buyingPowerCents = 1
    const report = run(
      definition,
      [scenario(selectedScenario(definition, riskInput))],
      exactRecords,
    )

    expect(report).toMatchObject({
      tradeCount: 0,
      results: [{
        candidate: { candidateId: selected.screening.selectedCandidate.candidateId },
        riskStatus: "REJECTED",
        risk: {
          status: "REJECTED",
          evaluation: { reasonCodes: ["BUYING_POWER_RESERVE_INSUFFICIENT"] },
        },
        riskEvaluations: [{ outcome: "REJECTED" }],
        outcome: "NO_ENTRY",
        pnlCents: 0,
      }],
    })
  })

  it("rejects incomplete dataset manifests", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    expect(() => runBacktestReplayV2({
      definition,
      partitions: [],
      complete: false,
      checksum: "a".repeat(64),
      limitations: [],
    }, {
      replayVersion: "2.0.0",
      execution,
      scenarios: [scenario(noActionScenario(definition))],
    })).toThrow("must be complete")
  })

  it.each([
    ["feature identity", (definition: BacktestDatasetDefinitionV2) => ({
      definition: reidentifyDefinition(definition, (content) => ({
        ...content,
        replayComponents: {
          ...content.replayComponents,
          featureCalculation: {
            ...content.replayComponents.featureCalculation,
            componentVersion: "9.9.9",
          },
        },
      })),
    })],
    ["candidate/ranker identity", (definition: BacktestDatasetDefinitionV2) => ({
      definition: reidentifyDefinition(definition, (content) => ({
        ...content,
        replayComponents: {
          ...content.replayComponents,
          candidateGenerationRanking: {
            ...content.replayComponents.candidateGenerationRanking,
            componentId: "different-ranker",
          },
        },
      })),
    })],
    ["risk identity", (definition: BacktestDatasetDefinitionV2) => ({
      definition: reidentifyDefinition(definition, (content) => ({
        ...content,
        replayComponents: {
          ...content.replayComponents,
          riskRule: { ...content.replayComponents.riskRule, evaluationVersion: "9.9.9" },
        },
      })),
    })],
    ["exit identity", (definition: BacktestDatasetDefinitionV2) => ({
      definition: reidentifyDefinition(definition, (content) => ({
        ...content,
        replayComponents: {
          ...content.replayComponents,
          exitPolicy: { ...content.replayComponents.exitPolicy, componentId: "different-exit" },
        },
      })),
    })],
    ["replay identity", () => ({
      replayExecution: { ...execution, modelVersion: "9.9.9" },
    })],
    ["execution identity", () => ({
      replayExecution: { ...execution, componentId: "different-execution" },
    })],
  ])("rejects %s drift", (_label, mutate) => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    const changed = mutate(definition)
    expect(() => run(
      "definition" in changed ? changed.definition : definition,
      [scenario(noActionScenario(definition))],
      [],
      "a".repeat(64),
      "replayExecution" in changed ? changed.replayExecution : execution,
    )).toThrow()
  })

  it("rejects dataset/scenario symbol mismatches and synthetic QQQ datasets", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    const noAction = noActionScenario(definition)
    expect(() => run(definition, [scenario({ ...noAction, symbol: "QQQ" })])).toThrow(
      "does not match the dataset identity",
    )

    const qqqDefinition = createBacktestDatasetDefinitionV2Fixture({
      strategyManifest: createSyntheticStrategyManifest("QQQ"),
      optionSymbols: ["QQQ240621C00450000", "QQQ240621C00455000"],
    })
    expect(() => run(qqqDefinition, [scenario({
      ...noAction,
      datasetId: qqqDefinition.datasetId,
      symbol: "QQQ",
    })])).toThrow("identity is incompatible")
  })

  it("keeps proxy signal and risk not evaluable and derives omitted cycles from retained records", () => {
    const selected = createSelectedSnapshots()
    const riskInput = createRiskInput(selected)
    const definition = createBacktestDatasetDefinitionV2Fixture({
      fromDate: "2026-08-28",
      toDate: "2026-08-28",
      requestStartedAt: "2026-08-29T10:00:00.000Z",
      optionSymbols: [
        riskInput.intent.longContractSymbol,
        riskInput.intent.shortContractSymbol,
      ],
    })
    const content = {
      scenarioVersion: "2.0.0",
      datasetId: definition.datasetId,
      symbol: definition.symbol,
      fidelity: "HISTORICAL_BAR_PROXY" as const,
      retainedIntent: riskInput.intent,
    }
    const optionBar = (contractSymbol: string, lowMicros: number, highMicros: number) => ({
      recordType: "OPTION_BAR" as const,
      contractSymbol,
      timeframe: "1MINUTE" as const,
      timestamp: "2026-08-28T14:01:00.000Z",
      openMicros: lowMicros,
      highMicros,
      lowMicros,
      closeMicros: lowMicros,
      volume: 1,
      vwapMicros: lowMicros,
      tradeCount: 1,
    })
    expect(() => run(definition, [scenario({
      ...content,
      retainedIntent: { ...content.retainedIntent, strategyVersion: "1.0.0" },
    })], exactRecords)).toThrow("intent identity is incompatible")

    const report = run(definition, [scenario(content)], [
      ...exactRecords,
      optionBar(riskInput.intent.longContractSymbol, 4_000_000, 4_000_000),
      optionBar(riskInput.intent.shortContractSymbol, 1_500_000, 1_500_000),
    ])

    expect(report.results[0]).toMatchObject({
      signalDirection: "NOT_EVALUABLE",
      riskStatus: "NOT_EVALUABLE",
      screening: { status: "NOT_EVALUABLE" },
      risk: { status: "NOT_EVALUABLE" },
      riskEvaluations: [],
      outcome: "EXIT_UNPRICED",
      exitDecidedAt: "2026-08-28T14:07:00.000Z",
      pnlCents: null,
    })
  })

  it("binds V2 dataset exit identity while preserving retained V1 structural decoding", () => {
    const v2 = createBacktestDatasetDefinitionV2Fixture()
    const v1 = createBacktestDatasetDefinitionV2Fixture({
      strategyManifest: createReplayV1StrategyManifest(),
    })

    expect(v2.replayComponents.exitPolicy).toEqual({
      componentId: "simulateReplayScenario",
      componentVersion: "1.0.0",
    })
    expect(v2.datasetId).toBe(createBacktestDatasetDefinitionV2Fixture().datasetId)
    expect(v1.strategyManifest.replayCompatibility).toMatchObject({
      kind: "BACKTEST_REPLAY_V1",
      replayVersion: "1.0.0",
    })
  })

  it("checksums canonical reports and changes them for provenance, execution, and results", () => {
    const definition = createBacktestDatasetDefinitionV2Fixture()
    const selected = createSelectedSnapshots(true)
    const riskInput = createRiskInput(selected)
    const content = selectedScenario(definition, riskInput)
    const baseline = run(definition, [scenario(content)], exactRecords)
    const provenanceChanged = run(
      definition,
      [scenario(content)],
      exactRecords,
      "b".repeat(64),
    )
    const executionChanged = run(
      definition,
      [scenario(content)],
      exactRecords,
      "a".repeat(64),
      { ...execution, entrySlippageHalfCentsPerShare: 1 },
    )
    const rejectedRisk = structuredClone(riskInput)
    rejectedRisk.context.account.buyingPowerCents = 1
    const resultsChanged = run(
      definition,
      [scenario(selectedScenario(definition, rejectedRisk))],
      exactRecords,
    )
    const { checksum, ...canonicalReport } = baseline

    expect(checksum).toBe(canonicalJsonSha256(canonicalReport))
    expect(provenanceChanged.checksum).not.toBe(checksum)
    expect(executionChanged.checksum).not.toBe(checksum)
    expect(resultsChanged.checksum).not.toBe(checksum)
  })
})
