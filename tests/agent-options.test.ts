import {
  linkSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  DEFAULT_DRY_RUN_LEDGER_PATH,
  DEFAULT_RESEARCH_LEDGER_PATH,
  parseAgentOptions,
} from "../src/agent-options.js"

describe("parseAgentOptions", () => {
  it("keeps standard defaults and gives dry runs an isolated ledger", () => {
    expect(parseAgentOptions([])).toEqual({
      once: false,
      dryRun: false,
      execute: false,
      ledgerPath: DEFAULT_RESEARCH_LEDGER_PATH,
    })
    expect(parseAgentOptions(["--once", "--dry-run", "--session", "2026-08-25"])).toEqual({
      once: true,
      dryRun: true,
      execute: false,
      sessionDate: "2026-08-25",
      ledgerPath: DEFAULT_DRY_RUN_LEDGER_PATH,
    })
  })

  it("rejects malformed or unsafe combinations", () => {
    expect(() => parseAgentOptions(["--dry-run"])).toThrow("--dry-run requires --once")
    expect(() => parseAgentOptions(["--once", "--session", "2026-02-30"])).toThrow(
      "--session requires a valid calendar date",
    )
    expect(() => parseAgentOptions(["--session", "2026-08-25"])).toThrow(
      "--session requires --dry-run",
    )
    expect(() => parseAgentOptions(["--research-anytime"])).toThrow("Unknown option")
    expect(() =>
      parseAgentOptions(
        ["--once", "--dry-run", "--ledger", ".state/live.sqlite"],
        ".state/live.sqlite",
      ),
    ).toThrow("cannot use the configured production ledger")
  })

  it("detects an existing hard-link alias of the production ledger", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-options-test-"))
    try {
      const production = join(directory, "production.sqlite")
      const alias = join(directory, "dry-run.sqlite")
      writeFileSync(production, "")
      linkSync(production, alias)
      expect(() =>
        parseAgentOptions(["--once", "--dry-run", "--ledger", alias], production),
      ).toThrow("cannot use the configured production ledger")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
