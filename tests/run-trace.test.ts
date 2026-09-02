import { describe, expect, it } from "vitest"

import {
  boundedTraceValue,
  createRunTrace,
  traceInputDigest,
} from "../src/observability/run-trace.js"

const trace = (startedAtMs = 1_000, now = () => 1_500) => {
  const lines: string[] = []
  return {
    lines,
    sink: createRunTrace({
      path: "unused",
      cycleId: "cycle-1",
      startedAtMs,
      now,
      write: (line) => lines.push(line),
    }),
  }
}

describe("run trace", () => {
  it("stamps every record with elapsed milliseconds and the cycle", () => {
    const { lines, sink } = trace()
    sink.append("tool", { name: "alpaca_get_stock_bars", dur: 120 })

    expect(JSON.parse(lines[0]!)).toEqual({
      ms: 500,
      cycleId: "cycle-1",
      kind: "tool",
      name: "alpaca_get_stock_bars",
      dur: 120,
    })
    expect(lines[0]!.endsWith("\n")).toBe(true)
  })

  it("never reports negative elapsed time when a clock moves backwards", () => {
    const { lines, sink } = trace(2_000, () => 1_000)
    sink.append("stage", { stage: "universe.screen" })

    expect(JSON.parse(lines[0]!).ms).toBe(0)
  })

  it("bounds retained strings and arrays", () => {
    const { lines, sink } = trace()
    sink.append("note", {
      text: `  multi\n  line  ${"x".repeat(400)}`,
      symbols: Array.from({ length: 40 }, (_, index) => `SYM${index}`),
    })

    const record = JSON.parse(lines[0]!)
    expect(record.text.length).toBe(200)
    expect(record.text.startsWith("multi line ")).toBe(true)
    expect(record.symbols).toHaveLength(16)
  })

  it("keeps a failed write from breaking a cycle", () => {
    const sink = createRunTrace({
      path: "unused",
      cycleId: "cycle-1",
      startedAtMs: 0,
      write: () => {
        throw new Error("disk full")
      },
    })

    expect(() => sink.append("stage", { stage: "eligibility" })).not.toThrow()
  })

  it("digests a tool input to bounded scalars without nested content", () => {
    expect(traceInputDigest({
      symbols: "SPY,QQQ",
      limit: 1000,
      feed: "iex",
      nested: { secret: "value" },
      list: [1, 2, 3],
    })).toBe("symbols=SPY,QQQ;limit=1000;feed=iex;nested={};list=[3]")
    expect(traceInputDigest(undefined)).toBe("")
    expect(traceInputDigest("not-an-object")).toBe("")
  })

  it("leaves non-string values untouched", () => {
    expect(boundedTraceValue(42)).toBe(42)
    expect(boundedTraceValue(null)).toBe(null)
    expect(boundedTraceValue(true)).toBe(true)
  })
})
