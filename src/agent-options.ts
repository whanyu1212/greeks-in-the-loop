import { statSync } from "node:fs"
import { resolve } from "node:path"

export const DEFAULT_RESEARCH_LEDGER_PATH =
  ".state/research-ledger.sqlite" as const
export const DEFAULT_ANYTIME_RESEARCH_LEDGER_PATH =
  ".state/research-anytime.sqlite" as const

export type AgentOptions = Readonly<{
  once: boolean
  researchAnytime: boolean
  ledgerPath: string
}>

const ledgerTargetsMatch = (firstPath: string, secondPath: string) => {
  if (resolve(firstPath) === resolve(secondPath)) return true

  try {
    const first = statSync(firstPath)
    const second = statSync(secondPath)
    return first.dev === second.dev && first.ino === second.ino
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

/** Parses the worker CLI and checks existing ledger targets for aliasing. */
export function parseAgentOptions(
  args: readonly string[],
  configuredLedgerPath?: string,
): AgentOptions {
  let once = false
  let researchAnytime = false
  let cliLedgerPath: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--") continue
    if (argument === "--once") {
      once = true
      continue
    }
    if (argument === "--research-anytime") {
      researchAnytime = true
      continue
    }
    if (argument === "--ledger") {
      if (cliLedgerPath !== undefined) {
        throw new Error("--ledger may be provided only once")
      }
      const value = args[++index]?.trim()
      if (!value) throw new Error("--ledger requires a value")
      cliLedgerPath = value
      continue
    }
    throw new Error(`Unknown option: ${argument ?? ""}`)
  }

  if (researchAnytime && !once) {
    throw new Error("--research-anytime requires --once")
  }

  const normalLedgerPath =
    configuredLedgerPath?.trim() || DEFAULT_RESEARCH_LEDGER_PATH
  const ledgerPath =
    cliLedgerPath ??
    (researchAnytime
      ? DEFAULT_ANYTIME_RESEARCH_LEDGER_PATH
      : normalLedgerPath)
  if (
    researchAnytime &&
    ledgerTargetsMatch(ledgerPath, normalLedgerPath)
  ) {
    throw new Error(
      "--research-anytime cannot use the configured production ledger",
    )
  }

  return { once, researchAnytime, ledgerPath }
}
