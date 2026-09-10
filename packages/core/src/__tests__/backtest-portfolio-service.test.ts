import { describe, expect, it } from "vitest";

import { BotStatus, GridType, MinOrderMode, RecenterMode, StrategyMode } from "../domain/enums";
import type { BacktestConfig, BacktestMarketSeries, BacktestReplayPoint, BacktestRunResult } from "../domain/types";
import { BacktestPortfolioService } from "../services/backtest-portfolio-service";

const config = (budgetUsd: number, lowPrice = 90, highPrice = 110): BacktestConfig => ({
  budgetUsd,
  lowPrice,
  highPrice,
  levelCount: 3,
  gridType: GridType.Arithmetic,
  strategyMode: StrategyMode.Balanced,
  minOrderMode: MinOrderMode.Manual,
  minOrderQuoteAmount: 10,
  maxSlippageBps: 0,
  executionFeeBps: 100,
  cooldownMs: 0,
  maxOrdersPerHour: 10,
  maxDrawdownPct: 18,
  maxConsecutiveFailures: 3,
  levelLockMs: 0,
  priceConfirmationWindowMs: 0,
  recenterMode: RecenterMode.Manual,
  outOfRangePause: true
});

const series: BacktestMarketSeries = {
  symbol: "SOL",
  pair: "SOL/USDC",
  resolution: "1h",
  candles: [
    { timestamp: new Date("2026-04-01T00:00:00Z"), open: 100, high: 100, low: 100, close: 100 },
    { timestamp: new Date("2026-04-01T01:00:00Z"), open: 100, high: 100, low: 100, close: 100 }
  ]
};

function point(input: Partial<BacktestReplayPoint> & Pick<BacktestReplayPoint, "timestamp" | "phase" | "price">): BacktestReplayPoint {
  return {
    status: BotStatus.Running,
    activeLowPrice: 90,
    activeHighPrice: 110,
    availableQuoteAmount: 45,
    availableBaseAmount: 0,
    deployedQuoteAmount: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalEquityUsd: 45,
    drawdownPct: 0,
    occupancyPct: 0,
    ...input
  };
}

function fakeReplay(botConfig: BacktestConfig, replayPoints: BacktestReplayPoint[]): BacktestRunResult {
  const metric = {
    sampleCount: replayPoints.length,
    startingBudgetUsd: botConfig.budgetUsd,
    endingEquityUsd: replayPoints.at(-1)!.totalEquityUsd,
    realizedPnlUsd: replayPoints.at(-1)!.realizedPnlUsd,
    unrealizedPnlUsd: replayPoints.at(-1)!.unrealizedPnlUsd,
    totalPnlUsd: replayPoints.at(-1)!.totalEquityUsd - botConfig.budgetUsd,
    returnPct: 0,
    maxDrawdownPct: 0,
    maxOccupancyPct: 0,
    timeInRangePct: 0,
    timeOutOfRangePct: 0,
    closedCycleCount: 1,
    openCycleCount: 0,
    executedBuyCount: 1,
    executedSellCount: 1,
    blockedOrderCount: 0,
    simulatedOrderCount: 2,
    recenterCount: 0,
    rangeAdjustmentCount: 0,
    totalFeesUsd: 1,
    averageSlippageBps: 0
  };
  return {
    series,
    config: botConfig,
    replayPoints,
    executions: [],
    recenterEvents: [],
    rangeAdjustmentEvents: [],
    recenterAdvice: {} as BacktestRunResult["recenterAdvice"],
    trainMetrics: metric,
    validationMetrics: metric,
    overallMetrics: metric,
    benchmarks: { cash: { endingEquityUsd: botConfig.budgetUsd, returnPct: 0 }, buyAndHold: { endingEquityUsd: botConfig.budgetUsd, returnPct: 0 } },
    validationBenchmarks: { cash: { endingEquityUsd: botConfig.budgetUsd, returnPct: 0 }, buyAndHold: { endingEquityUsd: botConfig.budgetUsd, returnPct: 0 } },
    assumptions: {} as BacktestRunResult["assumptions"],
    meta: {} as BacktestRunResult["meta"]
  };
}

function serviceFor(pointsByBudget: Map<number, BacktestReplayPoint[]>) {
  return new BacktestPortfolioService({
    replay: ({ config: replayConfig }) => fakeReplay(replayConfig, pointsByBudget.get(replayConfig.budgetUsd)!)
  });
}

