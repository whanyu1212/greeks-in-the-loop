import { existsSync, readFileSync } from "node:fs"

import { parse as parseEnv } from "dotenv"
import { z } from "zod"

import type { StoredLedgerEventV1 } from "../event-ledger/ledger-event-v1.js"
import { createSqliteLedgerStore } from "../event-ledger/sqlite-ledger-store.js"
import { buildResearchScreeningAuditReportV1 } from "./research-screening-audit-report-v1.js"

const usage = `Usage: pnpm research:audit:report -- [options]

Build a deterministic screening-audit report from the read-only SQLite ledger.

Options:
  --ledger <path>  Ledger path (default: RESEARCH_LEDGER_PATH or .state/research-ledger.sqlite)
  --from <date>    First included session date (required, YYYY-MM-DD)
  --to <date>      Last included session date (required, YYYY-MM-DD)
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
let fromSessionDate: string | undefined
let toSessionDate: string | undefined
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === "--") continue
  if (argument === "--help") {
    console.log(usage)
    process.exit(0)
  }
  if (argument === "--ledger" || argument === "--from" || argument === "--to") {
    const value = args[++index]?.trim()
    if (!value) throw new Error(`${argument} requires a value`)
    if (argument === "--ledger") ledgerPath = value
    else if (argument === "--from") fromSessionDate = z.iso.date().parse(value)
    else toSessionDate = z.iso.date().parse(value)
    continue
  }
  throw new Error(`Unknown option: ${argument ?? ""}`)
}

if (fromSessionDate === undefined || toSessionDate === undefined) {
  throw new Error("--from and --to are required")
}
if (fromSessionDate > toSessionDate) {
  throw new Error("Research screening audit report date range is reversed")
}
if (!existsSync(ledgerPath)) {
  throw new Error(`Research ledger does not exist: ${ledgerPath}`)
}

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
        "RESEARCH_SCREENING_AUDIT_RECORDED",
      ],
      limit: 1_000,
    })
    events.push(...page)
    if (page.length < 1_000) break
    afterSequence = page.at(-1)?.sequence ?? afterSequence
  }
  console.log(JSON.stringify(buildResearchScreeningAuditReportV1(events, {
    fromSessionDate,
    toSessionDate,
  }), null, 2))
} finally {
  await store.close()
}
