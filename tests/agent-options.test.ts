import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
    expect(() =>
      parseAgentOptions(["--ledger", DEFAULT_ANYTIME_RESEARCH_LEDGER_PATH]),
    ).toThrow("reserved anytime dry-run ledger")
    expect(() => parseAgentOptions(["--ledger"])).toThrow(
      "--ledger requires a value",
    )
    expect(() => parseAgentOptions(["--unknown"])).toThrow("Unknown option")
  })

  it.each(["symbolic", "hard"] as const)(
    "rejects a %s-link alias of the production ledger",
    (linkKind) => {
      const directory = mkdtempSync(join(tmpdir(), "agent-options-test-"))
      try {
        const productionLedger = join(directory, "production.sqlite")
        const aliasLedger = join(directory, "dry-run.sqlite")
        writeFileSync(productionLedger, "")
        if (linkKind === "symbolic") {
          symlinkSync(productionLedger, aliasLedger)
        } else {
          linkSync(productionLedger, aliasLedger)
        }

        expect(() =>
          parseAgentOptions(
            ["--once", "--research-anytime", "--ledger", aliasLedger],
            productionLedger,
          ),
        ).toThrow("cannot use the configured production ledger")
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it("rejects a missing ledger behind a symlinked parent directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-options-test-"))
    try {
      const realDirectory = join(directory, "real")
      const aliasDirectory = join(directory, "alias")
      mkdirSync(realDirectory)
      symlinkSync(realDirectory, aliasDirectory, "dir")

      expect(() =>
        parseAgentOptions(
          [
            "--once",
            "--research-anytime",
            "--ledger",
            join(aliasDirectory, "ledger.sqlite"),
          ],
          join(realDirectory, "ledger.sqlite"),
        ),
      ).toThrow("cannot use the configured production ledger")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects a dangling symbolic-link alias of the production ledger", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-options-test-"))
    try {
      const productionLedger = join(directory, "production.sqlite")
      const aliasLedger = join(directory, "dry-run.sqlite")
      symlinkSync(productionLedger, aliasLedger)

      expect(() =>
        parseAgentOptions(
          ["--once", "--research-anytime", "--ledger", aliasLedger],
          productionLedger,
        ),
      ).toThrow("cannot use the configured production ledger")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("rejects case-only reserved anytime ledger aliases on case-folding platforms", () => {
    const parse = () =>
      parseAgentOptions(["--ledger", ".state/Research-Anytime.sqlite"])

    if (process.platform === "darwin" || process.platform === "win32") {
      expect(parse).toThrow("reserved anytime dry-run ledger")
    } else {
      expect(parse().ledgerPath).toBe(".state/Research-Anytime.sqlite")
    }
  })
})