describe("BacktestPortfolioService", () => {
  it("conserves equal total capital and preserves repeated boundary observations", () => {
    const replayPoints = [
      point({ timestamp: new Date("2026-04-01T00:00:00Z"), phase: "train", price: 100 }),
      point({ timestamp: new Date("2026-04-01T01:00:00Z"), phase: "train", price: 100 }),
      point({ timestamp: new Date("2026-04-01T01:00:00Z"), phase: "validation", price: 100 }),
      point({ timestamp: new Date("2026-04-01T02:00:00Z"), phase: "validation", price: 100 })
    ];
    const result = serviceFor(new Map([[45, replayPoints]])).replay({
      series,
      totalBudgetUsd: 100,
      reserveQuoteAmount: 10,
      allocations: [{ id: "wide", config: config(45) }, { id: "zone", config: config(45) }]
    });

    expect(result.points).toHaveLength(4);
    expect(result.points[1]!.timestamp.getTime()).toBe(result.points[2]!.timestamp.getTime());
    expect(result.points[0]!.totalEquityUsd).toBe(100);
    expect(result.points.at(-1)!.cashUsd).toBe(100);
    expect(result.overallMetrics.startingBudgetUsd).toBe(100);
    expect(result.overallMetrics.endingEquityUsd).toBe(100);
  });

  it("rejects duplicated or negative allocations before replay", () => {
    const service = serviceFor(new Map());
    expect(() => service.replay({ series, totalBudgetUsd: 100, allocations: [{ id: "a", config: config(60) }] })).toThrow(/equal totalBudgetUsd/);
    expect(() => service.replay({ series, totalBudgetUsd: 50, allocations: [{ id: "a", config: config(-1) }, { id: "b", config: config(51) }] })).toThrow(/nonnegative/);
  });

  it("counts lower-zone inventory as stranded trading cost while upper zone stays eligible", () => {
    const lower = [
      point({ timestamp: new Date("2026-04-01T00:00:00Z"), phase: "train", price: 80, activeLowPrice: 90, availableQuoteAmount: 20, availableBaseAmount: 1, deployedQuoteAmount: 30, totalEquityUsd: 100 }),
      point({ timestamp: new Date("2026-04-01T01:00:00Z"), phase: "validation", price: 80, activeLowPrice: 90, availableQuoteAmount: 20, availableBaseAmount: 1, deployedQuoteAmount: 30, totalEquityUsd: 100 })
    ];
    const upper = lower.map((entry) => ({ ...entry, activeLowPrice: 75, activeHighPrice: 120, availableQuoteAmount: 50, deployedQuoteAmount: 0 }));
    const result = new BacktestPortfolioService({
      replay: ({ config: replayConfig }) => fakeReplay(replayConfig, replayConfig.lowPrice === 90 ? lower : upper)
    }).replay({
      series,
      totalBudgetUsd: 100,
      allocations: [{ id: "lower", config: config(50, 90, 110) }, { id: "upper", config: config(50, 75, 120) }]
    });

    expect(result.points[0]!.strandedTradingCostUsd).toBe(30);
    expect(result.overallMetrics.maxStrandedTradingCostUsd).toBe(30);
    expect(result.overallMetrics.endStrandedTradingCostUsd).toBe(30);
    expect(result.points[0]!.affordableOperatingBotIds).toEqual(["upper"]);
  });

  it("reports mark-to-market drawdown separately from realized PnL", () => {
    const replayPoints = [
      point({ timestamp: new Date("2026-04-01T00:00:00Z"), phase: "train", price: 100, totalEquityUsd: 50 }),
      point({ timestamp: new Date("2026-04-01T01:00:00Z"), phase: "validation", price: 90, totalEquityUsd: 40, realizedPnlUsd: 0, unrealizedPnlUsd: -10 })
    ];
    const result = serviceFor(new Map([[50, replayPoints]])).replay({ series, totalBudgetUsd: 50, allocations: [{ id: "wide", config: config(50) }] });
    expect(result.overallMetrics.totalPnlUsd).toBe(-10);
    expect(result.overallMetrics.realizedPnlUsd).toBe(0);
    expect(result.overallMetrics.unrealizedPnlUsd).toBe(-10);
    expect(result.overallMetrics.maxDrawdownPct).toBe(20);
  });

  it("keeps retained base phase scoped instead of leaking validation inventory into train", () => {
    const replayPoints = [
      point({ timestamp: new Date("2026-04-01T00:00:00Z"), phase: "train", price: 100, retainedBaseAmount: 0 }),
      point({ timestamp: new Date("2026-04-01T01:00:00Z"), phase: "train", price: 100, retainedBaseAmount: 0 }),
      point({ timestamp: new Date("2026-04-01T01:00:00Z"), phase: "validation", price: 100, retainedBaseAmount: 0 }),
      point({ timestamp: new Date("2026-04-01T02:00:00Z"), phase: "validation", price: 100, retainedBaseAmount: 2 })
    ];
    const result = serviceFor(new Map([[50, replayPoints]])).replay({
      series,
      totalBudgetUsd: 50,
      allocations: [{ id: "wide", config: config(50) }]
    });

    expect(result.trainMetrics.retainedBaseAmount).toBe(0);
    expect(result.validationMetrics.retainedBaseAmount).toBe(2);
    expect(result.overallMetrics.retainedBaseAmount).toBe(2);
  });

  it("excludes a point at the drawdown gate from the readiness proxy", () => {
    const replayPoints = [
      point({ timestamp: new Date("2026-04-01T00:00:00Z"), phase: "train", price: 100, drawdownPct: 18 }),
      point({ timestamp: new Date("2026-04-01T01:00:00Z"), phase: "validation", price: 100, drawdownPct: 18 })
    ];
    const result = serviceFor(new Map([[50, replayPoints]])).replay({
      series,
      totalBudgetUsd: 50,
      allocations: [{ id: "wide", config: config(50) }]
    });

    expect(result.points[0]!.eligibleOperatingBotIds).toEqual([]);
    expect(result.points[0]!.affordableOperatingBotIds).toEqual([]);
  });

  it("fails on a nonfinite replay snapshot instead of masking it as zero", () => {
    const replayPoints = [
      point({ timestamp: new Date("2026-04-01T00:00:00Z"), phase: "train", price: 100, totalEquityUsd: Number.NaN }),
      point({ timestamp: new Date("2026-04-01T01:00:00Z"), phase: "validation", price: 100 })
    ];
    expect(() => serviceFor(new Map([[50, replayPoints]])).replay({
      series,
      totalBudgetUsd: 50,
      allocations: [{ id: "wide", config: config(50) }]
    })).toThrow(/non-finite/);
  });
});
