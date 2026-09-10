import { StrategyMode, TradeSide } from "../domain/enums";
import type { PositionLot } from "../domain/types";
import { round } from "../utils/math";

export function applyLotExecution(input: {
  lots: PositionLot[]; botId: string; strategyMode: StrategyMode; side: TradeSide;
  report: { executionId: string; inputAmount: number; outputAmount: number; feeAmount: number };
  matchedLotIds?: string[]; levelPrice: number; now: Date;
}) {
  const { report, side, now } = input;
  if (![report.inputAmount, report.outputAmount].every((value) => Number.isFinite(value) && value > 0) ||
      !Number.isFinite(report.feeAmount) || report.feeAmount < 0) throw new Error("Invalid executed quantities");
  if (side === TradeSide.Buy) {
    const id = `lot-${report.executionId}`;
    if (input.lots.some((lot) => lot.id === id)) throw new Error("Execution already represented in inventory");
    const costQuote = round(report.inputAmount + report.feeAmount, 8);
    const lot: PositionLot = { id, kind: "trading", botId: input.botId,
      originalBaseAmount: report.outputAmount, remainingBaseAmount: report.outputAmount,
      entryPrice: round(costQuote / report.outputAmount, 8), costQuote,
      openedByExecutionId: report.executionId, closedByExecutionId: null, openedAt: now, closedAt: null };
    return { lots: [...input.lots, lot], realizedPnlDelta: 0, openedLotId: id, closedLotIds: [] as string[] };
  }
  const matched = new Set(input.matchedLotIds ?? input.lots.filter(isTradingLot).map((lot) => lot.id));
  const eligible = input.lots.filter((lot) => isTradingLot(lot) && matched.has(lot.id));
  const available = eligible.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0);
  if (report.inputAmount > available + 1e-8) throw new Error("Execution sold more than matched trading inventory");
  const mayRetain = input.strategyMode !== StrategyMode.AccumulateUsdc;
  let remaining = report.inputAmount;
  let realizedPnlDelta = 0;
  const closedLotIds: string[] = [];
  const retained: PositionLot[] = [];
  const lots = input.lots.map((lot) => {
    if (!isTradingLot(lot) || !matched.has(lot.id) || remaining <= 1e-10) return lot;
    const sold = Math.min(remaining, lot.remainingBaseAmount);
    remaining = round(remaining - sold, 10);
    const netProceeds = (report.outputAmount - report.feeAmount) * sold / report.inputAmount;
    // A partial fill that has not recovered principal must keep its remaining paired exit.
    const retain = mayRetain && netProceeds >= lot.costQuote - 1e-8;
    const cost = retain ? lot.costQuote : lot.costQuote * sold / lot.remainingBaseAmount;
    realizedPnlDelta += netProceeds - cost;
    const remainder = round(Math.max(0, lot.remainingBaseAmount - sold), 10);
    if (retain && remainder > 0) retained.push({ ...lot, id: `${lot.id}:retained:${report.executionId}`,
      kind: "retained", originalBaseAmount: remainder, remainingBaseAmount: remainder,
      costQuote: 0, entryPrice: 0, closedAt: null, closedByExecutionId: null });
    if (retain || remainder <= 1e-10) closedLotIds.push(lot.id);
    return { ...lot, remainingBaseAmount: retain ? 0 : remainder,
      costQuote: retain ? 0 : round(Math.max(0, lot.costQuote - cost), 8) };
  }).filter((lot) => lot.remainingBaseAmount > 1e-10);
  return { lots: [...lots, ...retained], realizedPnlDelta: round(realizedPnlDelta, 8), openedLotId: null, closedLotIds };
}

export function isTradingLot(lot: PositionLot) {
  return lot.kind !== "retained" && !lot.closedAt && lot.remainingBaseAmount > 0 && lot.costQuote > 0;
}

export function calculateNetSellPnl(lots: PositionLot[], matchedLotIds: string[] | undefined,
  requestedBaseAmount: number, expectedOutputAmount: number, feeQuote: number, strategyMode = StrategyMode.AccumulateUsdc): number | null {
  if (!(requestedBaseAmount > 0) || ![expectedOutputAmount, feeQuote].every(Number.isFinite)) return null;
  const matched = new Set(matchedLotIds ?? []);
  let remaining = requestedBaseAmount;
  let cost = 0;
  for (const lot of lots) {
    if (!isTradingLot(lot) || !matched.has(lot.id)) continue;
    const sold = Math.min(remaining, lot.remainingBaseAmount);
    cost += strategyMode === StrategyMode.AccumulateUsdc ? lot.costQuote * sold / lot.remainingBaseAmount : lot.costQuote;
    remaining -= sold;
    if (remaining <= 1e-10) break;
  }
  return remaining > 1e-8 ? null : round(expectedOutputAmount - feeQuote - cost, 8);
}

export function summarizeLots(lots: PositionLot[], price: number) {
  const active = lots.filter((lot) => !lot.closedAt && lot.remainingBaseAmount > 0);
  const trading = active.filter(isTradingLot);
  const totalBaseAmount = round(active.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0), 10);
  const tradingBaseAmount = round(trading.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0), 10);
  const totalCostQuote = round(active.reduce((sum, lot) => sum + lot.costQuote, 0), 8);
  const tradingCostQuote = round(trading.reduce((sum, lot) => sum + lot.costQuote, 0), 8);
  return { totalBaseAmount, tradingBaseAmount, retainedBaseAmount: round(totalBaseAmount - tradingBaseAmount, 10),
    tradingCostQuote, totalCostQuote, unrealizedPnlUsd: round(totalBaseAmount * price - totalCostQuote, 8),
    averageEntryPrice: tradingBaseAmount > 0 ? round(tradingCostQuote / tradingBaseAmount, 8) : null };
}
