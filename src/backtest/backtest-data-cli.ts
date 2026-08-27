import { existsSync, readFileSync } from "node:fs"

import { parse as parseEnv } from "dotenv"
import { z } from "zod"

import {
  BACKTEST_DATASET_VERSION,
  BACKTEST_NORMALIZATION_VERSION,
  type BacktestDatasetDefinitionV1,
} from "./dataset-v1.js"
import { ingestAlpacaBacktestDataset } from "./ingest-alpaca.js"
import { createBacktestDatasetStore } from "./sqlite-dataset-store.js"
import { createAlpacaHistoricalClient } from "../market-data/alpaca-historical-client.js"

const usage = `Usage: pnpm backtest:data -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Create or resume a normalized Alpaca replay dataset.

Options:
  --from <date>       First replay date (required)
  --to <date>         Last replay date (required)
  --dataset <path>    SQLite dataset path (default: .state/backtests/<id>.sqlite)
  --dataset-id <id>   Stable dataset identifier
  --option <symbol>   Retained SPY option symbol to acquire; repeatable
  --help              Show this help
`

const fileEnv = (() => {
  try {
    return parseEnv(readFileSync(".env"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
})()

const setting = (name: string) =>
  (process.env[name] ?? fileEnv[name])?.trim()

const parseOptions = (args: readonly string[]) => {
  let fromDate: string | undefined
  let toDate: string | undefined
  let datasetPath: string | undefined
  let datasetId: string | undefined
  const optionSymbols: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--") continue
    if (argument === "--help") {
      console.log(usage)
      process.exit(0)
    }
    if (
      argument === "--from" ||
      argument === "--to" ||
      argument === "--dataset" ||
      argument === "--dataset-id" ||
      argument === "--option"
    ) {
      const value = args[++index]?.trim()
      if (!value) throw new Error(`${argument} requires a value`)
      if (argument === "--from") fromDate = z.iso.date().parse(value)
      if (argument === "--to") toDate = z.iso.date().parse(value)
      if (argument === "--dataset") datasetPath = value
      if (argument === "--dataset-id") datasetId = value
      if (argument === "--option") optionSymbols.push(value)
      continue
    }
    throw new Error(`Unknown option: ${argument ?? ""}`)
  }
  if (fromDate === undefined || toDate === undefined) {
    throw new Error("--from and --to are required")
  }
  if (fromDate > toDate) throw new Error("--to cannot precede --from")
  const resolvedId = datasetId ?? `SPY-${fromDate}-${toDate}`
  return {
    fromDate,
    toDate,
    datasetId: resolvedId,
    datasetPath: datasetPath ?? `.state/backtests/${resolvedId}.sqlite`,
    optionSymbols,
  }
}

const options = parseOptions(process.argv.slice(2))
const apiKey = setting("ALPACA_API_KEY")
const secretKey = setting("ALPACA_SECRET_KEY")
const dataBaseUrl = setting("ALPACA_MARKET_DATA_BASE_URL")
const tradingBaseUrl = setting("ALPACA_TRADING_BASE_URL")
if (!apiKey || !secretKey) throw new Error("Alpaca credentials are required")

const definition: BacktestDatasetDefinitionV1 = {
  datasetVersion: BACKTEST_DATASET_VERSION,
  normalizationVersion: BACKTEST_NORMALIZATION_VERSION,
  datasetId: options.datasetId,
  symbol: "SPY",
  fromDate: options.fromDate,
  toDate: options.toDate,
  optionHistoricalFeed: "ALPACA_ACCOUNT_DEFAULT",
  createdAt: new Date().toISOString(),
}
const store = createBacktestDatasetStore({
  path: options.datasetPath,
  ...(existsSync(options.datasetPath) ? {} : { definition }),
  knownCredentialValues: [apiKey, secretKey],
})
if (
  store.definition.datasetId !== options.datasetId ||
  store.definition.fromDate !== options.fromDate ||
  store.definition.toDate !== options.toDate ||
  store.definition.optionHistoricalFeed !== "ALPACA_ACCOUNT_DEFAULT"
) {
  store.close()
  throw new Error("CLI options do not match the existing backtest dataset")
}

const controller = new AbortController()
const stop = () => controller.abort(new Error("Backtest acquisition interrupted"))
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
try {
  const client = createAlpacaHistoricalClient({
    apiKey,
    secretKey,
    ...(dataBaseUrl === undefined ? {} : { dataBaseUrl }),
    ...(tradingBaseUrl === undefined ? {} : { tradingBaseUrl }),
  })
  const manifest = await ingestAlpacaBacktestDataset({
    store,
    client,
    optionSymbols: options.optionSymbols,
    signal: controller.signal,
  })
  console.log(JSON.stringify(manifest, null, 2))
} finally {
  process.removeListener("SIGINT", stop)
  process.removeListener("SIGTERM", stop)
  store.close()
}
