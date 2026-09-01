import "dotenv/config"

import { readFileSync, writeFileSync } from "node:fs"

import {
  AlpacaBarProxyError,
  runAlpacaBarProxyBacktest,
} from "./alpaca-bar-proxy.js"
import { pathsReferToSameFile } from "./file-identity.js"

const usage = `Usage: pnpm backtest:bars -- --manifest <json> --output <json>`

const parseOptions = (args: readonly string[]) => {
  let manifestPath: string | undefined
  let outputPath: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--") continue
    if (argument === "--help") {
      console.log(usage)
      process.exit(0)
    }
    if (argument === "--manifest" || argument === "--output") {
      const value = args[++index]?.trim()
      if (!value || value.startsWith("--")) throw new Error(usage)
      if (argument === "--manifest") manifestPath = value
      else outputPath = value
      continue
    }
    throw new Error(usage)
  }
  if (manifestPath === undefined || outputPath === undefined) throw new Error(usage)
  return { manifestPath, outputPath }
}

try {
  const { manifestPath, outputPath } = parseOptions(process.argv.slice(2))
  if (pathsReferToSameFile(manifestPath, outputPath)) {
    throw new Error("Bar-proxy output must not overwrite its manifest")
  }
  const apiKey = process.env.ALPACA_API_KEY?.trim()
  const secretKey = process.env.ALPACA_SECRET_KEY?.trim()
  if (!apiKey || !secretKey) throw new Error("Alpaca credentials are required")
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown
  } catch {
    throw new AlpacaBarProxyError("MANIFEST_INVALID")
  }
  const signal = AbortSignal.timeout(5 * 60_000)
  const dataBaseUrl = process.env.ALPACA_MARKET_DATA_BASE_URL?.trim()
  const tradingBaseUrl = process.env.ALPACA_TRADING_BASE_URL?.trim()
  const report = await runAlpacaBarProxyBacktest(manifest, {
    apiKey,
    secretKey,
    ...(dataBaseUrl ? { dataBaseUrl } : {}),
    ...(tradingBaseUrl ? { tradingBaseUrl } : {}),
    signal,
  })
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
} catch (error) {
  const message = error instanceof AlpacaBarProxyError
    ? error.code
    : error instanceof Error && [
        usage,
        "Bar-proxy output must not overwrite its manifest",
        "Alpaca credentials are required",
        "ALPACA_MARKET_DATA_BASE_URL must be a credential-free Alpaca HTTPS URL",
        "ALPACA_TRADING_BASE_URL must be a credential-free Alpaca HTTPS URL",
      ].includes(error.message)
      ? error.message
      : "BAR_PROXY_FAILED"
  console.error(message)
  process.exitCode = 1
}
