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

  it("reports a transient failure and continues", async () => {
    const onError = vi.fn()

    const cycles = await runAgentLoop({
      intervalMs: 1,
      maxCycles: 2,
      signal: new AbortController().signal,
      runCycle: vi
        .fn<(cycle: number) => Promise<string>>()
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce("recovered"),
      onResult: vi.fn(),
      onError,
      sleep: async () => undefined,
    })

    expect(cycles).toBe(2)
    expect(onError).toHaveBeenCalledOnce()
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

    await expect(
      runAgentLoop({
        intervalMs: 1,
        maxCycles: 10,
        signal: new AbortController().signal,
        runCycle,
        onError,
        isFatalError: (error) => error === fatal,
      }),
    ).rejects.toBe(fatal)
    expect(runCycle).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })
})
