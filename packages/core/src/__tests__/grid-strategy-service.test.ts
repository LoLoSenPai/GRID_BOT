import { describe, expect, it } from "vitest";

import { GridStrategyService } from "../services/grid-strategy-service";
import { BotMode, BotStatus, ExecutionProvider, GridType, OrderStatus, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
import type { BotAggregate } from "../domain/types";

const service = new GridStrategyService();

const aggregate: BotAggregate = {
  bot: {
    id: "bot_1",
    key: "sol-paper",
    name: "SOL Grid",
    baseMint: "SOL",
    quoteMint: "USDC",
    baseSymbol: "SOL",
    quoteSymbol: "USDC",
    baseDecimals: 9,
    quoteDecimals: 6,
    strategyMode: StrategyMode.Balanced,
    mode: BotMode.Paper,
    status: BotStatus.Running,
    executionProvider: ExecutionProvider.Paper,
    currentPrice: 120
  },
  config: {
    id: "cfg",
    botId: "bot_1",
    totalBudgetUsd: 2000,
    maxDeployableUsd: 1500,
    reserveQuoteAmount: 500,
    lowPrice: 100,
    highPrice: 160,
    levelCount: 7,
    gridType: GridType.Arithmetic,
    minOrderQuoteAmount: 50,
    maxSlippageBps: 50,
    cooldownMs: 300000,
    maxOrdersPerHour: 12,
    maxDrawdownPct: 18,
    maxConsecutiveFailures: 3,
    levelLockMs: 60000,
    priceConfirmationWindowMs: 10000,
    recenterMode: RecenterMode.Manual,
    autoRecenterMinIntervalMs: 21600000,
    autoRecenterMaxPerDay: 2,
    outOfRangePause: true
  },
  latestState: {
    id: "snapshot",
    botId: "bot_1",
    status: BotStatus.Running,
    currentPrice: 120,
    availableQuoteAmount: 1500,
    availableBaseAmount: 3,
    deployedQuoteAmount: 500,
    averageEntryPrice: 118,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalEquityUsd: 2000,
    consecutiveFailures: 0,
    lastExecutionAt: null,
    lastProcessedAt: new Date(),
    lastRecenterAt: null,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {},
          recenterHistory: [],
          recentExecutions: []
        }
  },
  position: null,
  openLots: []
};

