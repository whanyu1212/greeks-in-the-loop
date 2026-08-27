import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import type { AlpacaHistoricalClient, HistoricalDataPage } from "../market-data/alpaca-historical-client.js"
import type {
  BacktestDatasetDefinitionV1,
  BacktestPartitionKind,
  BacktestPartitionRequestV1,
} from "./dataset-v1.js"
import type { BacktestDatasetStore } from "./sqlite-dataset-store.js"

const SIGNAL_WARMUP_CALENDAR_DAYS = 90

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10)

const chunks = <T>(values: readonly T[], size: number): readonly (readonly T[])[] => {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

type PageLoader = (pageToken?: string) => Promise<HistoricalDataPage>

const ingestPartition = async (
  store: BacktestDatasetStore,
  input: Readonly<{
    partitionKey: string
    kind: BacktestPartitionKind
    request: BacktestPartitionRequestV1
    now: () => Date
    load: PageLoader
  }>,
) => {
  let partition = store.beginPartition({
    partitionKey: input.partitionKey,
    kind: input.kind,
    request: input.request,
    updatedAt: input.now().toISOString(),
  })
  if (partition.status === "COMPLETE") return partition
  if (partition.pageCount > 0 && partition.nextPageToken === undefined) {
    return store.completePartition(input.partitionKey, input.now().toISOString())
  }

  const seenTokens = new Set<string>()
  while (true) {
    const currentToken = partition.nextPageToken
    if (currentToken !== undefined && seenTokens.has(currentToken)) {
      throw new Error("Alpaca pagination token repeated")
    }
    if (currentToken !== undefined) seenTokens.add(currentToken)
    const page = await input.load(currentToken)
    if (
      page.nextPageToken !== undefined &&
      (page.nextPageToken === currentToken || seenTokens.has(page.nextPageToken))
    ) {
      throw new Error("Alpaca pagination token repeated")
    }
    partition = store.appendPage({
      partitionKey: input.partitionKey,
      ...(currentToken === undefined ? {} : { expectedPageToken: currentToken }),
      records: page.records,
      ...(page.nextPageToken === undefined
        ? {}
        : { nextPageToken: page.nextPageToken }),
      updatedAt: input.now().toISOString(),
    })
    if (page.nextPageToken === undefined) {
      return store.completePartition(
        input.partitionKey,
        input.now().toISOString(),
      )
    }
  }
}

export type IngestAlpacaBacktestDatasetOptions = Readonly<{
  store: BacktestDatasetStore
  client: AlpacaHistoricalClient
  optionSymbols?: readonly string[]
  signal: AbortSignal
  now?: () => Date
}>

/** Downloads normalized Alpaca pages into resumable immutable partitions. */
export async function ingestAlpacaBacktestDataset({
  store,
  client,
  optionSymbols = [],
  signal,
  now = () => new Date(),
}: IngestAlpacaBacktestDatasetOptions) {
  const definition: BacktestDatasetDefinitionV1 = store.definition
  const { fromDate, toDate } = definition
  const today = now().toISOString().slice(0, 10)
  if (toDate >= today) {
    throw new Error("Backtest acquisition requires fully completed historical dates")
  }
  const signalHistoryFrom = addDays(fromDate, -SIGNAL_WARMUP_CALENDAR_DAYS)
  const expirationFrom = addDays(fromDate, 14)
  const expirationTo = addDays(toDate, 30)

  await ingestPartition(store, {
    partitionKey: "calendar",
    kind: "MARKET_CALENDAR",
    request: {
      endpoint: "/v2/calendar",
      parameters: { start: signalHistoryFrom, end: toDate },
    },
    now,
    load: async () => ({
      records: await client.getCalendar({
        fromDate: signalHistoryFrom,
        toDate,
        signal,
      }),
    }),
  })

  for (const timeframe of ["1DAY", "1MINUTE"] as const) {
    const barsFromDate = timeframe === "1DAY" ? signalHistoryFrom : fromDate
    const partitionKey = timeframe === "1DAY" ? "spy-daily" : "spy-minute"
    await ingestPartition(store, {
      partitionKey,
      kind:
        timeframe === "1DAY"
          ? "UNDERLYING_DAILY_BARS"
          : "UNDERLYING_MINUTE_BARS",
      request: {
        endpoint: "/v2/stocks/bars",
        parameters: {
          symbols: "SPY",
          timeframe: timeframe === "1DAY" ? "1Day" : "1Min",
          start: barsFromDate,
          end: toDate,
          feed: "iex",
          adjustment: "all",
        },
      },
      now,
      load: (pageToken) =>
        client.getUnderlyingBarsPage({
          timeframe,
          fromDate: barsFromDate,
          toDate,
          ...(pageToken === undefined ? {} : { pageToken }),
          signal,
        }),
    })
  }

  for (const status of ["active", "inactive"] as const) {
    await ingestPartition(store, {
      partitionKey: `contracts-${status}`,
      kind: "OPTION_CONTRACTS",
      request: {
        endpoint: "/v2/options/contracts",
        parameters: {
          underlying_symbols: "SPY",
          expiration_date_gte: expirationFrom,
          expiration_date_lte: expirationTo,
          status,
        },
      },
      now,
      load: (pageToken) =>
        client.getOptionContractsPage({
          fromDate: expirationFrom,
          toDate: expirationTo,
          status,
          ...(pageToken === undefined ? {} : { pageToken }),
          signal,
        }),
    })
  }

  const symbols = [...new Set(optionSymbols)].sort()
  for (const symbolChunk of chunks(symbols, 100)) {
    const chunkId = canonicalJsonSha256(symbolChunk).slice(0, 16)
    for (const timeframe of ["1DAY", "1MINUTE"] as const) {
      await ingestPartition(store, {
        partitionKey: `option-bars-${timeframe.toLowerCase()}-${chunkId}`,
        kind: "OPTION_BARS",
        request: {
          endpoint: "/v1beta1/options/bars",
          parameters: {
            symbols: [...symbolChunk],
            timeframe: timeframe === "1DAY" ? "1Day" : "1Min",
            start: fromDate,
            end: toDate,
          },
        },
        now,
        load: (pageToken) =>
          client.getOptionBarsPage({
            contractSymbols: symbolChunk,
            timeframe,
            fromDate,
            toDate,
            ...(pageToken === undefined ? {} : { pageToken }),
            signal,
          }),
      })
    }
    await ingestPartition(store, {
      partitionKey: `option-trades-${chunkId}`,
      kind: "OPTION_TRADES",
      request: {
        endpoint: "/v1beta1/options/trades",
        parameters: {
          symbols: [...symbolChunk],
          start: fromDate,
          end: toDate,
        },
      },
      now,
      load: (pageToken) =>
        client.getOptionTradesPage({
          contractSymbols: symbolChunk,
          fromDate,
          toDate,
          ...(pageToken === undefined ? {} : { pageToken }),
          signal,
        }),
    })
  }

  return store.manifest()
}
