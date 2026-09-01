/** Options for running work under a timeout and worker shutdown signal. */
export type CycleDeadlineOptions<T> = {
  /** Maximum duration for the work, or undefined for no elapsed-time deadline. */
  timeoutMs?: number
  /** Long-lived signal used to stop the worker. */
  shutdownSignal: AbortSignal
  /** Work that receives a signal combining the deadline and worker shutdown. */
  run: (signal: AbortSignal) => Promise<T>
  /** Synchronizes server-side cleanup after a cycle deadline expires. */
  onTimeout: () => Promise<void>
}

/**
 * Runs one cycle under a deadline and synchronizes timed-out server-side work.
 *
 * Worker shutdown cancels local work immediately and leaves resource teardown
 * to the worker's shutdown path. A deadline waits for `onTimeout` before
 * rejecting, preventing the scheduler from starting another cycle while the
 * timed-out operation may still be active remotely.
 *
 * @param options Deadline, shutdown, work, and timeout synchronization hooks.
 * @returns The completed cycle result.
 */
export async function runWithCycleDeadline<T>({
  timeoutMs,
  shutdownSignal,
  run,
  onTimeout,
}: CycleDeadlineOptions<T>): Promise<T> {
  const cycleController = new AbortController()
  let timedOut = false
  let rejectInterruption: (reason: unknown) => void = () => undefined
  const interruption = new Promise<never>((_, reject) => {
    rejectInterruption = reject
  })

  const interrupt = (reason: unknown) => {
    cycleController.abort(reason)
    rejectInterruption(reason)
  }
  const abortForShutdown = () => interrupt(shutdownSignal.reason)
  const timeout = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true
        interrupt(new DOMException("Agent cycle timed out", "TimeoutError"))
      }, timeoutMs)

  shutdownSignal.addEventListener("abort", abortForShutdown, { once: true })
  if (shutdownSignal.aborted) abortForShutdown()

  try {
    return await Promise.race([run(cycleController.signal), interruption])
  } catch (error) {
    if (timedOut && !shutdownSignal.aborted) await onTimeout()
    throw error
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    shutdownSignal.removeEventListener("abort", abortForShutdown)
  }
}
