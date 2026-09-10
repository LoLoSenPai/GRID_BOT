import { describe, expect, it } from "vitest";
import { BacktestLabService, hasViableStep } from "../services/backtest-lab-service";
import { GridType, StrategyMode } from "../domain/enums";
import type { BacktestMarketSeries } from "../domain/types";

function oscillating(symbol = "SOL"): BacktestMarketSeries {
  return { symbol, pair: `${symbol}/USDC`, resolution: "1h", candles: Array.from({ length: 240 }, (_, i) => {
    const close = 100 + 8 * Math.sin(i * Math.PI / 8);
    const open = 100 + 8 * Math.sin((i - 1) * Math.PI / 8);
    return { timestamp: new Date(Date.UTC(2026, 0, 1, i)), open, close,
      high: Math.max(open, close) + 0.3, low: Math.min(open, close) - 0.3 };
  }) };
}

describe("explainable grid recommendations", () => {
  const service = new BacktestLabService();

  it("locks the token objective and refuses to learn rebound zones from holdout", () => {
    const series = oscillating();
    const first = service.recommend({ series, budgetUsd: 600, rangeMethod: "rebounds" });
    const changed = { ...series, candles: series.candles.map((c, i) => i < 168 ? c : {
      ...c, open: c.open / 3, high: c.high / 3, low: c.low / 3, close: c.close / 3
    }) };
    const futureCrash = service.recommend({ series: changed, budgetUsd: 600, rangeMethod: "rebounds" });
    expect(first.bestConfig).toEqual(futureCrash.bestConfig);
    expect(first.rangeEvidence).toEqual(futureCrash.rangeEvidence);
    expect(first.rangeEvidence?.selected?.supportTouches).toBeGreaterThanOrEqual(3);
    expect(first.rangeEvidence?.selected?.resistanceTouches).toBeGreaterThanOrEqual(3);
    expect(first.leaderboard.every((row) => row.config.strategyMode === StrategyMode.AccumulateUsdc)).toBe(true);
    expect(futureCrash.eligibility?.status).toBe("no_launch");
  });

  it("keeps BTC accumulation explicit and separates owned tokens from cash-equivalent wealth", () => {
    const result = service.recommend({ series: oscillating("BTC"), budgetUsd: 600,
      maxDeployableUsd: 480, reserveQuoteAmount: 120, rangeMethod: "rebounds" });
    expect(result.leaderboard.every((row) => row.config.strategyMode === StrategyMode.AccumulateBase)).toBe(true);
    const accumulation = result.bestReplay.accumulation!;
    expect(accumulation.baseSymbol).toBe("BTC");
    expect(accumulation.retainedBaseAmount).toBeGreaterThanOrEqual(0);
    expect(accumulation.heldBaseAmount).toBeGreaterThanOrEqual(accumulation.retainedBaseAmount);
    expect(accumulation.baseEquivalent).toBeGreaterThan(accumulation.heldBaseAmount);
    expect(accumulation.excessBaseEquivalent).toBeCloseTo(accumulation.baseEquivalent - accumulation.buyAndHoldBaseEquivalent, 7);
    expect(result.bestReplay.replayPoints.every((point) => point.availableQuoteAmount >= 120 - 1e-6)).toBe(true);
    if (result.bestReplay.validationMetrics.endingEquityUsd <= result.bestReplay.validationBenchmarks!.buyAndHold.endingEquityUsd) {
      expect(result.eligibility?.status).toBe("no_launch");
    }
  });

  it("stresses the frozen winner rather than optimizing another configuration", () => {
    const series = oscillating();
    const result = service.recommend({ series, budgetUsd: 600, rangeMethod: "rebounds",
      executionCost: { maxSlippageBps: 60, executionFeeBps: 20 } });
    const expected = service.replay({ series, config: { ...result.bestConfig, maxSlippageBps: 120, executionFeeBps: 40 } });
    expect(result.costStress?.validationMetrics).toEqual(expected.validationMetrics);
    expect(result.costStress?.overallMetrics).toEqual(expected.overallMetrics);
    if (!result.costStress?.passed) expect(result.eligibility?.status).not.toBe("paper_candidate");
  });

  it("refuses a trend without repeated zones and refuses unaffordable grid spacing", () => {
    const trend = oscillating();
    trend.candles = trend.candles.map((c, i) => ({ ...c, open: 100 + i, close: 100.5 + i, low: 99.5 + i, high: 101 + i }));
    expect(() => service.recommend({ series: trend, budgetUsd: 600, rangeMethod: "rebounds" })).toThrow(/No launch/);
    expect(() => service.recommend({ series: oscillating(), budgetUsd: 600, rangeMethod: "rebounds",
      executionCost: { maxSlippageBps: 1000, executionFeeBps: 100 } })).toThrow(/No launch/);
  });

  it("uses the smallest arithmetic step and the true round-trip fee floor", () => {
    const config = service.recommend({ series: oscillating(), budgetUsd: 600, rangeMethod: "rebounds" }).bestConfig;
    expect(hasViableStep({ ...config, lowPrice: 100, highPrice: 104, levelCount: 14,
      gridType: GridType.Arithmetic, maxSlippageBps: 50, executionFeeBps: 10 }, 0)).toBe(false);
    expect(hasViableStep({ ...config, lowPrice: 100, highPrice: 130, levelCount: 6,
      gridType: GridType.Geometric, maxSlippageBps: 50, executionFeeBps: 10 }, 0)).toBe(true);
  });
});
