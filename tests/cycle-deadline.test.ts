import { afterEach, describe, expect, it, vi } from "vitest"

import { runWithCycleDeadline } from "../src/cycle-deadline.js"

afterEach(() => {
  vi.useRealTimers()
})

describe("runWithCycleDeadline", () => {
  it("awaits server-side timeout cleanup before rejecting the cycle", async () => {
    vi.useFakeTimers()
    let finishCleanup: () => void = () => undefined
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    const onTimeout = vi.fn(() => cleanup)

    const cycle = runWithCycleDeadline({
      timeoutMs: 100,
      shutdownSignal: new AbortController().signal,
      run: () => new Promise<never>(() => undefined),
      onTimeout,
    })
    const settled = vi.fn()
    void cycle.then(settled, settled)

    await vi.advanceTimersByTimeAsync(100)

    expect(onTimeout).toHaveBeenCalledOnce()
    expect(settled).not.toHaveBeenCalled()

    finishCleanup()

    await expect(cycle).rejects.toMatchObject({ name: "TimeoutError" })
  })

  it("returns successful work without running timeout cleanup", async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()

    const cycle = runWithCycleDeadline({
      timeoutMs: 100,
      shutdownSignal: new AbortController().signal,
      run: async () => "complete",
      onTimeout,
    })

    await expect(cycle).resolves.toBe("complete")
    await vi.advanceTimersByTimeAsync(100)

    expect(onTimeout).not.toHaveBeenCalled()
  })

  it("keeps unbounded work alive until worker shutdown", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const onTimeout = vi.fn()

    const cycle = runWithCycleDeadline({
      shutdownSignal: controller.signal,
      run: () => new Promise<never>(() => undefined),
      onTimeout,
    })
    const settled = vi.fn()
    void cycle.then(settled, settled)

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000)
    expect(settled).not.toHaveBeenCalled()

    controller.abort(new Error("shutdown"))

    await expect(cycle).rejects.toThrow("shutdown")
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
