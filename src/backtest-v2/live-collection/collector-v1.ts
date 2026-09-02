import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

import type { MarketCalendar } from "../../market-data/alpaca-calendar-client.js"
import type { AlpacaForwardCollectionProvider } from "./alpaca-provider-v1.js"
import type {
  CollectedOptionContractV1,
  CollectionSessionV1,
  ForwardCollectionConfigV1,
} from "./contracts-v1.js"
import type {
  CollectionModeV1,
  CollectionStoreV1,
  SessionStateV1,
} from "./collection-store-v1.js"

const DAY_MILLISECONDS = 86_400_000

const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>(
  (resolve, reject) => {
    if (milliseconds <= 0) return resolve()
    const timer = setTimeout(resolve, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error("Collection cancelled"))
    }
    signal.addEventListener("abort", abort, { once: true })
  },
)

const requestSignal = (signal: AbortSignal, timeoutMilliseconds: number) =>
  AbortSignal.any([signal, AbortSignal.timeout(timeoutMilliseconds)])

export const sessionStateAtV1 = (
  session: CollectionSessionV1 | undefined,
  at: string,
): SessionStateV1 => {
  if (session === undefined) return "NON_SESSION"
  const time = Date.parse(at)
  if (time < Date.parse(session.open)) return "PREMARKET"
  if (time > Date.parse(session.close)) return "AFTER_HOURS"
  return "OPEN"
}

const batchesOf = <T>(values: readonly T[], size: number) => {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}

export type ArtifactCaptureSummaryV1 = Readonly<{
  discovered: number
  imported: number
  rejected: number
}>

/** Imports canonical research JSON exports; SQLite remains authoritative. */
export async function captureResearchArtifactsV1(
  store: CollectionStoreV1,
  root: string,
  now: () => Date = () => new Date(),
): Promise<ArtifactCaptureSummaryV1> {
  let dateEntries
  try {
    dateEntries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { discovered: 0, imported: 0, rejected: 0 }
    }
    throw error
  }
  const paths: string[] = []
  for (const dateEntry of dateEntries) {
    if (!dateEntry.isDirectory()) continue
    const directory = join(root, dateEntry.name)
    const files = await readdir(directory, { withFileTypes: true })
    for (const file of files) {
      if (file.isFile() && file.name.endsWith(".json")) {
        paths.push(join(directory, file.name))
      }
    }
  }
  let imported = 0
  let rejected = 0
  for (const path of paths.toSorted()) {
    try {
      const input = JSON.parse(await readFile(path, "utf8")) as unknown
      if (store.importResearchArtifact(path, input, now().toISOString())) imported += 1
    } catch {
      rejected += 1
    }
  }
  return { discovered: paths.length, imported, rejected }
}

export type CollectorDependenciesV1 = Readonly<{
  provider: AlpacaForwardCollectionProvider
  calendar: MarketCalendar
  store: CollectionStoreV1
  now?: () => Date
}>

const loadSession = async (
  calendar: MarketCalendar,
  sessionDate: string,
  signal: AbortSignal,
  timeout: number,
): Promise<CollectionSessionV1 | undefined> => {
  const session = await calendar.getSession(
    sessionDate,
    requestSignal(signal, timeout),
  )
  return session === undefined
    ? undefined
    : { date: session.date, open: session.open, close: session.close }
}

