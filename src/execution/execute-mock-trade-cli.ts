import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"

import { config as loadEnvironment } from "dotenv"

import {
  calculateDebitSpreadEconomicsV1,
} from "../contracts/debit-spread-economics-v1.js"
import {
  tradeIntentV2Schema,
  type TradeIntentV2,
} from "../contracts/trade-intent-v2.js"
import { createSqliteLedgerStore } from "../event-ledger/sqlite-ledger-store.js"
import type { LedgerEventV2 } from "../event-ledger/ledger-event-v1.js"
import { createAlpacaOptionQuoteProvider } from "../market-data/alpaca-option-quotes.js"
import {
  evaluateTradeIntentRiskV1,
  RISK_EVALUATION_VERSION,
  RISK_RULE_VERSION,
  type RiskEvaluationInputV1,
} from "../risk/risk-evaluation-v1.js"
import { SHADOW_RISK_DECISION_VERSION } from "../risk/shadow-risk-v1.js"
import {
  alpacaOptionStrikeCents,
  parseAlpacaOptionSymbol,
} from "../shared/alpaca-option-identity.js"
import { createAlpacaOrderSubmitter } from "./alpaca-order-submitter.js"
import { executeApprovedTradeV1 } from "./trade-executor.js"

/**
 * Validation harness that drives one real paper order without the agent.
 *
 * Quotes and the broker are real. Only the application-owned risk *state* —
 * account, portfolio, contract metadata, and the schedule window — is
 * supplied synthetically, so the pure `evaluateTradeIntentRiskV1` still runs
 * in full and an order is still unreachable unless it returns `APPROVED`.
 * This exists to exercise the execution path end to end while the research
 * agent cannot reliably produce a passing proposal.
 *
 * It refuses to touch the production ledger and refuses any non-paper broker.
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
  if (ledgerPath === PRODUCTION_LEDGER_PATH) {
    throw new Error("Mock execution cannot use the production research ledger")
  }

  return {
    longContractSymbol,
    shortContractSymbol,
    ledgerPath,
    equityCents,
    buyingPowerCents,
    confirm,
  }
}

/** Builds the synthetic, application-owned risk state around a real intent. */
const buildMockRiskContext = (
  intent: TradeIntentV2,
  options: MockTradeOptions,
  observedAt: string,
  sessionDate: string,
): RiskEvaluationInputV1["context"] => {
  const leg = (role: "LONG" | "SHORT", contractSymbol: string) => ({
    role,
    contractSymbol,
    active: true,
    tradable: true,
    exerciseStyle: "AMERICAN" as const,
    multiplier: 100,
    delta: role === "LONG" ? 0.52 : 0.28,
    impliedVolatility: 0.17,
    gamma: 0.012,
    theta: -0.08,
    vega: 0.31,
    volume: 1_200,
    volumeDate: sessionDate,
    openInterest: 8_400,
    openInterestDate: sessionDate,
  })

  return {
    provenance: "APPLICATION_VERIFIED",
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
      observedAt,
      status: "ACTIVE",
      tradingRestricted: false,
      multilegOptionsApproved: true,
      buyingPowerCents: options.buyingPowerCents,
      equityCents: options.equityCents,
      lastEquityCents: options.equityCents,
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
      slotStartedAt: observedAt,
      observedAt,
      legs: [
        leg("LONG", intent.longContractSymbol),
        leg("SHORT", intent.shortContractSymbol),
      ],
    },
  }
}

