import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { config as loadEnvironment } from "dotenv"
import { z } from "zod"

import { canonicalLedgerTargetPath } from "../agent-options.js"
import {
  tradeIntentV4Schema,
  type TradeIntentV4,
} from "../contracts/trade-intent-v4.js"
import {
  createConfiguredLedgerStore,
  type LedgerBackendConfiguration,
} from "../event-ledger/ledger-backend.js"
import type { LedgerEventV4 } from "../event-ledger/ledger-event-v1.js"
import { createAlpacaOptionQuoteProvider } from "../market-data/alpaca-option-quotes.js"
import {
  evaluateTradeIntentRiskV1,
  riskEvaluationInputV2Schema,
  RISK_EVALUATION_VERSION,
  RISK_RULE_VERSION,
} from "../risk/risk-evaluation-v1.js"
import { SHADOW_RISK_DECISION_VERSION } from "../risk/shadow-risk-v1.js"
import { parseAlpacaOptionSymbol } from "../shared/alpaca-option-identity.js"
import { createAlpacaOrderSubmitter } from "./alpaca-order-submitter.js"
import { executeApprovedTradeV1 } from "./trade-executor.js"

/**
 * Validation harness that drives one real paper order without the agent.
 *
 * Quotes and the broker are real. Only the application-owned risk *state* —
 * account, portfolio, contract metadata, collateral, and the schedule window —
 * is supplied synthetically, so the pure `evaluateTradeIntentRiskV1` still runs
 * in full and an order stays unreachable unless it returns `APPROVED`. This
 * exercises the architecture-plan section 6.A execution path while the research
 * agent cannot reliably produce a passing proposal.
 *
 * It refuses the production ledger and any non-paper broker endpoint.
 */

const DEFAULT_MOCK_LEDGER_PATH: string = ".state/mock-execution.sqlite"
const PRODUCTION_LEDGER_PATH: string = ".state/research-ledger.sqlite"
const PAPER_TRADING_ORIGIN = "https://paper-api.alpaca.markets" as const

loadEnvironment({ quiet: true })

