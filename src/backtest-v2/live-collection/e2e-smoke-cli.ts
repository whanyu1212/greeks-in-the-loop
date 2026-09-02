import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, normalize } from "node:path"

import Database from "better-sqlite3"

import { historicalReplayExperimentV2Schema } from "../historical-contracts-v2.js"
import { runHistoricalReplayV2 } from "../historical-replay-v2.js"
import { createCollectionStoreV1 } from "./collection-store-v1.js"
import { forwardCollectionConfigV1Schema } from "./contracts-v1.js"
import { sealForwardCaptureV1 } from "./seal-capture-v1.js"

const args = process.argv.slice(2)
const outputIndex = args.indexOf("--output")
const output = normalize(
  outputIndex < 0
    ? "workspace/backtest-v2/e2e/minimal-fixture"
    : args[outputIndex + 1] ?? "",
)
const reset = args.includes("--reset")
const knownArguments = new Set(["--output", "--reset"])
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!
  if (argument === "--output") {
    index += 1
    continue
  }
  if (!knownArguments.has(argument)) throw new Error(`Unknown E2E argument: ${argument}`)
}
if (
  output === "workspace/backtest-v2/e2e" ||
  !output.startsWith("workspace/backtest-v2/e2e/")
) {
  throw new Error("E2E output must be a child of workspace/backtest-v2/e2e")
}
if (existsSync(output)) {
  if (!reset) throw new Error(`E2E output already exists: ${output}; pass --reset to replace it`)
  rmSync(output, { recursive: true, force: true })
}
mkdirSync(output, { recursive: true, mode: 0o700 })

const sessionDate = "2026-09-03"
const session = {
  date: sessionDate,
  open: "2026-09-03T13:30:00.000Z",
  close: "2026-09-03T20:00:00.000Z",
}
const captureStart = "2026-09-03T14:00:00.000Z"
const captureEnd = "2026-09-03T14:09:00.000Z"
const decisionAt = "2026-09-03T14:01:00.000Z"
const exitAt = "2026-09-03T14:07:00.000Z"
const captureDatabasePath = join(output, "collection", "capture.sqlite")
const historicalDatabasePath = join(output, "dataset", "historical.sqlite")
const replayDirectory = join(output, "replay")
const config = forwardCollectionConfigV1Schema.parse({
  configVersion: "1.0.0",
  databasePath: captureDatabasePath,
  symbols: ["AAPL"],
  feed: "indicative",
  stockFeed: "iex",
  minDte: 7,
  maxDte: 30,
  minMoneyness: 0.95,
  maxMoneyness: 1.05,
  pollSeconds: 60,
  contractRefreshMinutes: 15,
  snapshotBatchSize: 100,
  requestTimeoutMilliseconds: 30_000,
  freshQuoteMilliseconds: 60_000,
  researchArtifactRoot: join(output, "research"),
})
const contracts = [
  {
    providerContractId: "fixture-aapl-230-call",
    optionSymbol: "AAPL260918C00230000",
    underlying: "AAPL",
    right: "CALL" as const,
    strikeThousandthsPerShare: 230_000,
    expirationDate: "2026-09-18",
    multiplier: 100,
    style: "AMERICAN" as const,
    status: "active",
    tradable: true,
    openInterest: 2_000,
    openInterestDate: "2026-09-02",
  },
  {
    providerContractId: "fixture-aapl-235-call",
    optionSymbol: "AAPL260918C00235000",
    underlying: "AAPL",
    right: "CALL" as const,
    strikeThousandthsPerShare: 235_000,
    expirationDate: "2026-09-18",
    multiplier: 100,
    style: "AMERICAN" as const,
    status: "active",
    tradable: true,
    openInterest: 1_800,
    openInterestDate: "2026-09-02",
  },
]

