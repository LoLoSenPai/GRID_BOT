import { describe, expect, it } from "vitest";

import { BotStatus, EntryMode, GridType, MinOrderMode, OrderStatus, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
import { BacktestLabService, compareBacktestLeaderboardEntries, generateBacktestCandidates } from "../services/backtest-lab-service";
import type { BacktestConfig, BacktestLeaderboardEntry, BacktestMarketSeries } from "../domain/types";
import { MarketRegimeService } from "../services/market-regime-service";

const service = new BacktestLabService();

function candle(timestamp: string, open: number, high: number, low: number, close: number) {
  return {
    timestamp: new Date(timestamp),
    open,
    high,
    low,
    close
  };
}

function baseConfig(overrides: Partial<BacktestMarketSeries> = {}) {
  return {
    symbol: "SOL",
    pair: "SOL/USDC",
    resolution: "1h",
    candles: [
      candle("2026-04-01T00:00:00Z", 115, 116, 104, 105),
      candle("2026-04-01T01:00:00Z", 105, 126, 104, 125),
      candle("2026-04-01T02:00:00Z", 125, 127, 123, 124),
      candle("2026-04-01T03:00:00Z", 124, 128, 122, 127)
    ],
    ...overrides
  } satisfies BacktestMarketSeries;
}

function runConfig(strategyMode: StrategyMode, extra?: Partial<BacktestConfig>) {
  return service.replay({
    series: baseConfig(),
    config: {
      ...buildBacktestConfig(strategyMode),
      ...extra
    }
  });
}

function buildBacktestConfig(strategyMode: StrategyMode): BacktestConfig {
  return {
    budgetUsd: 30,
    lowPrice: 100,
    highPrice: 130,
    levelCount: 4,
    gridType: GridType.Arithmetic,
    strategyMode,
    minOrderMode: MinOrderMode.Auto,
    minOrderQuoteAmount: 10,
    maxSlippageBps: 0,
    executionFeeBps: 0,
    cooldownMs: 0,
    maxOrdersPerHour: 100,
    maxDrawdownPct: 100,
    maxConsecutiveFailures: 3,
    levelLockMs: 0,
    priceConfirmationWindowMs: 0,
    recenterMode: RecenterMode.Manual,
    outOfRangePause: true
  };
}

describe("BacktestLabService", () => {
  it("keeps the replay continuous while scoring train and validation separately", () => {
    const result = service.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles: [
          candle("2026-04-01T00:00:00Z", 115, 116, 104, 105),
          candle("2026-04-01T01:00:00Z", 105, 126, 104, 125)
        ]
      },
      config: buildBacktestConfig(StrategyMode.AccumulateUsdc)
    });

    expect(result.meta.trainCandleCount).toBe(1);
    expect(result.meta.validationCandleCount).toBe(1);
    expect(result.assumptions.candleTraversal).toBe("bullish_open_low_high_close_bearish_open_high_low_close");
    expect(result.assumptions.trainValidationSplit).toBe(0.7);
    expect(result.assumptions.recenterScope).toBe("advisory_only");
    expect(result.trainMetrics.executedBuyCount).toBe(1);
    expect(result.trainMetrics.closedCycleCount).toBe(0);
    expect(result.validationMetrics.executedSellCount).toBe(1);
    expect(result.validationMetrics.closedCycleCount).toBe(1);
    expect(result.validationMetrics.startingBudgetUsd).toBe(result.trainMetrics.endingEquityUsd);
    expect(result.validationMetrics.totalPnlUsd).toBeCloseTo(result.overallMetrics.endingEquityUsd - result.trainMetrics.endingEquityUsd, 7);
    expect(result.overallMetrics.endingEquityUsd).toBeGreaterThan(result.overallMetrics.startingBudgetUsd);
    expect(result.recenterAdvice.mode).toBe("none");
    expect(result.executions.map((execution) => execution.status)).toEqual([OrderStatus.Simulated, OrderStatus.Simulated]);
    expect(result.executions.map((execution) => execution.side)).toEqual([TradeSide.Buy, TradeSide.Sell]);
  });

  it("preserves distinct sell outcomes across the current strategy modes", () => {
    const accumulateUsdc = runConfig(StrategyMode.AccumulateUsdc);
    const balanced = runConfig(StrategyMode.Balanced);
    const accumulateBase = runConfig(StrategyMode.AccumulateBase);

    expect(accumulateUsdc.overallMetrics.realizedPnlUsd).toBeGreaterThan(balanced.overallMetrics.realizedPnlUsd);
    expect(balanced.overallMetrics.realizedPnlUsd).not.toBe(accumulateBase.overallMetrics.realizedPnlUsd);

    expect(accumulateUsdc.overallMetrics.openCycleCount).toBe(0);
    expect(balanced.overallMetrics.openCycleCount).toBe(0);
    expect(accumulateBase.overallMetrics.openCycleCount).toBe(0);

    expect(accumulateUsdc.replayPoints.at(-1)?.availableBaseAmount ?? 0).toBe(0);
    expect(balanced.replayPoints.at(-1)?.availableBaseAmount ?? 0).toBeGreaterThan(0);
    expect(accumulateBase.replayPoints.at(-1)?.availableBaseAmount ?? 0).toBeGreaterThan(0);
    expect(accumulateBase.replayPoints.at(-1)?.availableBaseAmount ?? 0).not.toBe(balanced.replayPoints.at(-1)?.availableBaseAmount ?? 0);
  });

  it("applies execution fees to simulated equity and realized PnL", () => {
    const noFee = runConfig(StrategyMode.AccumulateUsdc, { executionFeeBps: 0 });
    const withFee = runConfig(StrategyMode.AccumulateUsdc, { executionFeeBps: 100 });

    expect(withFee.overallMetrics.endingEquityUsd).toBeLessThan(noFee.overallMetrics.endingEquityUsd);
    expect(withFee.overallMetrics.realizedPnlUsd).toBeLessThan(noFee.overallMetrics.realizedPnlUsd);
    expect(withFee.overallMetrics.endingEquityUsd - withFee.overallMetrics.startingBudgetUsd).toBeCloseTo(withFee.overallMetrics.totalPnlUsd, 6);
    expect(withFee.executions.reduce((sum, execution) => sum + execution.feeAmount, 0)).toBeGreaterThan(0);
    expect(withFee.overallMetrics.totalFeesUsd).toBeGreaterThan(0);
  });

  it("reports average simulated slippage in basis points", () => {
    const result = runConfig(StrategyMode.AccumulateUsdc, { maxSlippageBps: 50 });

    expect(result.overallMetrics.simulatedOrderCount).toBeGreaterThan(0);
    expect(result.overallMetrics.averageSlippageBps).toBe(50);
    expect(result.assumptions.maxSlippageBps).toBe(50);
  });

  it("buys the lower boundary rail when a candle wick drops below the configured range", () => {
    const result = service.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles: [
          candle("2026-04-01T00:00:00Z", 96, 97, 94, 94),
          candle("2026-04-01T01:00:00Z", 94, 95, 93, 94)
        ]
      },
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        budgetUsd: 60,
        lowPrice: 95,
        highPrice: 100,
        levelCount: 6,
        minOrderMode: MinOrderMode.Manual,
        minOrderQuoteAmount: 10
      }
    });

    expect(result.executions).toContainEqual(
      expect.objectContaining({
        side: TradeSide.Buy,
        levelIndex: 0,
        targetPrice: 95,
        status: OrderStatus.Simulated
      })
    );
  });

  it("adds recenter advice when validation ends outside the range", () => {
    const result = service.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles: [
          candle("2026-04-01T00:00:00Z", 105, 106, 104, 105),
          candle("2026-04-01T01:00:00Z", 106, 112, 105, 112),
          candle("2026-04-01T02:00:00Z", 112, 114, 111, 113),
          candle("2026-04-01T03:00:00Z", 113, 116, 112, 115)
        ]
      },
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        highPrice: 110
      },
      marketRegime: {
        regime: "TREND_UP",
        confidence: 0.8,
        scores: { range: 0, trendUp: 4, trendDown: 0, chaoticHighVol: 0 },
        reasons: ["test"],
        evaluatedAt: new Date("2026-04-01T03:00:00Z")
      }
    });

    expect(result.recenterAdvice.side).toBe("above");
    expect(["soft", "hybrid", "hard"]).toContain(result.recenterAdvice.mode);
    expect(result.recenterAdvice.allowNewBuys).toBe(false);
  });

  it("simulates hybrid recenter in Lab auto mode without forcing a live bot change", () => {
    const result = service.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles: [
          candle("2026-04-01T00:00:00Z", 105, 106, 99, 100),
          candle("2026-04-01T01:00:00Z", 100, 101, 94, 95),
          candle("2026-04-01T02:00:00Z", 95, 96, 90, 92),
          candle("2026-04-01T03:00:00Z", 92, 98, 91, 97)
        ]
      },
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        highPrice: 120,
        levelCount: 3,
        recenterMode: RecenterMode.Auto,
        recenterModel: "candle_defense"
      },
      marketRegime: {
        regime: "TREND_DOWN",
        confidence: 0.8,
        scores: { range: 0, trendUp: 0, trendDown: 4, chaoticHighVol: 0 },
        reasons: ["test"],
        evaluatedAt: new Date("2026-04-01T03:00:00Z")
      }
    });

    expect(result.recenterEvents.length).toBeGreaterThan(0);
    expect(result.recenterEvents[0]?.mode).toBe("hybrid");
    expect(result.recenterEvents[0]?.side).toBe("below");
    expect(result.recenterEvents[0]?.applied).toBe(false);
    expect(result.overallMetrics.recenterCount).toBe(result.recenterEvents.length);
    expect(result.replayPoints.at(-1)?.activeLowPrice).toBe(100);
    expect(result.assumptions.recenterScope).toBe("simulated_when_auto_recenter");
  });

  it("applies simulated recenter when no open cycle needs protection", () => {
    const result = service.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles: [
          candle("2026-04-01T00:00:00Z", 112, 113, 111, 112),
          candle("2026-04-01T01:00:00Z", 112, 115, 112, 114),
          candle("2026-04-01T02:00:00Z", 114, 116, 113, 115),
          candle("2026-04-01T03:00:00Z", 115, 117, 114, 116)
        ]
      },
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        highPrice: 110,
        levelCount: 3,
        recenterMode: RecenterMode.Auto,
        recenterModel: "candle_defense"
      },
      marketRegime: {
        regime: "RANGE",
        confidence: 0.8,
        scores: { range: 4, trendUp: 0, trendDown: 0, chaoticHighVol: 0 },
        reasons: ["test"],
        evaluatedAt: new Date("2026-04-01T03:00:00Z")
      }
    });

    expect(result.recenterEvents.length).toBeGreaterThan(0);
    expect(result.recenterEvents[0]?.mode).toBe("hybrid");
    expect(result.recenterEvents[0]?.applied).toBe(true);
    expect(result.replayPoints.at(-1)?.activeLowPrice).toBeGreaterThan(100);
  });

  it("uses the worker-flat model for static auto replay with synthetic OHLC timing", () => {
    const result = service.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles: [
          candle("2026-04-01T00:00:00Z", 105, 106, 104, 105),
          candle("2026-04-01T01:00:00Z", 105, 120, 104, 118),
          candle("2026-04-01T02:00:00Z", 118, 119, 115, 117)
        ]
      },
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        highPrice: 110,
        recenterMode: RecenterMode.Auto
      }
    });

    expect(result.config.recenterModel).toBe("worker_flat");
    expect(result.assumptions.recenterModel).toBe("worker_flat");
    expect(result.assumptions.outOfRangeModel).toBe("pause_new_entries_allow_recovery_sells");
    expect(result.recenterEvents.some((event) => event.applied && event.side === "above")).toBe(true);
    expect(result.recenterEvents.every((event) => event.mode === "hybrid")).toBe(true);
    expect(result.replayPoints.some((point) => point.activeLowPrice > 100)).toBe(true);
  });

  it("does not buy below the range in worker-flat auto mode", () => {
    const result = service.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles: [
          candle("2026-04-01T00:00:00Z", 105, 106, 90, 95),
          candle("2026-04-01T01:00:00Z", 95, 96, 89, 94),
          candle("2026-04-01T02:00:00Z", 94, 96, 90, 95)
        ]
      },
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        lowPrice: 100,
        highPrice: 110,
        recenterMode: RecenterMode.Auto
      }
    });

    expect(result.config.recenterModel).toBe("worker_flat");
    expect(result.executions.some((execution) => execution.side === TradeSide.Buy)).toBe(false);
  });

  it("keeps adaptive replay on candle-defense semantics even if worker-flat is requested", () => {
    const result = service.replay({
      series: baseConfig({
        candles: [
          candle("2026-04-01T00:00:00Z", 105, 106, 104, 105),
          candle("2026-04-01T01:00:00Z", 105, 112, 104, 112),
          candle("2026-04-01T02:00:00Z", 112, 114, 111, 113)
        ]
      }),
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        highPrice: 110,
        rangeControlMode: "adaptive",
        recenterMode: RecenterMode.Auto,
        recenterModel: "worker_flat"
      }
    });

    expect(result.config.recenterModel).toBe("candle_defense");
    expect(result.assumptions.recenterModel).toBe("candle_defense");
  });

  it("simulates adaptive range shifts in Lab while the replay is flat", () => {
    const candles = Array.from({ length: 48 }, (_, index) => {
      const price = 120 + Math.sin(index / 3) * 0.35;
      return candle(
        new Date(Date.UTC(2026, 3, 1, index)).toISOString(),
        price,
        price + 0.12,
        price - 0.12,
        price + 0.02
      );
    });

    const result = service.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles
      },
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        budgetUsd: 100,
        rangeControlMode: "adaptive",
        minOrderMode: MinOrderMode.Manual,
        minOrderQuoteAmount: 10,
        lowPrice: 100,
        highPrice: 110
      }
    });

    expect(result.rangeAdjustmentEvents.length).toBeGreaterThan(0);
    expect(result.overallMetrics.rangeAdjustmentCount).toBe(result.rangeAdjustmentEvents.length);
    expect(result.assumptions.rangeControlMode).toBe("adaptive_lab_only");
    expect(result.rangeAdjustmentEvents[0]?.previousLowPrice).toBe(100);
    expect(result.rangeAdjustmentEvents[0]?.nextLowPrice).toBeGreaterThan(100);
  });

  it("does not chase a trend with adaptive range shifts", () => {
    class TrendRegimeService extends MarketRegimeService {
      override assess() {
        return {
          regime: "TREND_UP" as const,
          confidence: 0.8,
          scores: { range: 0, trendUp: 4, trendDown: 0, chaoticHighVol: 0 },
          reasons: ["test trend"],
          evaluatedAt: new Date("2026-04-02T23:00:00Z")
        };
      }
    }

    const trendService = new BacktestLabService(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new TrendRegimeService()
    );
    const candles = Array.from({ length: 48 }, (_, index) => {
      const price = 100 + index * 0.25;
      return candle(
        new Date(Date.UTC(2026, 3, 1, index)).toISOString(),
        price,
        price + 0.12,
        price - 0.12,
        price + 0.1
      );
    });

    const result = trendService.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles
      },
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        budgetUsd: 100,
        rangeControlMode: "adaptive",
        minOrderMode: MinOrderMode.Manual,
        minOrderQuoteAmount: 10,
        lowPrice: 95,
        highPrice: 105
      }
    });

    expect(result.rangeAdjustmentEvents).toEqual([]);
    expect(result.replayPoints.at(-1)?.activeLowPrice).toBe(95);
    expect(result.replayPoints.at(-1)?.activeHighPrice).toBe(105);
  });

  it("does not move adaptive rails while open cycles exist", () => {
    const candles = [
      candle("2026-04-01T00:00:00Z", 115, 116, 104, 105),
      ...Array.from({ length: 47 }, (_, index) =>
        candle(new Date(Date.UTC(2026, 3, 1, index + 1)).toISOString(), 105, 106, 104, 105)
      )
    ];

    const result = service.replay({
      series: {
        symbol: "SOL",
        pair: "SOL/USDC",
        resolution: "1h",
        candles
      },
      config: {
        ...buildBacktestConfig(StrategyMode.AccumulateUsdc),
        budgetUsd: 100,
        rangeControlMode: "adaptive",
        minOrderMode: MinOrderMode.Manual,
        minOrderQuoteAmount: 10
      }
    });

    expect(result.overallMetrics.openCycleCount).toBeGreaterThan(0);
    expect(result.rangeAdjustmentEvents).toEqual([]);
    expect(result.overallMetrics.rangeAdjustmentCount).toBe(0);
  });

  it("generates bounded candidates from train quantiles only", () => {
    const series: BacktestMarketSeries = {
      symbol: "BTC",
      pair: "BTC/USDC",
      resolution: "4h",
      candles: [
        candle("2026-01-01T00:00:00Z", 100, 102, 99, 100),
        candle("2026-01-01T04:00:00Z", 110, 112, 108, 110),
        candle("2026-01-01T08:00:00Z", 120, 122, 118, 120),
        candle("2026-01-01T12:00:00Z", 130, 132, 128, 130),
        candle("2026-01-01T16:00:00Z", 140, 142, 138, 140),
        candle("2026-01-01T20:00:00Z", 150, 152, 148, 150),
        candle("2026-01-02T00:00:00Z", 160, 162, 158, 160),
        candle("2026-01-02T04:00:00Z", 1000, 1002, 998, 1000),
        candle("2026-01-02T08:00:00Z", 1010, 1012, 1008, 1010),
        candle("2026-01-02T12:00:00Z", 1020, 1022, 1018, 1020)
      ]
    };

    const candidates = generateBacktestCandidates(series, 1000);
    expect(candidates.length).toBeGreaterThan(0);

    const trainCloses = series.candles.slice(0, 7).map((entry) => entry.close).sort((left, right) => left - right);
    const quantile = (values: number[], q: number) => {
      const position = (values.length - 1) * q;
      const lowerIndex = Math.floor(position);
      const upperIndex = Math.ceil(position);
      if (lowerIndex === upperIndex) {
        return values[lowerIndex]!;
      }

      const weight = position - lowerIndex;
      return values[lowerIndex]! + (values[upperIndex]! - values[lowerIndex]!) * weight;
    };

    const expectedLows = new Set([0.1, 0.2, 0.3].map((q) => Number(quantile(trainCloses, q).toFixed(8))));
    const expectedHighs = new Set([0.7, 0.8, 0.9].map((q) => Number(quantile(trainCloses, q).toFixed(8))));

    for (const candidate of candidates) {
      expect(candidate.minOrderMode).toBe(MinOrderMode.Auto);
      expect(candidate.levelCount).toBeGreaterThanOrEqual(6);
      expect(candidate.levelCount).toBeLessThanOrEqual(16);
      expect(candidate.highPrice).toBeGreaterThan(candidate.lowPrice);
      expect(((candidate.highPrice - candidate.lowPrice) / candidate.lowPrice) * 100).toBeGreaterThanOrEqual(4);
      expect(((candidate.highPrice - candidate.lowPrice) / candidate.lowPrice) * 100).toBeLessThanOrEqual(35);
      expect(expectedLows.has(Number(candidate.lowPrice.toFixed(8)))).toBe(true);
      expect(expectedHighs.has(Number(candidate.highPrice.toFixed(8)))).toBe(true);
    }
  });

  it("never uses final holdout performance to rank leaderboard entries", () => {
    const base: BacktestLeaderboardEntry = {
      rank: 0,
      config: buildBacktestConfig(StrategyMode.AccumulateUsdc),
      trainMetrics: {
        sampleCount: 1,
        startingBudgetUsd: 30,
        endingEquityUsd: 31,
        realizedPnlUsd: 1,
        unrealizedPnlUsd: 0,
        totalPnlUsd: 1,
        returnPct: 3.33,
        maxDrawdownPct: 1,
        maxOccupancyPct: 25,
        timeInRangePct: 80,
        timeOutOfRangePct: 20,
        closedCycleCount: 1,
        openCycleCount: 0,
        executedBuyCount: 1,
        executedSellCount: 1,
        blockedOrderCount: 0,
        simulatedOrderCount: 2,
        recenterCount: 0,
        rangeAdjustmentCount: 0,
        totalFeesUsd: 0,
        averageSlippageBps: 0
      },
      validationMetrics: {
        sampleCount: 1,
        startingBudgetUsd: 30,
        endingEquityUsd: 31,
        realizedPnlUsd: 1,
        unrealizedPnlUsd: 0,
        totalPnlUsd: 1,
        returnPct: 3.33,
        maxDrawdownPct: 2,
        maxOccupancyPct: 25,
        timeInRangePct: 80,
        timeOutOfRangePct: 20,
        closedCycleCount: 1,
        openCycleCount: 0,
        executedBuyCount: 1,
        executedSellCount: 1,
        blockedOrderCount: 0,
        simulatedOrderCount: 2,
        recenterCount: 0,
        rangeAdjustmentCount: 0,
        totalFeesUsd: 0,
        averageSlippageBps: 0
      }
    };

    const betterValidationGain: BacktestLeaderboardEntry = {
      ...base,
      validationMetrics: {
        ...base.validationMetrics,
        endingEquityUsd: 32
      }
    };

    const sameGainLowerDrawdown: BacktestLeaderboardEntry = {
      ...base,
      validationMetrics: {
        ...base.validationMetrics,
        endingEquityUsd: 32,
        maxDrawdownPct: 1
      }
    };

    const sorted = [base, sameGainLowerDrawdown, betterValidationGain].sort(compareBacktestLeaderboardEntries);
    expect(sorted).toEqual([base, sameGainLowerDrawdown, betterValidationGain]);
    const selected = { ...betterValidationGain, selectionMetrics: { ...base.trainMetrics, returnPct: 10 } };
    expect([base, selected].sort(compareBacktestLeaderboardEntries)[0]).toBe(selected);
  });
});


