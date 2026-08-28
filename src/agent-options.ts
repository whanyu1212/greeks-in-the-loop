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
export const DEFAULT_ANYTIME_SHADOW_LEDGER_PATH =
  ".state/shadow-anytime.sqlite" as const

export type AgentOptions = Readonly<{
  once: boolean
  researchAnytime: boolean
  shadowAnytime: boolean
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
  let researchAnytime = false
  let shadowAnytime = false
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
    if (argument === "--shadow-anytime") {
      shadowAnytime = true
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
  if (shadowAnytime && !once) {
    throw new Error("--shadow-anytime requires --once")
  }
  if (researchAnytime && shadowAnytime) {
    throw new Error("--research-anytime and --shadow-anytime are mutually exclusive")
  }

  const normalLedgerPath =
    configuredLedgerPath?.trim() || DEFAULT_RESEARCH_LEDGER_PATH
  const ledgerPath =
    cliLedgerPath ??
    (researchAnytime
      ? DEFAULT_ANYTIME_RESEARCH_LEDGER_PATH
      : shadowAnytime
        ? DEFAULT_ANYTIME_SHADOW_LEDGER_PATH
      : normalLedgerPath)
  if (
    (researchAnytime || shadowAnytime) &&
    ledgerTargetsMatch(ledgerPath, normalLedgerPath)
  ) {
    throw new Error(
      "Anytime dry runs cannot use the configured production ledger",
    )
  }
  if (
    !researchAnytime &&
    !shadowAnytime &&
    [
      DEFAULT_ANYTIME_RESEARCH_LEDGER_PATH,
      DEFAULT_ANYTIME_SHADOW_LEDGER_PATH,
    ].some((reservedPath) => ledgerTargetsMatch(ledgerPath, reservedPath))
  ) {
    throw new Error(
      "Standard agent runs cannot use the reserved anytime dry-run ledger",
    )
  }

  return { once, researchAnytime, shadowAnytime, ledgerPath }
}
