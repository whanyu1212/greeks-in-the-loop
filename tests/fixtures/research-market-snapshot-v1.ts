import { CURRENT_STRATEGY_MANIFEST } from "../../src/strategy/strategy-registry.js"
import type {
  OptionUniverseSnapshotBuildInputV1,
  UnderlyingSessionSnapshotBuildInputV1,
} from "../../src/contracts/research-market-snapshot-builders-v1.js"

const isoDate = (value: Date) => value.toISOString().slice(0, 10)

export const SNAPSHOT_SESSION_DATE = "2026-08-28"
export const SNAPSHOT_PREVIOUS_SESSION_DATES = (() => {
  const dates: string[] = []
  const date = new Date(`${SNAPSHOT_SESSION_DATE}T00:00:00.000Z`)
  while (dates.length < 50) {
    date.setUTCDate(date.getUTCDate() - 1)
    if (date.getUTCDay() >= 1 && date.getUTCDay() <= 5) {
      dates.unshift(isoDate(date))
    }
  }
  return dates
})()

const dailyBars = SNAPSHOT_PREVIOUS_SESSION_DATES.map((sessionDate, index) => ({
  symbol: "SPY" as const,
  sessionDate,
  startedAt: `${sessionDate}T20:00:00.000Z`,
  openMicrosPerShare: 630_000_000 + index * 100_000,
  highMicrosPerShare: 632_000_000 + index * 100_000,
  lowMicrosPerShare: 629_000_000 + index * 100_000,
  closeMicrosPerShare: 631_000_000 + index * 100_000,
  vwapMicrosPerShare: 630_500_000 + index * 100_000,
  volume: 50_000_000 + index,
}))

const minuteBars = Array.from({ length: 30 }, (_, index) => {
  const startedAt = new Date(
    Date.parse("2026-08-28T13:30:00.000Z") + index * 60_000,
  ).toISOString()
  return {
    symbol: "SPY" as const,
    startedAt,
    openMicrosPerShare: 635_000_000 + index * 10_000,
    highMicrosPerShare: 635_200_000 + index * 10_000,
    lowMicrosPerShare: 634_900_000 + index * 10_000,
    closeMicrosPerShare: 635_100_000 + index * 10_000,
    vwapMicrosPerShare: 635_050_000 + index * 10_000,
    volume: 100_000 + index,
  }
})

const underlyingInput: UnderlyingSessionSnapshotBuildInputV1 = {
  strategyManifest: CURRENT_STRATEGY_MANIFEST,
  underlying: "SPY",
  session: {
    date: SNAPSHOT_SESSION_DATE,
    openAt: "2026-08-28T13:30:00.000Z",
    closeAt: "2026-08-28T20:00:00.000Z",
    previousSessionDates: SNAPSHOT_PREVIOUS_SESSION_DATES,
  },
  times: {
    slotStartedAt: "2026-08-28T14:00:00.000Z",
    captureStartedAt: "2026-08-28T14:00:02.000Z",
    observedAt: "2026-08-28T14:00:59.000Z",
    evaluatedAt: "2026-08-28T14:01:00.000Z",
  },
  sources: {
    calendar: {
      provider: "ALPACA",
      source: "MARKET_CALENDAR",
      retrievedAt: "2026-08-28T14:00:10.000Z",
    },
    dailyBars: {
      provider: "ALPACA",
      source: "STOCK_BARS",
      feed: "IEX",
      adjustment: "ALL",
      retrievedAt: "2026-08-28T14:00:20.000Z",
    },
    minuteBars: {
      provider: "ALPACA",
      source: "STOCK_BARS",
      feed: "IEX",
      marketHours: "REGULAR",
      retrievedAt: "2026-08-28T14:00:40.000Z",
    },
    quote: {
      provider: "ALPACA",
      source: "STOCK_LATEST_QUOTE",
      feed: "IEX",
      retrievedAt: "2026-08-28T14:00:55.000Z",
    },
  },
  pagination: {
    dailyBars: "NO_NEXT_PAGE_TOKEN",
    minuteBars: "NO_NEXT_PAGE_TOKEN",
  },
  dailyBars,
  minuteBars,
  underlyingQuote: {
    symbol: "SPY",
    providerTimestamp: "2026-08-28T14:00:30.000Z",
    bidMicrosPerShare: 635_100_000,
    askMicrosPerShare: 635_120_000,
  },
}

const optionInput: OptionUniverseSnapshotBuildInputV1 = {
  underlying: "SPY",
  sources: {
    contracts: {
      provider: "ALPACA",
      source: "OPTION_CONTRACTS",
      retrievedAt: "2026-08-28T14:00:35.000Z",
    },
    marketSnapshots: {
      provider: "ALPACA",
      source: "OPTION_SNAPSHOTS",
      feed: "INDICATIVE",
      retrievedAt: "2026-08-28T14:00:58.000Z",
    },
  },
  contractPaginationTermination: "NO_NEXT_PAGE_TOKEN",
  requestedContractSymbols: [
    "SPY260925P00550000",
    "SPY260911C00600000",
  ],
  contracts: [
    {
      contractSymbol: "SPY260925P00550000",
      expirationDate: "2026-09-25",
      optionType: "PUT",
      strikeCentsPerShare: 55_000,
      active: true,
      tradable: true,
      exerciseStyle: "AMERICAN",
      multiplier: 100,
      quote: {
        providerTimestamp: "2026-08-28T14:00:44.000Z",
        bidCentsPerShare: 220,
        askCentsPerShare: 230,
      },
      greeks: {
        deltaMillionths: -520_000,
        gammaMillionths: 20_000,
        thetaMillionths: -100_000,
        vegaMillionths: 150_000,
        impliedVolatilityMillionths: 200_000,
      },
      currentSessionVolume: {
        sessionDate: SNAPSHOT_SESSION_DATE,
        providerTimestamp: "2026-08-28T14:00:00.000Z",
        contracts: 220,
      },
      openInterest: { asOfDate: "2026-08-27", contracts: 1_000 },
    },
    {
      contractSymbol: "SPY260911C00600000",
      expirationDate: "2026-09-11",
      optionType: "CALL",
      strikeCentsPerShare: 60_000,
      active: true,
      tradable: false,
      exerciseStyle: "EUROPEAN",
      multiplier: 50,
      quote: {
        providerTimestamp: "2026-08-28T14:00:45.000Z",
        bidCentsPerShare: 120,
        askCentsPerShare: 130,
      },
      greeks: {
        deltaMillionths: 290_000,
        gammaMillionths: 15_000,
        thetaMillionths: -80_000,
        vegaMillionths: 120_000,
        impliedVolatilityMillionths: 190_000,
      },
      currentSessionVolume: {
        sessionDate: SNAPSHOT_SESSION_DATE,
        providerTimestamp: "2026-08-28T14:00:00.000Z",
        contracts: 180,
      },
      openInterest: { asOfDate: "2026-08-27", contracts: 900 },
    },
  ],
}

export const createUnderlyingSnapshotInputV1 = () =>
  structuredClone(underlyingInput)

export const createOptionUniverseSnapshotInputV1 = () =>
  structuredClone(optionInput)
