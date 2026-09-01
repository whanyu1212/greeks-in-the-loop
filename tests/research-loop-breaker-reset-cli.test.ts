import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createResearchLifecycleRecorder } from "../src/event-ledger/research-lifecycle-recorder.js"
import { createSqliteLedgerStore } from "../src/event-ledger/sqlite-ledger-store.js"
import { acquireWorkerInstanceLock } from "../src/worker-instance-lock.js"

const temporaryDirectories: string[] = []
const workerEntrypoint = resolve("src/index.ts")
const resetEntrypoint = resolve(
  "src/event-ledger/research-loop-breaker-reset-cli.ts",
)

const createLedgerPath = () => {
  const directory = mkdtempSync(join(tmpdir(), "research-breaker-test-"))
  temporaryDirectories.push(directory)
  return join(directory, "ledger.sqlite")
}

const run = (entrypoint: string, args: readonly string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", entrypoint, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ALPACA_API_KEY: "breaker-test-key",
      ALPACA_SECRET_KEY: "breaker-test-secret",
      OTEL_SDK_DISABLED: "true",
    },
  })

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

describe("research-loop breaker reset command", () => {
  it("blocks worker startup, resets idempotently, and refuses a missing ledger", async () => {
    const ledgerPath = createLedgerPath()
    const store = createSqliteLedgerStore({
      path: ledgerPath,
      knownCredentialValues: [],
    })
    await store.migrate()
    await createResearchLifecycleRecorder({ store }).recordResearchLoopBreakerLatched({
      consecutiveFailures: 5,
      threshold: 5,
      lastAttempt: 5,
    })
    await store.close()

    const blocked = run(workerEntrypoint, ["--once", "--ledger", ledgerPath])
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain("Research loop breaker is latched")
    expect(blocked.stderr).toContain("agent:reset-breaker")

    const reset = run(resetEntrypoint, ["--ledger", ledgerPath])
    expect(reset.status).toBe(0)
    expect(reset.stdout).toContain("Research loop breaker reset")

    const reader = createSqliteLedgerStore({
      path: ledgerPath,
      knownCredentialValues: [],
      readonly: true,
    })
    await expect(
      createResearchLifecycleRecorder({
        store: reader,
      }).loadResearchLoopBreakerState(),
    ).resolves.toEqual({ latched: false })
    await reader.close()

    const repeated = run(resetEntrypoint, ["--ledger", ledgerPath])
    expect(repeated.status).toBe(0)
    expect(repeated.stdout).toContain("already reset")

    const lock = acquireWorkerInstanceLock({ ledgerPath })
    try {
      expect(run(resetEntrypoint, ["--ledger", ledgerPath]).status).not.toBe(0)
    } finally {
      lock.release()
    }

    const missingPath = join(dirname(ledgerPath), "missing.sqlite")
    const missing = run(resetEntrypoint, ["--ledger", missingPath])
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain("Research ledger does not exist")
    expect(existsSync(missingPath)).toBe(false)
  }, 15_000)
})
