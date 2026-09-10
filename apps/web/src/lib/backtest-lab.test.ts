import { describe, expect, it } from "vitest";
import { EntryMode, GridType, MinOrderMode, RecenterMode, StrategyMode } from "@grid-bot/core/enums";

import {
  LAB_LOOKBACK_OPTIONS,
  LAB_PAIR_OPTIONS,
  LAB_RESOLUTION_OPTIONS,
  buildReplayConfig,
  getLabLookbackOptions,
  parseBacktestRecommendRequest,
  parseBacktestReplayRequest
} from "./backtest-lab";

describe("backtest-lab request parsing", () => {
  it("parses a recommend request with supported scope values", () => {
    const payload = parseBacktestRecommendRequest({
      pair: LAB_PAIR_OPTIONS[0],
      budgetUsd: 100,
      lookbackDays: LAB_LOOKBACK_OPTIONS[0],
      resolution: LAB_RESOLUTION_OPTIONS[2]
    });

    expect(payload).toEqual({
      pair: "SOL",
      budgetUsd: 100,
      maxDeployableUsd: 100,
      reserveQuoteAmount: 0,
      entryMode: EntryMode.Normal,
      lookbackDays: 7,
      resolution: "1h",
      rangeMethod: "rebounds"
    });
  });

  it("defaults new recommendations to rebound fitting and accepts an explicit goal", () => {
    const payload = parseBacktestRecommendRequest({
      pair: "BTC",
      budgetUsd: 600,
      lookbackDays: 30,
      resolution: "1h",
      strategyMode: StrategyMode.AccumulateBase
    });

    expect(payload.rangeMethod).toBe("rebounds");
    expect(payload.strategyMode).toBe(StrategyMode.AccumulateBase);
  });

  it("rejects unsupported pair or resolution values", () => {
    expect(() =>
      parseBacktestRecommendRequest({
        pair: "ETH",
        budgetUsd: 100,
        lookbackDays: 30,
        resolution: "1h"
      })
    ).toThrow("Unsupported pair.");

    expect(() =>
      parseBacktestRecommendRequest({
        pair: "SOL",
        budgetUsd: 100,
        lookbackDays: 30,
        resolution: "1d"
      })
    ).toThrow("Unsupported resolution.");

    expect(() =>
      parseBacktestRecommendRequest({
        pair: "SOL",
        budgetUsd: 100,
        lookbackDays: 7,
        resolution: "1h",
        rangeMethod: "quantiles"
      })
    ).toThrow("Unsupported rangeMethod.");

    expect(() =>
      parseBacktestRecommendRequest({
        pair: "SOL",
        budgetUsd: 100,
        lookbackDays: 7,
        resolution: "1h",
        strategyMode: "not-a-goal"
      })
    ).toThrow("Unsupported strategyMode.");
  });

  it("rejects an unsupported recenter model", () => {
    expect(() =>
      parseBacktestReplayRequest({
        pair: "SOL",
        budgetUsd: 100,
        lookbackDays: 7,
        resolution: "1h",
        config: {
          budgetUsd: 100,
          lowPrice: 90,
          highPrice: 110,
          levelCount: 6,
          gridType: GridType.Arithmetic,
          strategyMode: StrategyMode.Balanced,
          minOrderMode: MinOrderMode.Auto,
          minOrderQuoteAmount: 10,
          maxSlippageBps: 50,
          cooldownMs: 0,
          maxOrdersPerHour: 10,
          maxDrawdownPct: 20,
          maxConsecutiveFailures: 2,
          levelLockMs: 0,
          priceConfirmationWindowMs: 0,
          recenterMode: RecenterMode.Auto,
          recenterModel: "unsupported",
          outOfRangePause: true
        }
      })
    ).toThrow("Unsupported config.recenterModel.");
  });

  it("rejects Lab windows that are too heavy for the VPS", () => {
    expect(() =>
      parseBacktestRecommendRequest({
        pair: "SOL",
        budgetUsd: 100,
        lookbackDays: 30,
        resolution: "5m"
      })
    ).toThrow("5m Lab runs are capped at 14d on this VPS.");
  });

  it("offers only source-page-safe lookbacks for fine resolutions", () => {
    expect(getLabLookbackOptions("5m")).toEqual([7, 14]);
    expect(getLabLookbackOptions("30m")).toEqual([7, 14, 30]);
  });

  it("parses replay config and forces manual recenter in the built core config", () => {
    const payload = parseBacktestReplayRequest({
      pair: "BTC",
      budgetUsd: 250,
      lookbackDays: 60,
      resolution: "4h",
      config: {
        budgetUsd: 250,
        maxDeployableUsd: 180,
        reserveQuoteAmount: 50,
        entryMode: EntryMode.SellOnly,
        lowPrice: 65000,
        highPrice: 73000,
        levelCount: 9,
        gridType: GridType.Geometric,
        strategyMode: StrategyMode.AccumulateUsdc,
        minOrderMode: MinOrderMode.Manual,
        minOrderQuoteAmount: 25,
        maxSlippageBps: 50,
        executionFeeBps: 12,
        cooldownMs: 15000,
        maxOrdersPerHour: 96,
        maxDrawdownPct: 18,
        maxConsecutiveFailures: 3,
        levelLockMs: 15000,
        priceConfirmationWindowMs: 0,
        outOfRangePause: true
      },
      executionCosts: { mode: "stress" }
    });

    const config = buildReplayConfig(payload.config);

    expect(config.gridType).toBe(GridType.Geometric);
    expect(config.strategyMode).toBe(StrategyMode.AccumulateUsdc);
    expect(config.minOrderMode).toBe(MinOrderMode.Manual);
    expect(config.executionFeeBps).toBe(12);
    expect(config.maxDeployableUsd).toBe(180);
    expect(config.reserveQuoteAmount).toBe(50);
    expect(config.entryMode).toBe(EntryMode.SellOnly);
    expect(config.recenterMode).toBe("manual_recenter");
    expect(payload.executionCosts.mode).toBe("stress");
    expect(payload.rangeMethod).toBe("rebounds");
  });

  it("defaults static auto recenter to the worker model", () => {
    const payload = parseBacktestReplayRequest({
      pair: "SOL",
      budgetUsd: 100,
      lookbackDays: 7,
      resolution: "1h",
      config: {
        budgetUsd: 100,
        lowPrice: 90,
        highPrice: 110,
        levelCount: 6,
        gridType: GridType.Arithmetic,
        strategyMode: StrategyMode.Balanced,
        minOrderMode: MinOrderMode.Auto,
        minOrderQuoteAmount: 10,
        maxSlippageBps: 50,
        cooldownMs: 0,
        maxOrdersPerHour: 10,
        maxDrawdownPct: 20,
        maxConsecutiveFailures: 2,
        levelLockMs: 0,
        priceConfirmationWindowMs: 0,
        recenterMode: RecenterMode.Auto,
        outOfRangePause: true
      }
    });

    expect(payload.config.recenterModel).toBe("worker_flat");
    expect(buildReplayConfig({ ...payload.config, recenterModel: undefined }).recenterModel).toBe("worker_flat");
  });

  it("keeps range method and goal independent from replay config fields", () => {
    const payload = parseBacktestReplayRequest({
      pair: "SOL",
      budgetUsd: 600,
      lookbackDays: 30,
      resolution: "1h",
      rangeMethod: "distribution",
      strategyMode: StrategyMode.AccumulateUsdc,
      config: {
        budgetUsd: 600,
        lowPrice: 90,
        highPrice: 110,
        levelCount: 6,
        gridType: GridType.Arithmetic,
        strategyMode: StrategyMode.Balanced,
        minOrderMode: MinOrderMode.Auto,
        minOrderQuoteAmount: 10,
        maxSlippageBps: 50,
        cooldownMs: 0,
        maxOrdersPerHour: 10,
        maxDrawdownPct: 20,
        maxConsecutiveFailures: 2,
        levelLockMs: 0,
        priceConfirmationWindowMs: 0,
        outOfRangePause: true
      }
    });

    expect(payload.rangeMethod).toBe("distribution");
    expect(payload.strategyMode).toBe(StrategyMode.AccumulateUsdc);
    expect(payload.config.strategyMode).toBe(StrategyMode.Balanced);
  });
});
