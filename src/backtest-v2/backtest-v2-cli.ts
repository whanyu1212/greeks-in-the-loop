import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { pathsReferToSameFile } from "../backtest/file-identity.js"
import {
  backtestExperimentV2Schema,
  datasetManifestV2Schema,
} from "./contracts-v2.js"
import { historicalReplayExperimentV2Schema } from "./historical-contracts-v2.js"
import { runHistoricalReplayV2 } from "./historical-replay-v2.js"
import { runBacktestV2Preflight } from "./preflight-v2.js"

const usage = `Usage: pnpm backtest:v2 -- --config <json> [--output <directory>]

Capabilities:
- SELECTION_PREFLIGHT: validates selection; output is optional.
- HISTORICAL_CHAIN_REPLAY: reconstructs chains and stores fills/P&L; output is required.`

export type BacktestV2CliOptions = Readonly<{
  configPath: string
  outputDirectory?: string
}>

const formatSchemaError = (label: string, issues: readonly { path: PropertyKey[]; message: string }[]) =>
  `${label} is invalid:\n${issues
    .map((issue) => `- ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n")}`

const parseJsonFile = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read JSON file ${path}: ${detail}`)
  }
}

export const parseBacktestV2CliOptions = (
  argv: readonly string[],
): BacktestV2CliOptions | "HELP" => {
  if (argv.includes("--help")) return "HELP"

  const allowed = new Set(["--config", "--output"])
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") continue
    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error(`${usage}\n\nUnexpected argument: ${argument ?? "<missing>"}`)
    }
    if (!allowed.has(argument)) {
      throw new Error(`${usage}\n\nUnknown option: ${argument}`)
    }
    if (values.has(argument)) throw new Error(`Duplicate option: ${argument}`)
    const value = argv[index + 1]?.trim()
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`)
    }
    values.set(argument, value)
    index += 1
  }

  const configPath = values.get("--config")
  if (configPath === undefined) throw new Error(usage)
  const outputDirectory = values.get("--output")
  return outputDirectory === undefined
    ? { configPath }
    : { configPath, outputDirectory }
}

export const runBacktestV2Cli = (options: BacktestV2CliOptions): string => {
  const configPath = resolve(options.configPath)
  const rawExperiment = parseJsonFile(configPath)
  const historicalExperiment = historicalReplayExperimentV2Schema.safeParse(rawExperiment)
  if (historicalExperiment.success) {
    if (options.outputDirectory === undefined) {
      throw new Error("--output is required for HISTORICAL_CHAIN_REPLAY")
    }
    const outputDirectory = resolve(options.outputDirectory)
    const runLedgerPath = join(outputDirectory, "run.sqlite")
    if (existsSync(runLedgerPath)) {
      throw new Error(`Immutable Backtest V2 run ledger already exists: ${runLedgerPath}`)
    }
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
    const resolvedExperiment = {
      ...historicalExperiment.data,
      databasePath: resolve(historicalExperiment.data.databasePath),
    }
    const report = runHistoricalReplayV2(resolvedExperiment, outputDirectory)
    const summaryPath = join(outputDirectory, "summary.json")
    const resolvedConfigPath = join(outputDirectory, "config-resolved.json")
    writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    writeFileSync(resolvedConfigPath, `${JSON.stringify(resolvedExperiment, null, 2)}\n`, { mode: 0o600 })
    return `${summaryPath}\n`
  }

  const parsedExperiment = backtestExperimentV2Schema.safeParse(rawExperiment)
  if (!parsedExperiment.success) {
    throw new Error(formatSchemaError(
      "Backtest V2 experiment",
      historicalExperiment.error.issues.length <= parsedExperiment.error.issues.length
        ? historicalExperiment.error.issues
        : parsedExperiment.error.issues,
    ))
  }

  const manifestRef = parsedExperiment.data.datasetManifestRef
  const manifestPath = isAbsolute(manifestRef)
    ? manifestRef
    : resolve(manifestRef)
  const parsedManifest = datasetManifestV2Schema.safeParse(
    parseJsonFile(manifestPath),
  )
  if (!parsedManifest.success) {
    throw new Error(
      formatSchemaError("Backtest V2 dataset manifest", parsedManifest.error.issues),
    )
  }

  const report = runBacktestV2Preflight(
    parsedExperiment.data,
    parsedManifest.data,
  )
  const serializedReport = `${JSON.stringify(report, null, 2)}\n`
  if (options.outputDirectory === undefined) return serializedReport

  const outputDirectory = resolve(options.outputDirectory)
  const summaryPath = join(outputDirectory, "summary.json")
  const resolvedConfigPath = join(outputDirectory, "config-resolved.json")
  for (const inputPath of [configPath, manifestPath]) {
    if (
      pathsReferToSameFile(inputPath, summaryPath) ||
      pathsReferToSameFile(inputPath, resolvedConfigPath)
    ) {
      throw new Error("Backtest V2 output must not overwrite an input")
    }
  }

  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
  writeFileSync(summaryPath, serializedReport, { mode: 0o600 })
  writeFileSync(
    resolvedConfigPath,
    `${JSON.stringify(parsedExperiment.data, null, 2)}\n`,
    { mode: 0o600 },
  )
  return `${summaryPath}\n`
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const options = parseBacktestV2CliOptions(process.argv.slice(2))
  if (options === "HELP") console.log(usage)
  else process.stdout.write(runBacktestV2Cli(options))
}
