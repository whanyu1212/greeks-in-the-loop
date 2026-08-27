import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { pathsReferToSameFile } from "../src/backtest/file-identity.js"

describe("backtest file identity", () => {
  it("detects lexical, symlink, and hard-link dataset aliases", () => {
    const directory = mkdtempSync(join(tmpdir(), "backtest-file-identity-"))
    const dataset = join(directory, "dataset.sqlite")
    const symlink = join(directory, "dataset-symlink.json")
    const hardLink = join(directory, "dataset-hard-link.json")
    try {
      writeFileSync(dataset, "dataset")
      symlinkSync(dataset, symlink)
      linkSync(dataset, hardLink)

      expect(pathsReferToSameFile(dataset, dataset)).toBe(true)
      expect(pathsReferToSameFile(dataset, symlink)).toBe(true)
      expect(pathsReferToSameFile(dataset, hardLink)).toBe(true)
      expect(pathsReferToSameFile(dataset, join(directory, "report.json"))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
