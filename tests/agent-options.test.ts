import { describe, expect, it } from "vitest"

import {
  DEFAULT_ANYTIME_RESEARCH_LEDGER_PATH,
  DEFAULT_RESEARCH_LEDGER_PATH,
  parseAgentOptions,
} from "../src/agent-options.js"

describe("parseAgentOptions", () => {
  it("preserves the normal worker defaults", () => {
    expect(parseAgentOptions([])).toEqual({
      once: false,
      researchAnytime: false,
      ledgerPath: DEFAULT_RESEARCH_LEDGER_PATH,
    })
    expect(parseAgentOptions(["--once"], ".state/configured.sqlite")).toEqual({
      once: true,
      researchAnytime: false,
      ledgerPath: ".state/configured.sqlite",
    })
  })

  it("uses a dedicated ledger for one-cycle anytime research", () => {
    expect(
      parseAgentOptions(
        ["--once", "--", "--research-anytime"],
        ".state/production.sqlite",
      ),
    ).toEqual({
      once: true,
      researchAnytime: true,
      ledgerPath: DEFAULT_ANYTIME_RESEARCH_LEDGER_PATH,
    })
  })

  it("allows an explicit isolated anytime ledger", () => {
    expect(
      parseAgentOptions(
        [
          "--once",
          "--research-anytime",
          "--ledger",
          ".state/quality-run.sqlite",
        ],
        ".state/production.sqlite",
      ).ledgerPath,
    ).toBe(".state/quality-run.sqlite")
  })

  it("rejects unsafe or malformed anytime options", () => {
    expect(() => parseAgentOptions(["--research-anytime"])).toThrow(
      "--research-anytime requires --once",
    )
    expect(() =>
      parseAgentOptions(
        ["--once", "--research-anytime", "--ledger", ".state/live.sqlite"],
        ".state/live.sqlite",
      ),
    ).toThrow("cannot use the configured production ledger")
    expect(() => parseAgentOptions(["--ledger"])).toThrow(
      "--ledger requires a value",
    )
    expect(() => parseAgentOptions(["--unknown"])).toThrow("Unknown option")
  })
})
