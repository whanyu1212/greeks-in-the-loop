import { describe, expect, it, vi } from "vitest"

import {
  createTerminalStageReporter,
  resolveTerminalLogFormat,
} from "../src/observability/terminal-stage-reporter.js"

describe("terminal stage reporter", () => {
  it("writes one bounded JSON line with cycle-relative timing", () => {
    const write = vi.fn()
    const reporter = createTerminalStageReporter({
      cycleId: "cycle-1",
      cycleNumber: 3,
      startedAt: "2026-08-27T14:00:00.000Z",
      now: () => new Date("2026-08-27T14:00:01.250Z"),
      write,
      format: "json",
    })

    reporter.report("quotes.confirm", "COMPLETED", {
      source: "options-snapshots-indicative",
      reasonCodes: [],
    })

    expect(write).toHaveBeenCalledOnce()
    const line = write.mock.calls[0]![0] as string
    expect(JSON.parse(line)).toEqual({
      timestamp: "2026-08-27T14:00:01.250Z",
      cycleId: "cycle-1",
      cycleNumber: 3,
      elapsedMs: 1_250,
      stage: "quotes.confirm",
      status: "COMPLETED",
      source: "options-snapshots-indicative",
      reasonCodes: [],
    })
  })

  it("renders aligned human-readable stage rows", () => {
    const write = vi.fn()
    const reporter = createTerminalStageReporter({
      cycleId: "cycle-1",
      cycleNumber: 3,
      startedAt: "2026-08-27T14:00:00.000Z",
      now: () => new Date("2026-08-27T14:02:20.000Z"),
      write,
      format: "pretty",
    })

    reporter.report("decision.validate", "COMPLETED", {
      outcome: "NO_ACTION",
      reasonCodes: ["SIGNAL_NOT_ACTIONABLE"],
    })

    const line = write.mock.calls[0]![0] as string
    expect(line).toContain("Decision validation")
    expect(line).toContain("2m 20s")
    expect(line).toContain("SIGNAL_NOT_ACTIONABLE")
    expect(line).not.toContain("cycle-1")
  })

  it("encodes runtime session metadata as one JSON line", () => {
    const write = vi.fn()
    const reporter = createTerminalStageReporter({
      cycleId: "cycle-1",
      cycleNumber: 3,
      startedAt: "2026-08-27T14:00:00.000Z",
      now: () => new Date("2026-08-27T14:00:00.100Z"),
      write,
      format: "json",
    })

    reporter.report("runtime.session", "COMPLETED", {
      sessionId: "session-1",
      url: "http://127.0.0.1:4096",
    })

    const line = write.mock.calls[0]![0] as string
    expect(line).not.toContain("\n")
    expect(JSON.parse(line)).toMatchObject({
      stage: "runtime.session",
      status: "COMPLETED",
      sessionId: "session-1",
      url: "http://127.0.0.1:4096",
    })
  })

  it("summarizes offline audit failures in pretty mode", () => {
    const write = vi.fn()
    const reporter = createTerminalStageReporter({
      cycleId: "cycle-1",
      cycleNumber: 3,
      startedAt: "2026-08-27T14:00:00.000Z",
      now: () => new Date("2026-08-27T14:00:02.000Z"),
      write,
      format: "pretty",
    })

    reporter.report("research.evaluate", "REJECTED", {
      passCount: 3,
      failCount: 1,
      notApplicableCount: 1,
      actionability: "NO_ACTION",
      issues: ["REPORT_CONTRACT_INVALID"],
    })

    const line = write.mock.calls[0]![0] as string
    expect(line).toContain("Offline audit")
    expect(line).toContain("3 pass | 1 fail | 1 n/a | NO_ACTION")
    expect(line).toContain("REPORT_CONTRACT_INVALID")
  })

  it("retains both artifact paths in structured output", () => {
    const write = vi.fn()
    const reporter = createTerminalStageReporter({
      cycleId: "cycle-1",
      cycleNumber: 3,
      startedAt: "2026-08-27T14:00:00.000Z",
      now: () => new Date("2026-08-27T14:00:02.000Z"),
      write,
      format: "json",
    })

    reporter.report("artifact.write", "COMPLETED", {
      path: "workspace/research/cycle.md",
      markdownPath: "workspace/research/cycle.md",
      jsonPath: "workspace/research/cycle.json",
    })

    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({
      stage: "artifact.write",
      status: "COMPLETED",
      path: "workspace/research/cycle.md",
      markdownPath: "workspace/research/cycle.md",
      jsonPath: "workspace/research/cycle.json",
    })
  })

  it("shows the readable artifact path in pretty mode", () => {
    const write = vi.fn()
    const reporter = createTerminalStageReporter({
      cycleId: "cycle-1",
      cycleNumber: 3,
      startedAt: "2026-08-27T14:00:00.000Z",
      now: () => new Date("2026-08-27T14:00:02.000Z"),
      write,
      format: "pretty",
    })

    reporter.report("artifact.write", "COMPLETED", {
      path: "workspace/research/cycle.md",
      markdownPath: "workspace/research/cycle.md",
      jsonPath: "workspace/research/cycle.json",
    })

    const line = write.mock.calls[0]![0] as string
    expect(line).toContain("Artifact")
    expect(line).toContain("workspace/research/cycle.md")
    expect(line).not.toContain("workspace/research/cycle.json")
  })

  it("selects format from an explicit value or TTY detection", () => {
    expect(resolveTerminalLogFormat(undefined, true)).toBe("pretty")
    expect(resolveTerminalLogFormat(undefined, false)).toBe("json")
    expect(resolveTerminalLogFormat(" PRETTY ", false)).toBe("pretty")
    expect(resolveTerminalLogFormat("json", true)).toBe("json")
    expect(() => resolveTerminalLogFormat("verbose", true)).toThrow(
      "AGENT_LOG_FORMAT must be pretty or json",
    )
  })
})
