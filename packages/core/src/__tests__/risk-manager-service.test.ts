import { describe, expect, it } from "vitest";

import { AlertType, BotMode, BotStatus, ExecutionProvider, GridType, OrderStatus, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
import type { BotAggregate, MarketPrice, OrderIntent, TriggerSignal } from "../domain/types";
import { RiskManagerService } from "../services/risk-manager-service";

const service = new RiskManagerService();

const bot: BotAggregate = {
  bot: {
    id: "bot",
    key: "bot",
    name: "Bot",
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
    botId: "bot",
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
    maxOrdersPerHour: 1,
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
    id: "snap",
    botId: "bot",
    status: BotStatus.Running,
    currentPrice: 120,
    availableQuoteAmount: 1500,
    availableBaseAmount: 1,
    deployedQuoteAmount: 500,
    averageEntryPrice: 120,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalEquityUsd: 1400,
    consecutiveFailures: 0,
    lastExecutionAt: null,
    lastProcessedAt: new Date(),
    lastRecenterAt: null,
    metadata: {
      levelLocks: {},
      pendingSignal: null,
      recenterHistory: [],
      recentExecutions: [new Date().toISOString()]
    }
  },
  position: null,
  openLots: []
};

const signal: TriggerSignal = {
  levelIndex: 1,
  side: TradeSide.Buy,
  levelPrice: 118,
  observedPrice: 117,
  idempotencyKey: "sig",
  triggeredAt: new Date()
};

const order: OrderIntent = {
  botId: "bot",
  orderKey: "order",
  side: TradeSide.Buy,
  levelIndex: 1,
  targetPrice: 118,
  requestedBaseAmount: 0.42,
  requestedQuoteAmount: 50,
  status: OrderStatus.Created,
  reason: "test"
};

const marketPrice: MarketPrice = {
  symbol: "SOL",
  pair: "SOL/USDC",
  price: 117,
  confidence: 0.1,
  source: "pyth",
  timestamp: new Date(),
  feedId: "feed"
};

describe("RiskManagerService", () => {
  it("blocks when max orders per hour is reached", () => {
    const result = service.evaluate(bot, signal, order, marketPrice);
    expect(result.allowed).toBe(false);
    expect(result.alertType).toBe(AlertType.BudgetMaxReached);
  });

  it("blocks on invalid market price", () => {
    const result = service.evaluate(
      {
        ...bot,
        latestState: {
          ...bot.latestState!,
          metadata: { ...bot.latestState!.metadata, recentExecutions: [] }
        }
      },
      signal,
      order,
      { ...marketPrice, price: 0 }
    );
    expect(result.allowed).toBe(false);
  });
});