const main = async () => {
  const options = parseOptions(process.argv.slice(2))
  const tradingBaseUrl =
    readSetting("ALPACA_TRADING_BASE_URL") || PAPER_TRADING_ORIGIN
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
    baseUrl: readSetting("ALPACA_MARKET_DATA_BASE_URL") || "https://data.alpaca.markets",
  })
  const confirmation = await quoteProvider.confirmQuotes({
    longContractSymbol: options.longContractSymbol,
    shortContractSymbol: options.shortContractSymbol,
    signal,
  })
  if (!confirmation.success) {
    console.error(`Quote confirmation failed: ${confirmation.reasons.join(", ")}`)
    process.exitCode = 1
    return
  }

  const { longQuote, shortQuote, evaluatedAt, snapshotMetadata } =
    confirmation.snapshot
  const quoteSnapshotRef = snapshotMetadata.source
  const longIdentity = parseAlpacaOptionSymbol(options.longContractSymbol)
  const shortIdentity = parseAlpacaOptionSymbol(options.shortContractSymbol)
  if (!longIdentity.success || !shortIdentity.success) {
    throw new Error("Both legs must be valid OCC option symbols")
  }
  const longStrike = alpacaOptionStrikeCents(longIdentity.identity)
  const shortStrike = alpacaOptionStrikeCents(shortIdentity.identity)
  if (!longStrike.success || !shortStrike.success) {
    throw new Error("Both legs must have representable strikes")
  }

  // 2. Exact economics from those quotes; no model-authored numbers.
  const economics = calculateDebitSpreadEconomicsV1(
    longQuote,
    shortQuote,
    longStrike.strikeCentsPerShare,
    shortStrike.strikeCentsPerShare,
  )
  if (!economics.success) {
    console.error(`Spread economics rejected: ${economics.reason}`)
    process.exitCode = 1
    return
  }

  const structure =
    longIdentity.identity.optionType === "C"
      ? "BULL_CALL_SPREAD"
      : "BEAR_PUT_SPREAD"
  const intent = tradeIntentV2Schema.parse({
    contractVersion: "2.0.0",
    decisionContractVersion: "2.0.0",
    direction: structure === "BULL_CALL_SPREAD" ? "BULLISH" : "BEARISH",
    structure,
    expiration: longIdentity.identity.expiration,
    longContractSymbol: options.longContractSymbol,
    shortContractSymbol: options.shortContractSymbol,
    quoteSnapshotRef,
    evaluatedAt,
    longQuote,
    shortQuote,
    ...economics.economics,
  }) as TradeIntentV2

  // 3. The real pure risk gate over synthetic application state.
  const sessionDate = evaluatedAt.slice(0, 10)
  const context = buildMockRiskContext(intent, options, evaluatedAt, sessionDate)
  const evaluation = evaluateTradeIntentRiskV1({ intent, context })

  console.log(`Intent: ${intent.structure} ${intent.longContractSymbol} / ${intent.shortContractSymbol}`)
  console.log(
    `Entry limit: ${intent.entryLimitCentsPerShare}c per share, width ${intent.widthCentsPerShare}c, max loss ${intent.maxLossCentsPerContract}c`,
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
  const store = createSqliteLedgerStore({
    path: options.ledgerPath,
    knownCredentialValues: [apiKey, secretKey],
  })
  await store.migrate(signal)

  const cycleId = `mock-${randomUUID()}`
  const correlationId = cycleId
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
      {
        eventId: randomUUID(),
        eventVersion: "2.0.0",
        eventType: "RESEARCH_CYCLE_STARTED",
        occurredAt,
        correlationId,
        cycleId,
        payload: { cycleNumber: 1 },
      },
      {
        eventId: "intent",
        eventVersion: "2.0.0",
        eventType: "TRADE_INTENT_DERIVED",
        occurredAt,
        correlationId,
        cycleId,
        payload: { intent },
      },
      {
        eventId: "risk",
        eventVersion: "2.0.0",
        eventType: "RISK_SHADOW_DECISION_RECORDED",
        occurredAt,
        correlationId,
        cycleId,
        payload: { decision },
      },
    ].map((event, index, events) => ({
      ...event,
      eventId: `${cycleId}-${index}`,
      ...(index === 0
        ? {}
        : { causationEventId: `${cycleId}-${index - 1}` }),
    })) as LedgerEventV2[],
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
    `Ledger (${options.ledgerPath}): ${recorded.map(({ eventType }) => eventType).join(" -> ")}`,
  )
  await store.close()
}

await main()
