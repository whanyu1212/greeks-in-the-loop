export const DEFAULT_PREMARKET_RESEARCH_START_ET = "08:00" as const

export type MarketSessionV1 = Readonly<{
  date: string
  open: string
  close: string
}>

export type ResearchEligibilityV1 = Readonly<{
  evaluatedAt: string
  sessionDate?: string
  researchEligible: boolean
  tradeIntentEligible: boolean
  reason?: "NO_MARKET_SESSION" | "OUTSIDE_RESEARCH_WINDOW" | "OUTSIDE_TRADE_INTENT_WINDOW"
}>

export type EvaluateResearchEligibilityOptions = Readonly<{
  evaluatedAt: Date
  session?: MarketSessionV1
  premarketStartEt?: string
}>

const timeOfDay = /^(?:[01]\d|2[0-3]):[0-5]\d$/u
const newYorkFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

const partsAt = (date: Date) =>
  Object.fromEntries(
    newYorkFormatter
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, Number(value)]),
  ) as Record<string, number>

export const newYorkDate = (date: Date): string => {
  if (!Number.isFinite(date.getTime())) throw new Error("Evaluation time is invalid")
  const parts = partsAt(date)
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`
}

export const newYorkLocalTime = (date: string, time: string): Date => {
  if (!zonedDatePattern.test(date) || !timeOfDay.test(time)) {
    throw new Error("New York local date or time is invalid")
  }
  const [year, month, day] = date.split("-").map(Number)
  const [hour, minute] = time.split(":").map(Number)
  const localAsUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!)
  let candidate = localAsUtc
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = partsAt(new Date(candidate))
    const representedAsUtc = Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
      parts.second!,
    )
    candidate = localAsUtc - (representedAsUtc - candidate)
  }
  return new Date(candidate)
}

const zonedDatePattern = /^\d{4}-\d{2}-\d{2}$/u

const floorToQuarterHour = (date: Date): Date => {
  const slot = new Date(date)
  slot.setUTCMinutes(Math.floor(slot.getUTCMinutes() / 15) * 15, 0, 0)
  return slot
}

export function evaluateResearchEligibility({
  evaluatedAt,
  session,
  premarketStartEt = DEFAULT_PREMARKET_RESEARCH_START_ET,
}: EvaluateResearchEligibilityOptions): ResearchEligibilityV1 {
  const evaluatedMilliseconds = evaluatedAt.getTime()
  if (!Number.isFinite(evaluatedMilliseconds)) {
    throw new Error("Evaluation time is invalid")
  }
  if (!timeOfDay.test(premarketStartEt)) {
    throw new Error("Pre-market research start must use HH:MM")
  }
  if (session === undefined || newYorkDate(evaluatedAt) !== session.date) {
    return {
      evaluatedAt: evaluatedAt.toISOString(),
      researchEligible: false,
      tradeIntentEligible: false,
      reason: "NO_MARKET_SESSION",
    }
  }

  const open = Date.parse(session.open)
  const close = Date.parse(session.close)
  const premarketStart = newYorkLocalTime(session.date, premarketStartEt).getTime()
  if (
    !Number.isFinite(open) ||
    !Number.isFinite(close) ||
    open >= close ||
    premarketStart >= open
  ) {
    throw new Error("Market session is invalid")
  }

  const researchEligible =
    evaluatedMilliseconds >= premarketStart && evaluatedMilliseconds < close
  if (!researchEligible) {
    return {
      evaluatedAt: evaluatedAt.toISOString(),
      sessionDate: session.date,
      researchEligible: false,
      tradeIntentEligible: false,
      reason: "OUTSIDE_RESEARCH_WINDOW",
    }
  }

  const slot = floorToQuarterHour(evaluatedAt)
  const slotAge = evaluatedMilliseconds - slot.getTime()
  const entryStart = newYorkLocalTime(session.date, "10:00").getTime()
  const configuredEntryCutoff = newYorkLocalTime(session.date, "15:00").getTime()
  const sessionCutoff = close - 60 * 60 * 1_000
  const entryCutoff = Math.min(configuredEntryCutoff, sessionCutoff)
  const tradeIntentEligible =
    evaluatedMilliseconds >= open &&
    slotAge >= 0 &&
    slotAge <= 119_999 &&
    slot.getTime() >= entryStart &&
    slot.getTime() < entryCutoff &&
    evaluatedMilliseconds < slot.getTime() + 5 * 60 * 1_000 &&
    evaluatedMilliseconds < entryCutoff

  return {
    evaluatedAt: evaluatedAt.toISOString(),
    sessionDate: session.date,
    researchEligible: true,
    tradeIntentEligible,
    ...(tradeIntentEligible
      ? {}
      : { reason: "OUTSIDE_TRADE_INTENT_WINDOW" as const }),
  }
}
