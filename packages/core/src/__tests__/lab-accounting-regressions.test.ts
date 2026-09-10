import { describe, it, expect } from "vitest";
import { applyLotExecution, summarizeLots } from "../services/lot-accounting-service";
import { StrategyMode, TradeSide } from "../domain/enums";
import type { PositionLot } from "../domain/types";
const lot: PositionLot = { id: "lot", botId: "bot", kind: "trading", remainingBaseAmount: 1, originalBaseAmount: 1,
  costQuote: 100, entryPrice: 100, openedByExecutionId: "buy", closedByExecutionId: null,
  openedAt: new Date("2026-01-01"), closedAt: null };
describe("actual partial execution accounting", () => {
  it.each(Object.values(StrategyMode))("keeps the unrecovered partial lot and PnL identity for %s", (strategyMode) => {
    const result = applyLotExecution({ lots: [lot], botId: "bot", strategyMode, side: TradeSide.Sell,
      report: { executionId: "sell", inputAmount: 0.5, outputAmount: 55, feeAmount: 1 },
      matchedLotIds: [lot.id], levelPrice: 110, now: new Date("2026-01-02") });
    expect(result.closedLotIds).toEqual([]);
    expect(result.lots[0]).toMatchObject({ kind: "trading", remainingBaseAmount: 0.5, costQuote: 50 });
    expect(result.realizedPnlDelta).toBe(4);
    const marked = summarizeLots(result.lots, 110);
    expect(marked.unrealizedPnlUsd + result.realizedPnlDelta).toBe(54 + 0.5 * 110 - 100);
  });
  it("closes a fully sold losing lot without inventing retained inventory", () => {
    const result = applyLotExecution({ lots: [lot], botId: "bot", strategyMode: StrategyMode.AccumulateBase, side: TradeSide.Sell,
      report: { executionId: "sell", inputAmount: 1, outputAmount: 90, feeAmount: 1 }, matchedLotIds: [lot.id], levelPrice: 90, now: new Date() });
    expect(result.lots).toEqual([]);
    expect(result.closedLotIds).toEqual([lot.id]);
    expect(result.realizedPnlDelta).toBe(-11);
  });
});
