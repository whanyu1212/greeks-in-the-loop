import { readFileSync, writeFileSync } from "node:fs"

import { pathsReferToSameFile } from "./file-identity.js"
import { runBacktestReplay } from "./replay.js"

const usage = `Usage: pnpm backtest -- --scenarios <json> [--output <json>]`

const option = (name: string) => {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]?.trim()
  if (value === undefined || value.startsWith("--")) return undefined
  return value
}

if (process.argv.includes("--help")) {
  console.log(usage)
  process.exit(0)
}
const scenariosPath = option("--scenarios")
const outputPath = option("--output")
if (scenariosPath === undefined) throw new Error(usage)
if (
  outputPath !== undefined &&
  pathsReferToSameFile(scenariosPath, outputPath)
) {
  throw new Error("Backtest output must not overwrite a replay input")
}
const replay = JSON.parse(readFileSync(scenariosPath, "utf8")) as unknown
const output = `${JSON.stringify(runBacktestReplay(replay), null, 2)}\n`
if (outputPath === undefined) process.stdout.write(output)
else writeFileSync(outputPath, output, { mode: 0o600 })
