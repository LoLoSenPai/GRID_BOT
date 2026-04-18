import { describe, expect, it } from "vitest";

import { BotStatus, GridType, MinOrderMode, OrderStatus, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
import { BacktestLabService, compareBacktestLeaderboardEntries, generateBacktestCandidates } from "../services/backtest-lab-service";
import type { BacktestConfig, BacktestLeaderboardEntry, BacktestMarketSeries } from "../domain/types";

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
    expect(result.validationMetrics.executedSellCount).toBe(0);
    expect(result.validationMetrics.closedCycleCount).toBe(0);
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
    expect(balanced.overallMetrics.realizedPnlUsd).toBeGreaterThan(accumulateBase.overallMetrics.realizedPnlUsd);

    expect(accumulateUsdc.overallMetrics.openCycleCount).toBe(0);
    expect(balanced.overallMetrics.openCycleCount).toBe(1);
    expect(accumulateBase.overallMetrics.openCycleCount).toBe(1);

    expect(accumulateUsdc.replayPoints.at(-1)?.availableBaseAmount ?? 0).toBe(0);
    expect(balanced.replayPoints.at(-1)?.availableBaseAmount ?? 0).toBeGreaterThan(0);
    expect(accumulateBase.replayPoints.at(-1)?.availableBaseAmount ?? 0).toBeGreaterThan(
      balanced.replayPoints.at(-1)?.availableBaseAmount ?? 0
    );
  });

  it("applies execution fees to simulated equity and realized PnL", () => {
    const noFee = runConfig(StrategyMode.AccumulateUsdc, { executionFeeBps: 0 });
    const withFee = runConfig(StrategyMode.AccumulateUsdc, { executionFeeBps: 100 });

    expect(withFee.overallMetrics.endingEquityUsd).toBeLessThan(noFee.overallMetrics.endingEquityUsd);
    expect(withFee.overallMetrics.realizedPnlUsd).toBeLessThan(noFee.overallMetrics.realizedPnlUsd);
    expect(withFee.executions.reduce((sum, execution) => sum + execution.feeAmount, 0)).toBeGreaterThan(0);
    expect(withFee.overallMetrics.totalFeesUsd).toBeGreaterThan(0);
  });

  it("reports average simulated slippage in basis points", () => {
    const result = runConfig(StrategyMode.AccumulateUsdc, { maxSlippageBps: 50 });

    expect(result.overallMetrics.simulatedOrderCount).toBeGreaterThan(0);
    expect(result.overallMetrics.averageSlippageBps).toBe(50);
    expect(result.assumptions.maxSlippageBps).toBe(50);
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
        recenterMode: RecenterMode.Auto
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
    expect(result.overallMetrics.recenterCount).toBe(result.recenterEvents.length);
    expect(result.replayPoints.at(-1)?.activeLowPrice).toBeLessThan(100);
    expect(result.assumptions.recenterScope).toBe("simulated_when_auto_recenter");
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

  it("ranks leaderboard entries by validation first", () => {
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
    expect(sorted[0]).toBe(sameGainLowerDrawdown);
    expect(sorted[1]).toBe(betterValidationGain);
    expect(sorted[2]).toBe(base);
  });
});