const collectionStore = createCollectionStoreV1(captureDatabasePath)
let collectionRunId: string
let bootstrapId: string
try {
  collectionRunId = collectionStore.startRun("SESSION", sessionDate, config, captureStart)
  collectionStore.recordSession(session, captureStart)
  bootstrapId = collectionStore.recordBootstrap({
    runId: collectionRunId,
    retrievedAt: captureStart,
    expirationStart: "2026-09-10",
    expirationEnd: "2026-10-03",
    symbols: ["AAPL"],
    spots: [{
      symbol: "AAPL",
      priceHalfCents: 46_000,
      providerTimestamp: "2026-09-03T13:59:59.500Z",
    }],
    providerContracts: contracts,
    retainedContracts: contracts,
  })
  for (let minute = 0; minute < 10; minute += 1) {
    const receivedAt = new Date(Date.parse(captureStart) + minute * 60_000).toISOString()
    const providerTimestamp = new Date(Date.parse(receivedAt) - 500).toISOString()
    const closing = minute >= 7
    collectionStore.recordPoll({
      runId: collectionRunId,
      bootstrapId,
      scheduledAt: receivedAt,
      startedAt: receivedAt,
      completedAt: receivedAt,
      sessionState: "OPEN",
      feed: "INDICATIVE",
      requestedContracts: contracts,
      quotes: [
        {
          optionSymbol: contracts[0]!.optionSymbol,
          providerTimestamp,
          bidHalfCents: closing ? 1_400 : 990,
          askHalfCents: closing ? 1_410 : 1_000,
          bidSize: 20,
          askSize: 20,
          conditions: [],
          parseStatus: "PARSED",
        },
        {
          optionSymbol: contracts[1]!.optionSymbol,
          providerTimestamp,
          bidHalfCents: closing ? 590 : 400,
          askHalfCents: closing ? 600 : 410,
          bidSize: 20,
          askSize: 20,
          conditions: [],
          parseStatus: "PARSED",
        },
      ],
      freshQuoteMilliseconds: config.freshQuoteMilliseconds,
    })
  }
  collectionStore.importResearchArtifact(
    "fixtures/backtest-v2/e2e-minimal-research-run.json",
    {
      runVersion: "7.0.0",
      cycle: {
        cycleId: "fixture-e2e-cycle-1",
        cycleNumber: 1,
        sessionDate,
        startedAt: decisionAt,
        completedAt: "2026-09-03T14:01:30.000Z",
      },
      outcome: { status: "PORTFOLIO_EVALUATED" },
      fixtureNotice: "LINEAGE_ONLY_NOT_USED_AS_REPLAY_SIGNAL",
    },
    "2026-09-03T14:01:31.000Z",
  )
  collectionStore.completeRun(collectionRunId, "COMPLETE", captureEnd)
} finally {
  collectionStore.close()
}

