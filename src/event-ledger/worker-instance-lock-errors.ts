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
