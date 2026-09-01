import { join } from "node:path"

import { canonicalJsonSha256 } from "../shared/canonical-json.js"
import {
  quotesForSpreadAtV2,
  reconstructDebitSpreadV2,
  type HistoricalOptionQuoteV2,
} from "./chain-reconstruction-v2.js"
import type { HistoricalReplayExperimentV2 } from "./historical-contracts-v2.js"
import {
  openHistoricalDatabaseReadonly,
  readHistoricalDatasetManifest,
} from "./historical-store-v2.js"
import { createBacktestRunLedgerV2 } from "./run-ledger-v2.js"

const halfCentsToContractCents = (priceHalfCents: number) => {
  const result = BigInt(priceHalfCents) * 100n
  if (result % 2n !== 0n) throw new Error("Contract cash flow is not representable in cents")
  const cents = result / 2n
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Contract cash flow exceeds safe range")
  return Number(cents)
}

const openFill = (
  longLeg: HistoricalOptionQuoteV2,
  shortLeg: HistoricalOptionQuoteV2,
  slippage: number,
) => {
  const longPrice = longLeg.askHalfCents + slippage
  const shortPrice = Math.max(0, shortLeg.bidHalfCents - slippage)
  return { longPrice, shortPrice, netPrice: longPrice - shortPrice }
}

const closeFill = (
  longLeg: HistoricalOptionQuoteV2,
  shortLeg: HistoricalOptionQuoteV2,
  slippage: number,
) => {
  const longPrice = Math.max(0, longLeg.bidHalfCents - slippage)
  const shortPrice = shortLeg.askHalfCents + slippage
  return { longPrice, shortPrice, netPrice: longPrice - shortPrice }
}

export type HistoricalReplayReportV2 = Readonly<{
  reportVersion: "2.0.0"
  capability: "HISTORICAL_CHAIN_REPLAY"
  runId: string
  status: "COMPLETE" | "INCOMPLETE"
  datasetId: string
  experimentId: string
  runLedgerPath: string
  initialEquityCents: number
  endingEquityCents: number
  netPnlCents: number
  decisions: number
  selectedSpreads: number
  openedPositions: number
  closedPositions: number
  noActions: number
  rejectedForConcurrency: number
  totalFeesCents: number
  warnings: readonly string[]
}>

