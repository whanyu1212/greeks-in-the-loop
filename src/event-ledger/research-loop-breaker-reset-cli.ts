import { existsSync, readFileSync } from "node:fs"

import { parse as parseEnv } from "dotenv"

import { DEFAULT_RESEARCH_LEDGER_PATH } from "../agent-options.js"
import { runWithWorkerInstanceLock } from "../worker-instance-lock.js"
import { createResearchLifecycleRecorder } from "./research-lifecycle-recorder.js"
import { createSqliteLedgerStore } from "./sqlite-ledger-store.js"

const usage = `Usage: pnpm agent:reset-breaker [options]

Reset a latched research-loop failure breaker.

Options:
  --ledger <path>  Ledger path (default: RESEARCH_LEDGER_PATH or ${DEFAULT_RESEARCH_LEDGER_PATH})
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
  DEFAULT_RESEARCH_LEDGER_PATH
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === "--") continue
  if (argument === "--help") {
    console.log(usage)
    process.exit(0)
  }
  if (argument === "--ledger") {
    const value = args[++index]?.trim()
    if (!value) throw new Error("--ledger requires a value")
    ledgerPath = value
    continue
  }
  throw new Error(`Unknown option: ${argument ?? ""}`)
}

await runWithWorkerInstanceLock({ ledgerPath }, async () => {
  if (!existsSync(ledgerPath)) {
    throw new Error(`Research ledger does not exist: ${ledgerPath}`)
  }
  const store = createSqliteLedgerStore({
    path: ledgerPath,
    knownCredentialValues: [],
    fileMustExist: true,
  })
  try {
    await store.migrate()
    const recorder = createResearchLifecycleRecorder({ store })
    const state = await recorder.loadResearchLoopBreakerState()
    if (!state.latched) {
      console.log("Research loop breaker is already reset")
      return
    }
    await recorder.recordResearchLoopBreakerReset()
    console.log("Research loop breaker reset")
  } finally {
    await store.close()
  }
})
