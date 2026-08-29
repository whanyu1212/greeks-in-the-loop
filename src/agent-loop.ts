/**
 * Sequential scheduling for autonomous agent cycles.
 *
 * Cycle attempts never overlap: the loop waits for `runCycle` to settle before
 * invoking the corresponding result or error callback and starting its delay.
 * Callback return values are not awaited, so callers must coordinate any
 * asynchronous callback work that must finish before the next cycle. Consecutive
 * non-fatal failures use bounded exponential backoff with equal jitter; the
 * normal interval resumes after success.
 *
 * Cancellation prevents new cycles and interrupts the inter-cycle delay. The
 * supplied `runCycle` implementation remains responsible for cancelling any
 * work already in progress.
 */

export const DEFAULT_AGENT_MAX_BACKOFF_MS = 30 * 60 * 1000
export const MAX_AGENT_LOOP_DELAY_MS = 2 ** 31 - 1

/** Configuration and callbacks for a sequential agent loop. */
export type AgentLoopOptions = {
  /** Delay between completed successful cycles, in milliseconds. */
  intervalMs: number
  /** Maximum failure delay; must be at least twice the normal interval. */
  maxBackoffMs?: number
  /** Maximum number of cycles to attempt. */
  maxCycles: number
  /** Signal used to stop the loop and interrupt its delay. */
  signal: AbortSignal
  /** Executes one agent cycle and returns its printable report. */
  runCycle: (cycle: number) => Promise<string>
  /** Receives the report from a successful cycle. */
  onResult?: (result: string, cycle: number) => void
  /** Receives an error from a failed cycle. */
  onError?: (error: unknown, cycle: number) => void
  /** Identifies failures that must stop the worker instead of retrying. */
  isFatalError?: (error: unknown) => boolean
  /** Overrides the delay implementation, primarily for tests. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  /** Supplies jitter, primarily for deterministic tests. */
  random?: () => number
}

/**
 * Waits for a duration or resolves early when cancellation is requested.
 *
 * @param milliseconds Duration to wait in milliseconds.
 * @param signal Signal that interrupts the delay.
 * @returns A promise that resolves after the delay or cancellation.
 */
export const abortableSleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds)

    function done() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }

    signal.addEventListener("abort", done, { once: true })
    if (signal.aborted) done()
  })

/**
 * Runs agent cycles sequentially until cancellation or the cycle limit.
 *
 * A non-fatal failed cycle is reported through `onError` and does not terminate
 * the loop. This allows transient model or MCP failures to recover on a later
 * cycle. Fatal failures propagate immediately. Attempts never overlap, and both
 * successful and non-fatal failed attempts wait before the next cycle.
 *
 * @param options Loop timing, cancellation, and callback configuration.
 * @returns The number of cycles attempted.
 */
export async function runAgentLoop({
  intervalMs,
  maxBackoffMs = DEFAULT_AGENT_MAX_BACKOFF_MS,
  maxCycles,
  signal,
  runCycle,
  onResult = (result, cycle) => console.log(`[cycle ${cycle}]\n${result}`),
  onError = (error, cycle) => console.error(`[cycle ${cycle}] failed`, error),
  isFatalError = () => false,
  sleep = abortableSleep,
  random = Math.random,
}: AgentLoopOptions): Promise<number> {
  if (maxBackoffMs / 2 < intervalMs) {
    throw new Error("maxBackoffMs must be at least twice intervalMs")
  }
  if (maxBackoffMs > MAX_AGENT_LOOP_DELAY_MS) {
    throw new Error(`maxBackoffMs must not exceed ${MAX_AGENT_LOOP_DELAY_MS}`)
  }

  let cycle = 0
  let backoffCeilingMs = intervalMs

  while (!signal.aborted && cycle < maxCycles) {
    cycle += 1

    let delayMs = intervalMs
    try {
      onResult(await runCycle(cycle), cycle)
      backoffCeilingMs = intervalMs
    } catch (error) {
      if (isFatalError(error)) throw error
      if (signal.aborted) break
      onError(error, cycle)
      backoffCeilingMs =
        backoffCeilingMs >= maxBackoffMs / 2
          ? maxBackoffMs
          : backoffCeilingMs * 2
      delayMs = Math.floor(
        backoffCeilingMs / 2 + random() * (backoffCeilingMs / 2),
      )
    }

    if (signal.aborted || cycle >= maxCycles) break
    await sleep(delayMs, signal)
  }

  return cycle
}
