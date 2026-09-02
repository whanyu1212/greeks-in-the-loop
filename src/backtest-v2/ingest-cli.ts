import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync } from "node:fs"

import { historicalSourceV2Schema } from "./historical-contracts-v2.js"
import { ingestHistoricalSourceV2 } from "./historical-store-v2.js"

const usage = `Usage: pnpm backtest:v2:ingest -- --input <normalized-source.json> --database <historical.sqlite> [--manifest <manifest.json>]

Imports a strict normalized historical source into the local immutable SQLite store.
Network/provider pulling is intentionally outside this command; provider adapters must first emit the normalized source contract.`

const valueFor = (argv: readonly string[], option: string) => {
  const index = argv.indexOf(option)
  const value = index < 0 ? undefined : argv[index + 1]
  if (value === undefined || value.startsWith("--")) return undefined
  return value.trim()
}

export const runHistoricalIngestCli = (argv: readonly string[]) => {
  if (argv.includes("--help")) return `${usage}\n`
  const allowed = new Set(["--input", "--database", "--manifest"])
  for (const argument of argv) {
    if (argument.startsWith("--") && !allowed.has(argument)) throw new Error(`Unknown option: ${argument}\n${usage}`)
  }
  const inputValue = valueFor(argv, "--input")
  const databaseValue = valueFor(argv, "--database")
  const manifestValue = valueFor(argv, "--manifest")
  if (inputValue === undefined || databaseValue === undefined) throw new Error(usage)
  const inputPath = resolve(inputValue)
  const databasePath = resolve(databaseValue)
  const raw = JSON.parse(readFileSync(inputPath, "utf8")) as unknown
  const source = historicalSourceV2Schema.parse(raw)
  const manifest = ingestHistoricalSourceV2(databasePath, source)
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  if (manifestValue !== undefined) {
    const manifestPath = resolve(manifestValue)
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 })
    writeFileSync(manifestPath, serialized, { mode: 0o600 })
    return `${manifestPath}\n`
  }
  return serialized
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) process.stdout.write(runHistoricalIngestCli(process.argv.slice(2)))
