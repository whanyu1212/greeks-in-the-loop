import Database from "better-sqlite3"
import { chmodSync, lstatSync, statSync } from "node:fs"

import { canonicalLedgerTargetPath } from "./agent-options.js"

const WORKER_LOCK_SUFFIX = ".worker-lock.sqlite" as const

export type WorkerInstanceLock = Readonly<{
  release(): void
}>

export type WorkerInstanceLockOptions = Readonly<{
  ledgerPath: string
}>

/** Indicates that another process currently owns the selected worker ledger. */
export class WorkerInstanceLockUnavailableError extends Error {
  constructor() {
    super(
      "Another worker already owns the selected ledger. Stop it and wait for shutdown to complete before starting another worker.",
    )
    this.name = "WorkerInstanceLockUnavailableError"
  }
}

/** Indicates that exclusive worker ownership could not be established safely. */
export class WorkerInstanceLockInitializationError extends Error {
  constructor() {
    super("The worker ownership lock could not be initialized safely.")
    this.name = "WorkerInstanceLockInitializationError"
  }
}

/** Indicates that a held worker lock could not be released cleanly. */
export class WorkerInstanceLockReleaseError extends Error {
  constructor() {
    super("The worker ownership lock could not be released cleanly.")
    this.name = "WorkerInstanceLockReleaseError"
  }
}

const isMissingPathError = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

const isSqliteContention = (error: unknown) => {
  const code = (error as { code?: unknown }).code
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
}

const assertLedgerHasOneFilesystemName = (ledgerPath: string) => {
  try {
    if (statSync(ledgerPath).nlink > 1) {
      throw new WorkerInstanceLockInitializationError()
    }
  } catch (error) {
    if (error instanceof WorkerInstanceLockInitializationError) throw error
    if (!isMissingPathError(error)) {
      throw new WorkerInstanceLockInitializationError()
    }
  }
}

const assertSafeExistingLockTarget = (lockPath: string) => {
  try {
    const stats = lstatSync(lockPath)
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
      throw new WorkerInstanceLockInitializationError()
    }
  } catch (error) {
    if (error instanceof WorkerInstanceLockInitializationError) throw error
    if (!isMissingPathError(error)) {
      throw new WorkerInstanceLockInitializationError()
    }
  }
}

/** Returns the persistent sidecar used to coordinate one selected ledger. */
export const workerInstanceLockPath = (ledgerPath: string) =>
  `${canonicalLedgerTargetPath(ledgerPath)}${WORKER_LOCK_SUFFIX}`

/**
 * Acquires exclusive, process-lifetime ownership of one canonical worker ledger.
 *
 * The sidecar file persists across runs. Ownership is represented only by the
 * live SQLite exclusive transaction, which the operating system releases when
 * the process closes or crashes.
 */
export function acquireWorkerInstanceLock({
  ledgerPath,
}: WorkerInstanceLockOptions): WorkerInstanceLock {
  const canonicalLedgerPath = canonicalLedgerTargetPath(ledgerPath)
  assertLedgerHasOneFilesystemName(canonicalLedgerPath)
  const lockPath = `${canonicalLedgerPath}${WORKER_LOCK_SUFFIX}`
  assertSafeExistingLockTarget(lockPath)

  let database: Database.Database | undefined
  try {
    database = new Database(lockPath, { timeout: 0 })
    database.pragma("busy_timeout = 0")
    database.exec("BEGIN EXCLUSIVE")
    chmodSync(lockPath, 0o600)
  } catch (error) {
    try {
      if (database?.open) database.close()
    } catch {
      // Acquisition still fails closed with a bounded primary error below.
    }
    if (isSqliteContention(error)) {
      throw new WorkerInstanceLockUnavailableError()
    }
    throw new WorkerInstanceLockInitializationError()
  }

  let released = false
  return {
    release() {
      if (released) return

      let releaseFailed = false
      try {
        if (database.inTransaction) database.exec("ROLLBACK")
      } catch {
        releaseFailed = true
      } finally {
        try {
          if (database.open) database.close()
        } catch {
          releaseFailed = true
        }
      }
      released = !database.open
      if (releaseFailed) throw new WorkerInstanceLockReleaseError()
    },
  }
}

/** Runs one worker body while guaranteeing final lock release. */
export async function runWithWorkerInstanceLock<T>(
  options: WorkerInstanceLockOptions,
  run: () => Promise<T>,
): Promise<T> {
  const lock = acquireWorkerInstanceLock(options)
  let runFailed = false
  try {
    return await run()
  } catch (error) {
    runFailed = true
    throw error
  } finally {
    try {
      lock.release()
    } catch (error) {
      if (!runFailed) throw error
    }
  }
}