describe("Lab audit regressions", () => {
  const series = (count = 100): BacktestMarketSeries => ({ symbol: "SOL", pair: "SOL/USDC", resolution: "1h",
    candles: Array.from({ length: count }, (_, index) => {
      // Smooth oscillations leave room for several rails above the NATR floor.
      const price = 110 + Math.sin(index * 0.4) * 8;
      return candle(new Date(Date.UTC(2026, 0, 1, index)).toISOString(), price, price + 2, price - 2, price + 0.5);
    }) });

  it("keeps candidate selection unchanged when the locked future is replaced", () => {
    const original = series();
    const changed = { ...original, candles: original.candles.map((c, index) => index < 70 ? c :
      { ...c, open: c.open * 0.2, high: c.high * 0.2, low: c.low * 0.2, close: c.close * 0.2 }) };
    const first = service.recommend({ series: original, budgetUsd: 100 });
    const second = service.recommend({ series: changed, budgetUsd: 100 });
    expect(first.bestConfig).toEqual(second.bestConfig);
    expect(first.leaderboard.map((entry) => [entry.config, entry.selectionMetrics])).toEqual(
      second.leaderboard.map((entry) => [entry.config, entry.selectionMetrics]));
    expect(first.validationMetrics).not.toEqual(second.validationMetrics);
    expect(second.eligibility?.status).not.toBe("paper_candidate");
  });

  it("preserves budget allocation through recommendation and cash benchmark", () => {
    const result = service.recommend({ series: series(), budgetUsd: 200, maxDeployableUsd: 100,
      reserveQuoteAmount: 80, entryMode: EntryMode.SellOnly });
    expect(result.bestConfig).toMatchObject({ budgetUsd: 200, maxDeployableUsd: 100, reserveQuoteAmount: 80, entryMode: EntryMode.SellOnly });
    expect(result.bestReplay.executions).toEqual([]);
    expect(result.bestReplay.benchmarks?.cash.endingEquityUsd).toBe(200);
    expect(result.eligibility?.status).toBe("no_launch");
  });

  it("does not let a supplied end-window regime or future candle alter earlier decisions", () => {
    const original = series();
    const altered = { ...original, candles: original.candles.map((c, i) => i < 70 ? c :
      { ...c, open: c.open * 2, high: c.high * 2, low: c.low * 2, close: c.close * 2 }) };
    const config = { ...buildBacktestConfig(StrategyMode.AccumulateUsdc), rangeControlMode: "adaptive" as const, recenterMode: RecenterMode.Auto };
    const first = service.replay({ series: original, config });
    const second = service.replay({ series: altered, config, marketRegime: { regime: "CHAOTIC_HIGH_VOL", confidence: 1,
      scores: { range: 0, trendUp: 0, trendDown: 0, chaoticHighVol: 10 }, reasons: [], evaluatedAt: altered.candles.at(-1)!.timestamp } });
    expect(first.replayPoints.filter((p) => p.phase === "train")).toEqual(second.replayPoints.filter((p) => p.phase === "train"));
    expect(first.executions.filter((p) => p.phase === "train")).toEqual(second.executions.filter((p) => p.phase === "train"));
  });

  it("keeps regime defense through ticks inside range and carries indicator warmup into holdout", () => {
    const seen: number[] = [];
    class Trend extends MarketRegimeService {
      override assess(candles: BacktestMarketSeries["candles"]) {
        seen.push(candles.length);
        return { regime: "TREND_DOWN" as const, confidence: 0.9,
          scores: { range: 0, trendUp: 0, trendDown: 4, chaoticHighVol: 0 }, reasons: [], evaluatedAt: candles.at(-1)!.timestamp };
      }
    }
    const defended = new BacktestLabService(undefined, undefined, undefined, undefined, undefined, undefined, undefined, new Trend());
    const input = series(60);
    input.candles = input.candles.map((c, i) => i < 30 ? { ...c, open: 140, high: 141, low: 139, close: 140 } :
      { ...c, open: 115, high: 116, low: 104, close: 105 });
    const result = defended.replay({ series: input, config: { ...buildBacktestConfig(StrategyMode.AccumulateUsdc), rangeControlMode: "adaptive" } });
    expect(result.executions.filter((e) => e.side === TradeSide.Buy && e.status === OrderStatus.Simulated)).toEqual([]);
    expect(seen).toContain(43);
    expect(seen).toContain(60);
  });

  it("reserves fees before spending the final available quote", () => {
    const result = runConfig(StrategyMode.AccumulateUsdc, { budgetUsd: 10, maxDeployableUsd: 8, reserveQuoteAmount: 2,
      levelCount: 2, lowPrice: 110, highPrice: 130, executionFeeBps: 100 });
    expect(result.executions.some((e) => e.status === OrderStatus.Simulated)).toBe(true);
    for (const point of result.replayPoints) {
      expect(point.availableQuoteAmount).toBeGreaterThanOrEqual(2);
      expect(point.deployedQuoteAmount).toBeLessThanOrEqual(8);
    }
  });

  it("fills at the observed wick price and accounts for retained tokens in total PnL", () => {
    for (const mode of Object.values(StrategyMode)) {
      const result = runConfig(mode);
      const buy = result.executions.find((e) => e.side === TradeSide.Buy && e.status === OrderStatus.Simulated)!;
      expect(buy.targetPrice).toBe(110);
      expect(buy.fillPrice).toBe(104);
      expect(result.overallMetrics.realizedPnlUsd + result.overallMetrics.unrealizedPnlUsd).toBeCloseTo(
        result.overallMetrics.endingEquityUsd - result.overallMetrics.startingBudgetUsd, 6);
    }
  });
});
