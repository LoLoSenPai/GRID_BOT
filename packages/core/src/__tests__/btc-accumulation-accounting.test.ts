import { describe, expect, it } from "vitest";
import { GridType, StrategyMode, TradeSide } from "../domain/enums";
import { applyLotExecution, calculateNetSellPnl, summarizeLots } from "../services/lot-accounting-service";
import { GridStrategyService } from "../services/grid-strategy-service";

const now = new Date("2026-09-16T20:00:00Z");
function buy(inputAmount = 40, outputAmount = 0.0005, feeAmount = 0.01) {
  return applyLotExecution({ lots: [], botId: "btc", strategyMode: StrategyMode.AccumulateBase,
    side: TradeSide.Buy, report: { executionId: "buy-btc", inputAmount, outputAmount, feeAmount },
    levelPrice: 80_000, now });
}

describe("BTC principal recovery and retained profit", () => {
  it("recovers a 40 USDC purchase plus both fees and keeps only the remaining BTC as profit", () => {
    const bought = buy();
    // The original BTC is now worth 42 USDC at 84,000. Round the sell up to
    // whole BTC atomic units (8 decimals), covering purchase cost + sale fee.
    const soldBase = 0.00047643;
    const saleOutput = soldBase * 84_000;
    const sold = applyLotExecution({ lots: bought.lots, botId: "btc", strategyMode: StrategyMode.AccumulateBase,
      side: TradeSide.Sell, matchedLotIds: [bought.openedLotId!], levelPrice: 84_000, now,
      report: { executionId: "sell-btc", inputAmount: soldBase, outputAmount: saleOutput, feeAmount: 0.01 } });

    expect(saleOutput - 0.01).toBeGreaterThanOrEqual(40.01);
    expect(sold.closedLotIds).toEqual([bought.openedLotId]);
    expect(sold.lots).toHaveLength(1);
    expect(sold.lots[0]).toMatchObject({ kind: "retained", costQuote: 0, remainingBaseAmount: 0.00002357 });
    const held = summarizeLots(sold.lots, 84_000);
    expect(held.tradingBaseAmount).toBe(0);
    expect(held.retainedBaseAmount).toBeCloseTo(0.00002357, 10);
    expect(held.unrealizedPnlUsd + sold.realizedPnlDelta).toBeCloseTo(2 - 0.01 - 0.01, 8);

    const strategy = new GridStrategyService();
    expect(strategy.remapOpenLotsToGridCycles(strategy.calculateLevels(80_000, 84_000, 2, GridType.Arithmetic), sold.lots)).toEqual({});
  });

  it("rejects screenshot-like proceeds below the whole purchase cost even if the sold fraction is profitable", () => {
    const bought = buy(40, 0.000532, 0.01);
    const matchedLotIds: string[] = [bought.openedLotId!];
    const args = [bought.lots, matchedLotIds, 0.000524, 39.83, 0.00128] as const;
    expect(calculateNetSellPnl(...args, StrategyMode.AccumulateUsdc)).toBeGreaterThan(0);
    expect(calculateNetSellPnl(...args, StrategyMode.AccumulateBase)).toBeCloseTo(-0.18128, 8);
  });

  it("does not label an under-recovered real fill as fully paid retained BTC", () => {
    const bought = buy(40, 0.000532, 0.01);
    const sold = applyLotExecution({ lots: bought.lots, botId: "btc", strategyMode: StrategyMode.AccumulateBase,
      side: TradeSide.Sell, matchedLotIds: [bought.openedLotId!], levelPrice: 76_266.67, now,
      report: { executionId: "short-recovery", inputAmount: 0.000524, outputAmount: 39.83, feeAmount: 0.00128 } });
    expect(sold.closedLotIds).toEqual([]);
    expect(sold.lots).toHaveLength(1);
    expect(sold.lots[0]).toMatchObject({ kind: "trading", remainingBaseAmount: 0.000008 });
    expect(sold.lots[0]!.costQuote).toBeGreaterThan(0);
    expect(summarizeLots(sold.lots, 75_944.49).retainedBaseAmount).toBe(0);
    const held = summarizeLots(sold.lots, 75_944.49);
    expect(sold.realizedPnlDelta + held.unrealizedPnlUsd).toBeCloseTo(39.83 - 0.00128 + 0.000008 * 75_944.49 - 40.01, 7);
  });
});
