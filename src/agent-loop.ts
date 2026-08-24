/** Configuration and callbacks for a sequential agent loop. */
export type AgentLoopOptions = {
  /** Delay between completed cycle attempts, in milliseconds. */
  intervalMs: number
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
  /** Overrides the delay implementation, primarily for tests. */
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

/**
 * Waits for a duration or resolves early when cancellation is requested.
 *
 * @param milliseconds Duration to wait in milliseconds.
 * @param signal Signal that interrupts the delay.
 * @returns A promise that resolves after the delay or cancellation.
 */
const abortableSleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds)

    function done() {
      clearTimeout(timeout)
      signal.removeEventListener("abort", done)
      resolve()
    }

    signal.addEventListener("abort", done, { once: true })
  })

/**
 * Runs agent cycles sequentially until cancellation or the cycle limit.
 *
 * A failed cycle is reported through `onError` and does not terminate the
 * loop. This allows transient model or MCP failures to recover on a later
 * cycle.
 *
 * @param options Loop timing, cancellation, and callback configuration.
 * @returns The number of cycles attempted.
 */
export async function runAgentLoop({
  intervalMs,
  maxCycles,
  signal,
  runCycle,
  onResult = (result, cycle) => console.log(`[cycle ${cycle}]\n${result}`),
  onError = (error, cycle) => console.error(`[cycle ${cycle}] failed`, error),
  sleep = abortableSleep,
}: AgentLoopOptions): Promise<number> {
  let cycle = 0

  while (!signal.aborted && cycle < maxCycles) {
    cycle += 1

    try {
      onResult(await runCycle(cycle), cycle)
    } catch (error) {
      if (signal.aborted) break
      onError(error, cycle)
    }

    if (signal.aborted || cycle >= maxCycles) break
    await sleep(intervalMs, signal)
  }

  return cycle
}
