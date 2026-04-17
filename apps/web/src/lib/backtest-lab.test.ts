import { describe, expect, it } from "vitest";
import { GridType, MinOrderMode, StrategyMode } from "@grid-bot/core/enums";

import {
  LAB_LOOKBACK_OPTIONS,
  LAB_PAIR_OPTIONS,
  LAB_RESOLUTION_OPTIONS,
  buildReplayConfig,
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
      lookbackDays: 30,
      resolution: "1h"
    });
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
  });

  it("rejects Lab windows that are too heavy for the VPS", () => {
    expect(() =>
      parseBacktestRecommendRequest({
        pair: "SOL",
        budgetUsd: 100,
        lookbackDays: 180,
        resolution: "5m"
      })
    ).toThrow("5m Lab runs are capped at 30d on this VPS.");
  });

  it("parses replay config and forces manual recenter in the built core config", () => {
    const payload = parseBacktestReplayRequest({
      pair: "BTC",
      budgetUsd: 250,
      lookbackDays: 60,
      resolution: "4h",
      config: {
        budgetUsd: 250,
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
      }
    });

    const config = buildReplayConfig(payload.config);

    expect(config.gridType).toBe(GridType.Geometric);
    expect(config.strategyMode).toBe(StrategyMode.AccumulateUsdc);
    expect(config.minOrderMode).toBe(MinOrderMode.Manual);
    expect(config.executionFeeBps).toBe(12);
    expect(config.recenterMode).toBe("manual_recenter");
  });
});
