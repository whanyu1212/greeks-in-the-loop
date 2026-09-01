import { existsSync, readFileSync } from "node:fs"

import { parse as parseEnv } from "dotenv"

import { createSqliteLedgerStore } from "../event-ledger/sqlite-ledger-store.js"
import { loadResearchRunV1 } from "../research/run/artifact.js"
import { evaluateResearchRunV1 } from "./research-run-evaluation-v1.js"

type Options = Readonly<{
  ledgerPath: string
  cycleId?: string
}>

const usage = `Usage: pnpm research:evaluate [options]

Evaluate one completed research run from the authoritative SQLite ledger.

Options:
  --ledger <path>   Ledger path (default: RESEARCH_LEDGER_PATH from the environment or .env)
  --cycle <id>      Cycle to evaluate (default: latest completed cycle)
  --help            Show this help
`

const fileEnv = (() => {
  try {
    return parseEnv(readFileSync(".env"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
})()

const parseOptions = (args: readonly string[]): Options => {
  let ledgerPath =
    (process.env.RESEARCH_LEDGER_PATH ?? fileEnv.RESEARCH_LEDGER_PATH)?.trim() ||
    ".state/research-ledger.sqlite"
  let cycleId: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--") continue
    if (argument === "--help") {
      console.log(usage)
      process.exit(0)
    }
    if (argument === "--ledger" || argument === "--cycle") {
      const value = args[++index]?.trim()
      if (!value) throw new Error(`${argument} requires a value`)
      if (argument === "--ledger") ledgerPath = value
      if (argument === "--cycle") cycleId = value
      continue
    }
    throw new Error(`Unknown option: ${argument ?? ""}`)
  }

  return {
    ledgerPath,
    ...(cycleId === undefined ? {} : { cycleId }),
  }
}

const options = parseOptions(process.argv.slice(2))
if (!existsSync(options.ledgerPath)) {
  throw new Error(`Research ledger does not exist: ${options.ledgerPath}`)
}

const store = createSqliteLedgerStore({
  path: options.ledgerPath,
  knownCredentialValues: [],
  readonly: true,
})
try {
  const cycleId =
    options.cycleId ??
    (
      await store.list({
        eventTypes: ["RESEARCH_CYCLE_COMPLETED"],
        direction: "DESC",
        limit: 1,
      })
    )[0]?.cycleId
  if (cycleId === undefined) throw new Error("No completed research cycle was found")

  const run = await loadResearchRunV1(store, cycleId)
  console.log(JSON.stringify(evaluateResearchRunV1(run), null, 2))
} finally {
  await store.close()
}