describe("GridStrategyService", () => {
  it("calculates arithmetic levels", () => {
    const levels = service.calculateLevels(100, 160, 7, GridType.Arithmetic);
    expect(levels).toHaveLength(7);
    expect(levels[0]?.price).toBe(100);
    expect(levels[6]?.price).toBe(160);
  });

  it("calculates geometric levels", () => {
    const levels = service.calculateLevels(100, 200, 4, GridType.Geometric);
    expect(levels).toHaveLength(4);
    expect(levels[0]?.price).toBe(100);
    expect(levels[3]?.price).toBe(200);
  });

  it("detects downward crosses as buy signals", () => {
    const levels = service.calculateLevels(100, 160, 7, GridType.Arithmetic);
    const signal = service.detectCrossedLevels(levels, 130, 108);
    expect(signal[0]?.side).toBe(TradeSide.Buy);
  });

  it("ignores impossible boundary signals at the bottom of the grid", () => {
    const levels = service.calculateLevels(100, 160, 7, GridType.Arithmetic);
    const signal = service.detectCrossedLevels(levels, 95, 105);
    expect(signal).toEqual([]);
  });

  it("ignores the topmost buy rail when price re-enters from above range", () => {
    const levels = service.calculateLevels(100, 160, 7, GridType.Arithmetic);
    const signal = service.detectCrossedLevels(levels, 165, 145);
    expect(signal.map((entry) => entry.levelIndex)).toEqual([5]);
    expect(signal[0]?.side).toBe(TradeSide.Buy);
  });

  it("builds an accumulate_base sell that keeps the profit in base", () => {
    const order = service.buildOrderIntent(
      {
        ...aggregate,
        latestState: {
          ...aggregate.latestState!,
          metadata: {
            ...aggregate.latestState!.metadata,
            gridCycles: {
              "3": {
                buyLevelIndex: 3,
                sellLevelIndex: 4,
                lotId: "lot-1",
                openedAt: "2026-04-01T00:00:00.000Z"
              }
            }
          }
        },
        bot: {
          ...aggregate.bot,
          strategyMode: StrategyMode.AccumulateBase
        },
        openLots: [
          {
            id: "lot-1",
            botId: "bot_1",
            originalBaseAmount: 1,
            remainingBaseAmount: 1,
            entryPrice: 100,
            costQuote: 100,
            openedByExecutionId: "exec-1",
            closedByExecutionId: null,
            openedAt: new Date("2026-04-01T00:00:00.000Z"),
            closedAt: null
          }
        ]
      },
      {
        levelIndex: 4,
        side: TradeSide.Sell,
        levelPrice: 110,
        observedPrice: 112,
        idempotencyKey: "signal-1",
        triggeredAt: new Date()
      }
    );

    expect(order?.requestedQuoteAmount).toBe(100);
    expect(order?.requestedBaseAmount).toBeCloseTo(0.90909091, 6);
    expect(order?.matchedLotIds).toEqual(["lot-1"]);
  });

  it("builds a balanced sell that keeps half the profit in base", () => {
    const order = service.buildOrderIntent(
      {
        ...aggregate,
        latestState: {
          ...aggregate.latestState!,
          metadata: {
            ...aggregate.latestState!.metadata,
            gridCycles: {
              "3": {
                buyLevelIndex: 3,
                sellLevelIndex: 4,
                lotId: "lot-1",
                openedAt: "2026-04-01T00:00:00.000Z"
              }
            }
          }
        },
        bot: {
          ...aggregate.bot,
          strategyMode: StrategyMode.Balanced
        },
        openLots: [
          {
            id: "lot-1",
            botId: "bot_1",
            originalBaseAmount: 1,
            remainingBaseAmount: 1,
            entryPrice: 100,
            costQuote: 100,
            openedByExecutionId: "exec-1",
            closedByExecutionId: null,
            openedAt: new Date("2026-04-01T00:00:00.000Z"),
            closedAt: null
          }
        ]
      },
      {
        levelIndex: 4,
        side: TradeSide.Sell,
        levelPrice: 110,
        observedPrice: 112,
        idempotencyKey: "signal-1",
        triggeredAt: new Date()
      }
    );

    expect(order?.requestedQuoteAmount).toBe(105);
    expect(order?.requestedBaseAmount).toBeCloseTo(0.95454545, 6);
  });

  it("builds an accumulate_usdc sell that exits the profitable lot", () => {
    const order = service.buildOrderIntent(
      {
        ...aggregate,
        latestState: {
          ...aggregate.latestState!,
          metadata: {
            ...aggregate.latestState!.metadata,
            gridCycles: {
              "3": {
                buyLevelIndex: 3,
                sellLevelIndex: 4,
                lotId: "lot-1",
                openedAt: "2026-04-01T00:00:00.000Z"
              }
            }
          }
        },
        bot: {
          ...aggregate.bot,
          strategyMode: StrategyMode.AccumulateUsdc
        },
        openLots: [
          {
            id: "lot-1",
            botId: "bot_1",
            originalBaseAmount: 1,
            remainingBaseAmount: 1,
            entryPrice: 100,
            costQuote: 100,
            openedByExecutionId: "exec-1",
            closedByExecutionId: null,
            openedAt: new Date("2026-04-01T00:00:00.000Z"),
            closedAt: null
          }
        ]
      },
      {
        levelIndex: 4,
        side: TradeSide.Sell,
        levelPrice: 110,
        observedPrice: 112,
        idempotencyKey: "signal-1",
        triggeredAt: new Date()
      }
    );

    expect(order?.requestedQuoteAmount).toBe(110);
    expect(order?.requestedBaseAmount).toBe(1);
  });

  it("keeps older small lots sellable after a budget increase raises the min order", () => {
    const order = service.buildOrderIntent(
      {
        ...aggregate,
        config: {
          ...aggregate.config,
          totalBudgetUsd: 300,
          maxDeployableUsd: 300,
          minOrderQuoteAmount: 25
        },
        latestState: {
          ...aggregate.latestState!,
          metadata: {
            ...aggregate.latestState!.metadata,
            gridCycles: {
              "1": {
                buyLevelIndex: 1,
                sellLevelIndex: 2,
                lotId: "lot-small",
                openedAt: "2026-04-18T10:00:00.000Z"
              }
            }
          }
        },
        bot: {
          ...aggregate.bot,
          strategyMode: StrategyMode.AccumulateUsdc
        },
        openLots: [
          {
            id: "lot-small",
            botId: "bot_1",
            originalBaseAmount: 0.15,
            remainingBaseAmount: 0.15,
            entryPrice: 82,
            costQuote: 12.3,
            openedByExecutionId: "exec-small",
            closedByExecutionId: null,
            openedAt: new Date("2026-04-18T10:00:00.000Z"),
            closedAt: null
          }
        ]
      },
      {
        levelIndex: 2,
        side: TradeSide.Sell,
        levelPrice: 84,
        observedPrice: 84.2,
        idempotencyKey: "signal-small-sell",
        triggeredAt: new Date("2026-04-18T11:00:00.000Z")
      }
    );

    expect(order).toEqual(
      expect.objectContaining({
        side: TradeSide.Sell,
        requestedQuoteAmount: 12.6,
        requestedBaseAmount: 0.15,
        matchedLotIds: ["lot-small"]
      })
    );
  });

  it("skips sells when no profitable lot is available", () => {
    const order = service.buildOrderIntent(
      {
        ...aggregate,
        latestState: {
          ...aggregate.latestState!,
          metadata: {
            ...aggregate.latestState!.metadata,
            gridCycles: {
              "3": {
                buyLevelIndex: 3,
                sellLevelIndex: 4,
                lotId: "lot-1",
                openedAt: "2026-04-01T00:00:00.000Z"
              }
            }
          }
        },
        openLots: [
          {
            id: "lot-1",
            botId: "bot_1",
            originalBaseAmount: 1,
            remainingBaseAmount: 1,
            entryPrice: 100,
            costQuote: 100,
            openedByExecutionId: "exec-1",
            closedByExecutionId: null,
            openedAt: new Date("2026-04-01T00:00:00.000Z"),
            closedAt: null
          }
        ]
      },
      {
        levelIndex: 4,
        side: TradeSide.Sell,
        levelPrice: 95,
        observedPrice: 96,
        idempotencyKey: "signal-1",
        triggeredAt: new Date()
      }
    );

    expect(order).toBeNull();
  });

  it("skips a buy when the same level is already occupied by an active cycle", () => {
    const order = service.buildOrderIntent(
      {
        ...aggregate,
        latestState: {
          ...aggregate.latestState!,
          metadata: {
            ...aggregate.latestState!.metadata,
            gridCycles: {
              "2": {
                buyLevelIndex: 2,
                sellLevelIndex: 3,
                lotId: "lot-1",
                openedAt: "2026-04-01T00:00:00.000Z"
              }
            }
          }
        }
      },
      {
        levelIndex: 2,
        side: TradeSide.Buy,
        levelPrice: 120,
        observedPrice: 119,
        idempotencyKey: "signal-2",
        triggeredAt: new Date()
      }
    );

    expect(order).toBeNull();
  });

  it("sizes buy intents by trade cycle count instead of raw rail count", () => {
    const order = service.buildOrderIntent(
      aggregate,
      {
        levelIndex: 2,
        side: TradeSide.Buy,
        levelPrice: 120,
        observedPrice: 119,
        idempotencyKey: "signal-3",
        triggeredAt: new Date()
      }
    );

    expect(order?.requestedQuoteAmount).toBe(250);
    expect(order?.requestedBaseAmount).toBeCloseTo(2.08333333, 6);
    expect(order?.status).toBe(OrderStatus.Created);
  });
});
