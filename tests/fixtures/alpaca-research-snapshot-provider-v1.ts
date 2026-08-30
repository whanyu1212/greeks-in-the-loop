export const CAPTURE_SESSION_DATE = "2026-08-28"
export const CAPTURE_SLOT_STARTED_AT = "2026-08-28T14:00:00.000Z"

const isoDate = (value: Date) => value.toISOString().slice(0, 10)

export const CAPTURE_PREVIOUS_SESSION_DATES = (() => {
  const dates: string[] = []
  const date = new Date(`${CAPTURE_SESSION_DATE}T00:00:00.000Z`)
  while (dates.length < 50) {
    date.setUTCDate(date.getUTCDate() - 1)
    if (date.getUTCDay() >= 1 && date.getUTCDay() <= 5) {
      dates.unshift(isoDate(date))
    }
  }
  return dates
})()

const calendar = [...CAPTURE_PREVIOUS_SESSION_DATES, CAPTURE_SESSION_DATE].map(
  (date) => ({ date, open: "09:30", close: "16:00" }),
)

const dailyBars = CAPTURE_PREVIOUS_SESSION_DATES.map((date, index) => ({
  t: `${date}T20:00:00Z`,
  o: (630 + index * 0.1).toFixed(2),
  h: (632 + index * 0.1).toFixed(2),
  l: (629 + index * 0.1).toFixed(2),
  c: (631 + index * 0.1).toFixed(2),
  vw: (630.5 + index * 0.1).toFixed(2),
  v: 50_000_000 + index,
}))

const minuteBars = Array.from({ length: 30 }, (_, index) => ({
  t: new Date(Date.parse("2026-08-28T13:30:00.000Z") + index * 60_000)
    .toISOString(),
  o: (635 + index * 0.01).toFixed(2),
  h: (635.2 + index * 0.01).toFixed(2),
  l: (634.9 + index * 0.01).toFixed(2),
  c: (635.1 + index * 0.01).toFixed(2),
  vw: (635.05 + index * 0.01).toFixed(2),
  v: 100_000 + index,
}))

export const CALL_CONTRACT_SYMBOL = "SPY260911C00600000"
export const PUT_CONTRACT_SYMBOL = "SPY260925P00550000"

const contracts = [
  {
    symbol: CALL_CONTRACT_SYMBOL,
    underlying_symbol: "SPY",
    expiration_date: "2026-09-11",
    type: "call",
    strike_price: "600",
    status: "active",
    tradable: true,
    style: "american",
    multiplier: "100",
    size: "100",
    open_interest: "900",
    open_interest_date: "2026-08-27",
  },
  {
    symbol: PUT_CONTRACT_SYMBOL,
    underlying_symbol: "SPY",
    expiration_date: "2026-09-25",
    type: "put",
    strike_price: "550",
    status: "active",
    tradable: false,
    style: "european",
    multiplier: "50",
    size: "100",
    open_interest: "1000",
    open_interest_date: "2026-08-27",
  },
]

const snapshots = {
  [PUT_CONTRACT_SYMBOL]: {
    latestQuote: {
      t: "2026-08-28T14:00:00.222222222Z",
      bp: "2.20",
      ap: "2.30",
    },
    greeks: {
      delta: "-0.5200004",
      gamma: "0.02",
      theta: "-0.10",
      vega: "0.15",
    },
    impliedVolatility: "0.20",
    dailyBar: { t: "2026-08-28T04:00:00Z", v: 220 },
  },
  [CALL_CONTRACT_SYMBOL]: {
    latestQuote: {
      t: "2026-08-28T14:00:00.111111111Z",
      bp: "1.20",
      ap: "1.30",
    },
    greeks: {
      delta: "0.2900005",
      gamma: "0.015",
      theta: "-0.08",
      vega: "0.12",
    },
    impliedVolatility: "0.19",
    dailyBar: { t: "2026-08-28T04:00:00Z", v: 180 },
  },
}

export const createSuccessfulAlpacaResearchResponses = () =>
  structuredClone({
    calendar,
    dailyBars: { bars: { SPY: dailyBars }, next_page_token: null },
    minuteBars: { bars: { SPY: minuteBars }, next_page_token: null },
    contracts: { option_contracts: contracts, next_page_token: null },
    snapshots: { snapshots, next_page_token: null },
    quote: {
      quotes: {
        SPY: {
          t: "2026-08-28T14:00:01.123456789Z",
          bp: "635.10",
          ap: "635.12",
        },
      },
    },
  })
