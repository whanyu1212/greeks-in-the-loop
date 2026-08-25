import { describe, expect, it } from "vitest"

import {
  floorNanosecondsToIsoMilliseconds,
  parseExactCents,
  parseRfc3339Nanoseconds,
} from "../src/shared/value-normalization.js"

describe("parseExactCents", () => {
  it.each([
    [1, 100],
    [1.2, 120],
    [1.23, 123],
    [1e-2, 1],
    [0.07, 7],
    [0.29, 29],
    [1.13, 113],
    [1.1000000000000001, 110],
    ["0.05", 5],
    ["1.10", 110],
    ["1.1", 110],
    ["-1.25", -125],
    ["90071992547409.91", Number.MAX_SAFE_INTEGER],
  ])("parses %s into exact cents", (value, expected) => {
    expect(parseExactCents(value)).toBe(expected)
  })

  it.each([
    0.005,
    0.015,
    1.234,
    "0.005",
    "0.015",
    "1.234",
    "1e2",
    "90071992547409.92",
    Number.POSITIVE_INFINITY,
    {},
    "",
  ])(
    "rejects unsupported value %j",
    (value) => {
      expect(parseExactCents(value)).toBeUndefined()
    },
  )
})

describe("RFC 3339 nanosecond helpers", () => {
  it("preserves sub-millisecond ordering", () => {
    const earlier = parseRfc3339Nanoseconds("2026-08-25T14:30:00.0000Z")
    const later = parseRfc3339Nanoseconds("2026-08-25T14:30:00.0009Z")

    expect(earlier).toBeDefined()
    expect(later).toBeDefined()
    expect(later! > earlier!).toBe(true)
  })

  it("normalizes equivalent offsets", () => {
    expect(parseRfc3339Nanoseconds("2026-08-25T14:30:00.123Z")).toBe(
      parseRfc3339Nanoseconds("2026-08-25T10:30:00.123-04:00"),
    )
  })

  it("floors without extending freshness", () => {
    const instant = parseRfc3339Nanoseconds("2026-08-25T14:30:00.999999999Z")
    expect(instant).toBeDefined()
    expect(floorNanosecondsToIsoMilliseconds(instant!)).toBe(
      "2026-08-25T14:30:00.999Z",
    )
  })

  it("floors negative instants toward the earlier millisecond", () => {
    expect(floorNanosecondsToIsoMilliseconds(-1n)).toBe(
      "1969-12-31T23:59:59.999Z",
    )
  })

  it.each([
    "not-a-timestamp",
    "2026-08-25T14:30:00",
    "2026-08-25T14:30:00.1234567890Z",
    "2026-02-30T14:30:00.000Z",
    "2026-08-25T24:30:00.000Z",
  ])("rejects unsupported timestamp %s", (value) => {
    expect(parseRfc3339Nanoseconds(value)).toBeUndefined()
  })
})
