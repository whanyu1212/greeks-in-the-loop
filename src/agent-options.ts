import {
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"

export const DEFAULT_RESEARCH_LEDGER_PATH =
  ".state/research-ledger.sqlite" as const
export const DEFAULT_ANYTIME_RESEARCH_LEDGER_PATH =
  ".state/research-anytime.sqlite" as const

export type AgentOptions = Readonly<{
  once: boolean
  researchAnytime: boolean
  ledgerPath: string
}>

const isMissingPathError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

const canonicalLedgerTargetPath = (
  ledgerPath: string,
  seenPaths = new Set<string>(),
): string => {
  const absolutePath = resolve(ledgerPath)
  if (seenPaths.has(absolutePath)) return absolutePath
  seenPaths.add(absolutePath)

  try {
    return realpathSync.native(absolutePath)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }

  try {
    if (lstatSync(absolutePath).isSymbolicLink()) {
      const linkTarget = readlinkSync(absolutePath)
      return canonicalLedgerTargetPath(
        isAbsolute(linkTarget)
          ? linkTarget
          : resolve(dirname(absolutePath), linkTarget),
        seenPaths,
      )
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }

  return resolve(
    canonicalLedgerTargetPath(dirname(absolutePath), seenPaths),
    basename(absolutePath),
  )
}

const ledgerFileIdentity = (ledgerPath: string) => {
  try {
    const stats = statSync(ledgerPath)
    return `${stats.dev}:${stats.ino}`
  } catch (error) {
    if (isMissingPathError(error)) return undefined
    throw error
  }
}

const ledgerTargetsMatch = (firstPath: string, secondPath: string) => {
  const firstCanonicalPath = canonicalLedgerTargetPath(firstPath)
  const secondCanonicalPath = canonicalLedgerTargetPath(secondPath)
  if (firstCanonicalPath === secondCanonicalPath) return true

  const firstIdentity = ledgerFileIdentity(firstPath)
  const secondIdentity = ledgerFileIdentity(secondPath)
  return firstIdentity !== undefined && firstIdentity === secondIdentity
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
