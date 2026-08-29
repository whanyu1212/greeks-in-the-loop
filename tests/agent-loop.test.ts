import { describe, expect, it, vi } from "vitest"

import { abortableSleep, runAgentLoop } from "../src/agent-loop.js"

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

  it("resets backoff after a successful cycle", async () => {
    const delays: number[] = []

    await runAgentLoop({
      intervalMs: 100,
      maxBackoffMs: 1_600,
      maxCycles: 4,
      signal: new AbortController().signal,
      runCycle: vi
        .fn<(cycle: number) => Promise<string>>()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce("recovered")
        .mockRejectedValueOnce(new Error("temporary again"))
        .mockResolvedValueOnce("recovered again"),
      onResult: vi.fn(),
      onError: vi.fn(),
      sleep: async (milliseconds) => {
        delays.push(milliseconds)
      },
      random: () => 0.5,
    })

    expect(delays).toEqual([150, 100, 150])
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
    const sleep = vi.fn(async () => undefined)

    await expect(
      runAgentLoop({
        intervalMs: 1,
        maxCycles: 10,
        signal: new AbortController().signal,
        runCycle,
        onError,
        isFatalError: (error) => error === fatal,
        sleep,
      }),
    ).rejects.toBe(fatal)
    expect(runCycle).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })
})
