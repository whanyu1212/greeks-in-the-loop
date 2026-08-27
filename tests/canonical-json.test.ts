import { describe, expect, it } from "vitest"

import {
  canonicalJson,
  canonicalJsonSha256,
} from "../src/shared/canonical-json.js"

describe("canonical JSON", () => {
  it("sorts object keys recursively while retaining array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [{ q: 1, a: 2 }] }))
      .toBe('{"a":{"b":3,"y":2},"list":[{"a":2,"q":1}],"z":1}')
  })

  it("produces the same digest for equivalent key orderings", () => {
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(
      canonicalJsonSha256({ a: 1, b: 2 }),
    )
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n])(
    "rejects non-JSON value %s",
    (value) => {
      expect(() => canonicalJson({ value })).toThrow("Canonical JSON")
    },
  )
})