const bootstrap = async (
  runId: string,
  sessionDate: string,
  config: ForwardCollectionConfigV1,
  dependencies: CollectorDependenciesV1,
  signal: AbortSignal,
) => {
  const now = dependencies.now ?? (() => new Date())
  const expirationStart = addDays(sessionDate, config.minDte)
  const expirationEnd = addDays(sessionDate, config.maxDte)
  const [spots, providerContracts] = await Promise.all([
    dependencies.provider.getUnderlyingSpots({
      symbols: config.symbols,
      stockFeed: config.stockFeed,
      signal: requestSignal(signal, config.requestTimeoutMilliseconds),
    }),
    dependencies.provider.listContracts({
      symbols: config.symbols,
      startDate: expirationStart,
      endDate: expirationEnd,
      signal: requestSignal(signal, config.requestTimeoutMilliseconds),
    }),
  ])
  const spotBySymbol = new Map(spots.map((spot) => [spot.symbol, spot]))
  const missingSpots = config.symbols.filter((symbol) => !spotBySymbol.has(symbol))
  if (missingSpots.length > 0) {
    throw new Error(`Underlying snapshots unavailable for: ${missingSpots.join(", ")}`)
  }
  const retainedContracts = providerContracts
    .filter((contract) => {
      const spot = spotBySymbol.get(contract.underlying)
      if (
        spot === undefined ||
        !contract.tradable ||
        contract.status.toLowerCase() !== "active" ||
        contract.style !== "AMERICAN" ||
        contract.multiplier !== 100
      ) return false
      const strikeHalfCents = contract.strikeThousandthsPerShare / 5
      const moneyness = strikeHalfCents / spot.priceHalfCents
      return moneyness >= config.minMoneyness && moneyness <= config.maxMoneyness
    })
    .toSorted((left, right) =>
      left.underlying.localeCompare(right.underlying) ||
      left.expirationDate.localeCompare(right.expirationDate) ||
      left.right.localeCompare(right.right) ||
      left.strikeThousandthsPerShare - right.strikeThousandthsPerShare ||
      left.optionSymbol.localeCompare(right.optionSymbol)
    )
  const retrievedAt = now().toISOString()
  const bootstrapId = dependencies.store.recordBootstrap({
    runId,
    retrievedAt,
    expirationStart,
    expirationEnd,
    symbols: config.symbols,
    spots,
    providerContracts,
    retainedContracts,
  })
  return { bootstrapId, contracts: retainedContracts, retrievedAt }
}

