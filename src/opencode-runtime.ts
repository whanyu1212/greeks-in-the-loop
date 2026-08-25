/**
 * Lifecycle management for the local OpenCode server used by the agent.
 *
 * This module owns the server process and, on non-Windows platforms, its
 * detached process group so shutdown signals can reach local MCP descendants.
 * Configuration overrides are removed from the child environment and external
 * plugins are disabled before startup. Callers own the returned client only
 * for the runtime's lifetime and must invoke the idempotent `close` operation
 * when finished.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"

/** A managed OpenCode server and its connected SDK client. */
export type OpencodeRuntime = {
  /** Type-safe client connected to the managed server. */
  client: OpencodeClient
  /** HTTP URL of the managed OpenCode server. */
  url: string
  /** Disposes OpenCode resources and terminates its process tree. */
  close: () => Promise<void>
}

/** Options used to start a managed OpenCode server. */
type StartOpencodeOptions = {
  /** Interface on which the server listens. */
  hostname?: string
  /** TCP port on which the server listens. */
  port: number
  /** Signal used to initiate runtime shutdown. */
  signal: AbortSignal
  /** Maximum time allowed for server startup, in milliseconds. */
  timeoutMs: number
}

/**
 * Waits for a child process to exit within a bounded duration.
 *
 * @param process Child process to observe.
 * @param timeoutMs Maximum time to wait in milliseconds.
 * @returns Whether the process exited before the timeout.
 */
const waitForExit = (process: ChildProcess, timeoutMs: number) => {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => done(false), timeoutMs)
    const onExit = () => done(true)

    function done(exited: boolean) {
      clearTimeout(timeout)
      process.removeListener("exit", onExit)
      resolve(exited)
    }

    process.once("exit", onExit)
  })
}

/**
 * Sends a signal to a child process and all of its descendants.
 *
 * @param process Root child process of the managed process tree.
 * @param signal Operating-system signal to send.
 */
const killProcessTree = (process: ChildProcess, signal: NodeJS.Signals) => {
  if (!process.pid || process.exitCode !== null || process.signalCode !== null) return

  if (globalThis.process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(process.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
    return
  }

  try {
    globalThis.process.kill(-process.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

/**
 * Removes environment settings that could replace the checked-in agent policy.
 *
 * @param environment Parent process environment.
 * @returns Environment inherited by the managed OpenCode process.
 */
export function createOpencodeEnvironment(
  environment: NodeJS.ProcessEnv,
  configHome: string,
) {
  const {
    OPENCODE_CONFIG: _configPath,
    OPENCODE_CONFIG_CONTENT: _configContent,
    OPENCODE_CONFIG_DIR: _configDirectory,
    OPENCODE_AGENT: _agentOverride,
    ...childEnvironment
  } = environment
  return { ...childEnvironment, XDG_CONFIG_HOME: configHome }
}

/**
 * Starts an OpenCode server and creates an SDK client for it.
 *
 * The server runs in its own process group so shutdown can terminate local
 * MCP descendants as well as OpenCode itself. The returned `close` operation
 * is idempotent and escalates from graceful disposal to forced termination.
 *
 * @param options Host, port, cancellation, and startup timeout settings.
 * @returns A managed OpenCode runtime.
 * @throws If OpenCode cannot start or does not report a valid server URL.
 */
export async function startOpencode({
  hostname = "127.0.0.1",
  port,
  signal,
  timeoutMs,
}: StartOpencodeOptions): Promise<OpencodeRuntime> {
  const configHome = mkdtempSync(join(tmpdir(), "greeks-opencode-"))
  const childEnvironment = createOpencodeEnvironment(
    globalThis.process.env,
    configHome,
  )
  const process = spawn(
    globalThis.process.env.OPENCODE_BIN ?? "opencode",
    ["--pure", "serve", `--hostname=${hostname}`, `--port=${port}`],
    {
      detached: globalThis.process.platform !== "win32",
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  )

  let output = ""
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out starting OpenCode after ${timeoutMs}ms`))
    }, timeoutMs)

    const onData = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-8_192)
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
        finish(match ? undefined : new Error("OpenCode returned an invalid server URL"), match?.[1])
        return
      }
    }
    const onExit = (code: number | null, processSignal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `OpenCode exited during startup (${processSignal ?? `code ${String(code)}`})${output.trim() ? `: ${output.trim()}` : ""}`,
        ),
      )
    }
    const onError = (error: Error) => finish(error)
    const onAbort = () => finish(signal.reason ?? new Error("OpenCode startup aborted"))

    function finish(error?: Error, serverUrl?: string) {
      clearTimeout(timeout)
      process.stdout?.removeListener("data", onData)
      process.stderr?.removeListener("data", onData)
      process.removeListener("exit", onExit)
      process.removeListener("error", onError)
      signal.removeEventListener("abort", onAbort)

      if (error || !serverUrl) {
        killProcessTree(process, "SIGKILL")
        rmSync(configHome, { force: true, recursive: true })
        reject(error ?? new Error("OpenCode failed to start"))
        return
      }

      process.stdout?.resume()
      process.stderr?.resume()
      resolve(serverUrl)
    }

    process.stdout?.on("data", onData)
    process.stderr?.on("data", onData)
    process.once("exit", onExit)
    process.once("error", onError)
    signal.addEventListener("abort", onAbort, { once: true })
  })

  const client = createOpencodeClient({ baseUrl: url, directory: globalThis.process.cwd() })
  let closing: Promise<void> | undefined

  /**
   * Disposes the SDK instance and terminates the owned process tree.
   *
   * Shutdown first requests SDK disposal. If the root process remains alive,
   * non-Windows platforms send SIGTERM to its process group and escalate to
   * SIGKILL when the root does not exit within the graceful-shutdown bound.
   * Windows instead force-terminates the live root and its process tree with
   * `taskkill /T /F`; it does not provide the same graceful signal window.
   */
  const close = () => {
    closing ??= (async () => {
      signal.removeEventListener("abort", onAbort)

      await Promise.race([
        client.instance.dispose().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])

      killProcessTree(process, "SIGTERM")
      if (!(await waitForExit(process, 5_000))) {
        killProcessTree(process, "SIGKILL")
        await waitForExit(process, 1_000)
      }

      process.stdout?.destroy()
      process.stderr?.destroy()
      rmSync(configHome, { force: true, recursive: true })
    })()
    return closing
  }
  const onAbort = () => void close()
  signal.addEventListener("abort", onAbort, { once: true })

  return { client, url, close }
}
