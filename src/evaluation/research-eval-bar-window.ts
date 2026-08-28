export type ResearchEvalBarRequest = Readonly<{
  timeframe: "1Day" | "1Min"
  start: string
  end: string
  limit: number
}>

const dailyStarts: ReadonlySet<string> = new Set([
  "2026-06-01T00:00:00Z",
  "2026-06-17T00:00:00Z",
])
const dailyEnds: ReadonlySet<string> = new Set([
  "2026-08-26T00:00:00Z",
  "2026-08-26T13:30:00Z",
])
const dailyLimits: ReadonlySet<number> = new Set([50, 100])
const intradayStarts: ReadonlySet<string> = new Set([
  "2026-08-26T13:30:00Z",
])
const intradayEnds: ReadonlySet<string> = new Set([
  "2026-08-26T14:30:00Z",
  "2026-08-26T14:31:00Z",
])
const intradayLimits: ReadonlySet<number> = new Set([60, 100, 1_000])

export const researchEvalBarRequestMatchesFixture = (
  request: ResearchEvalBarRequest,
): boolean => request.timeframe === "1Day"
  ? dailyStarts.has(request.start) &&
    dailyEnds.has(request.end) &&
    dailyLimits.has(request.limit)
  : intradayStarts.has(request.start) &&
    intradayEnds.has(request.end) &&
    intradayLimits.has(request.limit)
