import { z } from "zod"

export const DEFAULT_PREMARKET_RESEARCH_START_ET = "08:00" as const
export const DRY_RUN_ANYTIME_RESEARCH_MODE = "DRY_RUN_ANYTIME" as const

export type ResearchMode = typeof DRY_RUN_ANYTIME_RESEARCH_MODE

export type MarketSessionV1 = Readonly<{
  date: string
  open: string
  close: string
  previousSessionDates?: readonly string[]
}>

const eligibilityTimestamp = z.iso.datetime({ offset: true, precision: 3 })

export const tradeIntentWindowV1Schema = z
  .object({
    slotStartedAt: eligibilityTimestamp,
    deadline: eligibilityTimestamp,
  })
  .strict()

export type TradeIntentWindowV1 = Readonly<{
  slotStartedAt: string
  deadline: string
}>

export const researchEligibilityV1Schema = z
  .object({
    evaluatedAt: eligibilityTimestamp,
    sessionDate: z.iso.date().optional(),
    sessionOpen: eligibilityTimestamp.optional(),
    sessionClose: eligibilityTimestamp.optional(),
    researchEligible: z.boolean(),
    tradeIntentEligible: z.boolean(),
    tradeIntentWindow: tradeIntentWindowV1Schema.optional(),
    previousSessionDates: z.array(z.iso.date()).max(16).optional(),
    researchMode: z.literal(DRY_RUN_ANYTIME_RESEARCH_MODE).optional(),
    reason: z
      .enum([
        "NO_MARKET_SESSION",
        "OUTSIDE_RESEARCH_WINDOW",
        "OUTSIDE_TRADE_INTENT_WINDOW",
        "DRY_RUN_RESEARCH_ONLY",
      ])
      .optional(),
  })
  .strict()
  .superRefine((eligibility, context) => {
    const isAnytimeDryRun =
      eligibility.researchMode === DRY_RUN_ANYTIME_RESEARCH_MODE
    const dryRunShapeIsValid = eligibility.researchEligible
      ? eligibility.tradeIntentEligible === false &&
        eligibility.tradeIntentWindow === undefined &&
        eligibility.reason === "DRY_RUN_RESEARCH_ONLY"
      : eligibility.tradeIntentEligible === false &&
        eligibility.tradeIntentWindow === undefined &&
        eligibility.reason === "NO_MARKET_SESSION"

    if (
      (isAnytimeDryRun && !dryRunShapeIsValid) ||
      (!isAnytimeDryRun && eligibility.reason === "DRY_RUN_RESEARCH_ONLY")
    ) {
      context.addIssue({
        code: "custom",
        path: ["researchMode"],
        message: "Anytime dry-run eligibility is internally inconsistent",
      })
    }
  })

export type ResearchEligibilityV1 = Readonly<{
  evaluatedAt: string
  sessionDate?: string | undefined
  sessionOpen?: string | undefined
  sessionClose?: string | undefined
  researchEligible: boolean
  tradeIntentEligible: boolean
  tradeIntentWindow?: TradeIntentWindowV1 | undefined
  previousSessionDates?: readonly string[] | undefined
  researchMode?: ResearchMode | undefined
  reason?:
    | "NO_MARKET_SESSION"
    | "OUTSIDE_RESEARCH_WINDOW"
    | "OUTSIDE_TRADE_INTENT_WINDOW"
    | "DRY_RUN_RESEARCH_ONLY"
    | undefined
}>

export type EvaluateResearchEligibilityOptions = Readonly<{
  evaluatedAt: Date
  session?: MarketSessionV1
  premarketStartEt?: string
  tradeIntentWindow?: TradeIntentWindowV1 | null
  researchMode?: ResearchMode
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
  tradeIntentWindow,
  researchMode,
}: EvaluateResearchEligibilityOptions): ResearchEligibilityV1 {
  const evaluatedMilliseconds = evaluatedAt.getTime()
  if (!Number.isFinite(evaluatedMilliseconds)) {
    throw new Error("Evaluation time is invalid")
  }
  if (!timeOfDay.test(premarketStartEt) || premarketStartEt >= "09:30") {
    throw new Error("Pre-market research start must use HH:MM before 09:30 ET")
  }
  if (session === undefined || newYorkDate(evaluatedAt) !== session.date) {
    return {
      evaluatedAt: evaluatedAt.toISOString(),
      researchEligible: false,
      tradeIntentEligible: false,
      reason: "NO_MARKET_SESSION",
      ...(researchMode === undefined ? {} : { researchMode }),
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

  if (researchMode === DRY_RUN_ANYTIME_RESEARCH_MODE) {
    return {
      evaluatedAt: evaluatedAt.toISOString(),
      sessionDate: session.date,
      sessionOpen: new Date(open).toISOString(),
      sessionClose: new Date(close).toISOString(),
      researchEligible: true,
      tradeIntentEligible: false,
      ...(session.previousSessionDates === undefined
        ? {}
        : { previousSessionDates: [...session.previousSessionDates] }),
      researchMode,
      reason: "DRY_RUN_RESEARCH_ONLY",
    }
  }

  const researchEligible =
    evaluatedMilliseconds >= premarketStart && evaluatedMilliseconds < close
  if (!researchEligible) {
    return {
      evaluatedAt: evaluatedAt.toISOString(),
      sessionDate: session.date,
      sessionOpen: new Date(open).toISOString(),
      sessionClose: new Date(close).toISOString(),
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
  let activeWindow: TradeIntentWindowV1 | undefined
  if (tradeIntentWindow === undefined) {
    if (
      evaluatedMilliseconds >= open &&
      slotAge >= 0 &&
      slotAge <= 119_999 &&
      slot.getTime() >= entryStart &&
      slot.getTime() < entryCutoff
    ) {
      activeWindow = {
        slotStartedAt: slot.toISOString(),
        deadline: new Date(
          Math.min(slot.getTime() + 5 * 60 * 1_000, entryCutoff),
        ).toISOString(),
      }
    }
  } else if (tradeIntentWindow !== null) {
    const slotStartedAt = Date.parse(tradeIntentWindow.slotStartedAt)
    const deadline = Date.parse(tradeIntentWindow.deadline)
    if (
      !Number.isFinite(slotStartedAt) ||
      !Number.isFinite(deadline) ||
      slotStartedAt < entryStart ||
      slotStartedAt >= entryCutoff ||
      deadline !== Math.min(slotStartedAt + 5 * 60 * 1_000, entryCutoff)
    ) {
      throw new Error("Trade-intent window is invalid")
    }
    activeWindow = tradeIntentWindow
  }
  const tradeIntentEligible =
    activeWindow !== undefined &&
    evaluatedMilliseconds >= Date.parse(activeWindow.slotStartedAt) &&
    evaluatedMilliseconds < Date.parse(activeWindow.deadline) &&
    evaluatedMilliseconds < entryCutoff

  return {
    evaluatedAt: evaluatedAt.toISOString(),
    sessionDate: session.date,
    sessionOpen: new Date(open).toISOString(),
    sessionClose: new Date(close).toISOString(),
    researchEligible: true,
    tradeIntentEligible,
    ...(activeWindow === undefined ? {} : { tradeIntentWindow: activeWindow }),
    ...(session.previousSessionDates === undefined
      ? {}
      : { previousSessionDates: [...session.previousSessionDates] }),
    ...(tradeIntentEligible
      ? {}
      : { reason: "OUTSIDE_TRADE_INTENT_WINDOW" as const }),
  }
}
