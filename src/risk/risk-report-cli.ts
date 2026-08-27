import { existsSync, readFileSync } from "node:fs"

import { parse as parseEnv } from "dotenv"
import { z } from "zod"

import type { StoredLedgerEventV1 } from "../event-ledger/ledger-event-v1.js"
import { createSqliteLedgerStore } from "../event-ledger/sqlite-ledger-store.js"
import { buildRiskReportV1 } from "./risk-report-v1.js"

const usage = `Usage: pnpm risk:report [options]

Read shadow risk decisions from the authoritative SQLite ledger.

Options:
  --ledger <path>  Ledger path (default: RESEARCH_LEDGER_PATH or .state/research-ledger.sqlite)
  --date <date>    Include only decisions for YYYY-MM-DD
  --help           Show this help
`

const fileEnv = (() => {
  try {
    return parseEnv(readFileSync(".env"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
})()

let ledgerPath =
  (process.env.RESEARCH_LEDGER_PATH ?? fileEnv.RESEARCH_LEDGER_PATH)?.trim() ||
  ".state/research-ledger.sqlite"
let tradingDate: string | undefined
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === "--") continue
  if (argument === "--help") {
    console.log(usage)
    process.exit(0)
  }
  if (argument === "--ledger" || argument === "--date") {
    const value = args[++index]?.trim()
    if (!value) throw new Error(`${argument} requires a value`)
    if (argument === "--ledger") ledgerPath = value
    else tradingDate = z.iso.date().parse(value)
    continue
  }
  throw new Error(`Unknown option: ${argument ?? ""}`)
}

if (!existsSync(ledgerPath)) throw new Error(`Research ledger does not exist: ${ledgerPath}`)
const store = createSqliteLedgerStore({
  path: ledgerPath,
  knownCredentialValues: [],
  readonly: true,
})
try {
  const events: StoredLedgerEventV1[] = []
  let afterSequence = 0
  while (true) {
    const page = await store.list({
      afterSequence,
      direction: "ASC",
      eventTypes: [
        "RESEARCH_CYCLE_STARTED",
        "RISK_SHADOW_DECISION_RECORDED",
        "RISK_BREAKER_LATCHED",
      ],
      limit: 1_000,
    })
    events.push(...page)
    if (page.length < 1_000) break
    afterSequence = page.at(-1)?.sequence ?? afterSequence
  }
  console.log(JSON.stringify(buildRiskReportV1(events, tradingDate), null, 2))
} finally {
  await store.close()
}
