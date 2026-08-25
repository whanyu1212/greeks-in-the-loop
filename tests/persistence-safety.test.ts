import { describe, expect, it } from "vitest"

import {
  assertPersistenceSafe,
  UnsafePersistencePayloadError,
} from "../src/event-ledger/persistence-safety.js"

describe("assertPersistenceSafe", () => {
  it("accepts bounded ordinary JSON data", () => {
    expect(() =>
      assertPersistenceSafe({
        eventId: "event-1",
        payload: {
          locator: "alpaca://option-quotes/SPY",
          reasons: ["SIGNAL_NOT_ACTIONABLE"],
        },
      }),
    ).not.toThrow()
  })

  it.each([
    { apiKey: "secret-value" },
    { nested: { secret_key: "secret-value" } },
    { authorization: "Bearer secret-value" },
    { accessToken: "secret-value" },
    { refreshToken: "secret-value" },
    { credentials: "secret-value" },
    { cookie: "session=secret" },
    { environment: { PATH: "/usr/bin" } },
    { requestHeaders: { accept: "application/json" } },
  ])("rejects prohibited key names without including values", (payload) => {
    let error: unknown
    try {
      assertPersistenceSafe(payload)
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(UnsafePersistencePayloadError)
    expect(String(error)).not.toContain("secret-value")
  })

  it("redacts untrusted property names from errors", () => {
    const unsafeProperty = "credential-value_secret"
    let error: unknown
    try {
      assertPersistenceSafe({ [unsafeProperty]: "value" })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(UnsafePersistencePayloadError)
    expect(String(error)).toContain("<field>")
    expect(String(error)).not.toContain(unsafeProperty)
  })

  it.each([
    "Bearer abcdefghijklmnop",
    "apikey=secret-value",
    "client_secret: secret-value",
  ])("rejects credentials embedded in ordinary strings", (value) => {
    expect(() => assertPersistenceSafe({ claim: value })).toThrow(
      UnsafePersistencePayloadError,
    )
  })

  it("rejects bare known credentials in text and property names", () => {
    const credential = "alpaca-bare-credential-123"

    expect(() =>
      assertPersistenceSafe({ claim: credential }, [credential]),
    ).toThrow(UnsafePersistencePayloadError)
    expect(() =>
      assertPersistenceSafe({ [credential]: true }, [credential]),
    ).toThrow(UnsafePersistencePayloadError)
    expect(() =>
      assertPersistenceSafe(
        { locator: `https://example.com/${encodeURIComponent(credential)}` },
        [credential],
      ),
    ).toThrow(UnsafePersistencePayloadError)
  })

  it.each([
    "https://example.com/mcp?apikey=secret-value",
    "https://user:password@example.com/data",
    "https://example.com/path?access%5Ftoken=secret-value",
    "https://example.com/path#token=secret-value",
    "https://example.com/data?refresh_token=secret-value",
    "https://example.com/data?credential=secret-value",
    "https://example.com/data?X-Amz-Credential=example&X-Amz-Signature=secret-value",
  ])("rejects credential-bearing URLs", (value) => {
    expect(() => assertPersistenceSafe({ locator: value })).toThrow(
      UnsafePersistencePayloadError,
    )
  })

  it("accepts URLs with non-secret query parameters", () => {
    expect(() =>
      assertPersistenceSafe({
        locator: "https://example.com/data?symbol=SPY&page=2#results",
      }),
    ).not.toThrow()
  })

  it.each([
    undefined,
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(),
  ])("rejects non-JSON-compatible values", (value) => {
    expect(() => assertPersistenceSafe({ value })).toThrow(
      UnsafePersistencePayloadError,
    )
  })

  it("rejects cycles and prototype-bearing objects", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => assertPersistenceSafe(cyclic)).toThrow(
      UnsafePersistencePayloadError,
    )

    const polluted = Object.create({ inherited: "value" }) as Record<string, unknown>
    polluted.safe = true
    expect(() => assertPersistenceSafe(polluted)).toThrow(
      UnsafePersistencePayloadError,
    )
  })

  it("rejects excessive nesting without overflowing the call stack", () => {
    let deeplyNested: unknown = "safe"
    for (let depth = 0; depth < 2_000; depth += 1) {
      deeplyNested = { nested: deeplyNested }
    }

    expect(() => assertPersistenceSafe(deeplyNested)).toThrow(
      UnsafePersistencePayloadError,
    )
  })
})
