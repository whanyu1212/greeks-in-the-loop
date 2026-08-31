import { describe, expect, it, vi } from "vitest"

import {
  AgentLoopBreakerLatchedError,
  abortableSleep,
  MAX_AGENT_LOOP_DELAY_MS,
  runAgentLoop,
} from "../src/agent-loop.js"

describe("abortableSleep", () => {
  it("resolves immediately when cancellation happened before listener registration", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined()
  })
})

describe("runAgentLoop", () => {
  it("runs sequential cycles and waits only between them", async () => {
    const controller = new AbortController()
    const events: string[] = []

    const cycles = await runAgentLoop({
      intervalMs: 100,
      maxCycles: 3,
      signal: controller.signal,
      runCycle: async (cycle) => {
        events.push(`run:${cycle}`)
        return `result:${cycle}`
      },
      onResult: (result, cycle) => events.push(`result:${cycle}:${result}`),
      sleep: async (milliseconds) => {
        events.push(`sleep:${milliseconds}`)
      },
    })

    expect(cycles).toBe(3)
    expect(events).toEqual([
      "run:1",
      "result:1:result:1",
      "sleep:100",
      "run:2",
      "result:2:result:2",
      "sleep:100",
      "run:3",
      "result:3:result:3",
    ])
  })

  it("rejects a backoff cap below the first failure ceiling", async () => {
    const runCycle = vi.fn(async () => "unused")

    await expect(
      runAgentLoop({
        intervalMs: 100,
        maxBackoffMs: 199,
        maxCycles: 1,
        signal: new AbortController().signal,
        runCycle,
      }),
    ).rejects.toThrow("maxBackoffMs must be at least twice intervalMs")
    expect(runCycle).not.toHaveBeenCalled()
  })

  it("rejects a backoff cap beyond the timer range", async () => {
    const runCycle = vi.fn(async () => "unused")

    await expect(
      runAgentLoop({
        intervalMs: 100,
        maxBackoffMs: MAX_AGENT_LOOP_DELAY_MS + 1,
        maxCycles: 1,
        signal: new AbortController().signal,
        runCycle,
      }),
    ).rejects.toThrow(`maxBackoffMs must not exceed ${MAX_AGENT_LOOP_DELAY_MS}`)
    expect(runCycle).not.toHaveBeenCalled()
  })

  it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid failure threshold %s before running",
    async (maxConsecutiveFailures) => {
      const runCycle = vi.fn(async () => "unused")

      await expect(
        runAgentLoop({
          intervalMs: 100,
          maxConsecutiveFailures,
          maxCycles: 1,
          signal: new AbortController().signal,
          runCycle,
        }),
      ).rejects.toThrow("maxConsecutiveFailures must be a positive integer")
      expect(runCycle).not.toHaveBeenCalled()
    },
  )

  it("latches at the failure threshold without another backoff delay", async () => {
    const delays: number[] = []
    const onError = vi.fn()
    const onBreakerLatched = vi.fn(async () => undefined)

    await expect(
      runAgentLoop({
        intervalMs: 100,
        maxBackoffMs: 1_600,
        maxConsecutiveFailures: 3,
        maxCycles: 10,
        signal: new AbortController().signal,
        runCycle: vi.fn().mockRejectedValue(new Error("temporary")),
        onError,
        onBreakerLatched,
        sleep: async (milliseconds) => {
          delays.push(milliseconds)
        },
        random: () => 0.5,
      }),
    ).rejects.toBeInstanceOf(AgentLoopBreakerLatchedError)

    expect(delays).toEqual([150, 300])
    expect(onError).toHaveBeenCalledTimes(3)
    expect(onBreakerLatched).toHaveBeenCalledWith({
      attempt: 3,
      consecutiveFailures: 3,
      threshold: 3,
    })
  })

  it("latches the breaker on sustained model-identity drift", async () => {
    // A drifted cycle throws a plain Error, which index.ts's isFatalError
    // treats as non-fatal. A provider that silently swaps the default model
    // must therefore halt the worker rather than loop forever.
    const onBreakerLatched = vi.fn(async () => undefined)
    const drift = new Error(
      "Research model identity rejected: MODEL_DRIFT (expected deepseek-v4-flash, observed deepseek-v4-flash-turbo)",
    )

    await expect(
      runAgentLoop({
        intervalMs: 100,
        maxBackoffMs: 1_600,
        maxConsecutiveFailures: 5,
        maxCycles: 20,
        signal: new AbortController().signal,
        runCycle: vi.fn().mockRejectedValue(drift),
        onError: vi.fn(),
        onBreakerLatched,
        // Mirrors the composition root: only ledger/worker failures are fatal.
        isFatalError: () => false,
        sleep: async () => undefined,
        random: () => 0.5,
      }),
    ).rejects.toBeInstanceOf(AgentLoopBreakerLatchedError)

    expect(onBreakerLatched).toHaveBeenCalledWith({
      attempt: 5,
      consecutiveFailures: 5,
      threshold: 5,
    })
  })

  it("clears drift failures when a matching cycle succeeds", async () => {
    const onBreakerLatched = vi.fn(async () => undefined)
    const drift = new Error("Research model identity rejected: PROVIDER_DRIFT")
    const runCycle = vi
      .fn()
      .mockRejectedValueOnce(drift)
      .mockRejectedValueOnce(drift)
      .mockResolvedValueOnce("recovered")
      .mockRejectedValueOnce(drift)

    const cycles = await runAgentLoop({
      intervalMs: 100,
      maxBackoffMs: 1_600,
      maxConsecutiveFailures: 3,
      maxCycles: 4,
      signal: new AbortController().signal,
      runCycle,
      onError: vi.fn(),
      onBreakerLatched,
      isFatalError: () => false,
      sleep: async () => undefined,
      random: () => 0.5,
    })

    expect(cycles).toBe(4)
    expect(onBreakerLatched).not.toHaveBeenCalled()
  })

  it("increases jittered delays after consecutive transient failures", async () => {
    const delays: number[] = []
    const onError = vi.fn()

    const cycles = await runAgentLoop({
      intervalMs: 100,
      maxBackoffMs: 1_600,
      maxCycles: 4,
      signal: new AbortController().signal,
      runCycle: vi.fn().mockRejectedValue(new Error("temporary")),
      onError,
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      },
      random: () => 0.5,
    })

    expect(cycles).toBe(4)
    expect(delays).toEqual([150, 300, 600])
    expect(onError).toHaveBeenCalledTimes(4)
  })

  it("resets backoff and failure count after a successful cycle", async () => {
    const delays: number[] = []
    const onBreakerLatched = vi.fn(async () => undefined)

    await expect(
      runAgentLoop({
        intervalMs: 100,
        maxBackoffMs: 1_600,
        maxConsecutiveFailures: 3,
        maxCycles: 10,
        signal: new AbortController().signal,
        runCycle: vi
          .fn<(cycle: number) => Promise<string>>()
          .mockRejectedValueOnce(new Error("temporary"))
          .mockResolvedValueOnce("recovered")
          .mockRejectedValue(new Error("temporary again")),
        onResult: vi.fn(),
        onError: vi.fn(),
        onBreakerLatched,
        sleep: async (milliseconds) => {
          delays.push(milliseconds)
        },
        random: () => 0.5,
      }),
    ).rejects.toBeInstanceOf(AgentLoopBreakerLatchedError)

    expect(delays).toEqual([150, 100, 150, 300])
    expect(onBreakerLatched).toHaveBeenCalledWith({
      attempt: 5,
      consecutiveFailures: 3,
      threshold: 3,
    })
  })

  it("propagates latch persistence failure without sleeping", async () => {
    const persistenceFailure = new Error("ledger unavailable")
    const sleep = vi.fn(async () => undefined)

    await expect(
      runAgentLoop({
        intervalMs: 100,
        maxConsecutiveFailures: 1,
        maxCycles: 10,
        signal: new AbortController().signal,
        runCycle: vi.fn().mockRejectedValue(new Error("temporary")),
        onError: vi.fn(),
        onBreakerLatched: async () => {
          throw persistenceFailure
        },
        sleep,
      }),
    ).rejects.toBe(persistenceFailure)
    expect(sleep).not.toHaveBeenCalled()
  })

  it("caps backoff after repeated failures", async () => {
    const delays: number[] = []

    await runAgentLoop({
      intervalMs: 100,
      maxBackoffMs: 400,
      maxCycles: 4,
      signal: new AbortController().signal,
      runCycle: vi.fn().mockRejectedValue(new Error("temporary")),
      onError: vi.fn(),
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      },
      random: () => 0.5,
    })

    expect(delays).toEqual([150, 300, 300])
  })

  it("stops when shutdown interrupts a backoff delay", async () => {
    const controller = new AbortController()
    const runCycle = vi.fn().mockRejectedValue(new Error("temporary"))

    const cycles = await runAgentLoop({
      intervalMs: 100,
      maxBackoffMs: 400,
      maxCycles: 10,
      signal: controller.signal,
      runCycle,
      onError: vi.fn(),
      sleep: async (milliseconds, signal) => {
        const sleeping = abortableSleep(milliseconds, signal)
        controller.abort()
        await sleeping
      },
      random: () => 0.5,
    })

    expect(cycles).toBe(1)
    expect(runCycle).toHaveBeenCalledOnce()
  })

  it("does not begin another cycle after shutdown", async () => {
    const controller = new AbortController()
    const runCycle = vi.fn(async () => {
      controller.abort()
      return "stopping"
    })

    const cycles = await runAgentLoop({
      intervalMs: 1,
      maxCycles: 10,
      signal: controller.signal,
      runCycle,
      onResult: vi.fn(),
    })

    expect(cycles).toBe(1)
    expect(runCycle).toHaveBeenCalledOnce()
  })

  it("propagates a fatal cycle failure without retrying", async () => {
    const fatal = new Error("ledger unavailable")
    const runCycle = vi.fn(async () => {
      throw fatal
    })
    const onError = vi.fn()
    const onBreakerLatched = vi.fn(async () => undefined)
    const sleep = vi.fn(async () => undefined)

    await expect(
      runAgentLoop({
        intervalMs: 1,
        maxConsecutiveFailures: 1,
        maxCycles: 10,
        signal: new AbortController().signal,
        runCycle,
        onError,
        onBreakerLatched,
        isFatalError: (error) => error === fatal,
        sleep,
      }),
    ).rejects.toBe(fatal)
    expect(runCycle).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(onBreakerLatched).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })
})
