import { describe, expect, it } from "vitest"

import { getTrustedTime } from "../src/research/trusted-time.js"

describe("getTrustedTime", () => {
  it("returns the injected host UTC time", () => {
    expect(
      getTrustedTime(() => new Date("2026-08-25T14:31:59.123Z")),
    ).toBe("2026-08-25T14:31:59.123Z")
  })
})