const datasetId = "minimal-e2e-aapl-forward-fixture-v1"
const manifest = sealForwardCaptureV1({
  captureDatabasePath,
  historicalDatabasePath,
  datasetId,
  universeId: "golden-tech-options-v1",
  evidenceTier: "TEST_FIXTURE_REPLAY",
  sessionDate,
  startAt: captureStart,
  endAt: captureEnd,
  symbols: ["AAPL"],
})
mkdirSync(join(output, "dataset"), { recursive: true, mode: 0o700 })
writeFileSync(
  join(output, "dataset", "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600 },
)

const replayConfig = historicalReplayExperimentV2Schema.parse({
  backtestVersion: "2.0.0",
  experimentId: "minimal-e2e-aapl-v1",
  capability: "HISTORICAL_CHAIN_REPLAY",
  databasePath: historicalDatabasePath,
  datasetId,
  universeId: "golden-tech-options-v1",
  replaySelection: {
    startDate: sessionDate,
    endDate: sessionDate,
    timezone: "America/New_York",
    symbols: ["AAPL"],
  },
  signals: [{
    decisionId: "fixture-aapl-bullish-1401",
    decisionAt,
    symbol: "AAPL",
    direction: "BULLISH",
    exitAt,
  }],
  selector: {
    minDte: 10,
    maxDte: 30,
    minWidthHalfCents: 1_000,
    maxWidthHalfCents: 1_000,
    maxQuoteAgeMilliseconds: 90_000,
  },
  execution: {
    latencyMilliseconds: 60_000,
    slippageHalfCentsPerLeg: 1,
    commissionCentsPerContract: 65,
    missingQuote: "INCOMPLETE_RUN",
  },
  exitPolicy: {
    profitTargetBps: 2_500,
    stopLossBps: 5_000,
    expirationGuardDte: 3,
    priority: ["EXPIRATION_GUARD", "STOP_LOSS", "PROFIT_TARGET", "MAX_HOLD"],
  },
  portfolio: {
    initialCapitalCents: 1_000_000,
    quantity: 1,
    maxConcurrentPositions: 1,
    endOfTest: "LIQUIDATE_AT_END",
  },
})
mkdirSync(replayDirectory, { recursive: true, mode: 0o700 })
writeFileSync(
  join(replayDirectory, "config.json"),
  `${JSON.stringify(replayConfig, null, 2)}\n`,
  { mode: 0o600 },
)
const replay = runHistoricalReplayV2(replayConfig, replayDirectory)

const capture = new Database(captureDatabasePath, { readonly: true })
let captureCounts: Record<string, number>
try {
  const count = (table: string) =>
    (capture.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
  captureCounts = {
    collectionRuns: count("collection_runs"),
    contracts: count("option_contracts"),
    polls: count("quote_poll_attempts"),
    quoteObservations: count("option_quote_observations"),
    researchArtifacts: count("research_artifacts"),
  }
} finally {
  capture.close()
}
const summary = {
  e2eVersion: "1.0.0",
  evidenceTier: "TEST_FIXTURE_REPLAY",
  status: replay.status,
  notice: "DETERMINISTIC_LIVE_SHAPED_FIXTURE_NOT_ALPACA_MARKET_PERFORMANCE",
  collection: {
    databasePath: captureDatabasePath,
    window: { startAt: captureStart, endAt: captureEnd, pollSeconds: 60 },
    ...captureCounts,
  },
  dataset: manifest,
  replay,
  limitations: [
    "SINGLE_DECLARED_EXIT_CUTOFF_NOT_FIVE_MINUTE_MONITOR_LOOP",
    "MANUAL_DIRECTIONAL_SIGNAL_NOT_FROZEN_RESEARCH_REPORT_V7_REPLAY",
    "BOOTSTRAP_SPOT_PROXY_NOT_FULL_UNDERLYING_BAR_HISTORY",
  ],
}
writeFileSync(
  join(output, "e2e-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
  { mode: 0o600 },
)
writeFileSync(
  join(output, "report.md"),
  [
    "# Minimal Backtesting V2 E2E Result",
    "",
    "> Deterministic live-shaped fixture. This is an infrastructure proof, not Alpaca market performance.",
    "",
    `- Status: **${replay.status}**`,
    `- Collection polls: **${captureCounts.polls}**`,
    `- Quote observations: **${captureCounts.quoteObservations}**`,
    `- Sealed historical quotes: **${manifest.counts.quotes}**`,
    `- Opened / closed positions: **${replay.openedPositions} / ${replay.closedPositions}**`,
    `- Net P&L: **${replay.netPnlCents === null ? "unavailable" : `$${(replay.netPnlCents / 100).toFixed(2)}`}**`,
    `- Ending equity: **${replay.endingEquityCents === null ? "unavailable" : `$${(replay.endingEquityCents / 100).toFixed(2)}`}**`,
    `- Exit reason: inspect \`${replay.runLedgerPath}\``,
    "",
    "## Boundaries",
    "",
    ...summary.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n"),
  { mode: 0o600 },
)
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
