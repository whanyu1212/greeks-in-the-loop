import {
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"

export const DEFAULT_RESEARCH_LEDGER_PATH =
  ".state/research-ledger.sqlite" as const
export const DEFAULT_DRY_RUN_LEDGER_PATH = ".state/dry-run.sqlite" as const

export type AgentOptions = Readonly<{
  once: boolean
  dryRun: boolean
  sessionDate?: string
  ledgerPath: string
}>

const isMissingPathError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

/** Resolves an existing ledger or its nearest existing parent to a stable target. */
export const canonicalLedgerTargetPath = (
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

const alternateAsciiCase = (value: string) => {
  const index = value.search(/[A-Za-z]/u)
  if (index === -1) return value
  const character = value[index]!
  const alternate =
    character === character.toLowerCase()
      ? character.toUpperCase()
      : character.toLowerCase()
  return `${value.slice(0, index)}${alternate}${value.slice(index + 1)}`
}

const pathLookupMayFoldCase = (targetPath: string): boolean => {
  let currentPath = targetPath

  while (true) {
    try {
      const currentStats = lstatSync(currentPath)
      const currentName = basename(currentPath)
      const alternateName = alternateAsciiCase(currentName)
      if (alternateName !== currentName) {
        try {
          const alternateStats = lstatSync(
            resolve(dirname(currentPath), alternateName),
          )
          return (
            currentStats.dev === alternateStats.dev &&
            currentStats.ino === alternateStats.ino
          )
        } catch (error) {
          if (isMissingPathError(error)) return false
          throw error
        }
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }

    const parentPath = dirname(currentPath)
    if (parentPath === currentPath) {
      return process.platform === "darwin" || process.platform === "win32"
    }
    currentPath = parentPath
  }
}

const ledgerTargetsMatch = (firstPath: string, secondPath: string) => {
  const firstCanonicalPath = canonicalLedgerTargetPath(firstPath)
  const secondCanonicalPath = canonicalLedgerTargetPath(secondPath)
  if (firstCanonicalPath === secondCanonicalPath) return true

  const firstIdentity = ledgerFileIdentity(firstPath)
  const secondIdentity = ledgerFileIdentity(secondPath)
  if (firstIdentity !== undefined || secondIdentity !== undefined) {
    return firstIdentity !== undefined && firstIdentity === secondIdentity
  }

  return (
    firstCanonicalPath.toLowerCase() === secondCanonicalPath.toLowerCase() &&
    (pathLookupMayFoldCase(firstCanonicalPath) ||
      pathLookupMayFoldCase(secondCanonicalPath))
  )
}

/** Parses the worker CLI and checks existing ledger targets for aliasing. */
export function parseAgentOptions(
  args: readonly string[],
  configuredLedgerPath?: string,
): AgentOptions {
  let once = false
  let dryRun = false
  let sessionDate: string | undefined
  let cliLedgerPath: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--") continue
    if (argument === "--once") {
      once = true
      continue
    }
    if (argument === "--dry-run") {
      dryRun = true
      continue
    }
    if (argument === "--session") {
      if (sessionDate !== undefined) {
        throw new Error("--session may be provided only once")
      }
      const value = args[++index]?.trim()
      if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
        throw new Error("--session requires YYYY-MM-DD")
      }
      const parsed = Date.parse(`${value}T00:00:00.000Z`)
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
        throw new Error("--session requires a valid calendar date")
      }
      sessionDate = value
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

  if (dryRun && !once) throw new Error("--dry-run requires --once")
  if (sessionDate !== undefined && !dryRun) {
    throw new Error("--session requires --dry-run")
  }

  const normalLedgerPath =
    configuredLedgerPath?.trim() || DEFAULT_RESEARCH_LEDGER_PATH
  const ledgerPath =
    cliLedgerPath ?? (dryRun ? DEFAULT_DRY_RUN_LEDGER_PATH : normalLedgerPath)
  if (dryRun && ledgerTargetsMatch(ledgerPath, normalLedgerPath)) {
    throw new Error("Dry runs cannot use the configured production ledger")
  }
  if (
    !dryRun &&
    ledgerTargetsMatch(ledgerPath, DEFAULT_DRY_RUN_LEDGER_PATH)
  ) {
    throw new Error("Standard agent runs cannot use the dry-run ledger")
  }

  return {
    once,
    dryRun,
    ...(sessionDate === undefined ? {} : { sessionDate }),
    ledgerPath,
  }
}
