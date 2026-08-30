import { readFileSync, writeFileSync } from "node:fs"

import { pathsReferToSameFile } from "./file-identity.js"
import { runBacktestReplayV1 } from "./replay-v1.js"
import { runBacktestReplayV2 } from "./replay-v2.js"
import { createBacktestDatasetStore } from "./sqlite-dataset-store.js"

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
  const manifest = store.manifest()
  const replay = JSON.parse(readFileSync(scenariosPath, "utf8")) as unknown
  const replayVersion =
    replay !== null &&
    typeof replay === "object" &&
    "replayVersion" in replay
      ? (replay as { replayVersion?: unknown }).replayVersion
      : undefined
  const records = store.listRecords()
  const report = replayVersion === "1.0.0"
    ? runBacktestReplayV1(manifest, replay, records)
    : replayVersion === "2.0.0"
      ? runBacktestReplayV2(manifest, replay, records)
      : (() => {
          throw new Error("Backtest replay version is unsupported")
        })()
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (outputPath === undefined) process.stdout.write(output)
  else writeFileSync(outputPath, output, { mode: 0o600 })
} finally {
  store.close()
}