const poll = async (
  runId: string,
  bootstrapId: string,
  contracts: readonly CollectedOptionContractV1[],
  session: CollectionSessionV1 | undefined,
  scheduledAt: string,
  config: ForwardCollectionConfigV1,
  dependencies: CollectorDependenciesV1,
  signal: AbortSignal,
) => {
  const now = dependencies.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const sessionState = sessionStateAtV1(session, startedAt)
  const quotes = []
  try {
    for (const batch of batchesOf(contracts, config.snapshotBatchSize)) {
      quotes.push(...await dependencies.provider.getOptionQuotes({
        optionSymbols: batch.map(({ optionSymbol }) => optionSymbol),
        feed: config.feed,
        signal: requestSignal(signal, config.requestTimeoutMilliseconds),
      }))
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    return dependencies.store.recordFailedPoll({
      runId,
      bootstrapId,
      scheduledAt,
      startedAt,
      completedAt: now().toISOString(),
      sessionState,
      requestedContractCount: contracts.length,
      failureCode: "OPTION_SNAPSHOT_REQUEST_FAILED",
    })
  }
  return dependencies.store.recordPoll({
    runId,
    bootstrapId,
    scheduledAt,
    startedAt,
    completedAt: now().toISOString(),
    sessionState,
    feed: config.feed.toUpperCase(),
    requestedContracts: contracts,
    quotes,
    freshQuoteMilliseconds: config.freshQuoteMilliseconds,
  })
}

export type RunForwardCollectorOptionsV1 = Readonly<{
  mode: CollectionModeV1
  sessionDate: string
  config: ForwardCollectionConfigV1
  signal: AbortSignal
}>

export type ForwardCollectorReportV1 = Readonly<{
  collectorVersion: "1.0.0"
  runId: string
  mode: CollectionModeV1
  sessionDate: string
  databasePath: string
  bootstrapId?: string
  retainedContracts: number
  polls: number
  researchArtifacts: ArtifactCaptureSummaryV1
  note?: string
}>

/** Runs an explicit bootstrap, one-shot diagnostic poll, or bounded market session. */
export async function runForwardCollectorV1(
  options: RunForwardCollectorOptionsV1,
  dependencies: CollectorDependenciesV1,
): Promise<ForwardCollectorReportV1> {
  const now = dependencies.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const runId = dependencies.store.startRun(
    options.mode,
    options.sessionDate,
    options.config,
    startedAt,
  )
  let bootstrapId: string | undefined
  let retainedContracts = 0
  let polls = 0
  try {
    const session = await loadSession(
      dependencies.calendar,
      options.sessionDate,
      options.signal,
      options.config.requestTimeoutMilliseconds,
    )
    if (session !== undefined) dependencies.store.recordSession(session, now().toISOString())
    const bootstrapped = await bootstrap(
      runId,
      options.sessionDate,
      options.config,
      dependencies,
      options.signal,
    )
    bootstrapId = bootstrapped.bootstrapId
    retainedContracts = bootstrapped.contracts.length

    if (options.mode === "ONCE") {
      await poll(
        runId,
        bootstrapId,
        bootstrapped.contracts,
        session,
        now().toISOString(),
        options.config,
        dependencies,
        options.signal,
      )
      polls = 1
    } else if (options.mode === "SESSION") {
      if (session === undefined) throw new Error("Requested date is not a market session")
      const open = Date.parse(session.open)
      const close = Date.parse(session.close)
      if (now().getTime() > close) {
        const researchArtifacts = await captureResearchArtifactsV1(
          dependencies.store,
          options.config.researchArtifactRoot,
          now,
        )
        dependencies.store.completeRun(runId, "COMPLETE", now().toISOString())
        return {
          collectorVersion: "1.0.0",
          runId,
          mode: options.mode,
          sessionDate: options.sessionDate,
          databasePath: dependencies.store.databasePath,
          bootstrapId,
          retainedContracts,
          polls,
          researchArtifacts,
          note: "SESSION_ALREADY_CLOSED_NO_AFTER_HOURS_POLL",
        }
      }
      if (now().getTime() < open) await wait(open - now().getTime(), options.signal)
      const interval = options.config.pollSeconds * 1_000
      const refreshInterval = options.config.contractRefreshMinutes * 60_000
      let currentBootstrap = bootstrapped
      let lastRefresh = Date.parse(bootstrapped.retrievedAt)
      while (now().getTime() <= close) {
        options.signal.throwIfAborted()
        if (now().getTime() - lastRefresh >= refreshInterval) {
          currentBootstrap = await bootstrap(
            runId,
            options.sessionDate,
            options.config,
            dependencies,
            options.signal,
          )
          bootstrapId = currentBootstrap.bootstrapId
          retainedContracts = currentBootstrap.contracts.length
          lastRefresh = now().getTime()
        }
        const scheduledAt = now().toISOString()
        await poll(
          runId,
          currentBootstrap.bootstrapId,
          currentBootstrap.contracts,
          session,
          scheduledAt,
          options.config,
          dependencies,
          options.signal,
        )
        polls += 1
        await captureResearchArtifactsV1(
          dependencies.store,
          options.config.researchArtifactRoot,
          now,
        )
        const next = Math.min(
          Math.ceil((now().getTime() + 1) / interval) * interval,
          close + 1,
        )
        if (next > close) break
        await wait(next - now().getTime(), options.signal)
      }
    }

    const researchArtifacts = await captureResearchArtifactsV1(
      dependencies.store,
      options.config.researchArtifactRoot,
      now,
    )
    dependencies.store.completeRun(runId, "COMPLETE", now().toISOString())
    return {
      collectorVersion: "1.0.0",
      runId,
      mode: options.mode,
      sessionDate: options.sessionDate,
      databasePath: dependencies.store.databasePath,
      bootstrapId,
      retainedContracts,
      polls,
      researchArtifacts,
      ...(options.mode === "BOOTSTRAP"
        ? { note: "CONTRACT_METADATA_ONLY_NO_QUOTES_COLLECTED" }
        : {}),
    }
  } catch (error) {
    dependencies.store.completeRun(
      runId,
      "FAILED",
      now().toISOString(),
      error instanceof Error ? error.message : "COLLECTION_FAILED",
    )
    throw error
  }
}

export const collectionDateRangeV1 = (sessionDate: string) => ({
  earliestUsefulDailyHistoryDate: addDays(sessionDate, -80),
  sessionDate,
  millisecondsPerDay: DAY_MILLISECONDS,
})