export const runHistoricalReplayV2 = (
  experiment: HistoricalReplayExperimentV2,
  outputDirectory: string,
): HistoricalReplayReportV2 => {
  const historical = openHistoricalDatabaseReadonly(experiment.databasePath)
  const manifest = readHistoricalDatasetManifest(historical, experiment.databasePath, experiment.datasetId)
  if (
    manifest.evidenceTier !== "TEST_FIXTURE_REPLAY" &&
    manifest.evidenceTier !== "ONE_MINUTE_QUOTE_SNAPSHOT_REPLAY" &&
    manifest.evidenceTier !== "EXACT_CHAIN_REPLAY"
  ) {
    historical.close()
    throw new Error(`Dataset evidence tier cannot support historical replay: ${manifest.evidenceTier}`)
  }
  const covered = new Set(manifest.coveredSymbols)
  const missing = experiment.replaySelection.symbols.filter(
    (symbol: string) => !covered.has(symbol),
  )
  if (missing.length > 0) {
    historical.close()
    throw new Error(`Historical dataset does not cover: ${missing.join(", ")}`)
  }

  const experimentHash = canonicalJsonSha256(experiment)
  const runId = canonicalJsonSha256({ experimentHash, datasetHash: manifest.sourceHash })
  const runLedgerPath = join(outputDirectory, "run.sqlite")
  const ledger = createBacktestRunLedgerV2({
    path: runLedgerPath,
    runId,
    experimentId: experiment.experimentId,
    experimentHash,
    datasetId: experiment.datasetId,
    datasetHash: manifest.sourceHash,
    initialEquityCents: experiment.portfolio.initialCapitalCents,
  })

  let cashCents = experiment.portfolio.initialCapitalCents
  let realizedPnlCents = 0
  let selectedSpreads = 0
  let openedPositions = 0
  let closedPositions = 0
  let noActions = 0
  let rejectedForConcurrency = 0
  let totalFeesCents = 0
  let status: "COMPLETE" | "INCOMPLETE" = "COMPLETE"
  let occupiedUntil: string | undefined
  let terminalAt = `${experiment.replaySelection.endDate}T21:00:00.000Z`

  try {
    ledger.appendEvent("RUN_STARTED", `${experiment.replaySelection.startDate}T14:30:00.000Z`, {
      experimentHash,
      datasetHash: manifest.sourceHash,
      evidenceTier: manifest.evidenceTier,
    })
    type ReplaySignal = HistoricalReplayExperimentV2["signals"][number]
    const orderedSignals = experiment.signals.toSorted(
      (left: ReplaySignal, right: ReplaySignal) =>
        left.decisionAt.localeCompare(right.decisionAt) ||
        left.decisionId.localeCompare(right.decisionId),
    )
    for (const signal of orderedSignals) {
      terminalAt = signal.exitAt > terminalAt ? signal.exitAt : terminalAt
      const decisionEvent = ledger.appendEvent("DECISION_RECORDED", signal.decisionAt, signal)
      if (occupiedUntil !== undefined && signal.decisionAt < occupiedUntil) {
        rejectedForConcurrency += 1
        ledger.appendEvent("DECISION_REJECTED", signal.decisionAt, { decisionId: signal.decisionId, reason: "MAX_CONCURRENT_POSITIONS" }, decisionEvent)
        continue
      }
      const spread = reconstructDebitSpreadV2(historical, {
        datasetId: experiment.datasetId,
        symbol: signal.symbol,
        direction: signal.direction,
        cutoff: signal.decisionAt,
        ...experiment.selector,
      })
      if (spread === undefined) {
        noActions += 1
        ledger.appendEvent("NO_ACTION", signal.decisionAt, { decisionId: signal.decisionId, reason: "NO_ELIGIBLE_SPREAD" }, decisionEvent)
        continue
      }
      selectedSpreads += 1
      const selectionEvent = ledger.appendEvent("CHAIN_RECONSTRUCTED", signal.decisionAt, {
        decisionId: signal.decisionId,
        structure: spread.structure,
        longContractId: spread.longLeg.contractId,
        shortContractId: spread.shortLeg.contractId,
        decisionLongQuoteId: spread.longLeg.quoteId,
        decisionShortQuoteId: spread.shortLeg.quoteId,
        dte: spread.dte,
        widthHalfCents: spread.widthHalfCents,
        chainContractCount: spread.chainContractCount,
      }, decisionEvent)

      const fillAt = new Date(Date.parse(signal.decisionAt) + experiment.execution.latencyMilliseconds).toISOString()
      const entryQuotes = quotesForSpreadAtV2(historical, experiment.datasetId, spread, fillAt, experiment.selector.maxQuoteAgeMilliseconds)
      if (entryQuotes === undefined) {
        noActions += 1
        ledger.appendEvent("ORDER_NO_FILL", fillAt, { decisionId: signal.decisionId, reason: "ENTRY_QUOTES_UNAVAILABLE" }, selectionEvent)
        continue
      }
      const entry = openFill(entryQuotes.longLeg, entryQuotes.shortLeg, experiment.execution.slippageHalfCentsPerLeg)
      const openLimit = spread.naturalDebitHalfCents + 2 * experiment.execution.slippageHalfCentsPerLeg
      if (entry.netPrice <= 0 || entry.netPrice > openLimit) {
        noActions += 1
        ledger.appendEvent("ORDER_NO_FILL", fillAt, { decisionId: signal.decisionId, reason: "OPEN_LIMIT_NOT_MARKETABLE", openLimit, executableDebit: entry.netPrice }, selectionEvent)
        continue
      }
      const entryDebitCents = halfCentsToContractCents(entry.netPrice)
      const entryFeesCents = 2 * experiment.execution.commissionCentsPerContract
      if (entryDebitCents + entryFeesCents > cashCents) {
        noActions += 1
        ledger.appendEvent("RISK_REJECTED", fillAt, { decisionId: signal.decisionId, reason: "INSUFFICIENT_CASH" }, selectionEvent)
        continue
      }
      const openFillId = canonicalJsonSha256({ runId, decisionId: signal.decisionId, purpose: "OPEN" })
      const openNetCashFlow = -(entryDebitCents + entryFeesCents)
      cashCents += openNetCashFlow
      totalFeesCents += entryFeesCents
      openedPositions += 1
      occupiedUntil = signal.exitAt
      ledger.insertFill({
        fillId: openFillId, decisionId: signal.decisionId, purpose: "OPEN", occurredAt: fillAt,
        longContractId: spread.longLeg.contractId, shortContractId: spread.shortLeg.contractId,
        longPriceHalfCents: entry.longPrice, shortPriceHalfCents: entry.shortPrice,
        netPriceHalfCents: entry.netPrice, grossCashFlowCents: -entryDebitCents,
        feesCents: entryFeesCents, netCashFlowCents: openNetCashFlow,
        longQuoteId: entryQuotes.longLeg.quoteId, shortQuoteId: entryQuotes.shortLeg.quoteId,
      })
      const openEvent = ledger.appendEvent("POSITION_OPENED", fillAt, { decisionId: signal.decisionId, fillId: openFillId, cashCents }, selectionEvent)
      ledger.insertSnapshot({ occurredAt: fillAt, cashCents, realizedPnlCents, unrealizedPnlCents: -entryFeesCents, liquidationValueCents: entryDebitCents, equityCents: cashCents + entryDebitCents })

      const exitQuotes = quotesForSpreadAtV2(historical, experiment.datasetId, spread, signal.exitAt, experiment.selector.maxQuoteAgeMilliseconds)
      if (exitQuotes === undefined) {
        status = "INCOMPLETE"
        ledger.appendEvent("EXIT_UNPRICED", signal.exitAt, { decisionId: signal.decisionId }, openEvent)
        break
      }
      const exit = closeFill(exitQuotes.longLeg, exitQuotes.shortLeg, experiment.execution.slippageHalfCentsPerLeg)
      if (exit.netPrice < 0) {
        status = "INCOMPLETE"
        ledger.appendEvent("EXIT_UNPRICED", signal.exitAt, { decisionId: signal.decisionId, reason: "NEGATIVE_EXECUTABLE_CREDIT" }, openEvent)
        break
      }
      const exitCreditCents = halfCentsToContractCents(exit.netPrice)
      const exitDte = Math.round(
        (Date.parse(`${spread.expirationDate}T00:00:00.000Z`) -
          Date.parse(`${signal.exitAt.slice(0, 10)}T00:00:00.000Z`)) /
          86_400_000,
      )
      const exitReason = exitDte <= experiment.exitPolicy.expirationGuardDte
        ? "EXPIRATION_GUARD"
        : exitCreditCents * 10_000 <= entryDebitCents * (10_000 - experiment.exitPolicy.stopLossBps)
          ? "STOP_LOSS"
          : exitCreditCents * 10_000 >= entryDebitCents * (10_000 + experiment.exitPolicy.profitTargetBps)
            ? "PROFIT_TARGET"
            : "MAX_HOLD"
      const exitEvent = ledger.appendEvent("EXIT_TRIGGERED", signal.exitAt, {
        decisionId: signal.decisionId,
        exitReason,
        exitCreditCents,
        entryDebitCents,
        exitDte,
      }, openEvent)
      const exitFeesCents = 2 * experiment.execution.commissionCentsPerContract
      const closeNetCashFlow = exitCreditCents - exitFeesCents
      cashCents += closeNetCashFlow
      totalFeesCents += exitFeesCents
      const tradePnlCents = exitCreditCents - entryDebitCents - entryFeesCents - exitFeesCents
      realizedPnlCents += tradePnlCents
      closedPositions += 1
      occupiedUntil = undefined
      const closeFillId = canonicalJsonSha256({ runId, decisionId: signal.decisionId, purpose: "CLOSE" })
      ledger.insertFill({
        fillId: closeFillId, decisionId: signal.decisionId, purpose: "CLOSE", occurredAt: signal.exitAt,
        longContractId: spread.longLeg.contractId, shortContractId: spread.shortLeg.contractId,
        longPriceHalfCents: exit.longPrice, shortPriceHalfCents: exit.shortPrice,
        netPriceHalfCents: exit.netPrice, grossCashFlowCents: exitCreditCents,
        feesCents: exitFeesCents, netCashFlowCents: closeNetCashFlow,
        longQuoteId: exitQuotes.longLeg.quoteId, shortQuoteId: exitQuotes.shortLeg.quoteId,
      })
      const positionId = canonicalJsonSha256({ runId, decisionId: signal.decisionId, kind: "POSITION" })
      ledger.insertPosition({
        positionId, decisionId: signal.decisionId, underlying: signal.symbol,
        structure: spread.structure, openedAt: fillAt, closedAt: signal.exitAt,
        entryDebitCents, entryFeesCents, exitCreditCents, exitFeesCents,
        realizedPnlCents: tradePnlCents, exitReason,
      })
      ledger.appendEvent("POSITION_CLOSED", signal.exitAt, { decisionId: signal.decisionId, fillId: closeFillId, positionId, exitReason, realizedPnlCents: tradePnlCents, cashCents }, exitEvent)
      ledger.insertSnapshot({ occurredAt: signal.exitAt, cashCents, realizedPnlCents, unrealizedPnlCents: 0, liquidationValueCents: 0, equityCents: cashCents })
    }

    const endingEquityCents = cashCents
    const netPnlCents = endingEquityCents - experiment.portfolio.initialCapitalCents
    ledger.insertMetric("NET_PNL_CENTS", netPnlCents)
    ledger.insertMetric("ENDING_EQUITY_CENTS", endingEquityCents)
    ledger.insertMetric("TOTAL_FEES_CENTS", totalFeesCents)
    ledger.insertMetric("CLOSED_POSITIONS", closedPositions)
    ledger.complete(status, endingEquityCents, netPnlCents, terminalAt)
    return {
      reportVersion: "2.0.0",
      capability: "HISTORICAL_CHAIN_REPLAY",
      runId,
      status,
      datasetId: experiment.datasetId,
      experimentId: experiment.experimentId,
      runLedgerPath,
      initialEquityCents: experiment.portfolio.initialCapitalCents,
      endingEquityCents,
      netPnlCents,
      decisions: experiment.signals.length,
      selectedSpreads,
      openedPositions,
      closedPositions,
      noActions,
      rejectedForConcurrency,
      totalFeesCents,
      warnings: manifest.evidenceTier === "TEST_FIXTURE_REPLAY" ? ["TEST_FIXTURE_NOT_MARKET_EVIDENCE"] : [],
    }
  } finally {
    ledger.close()
    historical.close()
  }
}
