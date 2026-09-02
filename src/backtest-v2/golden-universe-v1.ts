export const GOLDEN_TECH_OPTIONS_UNIVERSE_V1 = [
  "AAPL", "ADBE", "ADI", "ADSK", "ALAB", "AMAT", "AMD", "APP",
  "ARM", "ASML", "AVGO", "CDNS", "CRWD", "CRWV", "DASH", "DDOG",
  "FTNT", "GOOG", "GOOGL", "INTC", "INTU", "KLAC", "LITE", "LRCX",
  "MCHP", "META", "MPWR", "MRVL", "MSFT", "MSTR", "MU", "NBIS",
  "NVDA", "NXPI", "PANW", "PDD", "PLTR", "QCOM", "ROP", "SHOP",
  "SNDK", "SNPS", "STX", "TER", "TRI", "TXN", "WDAY", "WDC",
] as const

export type GoldenTechOptionsSymbolV1 =
  (typeof GOLDEN_TECH_OPTIONS_UNIVERSE_V1)[number]

export const GOLDEN_TECH_OPTIONS_UNIVERSE_ID_V1 =
  "golden-tech-options-v1" as const

export const goldenTechOptionsSymbolSetV1: ReadonlySet<string> =
  new Set(GOLDEN_TECH_OPTIONS_UNIVERSE_V1)
