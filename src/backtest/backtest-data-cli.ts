import { existsSync, readFileSync } from "node:fs"

import { parse as parseEnv } from "dotenv"
import { z } from "zod"

import { createBacktestDatasetDefinitionV2 } from "./dataset-v2.js"
import { ingestAlpacaBacktestDataset } from "./ingest-alpaca.js"
import { createBacktestDatasetStore } from "./sqlite-dataset-store.js"
import { createAlpacaHistoricalClient } from "../market-data/alpaca-historical-client.js"
import { CURRENT_STRATEGY_MANIFEST } from "../strategy/strategy-registry.js"

const usage = `Usage: pnpm backtest:data -- --from YYYY-MM-DD --to YYYY-MM-DD [options]

Create or resume a normalized Alpaca replay dataset.

Options:
  --from <date>       First replay date (required)
  --to <date>         Last replay date (required)
  --dataset <path>    SQLite dataset path (default: .state/backtests/<content-id>.sqlite)
  --option <symbol>   Retained option symbol matching the selected strategy underlying; repeatable
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
      argument === "--option"
    ) {
      const value = args[++index]?.trim()
      if (!value) throw new Error(`${argument} requires a value`)
      if (argument === "--from") fromDate = z.iso.date().parse(value)
      if (argument === "--to") toDate = z.iso.date().parse(value)
      if (argument === "--dataset") datasetPath = value
      if (argument === "--option") optionSymbols.push(value)
      continue
    }
    throw new Error(`Unknown option: ${argument ?? ""}`)
  }
  if (fromDate === undefined || toDate === undefined) {
    throw new Error("--from and --to are required")
  }
  if (fromDate > toDate) throw new Error("--to cannot precede --from")
  return {
    fromDate,
    toDate,
    datasetPath,
    optionSymbols: [...new Set(optionSymbols)].sort(),
  }
}

const options = parseOptions(process.argv.slice(2))
const apiKey = setting("ALPACA_API_KEY")
const secretKey = setting("ALPACA_SECRET_KEY")
const dataBaseUrl = setting("ALPACA_MARKET_DATA_BASE_URL")
const tradingBaseUrl = setting("ALPACA_TRADING_BASE_URL")
if (!apiKey || !secretKey) throw new Error("Alpaca credentials are required")

const definition = createBacktestDatasetDefinitionV2({
  strategyManifest: CURRENT_STRATEGY_MANIFEST,
  fromDate: options.fromDate,
  toDate: options.toDate,
  optionSymbols: options.optionSymbols,
  requestStartedAt: new Date().toISOString(),
})
const datasetPath =
  options.datasetPath ?? `.state/backtests/${definition.datasetId}.sqlite`
const store = createBacktestDatasetStore({
  path: datasetPath,
  ...(existsSync(datasetPath) ? {} : { definition }),
  knownCredentialValues: [apiKey, secretKey],
})
if (
  store.definition.datasetId !== definition.datasetId ||
  store.definition.fromDate !== options.fromDate ||
  store.definition.toDate !== options.toDate ||
  store.definition.optionHistoricalFeed !== "ALPACA_ACCOUNT_DEFAULT" ||
  JSON.stringify(store.definition.optionSymbols) !==
    JSON.stringify(options.optionSymbols)
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
    signal: controller.signal,
  })
  console.log(JSON.stringify(manifest, null, 2))
} finally {
  process.removeListener("SIGINT", stop)
  process.removeListener("SIGTERM", stop)
  store.close()
}
