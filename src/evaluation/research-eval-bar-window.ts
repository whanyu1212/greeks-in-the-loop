export type ResearchEvalBarRequest = Readonly<{
  timeframe: "1Day" | "1Min"
  start: string
  end: string
  limit: number
}>

const instants = (values: readonly string[]): ReadonlySet<number> =>
  new Set(values.map((value) => Date.parse(value)))
const dailyStartMinimum = Date.parse("2026-06-01T00:00:00Z")
const dailyStartMaximum = Date.parse("2026-06-17T00:00:00Z")
const dailyEndMinimum = Date.parse("2026-08-26T00:00:00Z")
const dailyEndMaximum = Date.parse("2026-08-26T13:30:00Z")
const intradayStarts = instants(["2026-08-26T13:30:00Z"])
const intradayEnds = instants([
  "2026-08-26T14:30:00Z",
  "2026-08-26T14:31:00Z",
])
const intradayLimits: ReadonlySet<number> = new Set([60, 100, 1_000])

export const researchEvalBarRequestMatchesFixture = (
  request: ResearchEvalBarRequest,
): boolean => {
  const start = Date.parse(request.start)
  const end = Date.parse(request.end)
  return request.timeframe === "1Day"
    ? start >= dailyStartMinimum && start <= dailyStartMaximum &&
      end >= dailyEndMinimum && end <= dailyEndMaximum &&
      request.limit >= 50 && request.limit <= 100
    : intradayStarts.has(start) && intradayEnds.has(end) &&
      intradayLimits.has(request.limit)
}
