import { describe, expect, it, vi } from "vitest"

import { createAlpacaCalendarClient } from "../src/market-data/alpaca-calendar-client.js"

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

describe("Alpaca calendar client", () => {
  it("exposes only one read-only session lookup", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        { date: "2026-08-21", open: "09:30", close: "16:00" },
        { date: "2026-08-24", open: "09:30", close: "16:00" },
        { date: "2026-08-25", open: "09:30", close: "16:00" },
      ]),
    )
    const calendar = createAlpacaCalendarClient({
      apiKey: "key",
      secretKey: "secret",
      fetch: fetchMock,
      baseUrl: "https://test.invalid/path",
    })

    expect(Object.keys(calendar)).toEqual(["getSession"])
    await expect(
      calendar.getSession("2026-08-25", new AbortController().signal),
    ).resolves.toEqual({
      date: "2026-08-25",
      open: "2026-08-25T13:30:00.000Z",
      close: "2026-08-25T20:00:00.000Z",
      previousSessionDates: ["2026-08-21", "2026-08-24"],
    })
    const [requestUrl, init] = fetchMock.mock.calls[0]!
    const url = new URL(String(requestUrl))
    expect(url.pathname).toBe("/v2/calendar")
    expect(url.searchParams.get("start")).toBe("2026-08-11")
    expect(url.searchParams.get("end")).toBe("2026-08-25")
    expect(init).toMatchObject({ method: "GET", redirect: "error" })
    expect(init).not.toHaveProperty("body")
  })

  it("returns no session for a holiday", async () => {
    const calendar = createAlpacaCalendarClient({
      apiKey: "key",
      secretKey: "secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response([])),
    })
    await expect(
      calendar.getSession("2026-12-25", new AbortController().signal),
    ).resolves.toBeUndefined()
  })

  it("selects the latest completed session only when requested", async () => {
    const calendar = createAlpacaCalendarClient({
      apiKey: "key",
      secretKey: "secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response([
        { date: "2026-08-27", open: "09:30", close: "16:00" },
        { date: "2026-08-28", open: "09:30", close: "16:00" },
      ])),
    })
    await expect(
      calendar.getSession("2026-08-30", new AbortController().signal, true),
    ).resolves.toEqual({
      date: "2026-08-28",
      open: "2026-08-28T13:30:00.000Z",
      close: "2026-08-28T20:00:00.000Z",
      previousSessionDates: ["2026-08-27"],
    })
  })

  it("fails closed on malformed or unsuccessful responses", async () => {
    const malformed = createAlpacaCalendarClient({
      apiKey: "key",
      secretKey: "secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response([{}])),
    })
    const failed = createAlpacaCalendarClient({
      apiKey: "key",
      secretKey: "secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response({}, 503)),
    })
    await expect(
      malformed.getSession("2026-08-25", new AbortController().signal),
    ).rejects.toThrow("Alpaca calendar response is invalid")
    await expect(
      failed.getSession("2026-08-25", new AbortController().signal),
    ).rejects.toThrow("Alpaca calendar request failed")
  })

  it("rejects unsafe production base URLs", () => {
    expect(() =>
      createAlpacaCalendarClient({
        apiKey: "key",
        secretKey: "secret",
        baseUrl: "https://example.com",
      }),
    ).toThrow("ALPACA_TRADING_BASE_URL")
  })
})
