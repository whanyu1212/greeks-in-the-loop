import { fork, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import {
  acquireWorkerInstanceLock,
  runWithWorkerInstanceLock,
  workerInstanceLockPath,
} from "../src/event-ledger/deprecated/worker-instance-lock.js"
import {
  WorkerInstanceLockInitializationError,
  WorkerInstanceLockUnavailableError,
} from "../src/event-ledger/worker-instance-lock-errors.js"

const fixturePath = fileURLToPath(
  new URL("fixtures/worker-lock-holder.ts", import.meta.url),
)
const workerEntrypointPath = fileURLToPath(
  new URL("../src/index.ts", import.meta.url),
)
const temporaryDirectories: string[] = []
const children = new Set<ChildProcess>()

const createLedgerPath = () => {
  const directory = mkdtempSync(join(tmpdir(), "worker-instance-lock-test-"))
  temporaryDirectories.push(directory)
  return join(directory, "ledger.sqlite")
}

const waitForLock = (child: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for child worker lock")),
      5_000,
    )
    const onMessage = (message: unknown) => {
      if (message === "LOCKED") finish()
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`Lock holder exited early (${code ?? signal ?? "unknown"})`))
    const onError = (error: Error) => finish(error)

    function finish(error?: Error) {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
      child.off("error", onError)
      if (error === undefined) resolve()
      else reject(error)
    }

    child.on("message", onMessage)
    child.once("exit", onExit)
    child.once("error", onError)
  })

const spawnLockHolder = async (
  ledgerPath: string,
  releaseOnSignal = false,
) => {
  const child = fork(
    fixturePath,
    [ledgerPath, ...(releaseOnSignal ? ["release-on-signal"] : [])],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  )
  children.add(child)
  child.once("exit", () => children.delete(child))
  await waitForLock(child)
  return child
}

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      await exited
    }),
  )
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("worker instance lock", () => {
  it("fails fast before entering a second protected worker body", async () => {
    const ledgerPath = createLedgerPath()
    const first = acquireWorkerInstanceLock({ ledgerPath })
    let entered = false

    await expect(
      runWithWorkerInstanceLock({ ledgerPath }, async () => {
        entered = true
      }),
    ).rejects.toBeInstanceOf(WorkerInstanceLockUnavailableError)
    expect(entered).toBe(false)

    first.release()
  })

  it("supports clean, idempotent release and persistent-sidecar reacquisition", () => {
    const ledgerPath = createLedgerPath()
    const lockPath = workerInstanceLockPath(ledgerPath)
    const first = acquireWorkerInstanceLock({ ledgerPath })

    expect(existsSync(lockPath)).toBe(true)
    if (process.platform !== "win32") {
      expect(statSync(lockPath).mode & 0o777).toBe(0o600)
    }

    first.release()
    first.release()
    expect(existsSync(lockPath)).toBe(true)

    const second = acquireWorkerInstanceLock({ ledgerPath })
    second.release()
  })

  it("releases ownership when the protected worker body fails", async () => {
    const ledgerPath = createLedgerPath()
    const failure = new Error("worker failed")

    await expect(
      runWithWorkerInstanceLock({ ledgerPath }, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    const restarted = acquireWorkerInstanceLock({ ledgerPath })
    restarted.release()
  })

  it("maps canonical and symlink-parent ledger paths to one owner", () => {
    const directory = mkdtempSync(join(tmpdir(), "worker-lock-alias-test-"))
    temporaryDirectories.push(directory)
    const realDirectory = join(directory, "real")
    const aliasDirectory = join(directory, "alias")
    mkdirSync(realDirectory)
    symlinkSync(realDirectory, aliasDirectory, "dir")

    const owner = acquireWorkerInstanceLock({
      ledgerPath: join(realDirectory, "ledger.sqlite"),
    })
    expect(() =>
      acquireWorkerInstanceLock({
        ledgerPath: join(aliasDirectory, "ledger.sqlite"),
      })
    ).toThrow(WorkerInstanceLockUnavailableError)
    owner.release()
  })

  it("rejects hard-linked ledgers and unsafe lock targets", () => {
    const ledgerPath = createLedgerPath()
    const aliasPath = join(ledgerPath, "..", "ledger-alias.sqlite")
    writeFileSync(ledgerPath, "")
    linkSync(ledgerPath, aliasPath)

    expect(() => acquireWorkerInstanceLock({ ledgerPath })).toThrow(
      WorkerInstanceLockInitializationError,
    )

    rmSync(aliasPath)
    const lockPath = workerInstanceLockPath(ledgerPath)
    const targetPath = join(ledgerPath, "..", "unexpected-target")
    writeFileSync(targetPath, "")
    symlinkSync(targetPath, lockPath)
    expect(() => acquireWorkerInstanceLock({ ledgerPath })).toThrow(
      WorkerInstanceLockInitializationError,
    )

    rmSync(lockPath)
    linkSync(targetPath, lockPath)
    expect(() => acquireWorkerInstanceLock({ ledgerPath })).toThrow(
      WorkerInstanceLockInitializationError,
    )
  })

  it("returns bounded, provider-free contention diagnostics", () => {
    const ledgerPath = createLedgerPath()
    const owner = acquireWorkerInstanceLock({ ledgerPath })

    try {
      acquireWorkerInstanceLock({ ledgerPath })
      throw new Error("Expected lock contention")
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerInstanceLockUnavailableError)
      expect((error as Error).message.length).toBeLessThanOrEqual(160)
      expect((error as Error).message).not.toContain(ledgerPath)
      expect((error as Error).message).not.toContain("SQLITE")
    } finally {
      owner.release()
    }
  })

  it("rejects the real worker entrypoint before runtime startup", async () => {
    const ledgerPath = createLedgerPath()
    const owner = acquireWorkerInstanceLock({ ledgerPath })
    const child = fork(
      workerEntrypointPath,
      ["--once", "--ledger", ledgerPath],
      {
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          ALPACA_API_KEY: "worker-lock-test-key",
          ALPACA_SECRET_KEY: "worker-lock-test-secret",
          AGENT_PREMARKET_START_ET: "04:00",
          OTEL_SDK_DISABLED: "true",
        },
        silent: true,
      },
    )
    children.add(child)
    child.once("exit", () => children.delete(child))
    let standardError = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      standardError += chunk
    })

    const [code] = await once(child, "exit")
    owner.release()

    expect(code).not.toBe(0)
    expect(existsSync(ledgerPath)).toBe(false)
    expect(standardError).toContain("WorkerInstanceLockUnavailableError")
    expect(standardError).toContain("Another worker already owns")
    expect(standardError).not.toContain("Starting OpenCode")
  })

  it("recovers immediately after a lock-holding process is killed", async () => {
    const ledgerPath = createLedgerPath()
    const child = await spawnLockHolder(ledgerPath)

    expect(() => acquireWorkerInstanceLock({ ledgerPath })).toThrow(
      WorkerInstanceLockUnavailableError,
    )

    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited

    const restarted = acquireWorkerInstanceLock({ ledgerPath })
    restarted.release()
  })

  it.each(["SIGINT", "SIGTERM"] as const)(
    "releases ownership after clean %s shutdown",
    async (signal) => {
      const ledgerPath = createLedgerPath()
      const child = await spawnLockHolder(ledgerPath, true)

      const exited = once(child, "exit")
      child.kill(signal)
      await exited

      const restarted = acquireWorkerInstanceLock({ ledgerPath })
      restarted.release()
    },
  )
})