const readSetting = (name: string) => process.env[name]?.trim()
const readRequiredSetting = (name: string) => {
  const value = readSetting(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

/** Forces the mutation harness onto its dedicated local backend. */
export const resolveMockLedgerConfiguration = (
  ledgerPath: string,
): LedgerBackendConfiguration => {
  if (
    canonicalLedgerTargetPath(ledgerPath) ===
      canonicalLedgerTargetPath(PRODUCTION_LEDGER_PATH)
  ) {
    throw new Error("Mock execution cannot use the production research ledger")
  }
  return { backend: "sqlite", path: ledgerPath }
}

type MockTradeOptions = Readonly<{
  longContractSymbol: string
  shortContractSymbol: string
  ledgerPath: string
  equityCents: number
  buyingPowerCents: number
  confirm: boolean
}>

const parseOptions = (args: readonly string[]): MockTradeOptions => {
  let longContractSymbol: string | undefined
  let shortContractSymbol: string | undefined
  let ledgerPath = DEFAULT_MOCK_LEDGER_PATH
  let equityCents = 10_000_000
  let buyingPowerCents = 10_000_000
  let confirm = false

  const requireValue = (flag: string, value: string | undefined) => {
    const trimmed = value?.trim()
    if (!trimmed) throw new Error(`${flag} requires a value`)
    return trimmed
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--") continue
    switch (argument) {
      case "--long":
        longContractSymbol = requireValue("--long", args[++index])
        break
      case "--short":
        shortContractSymbol = requireValue("--short", args[++index])
        break
      case "--ledger":
        ledgerPath = requireValue("--ledger", args[++index])
        break
      case "--equity-cents":
        equityCents = Number(requireValue("--equity-cents", args[++index]))
        break
      case "--buying-power-cents":
        buyingPowerCents = Number(
          requireValue("--buying-power-cents", args[++index]),
        )
        break
      case "--confirm":
        confirm = true
        break
      default:
        throw new Error(`Unknown option: ${argument ?? ""}`)
    }
  }

  if (longContractSymbol === undefined || shortContractSymbol === undefined) {
    throw new Error(
      "Usage: pnpm execute:mock -- --long <OCC> --short <OCC> [--confirm]",
    )
  }
  if (
    !Number.isSafeInteger(equityCents) ||
    !Number.isSafeInteger(buyingPowerCents) ||
    equityCents <= 0 ||
    buyingPowerCents <= 0
  ) {
    throw new Error("Synthetic account amounts must be positive integers")
  }
  resolveMockLedgerConfiguration(ledgerPath)

  return {
    longContractSymbol,
    shortContractSymbol,
    ledgerPath,
    equityCents,
    buyingPowerCents,
    confirm,
  }
}

/**
 * Builds the synthetic, application-owned risk state around a real intent.
 *
 * Typed against the risk input schema so a future change to the captured
 * state shape breaks `pnpm typecheck` here, rather than silently degrading
 * this harness into a permanent `RISK_INPUT_INVALID` rejection.
 */
const buildMockRiskContext = (
  intent: TradeIntentV4,
  options: MockTradeOptions,
  observedAt: string,
  sessionDate: string,
): z.input<typeof riskEvaluationInputV2Schema>["context"] => ({
  provenance: "APPLICATION_VERIFIED" as const,
  eligibility: {
    evaluatedAt: observedAt,
    sessionDate,
    researchEligible: true,
    tradeIntentEligible: true,
    tradeIntentWindow: {
      slotStartedAt: observedAt,
      deadline: new Date(Date.parse(observedAt) + 10 * 60_000).toISOString(),
    },
  },
  account: {
    snapshotVersion: "2.0.0" as const,
    observedAt,
    status: "ACTIVE" as const,
    tradingRestricted: false,
    buyingPowerCents: options.buyingPowerCents,
    equityCents: options.equityCents,
    lastEquityCents: options.equityCents,
    cashCents: options.buyingPowerCents,
    // Level 3 is the multi-leg approval the risk gate requires; the two
    // fields must agree or the account schema rejects the state.
    optionsApprovedLevel: 3,
    optionsTradingLevel: 3,
    multilegOptionsApproved: true,
  },
  candidateCollateral: {
    underlying: intent.underlying,
    longUnderlyingShares: 0,
    cashAvailableCents: options.buyingPowerCents,
    requiredLongSharesPerUnit: 0,
    requiredCashCentsPerUnit: 0,
    maxUnitsFromShares: null,
    maxUnitsFromCash: null,
  },
  portfolio: {
    observedAt,
    consistent: true,
    openStrategyPositionCount: 0,
    pendingEntryCount: 0,
    entriesSubmittedToday: 0,
    dailyBreakerActive: false,
    competitionBreakerActive: false,
  },
  contracts: {
    snapshotVersion: "2.0.0" as const,
    slotStartedAt: observedAt,
    observedAt,
    legs: intent.legs.map((leg) => ({
      contractSymbol: leg.contractSymbol,
      positionIntent: leg.positionIntent,
      ratioQuantity: leg.ratioQuantity,
      active: true,
      tradable: true,
      exerciseStyle: "AMERICAN" as const,
      multiplier: 100,
      delta: leg.positionIntent === "BUY_TO_OPEN" ? 0.52 : 0.28,
      impliedVolatility: 0.17,
      gamma: 0.012,
      theta: -0.08,
      vega: 0.31,
      volume: 1_200,
      volumeDate: sessionDate,
      openInterest: 8_400,
      openInterestDate: sessionDate,
    })),
  },
})

const main = async () => {
  const options = parseOptions(process.argv.slice(2))
  const tradingBaseUrl =
    readSetting("ALPACA_TRADING_BASE_URL") || PAPER_TRADING_ORIGIN
  // Plan section 9: assert the paper endpoint at startup.
  if (tradingBaseUrl !== PAPER_TRADING_ORIGIN) {
    throw new Error("Mock execution is restricted to the Alpaca paper endpoint")
  }

  const apiKey = readRequiredSetting("ALPACA_API_KEY")
  const secretKey = readRequiredSetting("ALPACA_SECRET_KEY")
  const signal = AbortSignal.timeout(60_000)

  // 1. Real quotes for the real legs.
  const quoteProvider = createAlpacaOptionQuoteProvider({
    apiKey,
    secretKey,
    baseUrl:
      readSetting("ALPACA_MARKET_DATA_BASE_URL") || "https://data.alpaca.markets",
  })
  const confirmation = await quoteProvider.confirmQuotes({
    contractSymbols: [options.longContractSymbol, options.shortContractSymbol],
    signal,
  })
  if (!confirmation.success) {
    console.error(`Quote confirmation failed: ${confirmation.reasons.join(", ")}`)
    process.exitCode = 1
    return
  }

  const { evaluatedAt, snapshotMetadata, quotes } = confirmation.snapshot
  const longQuote = quotes.find(
    ({ contractSymbol }) => contractSymbol === options.longContractSymbol,
  )
  const shortQuote = quotes.find(
    ({ contractSymbol }) => contractSymbol === options.shortContractSymbol,
  )
  if (longQuote === undefined || shortQuote === undefined) {
    console.error("Confirmed snapshot did not cover both requested legs")
    process.exitCode = 1
    return
  }

  const longIdentity = parseAlpacaOptionSymbol(options.longContractSymbol)
  if (!longIdentity.success) {
    throw new Error("The long leg must be a valid OCC option symbol")
  }

  // 2. Exact net debit from those quotes; no model-authored numbers.
  //    TradeIntentV4 prices the entry at the natural debit, so the limit is
  //    marketable rather than resting at the midpoint.
  const entryLimitCentsPerStrategyUnit =
    longQuote.askCentsPerShare - shortQuote.bidCentsPerShare
  if (entryLimitCentsPerStrategyUnit <= 0) {
    console.error("Selected legs do not form a net debit spread")
    process.exitCode = 1
    return
  }

  const strategy =
    longIdentity.identity.optionType === "C"
      ? "BULL_CALL_SPREAD"
      : "BEAR_PUT_SPREAD"
  const parsedIntent = tradeIntentV4Schema.safeParse({
    contractVersion: "4.0.0",
    decisionContractVersion: "4.0.0",
    underlying: longIdentity.identity.root,
    direction: strategy === "BULL_CALL_SPREAD" ? "BULLISH" : "BEARISH",
    strategy,
    quoteSnapshotRef: snapshotMetadata.source,
    evaluatedAt,
    legs: [
      {
        contractSymbol: options.longContractSymbol,
        positionIntent: "BUY_TO_OPEN",
        ratioQuantity: 1,
        quote: longQuote,
      },
      {
        contractSymbol: options.shortContractSymbol,
        positionIntent: "SELL_TO_OPEN",
        ratioQuantity: 1,
        quote: shortQuote,
      },
    ],
    premiumEffect: "DEBIT",
    entryLimitCentsPerStrategyUnit,
  })
  if (!parsedIntent.success) {
    console.error(
      `Trade intent rejected: ${parsedIntent.error.issues
        .map(({ path, message }) => `${path.join(".")}: ${message}`)
        .join("; ")}`,
    )
    process.exitCode = 1
    return
  }
  const intent = parsedIntent.data as TradeIntentV4

  // 3. The real pure risk gate over synthetic application state.
  const sessionDate = evaluatedAt.slice(0, 10)
  const context = buildMockRiskContext(intent, options, evaluatedAt, sessionDate)
  const evaluation = evaluateTradeIntentRiskV1({ intent, context })

  console.log(
    `Intent: ${intent.strategy} ${intent.legs
      .map(({ contractSymbol }) => contractSymbol)
      .join(" / ")}`,
  )
  console.log(
    `Entry limit: ${intent.entryLimitCentsPerStrategyUnit}c per strategy unit`,
  )
  console.log(`Risk: ${evaluation.outcome} (rule ${evaluation.ruleVersion})`)
  if (evaluation.outcome !== "APPROVED") {
    console.log(`Reasons: ${evaluation.reasonCodes.join(", ")}`)
    process.exitCode = 1
    return
  }
  if (!options.confirm) {
    console.log("Approved. Re-run with --confirm to submit this paper order.")
    return
  }

  // 4. Record the approval durably, then execute against it.
  mkdirSync(dirname(options.ledgerPath), { recursive: true })
  const store = await createConfiguredLedgerStore({
    configuration: resolveMockLedgerConfiguration(options.ledgerPath),
    knownCredentialValues: [apiKey, secretKey],
  })
  await store.migrate(signal)

  const cycleId = `mock-${randomUUID()}`
  const occurredAt = new Date().toISOString()
  const decision = {
    decisionVersion: SHADOW_RISK_DECISION_VERSION,
    mode: "SHADOW" as const,
    evaluationVersion: RISK_EVALUATION_VERSION,
    ruleVersion: RISK_RULE_VERSION,
    stage: "EVALUATED" as const,
    outcome: "APPROVED" as const,
    evaluatedIntent: intent,
    stateProvenance: {
      capturedAt: occurredAt,
      accountObservedAt: evaluatedAt,
      portfolioObservedAt: evaluatedAt,
      contractsObservedAt: evaluatedAt,
      quoteSnapshot: {
        provider: "ALPACA" as const,
        source: snapshotMetadata.source,
        retrievedAt: evaluatedAt,
        freshUntil: new Date(Date.parse(evaluatedAt) + 60_000).toISOString(),
      },
      reconciliationReasonCodes: [],
    },
    evaluation,
  }

  await store.appendBatch(
    [
      { eventType: "RESEARCH_CYCLE_STARTED", payload: { cycleNumber: 1 } },
      { eventType: "TRADE_INTENT_DERIVED", payload: { intent } },
      { eventType: "RISK_SHADOW_DECISION_RECORDED", payload: { decision } },
    ].map((event, index) => ({
      ...event,
      eventId: `${cycleId}-${index}`,
      eventVersion: "4.0.0",
      occurredAt,
      correlationId: cycleId,
      cycleId,
      ...(index === 0 ? {} : { causationEventId: `${cycleId}-${index - 1}` }),
    })) as LedgerEventV4[],
    signal,
  )

  const submitter = createAlpacaOrderSubmitter({
    apiKey,
    secretKey,
    tradingBaseUrl,
  })
  const execution = await executeApprovedTradeV1({
    store,
    submitter,
    shadowRisk: { decision, breakerTransitions: [] },
    cycleId,
    signal,
  })

  console.log(`Execution: ${JSON.stringify(execution)}`)
  const recorded = await store.list({ cycleId, direction: "ASC", limit: 20 })
  console.log(
    `Ledger (${options.ledgerPath}): ${recorded
      .map((event) => event.eventType)
      .join(" -> ")}`,
  )
  await store.close()
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) await main()
