import { readFileSync, writeFileSync } from "node:fs"

import { pathsReferToSameFile } from "./file-identity.js"
import { createBacktestDatasetStore } from "./sqlite-dataset-store.js"
import { runBacktestReplayV1 } from "./replay-v1.js"

const usage = `Usage: pnpm backtest -- --dataset <sqlite> --scenarios <json> [--output <json>]`

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
const datasetPath = option("--dataset")
const scenariosPath = option("--scenarios")
const outputPath = option("--output")
if (datasetPath === undefined || scenariosPath === undefined) throw new Error(usage)
if (
  outputPath !== undefined &&
  (pathsReferToSameFile(datasetPath, outputPath) ||
    pathsReferToSameFile(scenariosPath, outputPath))
) {
  throw new Error("Backtest output must not overwrite a replay input")
}

const store = createBacktestDatasetStore({ path: datasetPath, readonly: true })
try {
  const report = runBacktestReplayV1(
    store.manifest(),
    JSON.parse(readFileSync(scenariosPath, "utf8")) as unknown,
    store.listRecords(),
  )
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (outputPath === undefined) process.stdout.write(output)
  else writeFileSync(outputPath, output, { mode: 0o600 })
} finally {
  store.close()
}
