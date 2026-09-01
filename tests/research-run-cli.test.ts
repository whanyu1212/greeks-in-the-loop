import { describe, expect, it } from "vitest"

import { parseResearchRunCliOptions } from "../src/research/run/cli.js"

describe("research run CLI", () => {
  it("preserves JSON output defaults", () => {
    expect(parseResearchRunCliOptions([])).toMatchObject({
      exportArtifact: false,
      force: false,
      format: "json",
    })
  })

  it("selects Markdown stdout and paired export options", () => {
    expect(
      parseResearchRunCliOptions([
        "--format",
        "markdown",
        "--export",
        "--force",
        "--root",
        "workspace/custom",
        "--cycle",
        "cycle-1",
      ]),
    ).toMatchObject({
      cycleId: "cycle-1",
      exportArtifact: true,
      force: true,
      format: "markdown",
      root: "workspace/custom",
    })
  })

  it("rejects unsupported formats and missing values", () => {
    expect(() =>
      parseResearchRunCliOptions(["--format", "pretty"]),
    ).toThrow("--format must be json or markdown")
    expect(() => parseResearchRunCliOptions(["--format"])).toThrow(
      "--format requires a value",
    )
  })
})
