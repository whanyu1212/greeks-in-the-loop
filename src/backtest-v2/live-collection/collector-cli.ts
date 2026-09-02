import { readFileSync } from "node:fs"

import { parse as parseEnv } from "dotenv"

import { createAlpacaCalendarClient } from "../../market-data/alpaca-calendar-client.js"
import { newYorkDate } from "../../scheduling/research-eligibility.js"
import { createAlpacaForwardCollectionProvider } from "./alpaca-provider-v1.js"
import { createCollectionStoreV1, type CollectionModeV1 } from "./collection-store-v1.js"
import {
  DEFAULT_FORWARD_COLLECTION_SYMBOLS,
  forwardCollectionConfigV1Schema,
} from "./contracts-v1.js"
import { runForwardCollectorV1 } from "./collector-v1.js"

const fileEnv = (() => {
  try {
    return parseEnv(readFileSync(".env"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
})()
const setting = (name: string) => process.env[name] ?? fileEnv[name]
const requiredSetting = (name: string) => {
  const value = setting(name)?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const args = process.argv.slice(2)
const valueFor = (name: string) => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`)
  }
  return value
}
const allowed = new Set([
  "--mode",
  "--config",
  "--session-date",
  "--database",
  "--symbols",
  "--feed",
  "--poll-seconds",
])
for (let index = 0; index < args.length; index += 2) {
  const argument = args[index]
  if (argument === undefined || !allowed.has(argument)) {
    throw new Error(`Unknown collector argument: ${argument ?? "<missing>"}`)
  }
}

const modeValue = (valueFor("--mode") ?? "bootstrap").toUpperCase()
if (!["BOOTSTRAP", "ONCE", "SESSION"].includes(modeValue)) {
  throw new Error("--mode must be bootstrap, once, or session")
}
const mode = modeValue as CollectionModeV1
const configPath = valueFor("--config") ?? "config/backtest-v2/live-collection.json"
const rawConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
const symbolsOverride = valueFor("--symbols")
const symbols = symbolsOverride === undefined
  ? rawConfig.symbols ?? DEFAULT_FORWARD_COLLECTION_SYMBOLS
  : symbolsOverride.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)
const pollOverride = valueFor("--poll-seconds")
const config = forwardCollectionConfigV1Schema.parse({
  ...rawConfig,
  symbols,
  ...(valueFor("--database") === undefined
    ? {}
    : { databasePath: valueFor("--database") }),
  ...(valueFor("--feed") === undefined ? {} : { feed: valueFor("--feed") }),
  ...(pollOverride === undefined ? {} : { pollSeconds: Number(pollOverride) }),
})
const sessionDate = valueFor("--session-date") ?? newYorkDate(new Date())

const apiKey = requiredSetting("ALPACA_API_KEY")
const secretKey = requiredSetting("ALPACA_SECRET_KEY")
const controller = new AbortController()
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(new Error(`Collector interrupted by ${signal}`)))
}
const store = createCollectionStoreV1(config.databasePath)
try {
  const provider = createAlpacaForwardCollectionProvider({
    apiKey,
    secretKey,
    ...(setting("ALPACA_MARKET_DATA_BASE_URL") === undefined
      ? {}
      : { dataBaseUrl: setting("ALPACA_MARKET_DATA_BASE_URL") }),
    ...(setting("ALPACA_TRADING_BASE_URL") === undefined
      ? {}
      : { tradingBaseUrl: setting("ALPACA_TRADING_BASE_URL") }),
  })
  const calendar = createAlpacaCalendarClient({
    apiKey,
    secretKey,
    ...(setting("ALPACA_TRADING_BASE_URL") === undefined
      ? {}
      : { baseUrl: setting("ALPACA_TRADING_BASE_URL") }),
  })
  const report = await runForwardCollectorV1(
    { mode, sessionDate, config, signal: controller.signal },
    { provider, calendar, store },
  )
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  store.close()
}
