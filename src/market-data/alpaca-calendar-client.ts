import { z } from "zod"

import {
  newYorkLocalTime,
  type MarketSessionV1,
} from "../scheduling/research-eligibility.js"

const calendarDaySchema = z
  .object({
    date: z.iso.date(),
    open: z.string().min(1).max(64),
    close: z.string().min(1).max(64),
  })
  .passthrough()
const calendarResponseSchema = z.array(calendarDaySchema).max(16)
const localTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/u

export type MarketCalendar = Readonly<{
  getSession(date: string, signal: AbortSignal): Promise<MarketSessionV1 | undefined>
}>

export type CreateAlpacaCalendarClientOptions = Readonly<{
  apiKey: string
  secretKey: string
  baseUrl?: string
  fetch?: typeof fetch
}>

const normalizeBaseUrl = (value: string, allowCustomHost: boolean): string => {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      (!allowCustomHost &&
        !["https://paper-api.alpaca.markets", "https://api.alpaca.markets"].includes(
          url.origin,
        ))
    ) {
      throw new Error("invalid origin")
    }
    return url.origin
  } catch {
    throw new Error(
      "ALPACA_TRADING_BASE_URL must be a credential-free Alpaca HTTPS URL",
    )
  }
}

const parseSessionTimestamp = (date: string, value: string): string => {
  if (localTime.test(value)) return newYorkLocalTime(date, value).toISOString()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error("Alpaca calendar response is invalid")
  return new Date(parsed).toISOString()
}

/** Creates the read-only market-calendar boundary used by research gating. */
export function createAlpacaCalendarClient(
  options: CreateAlpacaCalendarClientOptions,
): MarketCalendar {
  const request = options.fetch ?? fetch
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? "https://paper-api.alpaca.markets",
    options.fetch !== undefined,
  )

  return {
    async getSession(date, signal) {
      const parsedDate = z.iso.date().parse(date)
      const lookbackStart = new Date(
        Date.parse(`${parsedDate}T00:00:00.000Z`) - 14 * 86_400_000,
      ).toISOString().slice(0, 10)
      const url = new URL("/v2/calendar", baseUrl)
      url.searchParams.set("start", lookbackStart)
      url.searchParams.set("end", parsedDate)

      let response: Response
      try {
        response = await request(url, {
          method: "GET",
          redirect: "error",
          headers: {
            "APCA-API-KEY-ID": options.apiKey,
            "APCA-API-SECRET-KEY": options.secretKey,
          },
          signal,
        })
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        throw new Error("Alpaca calendar request failed")
      }
      if (!response.ok) throw new Error("Alpaca calendar request failed")

      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error
        throw new Error("Alpaca calendar response is invalid")
      }
      const parsed = calendarResponseSchema.safeParse(body)
      if (!parsed.success) throw new Error("Alpaca calendar response is invalid")
      const dates = parsed.data.map(({ date: sessionDate }) => sessionDate)
      if (
        new Set(dates).size !== dates.length ||
        dates.some((sessionDate) => sessionDate > parsedDate)
      ) {
        throw new Error("Alpaca calendar response is invalid")
      }
      const matchingDays = parsed.data.filter((day) => day.date === parsedDate)
      if (matchingDays.length === 0) return undefined
      if (matchingDays.length !== 1) {
        throw new Error("Alpaca calendar response is invalid")
      }

      const day = matchingDays[0]!
      const session = {
        date: day.date,
        open: parseSessionTimestamp(day.date, day.open),
        close: parseSessionTimestamp(day.date, day.close),
        previousSessionDates: dates
          .filter((sessionDate) => sessionDate < parsedDate)
          .sort(),
      }
      if (Date.parse(session.open) >= Date.parse(session.close)) {
        throw new Error("Alpaca calendar response is invalid")
      }
      return session
    },
  }
}
