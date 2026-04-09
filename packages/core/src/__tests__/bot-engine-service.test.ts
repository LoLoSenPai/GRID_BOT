import { describe, expect, it, vi } from "vitest";

import type { AlertRepository, AlertSink, BotStateRepository, MarketPricePort, PriceSnapshotRepository, SystemLogRepository, TradeRepository } from "../domain/contracts";
import { AlertType, BotMode, BotStatus, ExecutionProvider, ExecutionStatus, GridType, LogLevel, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
import type { BotAggregate, ExecutionReport, MarketPrice, PositionLot } from "../domain/types";
import { AlertService } from "../services/alert-service";
import { BotEngineService } from "../services/bot-engine-service";
import { ExecutionService } from "../services/execution-service";
import { GridStrategyService } from "../services/grid-strategy-service";
import { RiskManagerService } from "../services/risk-manager-service";

function createAggregate(overrides: {
  bot?: Partial<BotAggregate["bot"]>;
  config?: Partial<BotAggregate["config"]>;
  latestState?: Partial<NonNullable<BotAggregate["latestState"]>>;
  position?: Partial<NonNullable<BotAggregate["position"]>> | null;
  openLots?: PositionLot[];
} = {}): BotAggregate {
  return {
    bot: {
      id: "bot-1",
      key: "sol-grid",
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
      currentPrice: 120,
      ...(overrides.bot ?? {})
    },
    config: {
      id: "cfg-1",
      botId: "bot-1",
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
      outOfRangePause: true,
      ...(overrides.config ?? {})
    },
    latestState: {
      id: "snapshot-1",
      botId: "bot-1",
      status: BotStatus.Running,
      currentPrice: 120,
      availableQuoteAmount: 1500,
      availableBaseAmount: 1,
      deployedQuoteAmount: 500,
      averageEntryPrice: 118,
      realizedPnlUsd: 10,
      unrealizedPnlUsd: 5,
      totalEquityUsd: 2005,
      consecutiveFailures: 0,
      lastExecutionAt: null,
      lastProcessedAt: new Date("2026-04-02T00:00:00.000Z"),
      lastRecenterAt: null,
      metadata: {
        levelLocks: {},
        pendingSignal: null,
        gridCycles: {},
        recenterHistory: [],
        recentExecutions: []
      },
      ...(overrides.latestState ?? {})
    },
    position: {
      id: "pos-1",
      botId: "bot-1",
      baseAmount: 1,
      quoteSpent: 118,
      averageEntryPrice: 118,
      realizedPnlUsd: 10,
      unrealizedPnlUsd: 5,
      totalFeesQuote: 0.1,
      ...(overrides.position ?? {})
    },
    openLots: overrides.openLots ?? []
  };
}

function createBotRepository(aggregate: BotAggregate): BotStateRepository & {
  updateBotStatus: ReturnType<typeof vi.fn>;
  createStateSnapshot: ReturnType<typeof vi.fn>;
  setBotHeartbeat: ReturnType<typeof vi.fn>;
} {
  return {
    listRunnableBots: vi.fn(async () => [aggregate]),
    getBotAggregate: vi.fn(async () => aggregate),
    updateBotStatus: vi.fn(async () => undefined),
    setBotHeartbeat: vi.fn(async () => undefined),
    createStateSnapshot: vi.fn(async () => undefined),
    withBotLock: async <T>(_botId: string, callback: () => Promise<T>) => callback()
  };
}

function createTradeRepository(): TradeRepository & Record<string, ReturnType<typeof vi.fn>> {
  return {
    createOrder: vi.fn(async () => ({ id: "order-1" })),
    markOrderStatus: vi.fn(async () => undefined),
    createExecution: vi.fn(async () => ({ id: "exec-row-1" })),
    finalizeExecution: vi.fn(async () => undefined),
    upsertPosition: vi.fn(async () => undefined),
    replaceLots: vi.fn(async () => undefined),
    createInventorySnapshot: vi.fn(async () => undefined),
    createPnlSnapshot: vi.fn(async () => undefined)
  };
}

function createAlertService() {
  const repository: AlertRepository = {
    createAlert: vi.fn(async (alert) => ({
      id: "alert-1",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
      ...alert
    }))
  };
  const sink: AlertSink = {
    notify: vi.fn(async () => undefined)
  };

  return {
    service: new AlertService(repository, [sink]),
    createAlert: repository.createAlert as ReturnType<typeof vi.fn>,
    notify: sink.notify as ReturnType<typeof vi.fn>
  };
}

function createEngine({
  aggregate,
  marketPrice,
  executionReport
}: {
  aggregate: BotAggregate;
  marketPrice: MarketPrice;
  executionReport?: ExecutionReport;
}) {
  const botRepository = createBotRepository(aggregate);
  const tradeRepository = createTradeRepository();
  const priceSnapshotRepository: PriceSnapshotRepository & { createPriceSnapshot: ReturnType<typeof vi.fn> } = {
    createPriceSnapshot: vi.fn(async () => undefined)
  };
  const logRepository: SystemLogRepository & { writeLog: ReturnType<typeof vi.fn> } = {
    writeLog: vi.fn(async () => undefined)
  };
  const marketPriceService: MarketPricePort = {
    getLatestPrice: vi.fn(async () => marketPrice)
  };
  const adapterReport =
    executionReport ??
    ({
      provider: ExecutionProvider.Paper,
      status: ExecutionStatus.Simulated,
      executionId: "sim-1",
      txId: null,
      inputAmount: 50,
      outputAmount: 0.4,
      effectivePrice: 125,
      feeAmount: 0.05
    } satisfies ExecutionReport);

  const executionAdapter = {
    getQuote: vi.fn(),
    estimateExecution: vi.fn(),
    executeSwap: vi.fn(async () => adapterReport),
    getExecutionReport: vi.fn()
  };
  const executionService = new ExecutionService(
    {
      [ExecutionProvider.Paper]: executionAdapter,
      [ExecutionProvider.Jupiter]: executionAdapter,
      [ExecutionProvider.Dflow]: executionAdapter
    },
    false
  );
  const alert = createAlertService();

  return {
    engine: new BotEngineService(
      botRepository,
      tradeRepository,
      priceSnapshotRepository,
      logRepository,
      marketPriceService,
      executionService,
      new GridStrategyService(),
      new RiskManagerService(),
      alert.service
    ),
    botRepository,
    tradeRepository,
    priceSnapshotRepository,
    logRepository,
    executionAdapter,
    alert
  };
}

describe("BotEngineService", () => {
  it("transitions cooldown bots back to running after the cooldown window", async () => {
    const aggregate = createAggregate({
      bot: { status: BotStatus.Cooldown },
      latestState: {
        ...createAggregate().latestState,
        status: BotStatus.Cooldown,
        lastExecutionAt: new Date(Date.now() - 301000)
      }
    });

    const { engine, botRepository, tradeRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 121,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(botRepository.createStateSnapshot).toHaveBeenCalledOnce();
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BotStatus.Running,
        currentPrice: 121
      })
    );
    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
  });

  it("recovers bots stuck in error once market data fetch succeeds again", async () => {
    const aggregate = createAggregate({
      bot: { status: BotStatus.Error },
      latestState: {
        ...createAggregate().latestState,
        status: BotStatus.Error
      }
    });

    const { engine, botRepository, tradeRepository, logRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 121,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(botRepository.updateBotStatus).toHaveBeenCalledWith(aggregate.bot.id, BotStatus.Running);
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BotStatus.Running,
        currentPrice: 121
      })
    );
    expect(logRepository.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: LogLevel.Info,
        category: "engine",
        message: "Recovered after successful market data fetch."
      })
    );
    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
  });

  it("moves a manual bot to out_of_range and emits an alert when price leaves the band", async () => {
    const aggregate = createAggregate();
    const { engine, botRepository, tradeRepository, alert } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 170,
        confidence: 0.2,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(botRepository.updateBotStatus).toHaveBeenCalledWith(aggregate.bot.id, BotStatus.OutOfRange);
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BotStatus.OutOfRange,
        currentPrice: 170
      })
    );
    expect(alert.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AlertType.BotOutOfRange
      })
    );
    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
  });

  it("does not emit duplicate out_of_range alerts while the bot remains outside the band", async () => {
    const aggregate = createAggregate({
      bot: { status: BotStatus.OutOfRange },
      latestState: {
        ...createAggregate().latestState,
        status: BotStatus.OutOfRange,
        currentPrice: 170
      }
    });

    const { engine, alert } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 172,
        confidence: 0.2,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(alert.createAlert).not.toHaveBeenCalled();
  });

  it("creates a simulated execution and enters cooldown after a confirmed signal", async () => {
    const aggregate = createAggregate({
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 121,
        availableQuoteAmount: 1500,
        availableBaseAmount: 0,
        metadata: {
          levelLocks: {},
          pendingSignal: {
            levelIndex: 2,
            side: TradeSide.Buy,
            firstObservedAt: new Date(Date.now() - 20000).toISOString(),
            lastObservedPrice: 118
          },
          recenterHistory: [],
          recentExecutions: []
        }
      },
      position: null,
      openLots: []
    });

    const { engine, tradeRepository, botRepository, executionAdapter } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 118,
        confidence: 0.15,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledOnce();
    expect(tradeRepository.createExecution).toHaveBeenCalledOnce();
    expect(executionAdapter.executeSwap).toHaveBeenCalledOnce();
    expect(tradeRepository.markOrderStatus).toHaveBeenCalledWith("order-1", "simulated");
    expect(tradeRepository.replaceLots).toHaveBeenCalledWith(
      aggregate.bot.id,
      expect.arrayContaining([
        expect.objectContaining<Partial<PositionLot>>({
          botId: aggregate.bot.id,
          remainingBaseAmount: 0.4
        })
      ])
    );
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BotStatus.Cooldown,
        currentPrice: 118,
        metadata: expect.objectContaining({
          gridCycles: expect.objectContaining({
            "2": expect.objectContaining({
              buyLevelIndex: 2,
              sellLevelIndex: 3
            })
          })
        })
      })
    );
  });

  it("confirms a pending signal when price stays beyond the level across ticks", async () => {
    const aggregate = createAggregate({
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 118,
        availableQuoteAmount: 1500,
        availableBaseAmount: 0,
        averageEntryPrice: null,
        metadata: {
          levelLocks: {},
          pendingSignal: {
            levelIndex: 2,
            side: TradeSide.Buy,
            firstObservedAt: new Date(Date.now() - 20_000).toISOString(),
            lastObservedPrice: 118
          },
          recenterHistory: [],
          recentExecutions: []
        }
      },
      position: null,
      openLots: []
    });

    const { engine, tradeRepository, executionAdapter } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 117.5,
        confidence: 0.15,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledOnce();
    expect(executionAdapter.executeSwap).toHaveBeenCalledOnce();
  });

  it("clears the occupied buy level after the paired sell executes", async () => {
    const aggregate = createAggregate({
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 141,
        availableQuoteAmount: 1400,
        availableBaseAmount: 1,
        deployedQuoteAmount: 120,
        metadata: {
          levelLocks: {},
          pendingSignal: {
            levelIndex: 4,
            side: TradeSide.Sell,
            firstObservedAt: new Date(Date.now() - 20_000).toISOString(),
            lastObservedPrice: 141
          },
          gridCycles: {
            "3": {
              buyLevelIndex: 3,
              sellLevelIndex: 4,
              lotId: "lot-1",
              openedAt: "2026-04-01T00:00:00.000Z"
            }
          },
          recenterHistory: [],
          recentExecutions: []
        }
      },
      openLots: [
        {
          id: "lot-1",
          botId: "bot-1",
          originalBaseAmount: 1,
          remainingBaseAmount: 1,
          entryPrice: 120,
          costQuote: 120,
          openedByExecutionId: "exec-1",
          closedByExecutionId: null,
          openedAt: new Date("2026-04-01T00:00:00.000Z"),
          closedAt: null
        }
      ]
    });

    const { engine, botRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 141,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      },
      executionReport: {
        provider: ExecutionProvider.Paper,
        status: ExecutionStatus.Simulated,
        executionId: "sim-sell-1",
        txId: null,
        inputAmount: 0.9,
        outputAmount: 126.9,
        effectivePrice: 141,
        feeAmount: 0.05
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          gridCycles: {}
        })
      })
    );
  });

  it("does not log benign empty-intent signals", async () => {
    const aggregate = createAggregate({
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 99,
        availableQuoteAmount: 1500,
        availableBaseAmount: 0,
        metadata: {
          levelLocks: {},
          pendingSignal: {
            levelIndex: 0,
            side: TradeSide.Sell,
            firstObservedAt: new Date(Date.now() - 20_000).toISOString(),
            lastObservedPrice: 101
          },
          gridCycles: {},
          recenterHistory: [],
          recentExecutions: []
        }
      },
      position: null,
      openLots: []
    });

    const { engine, tradeRepository, logRepository, botRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 101,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
    expect(logRepository.writeLog).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("empty intent")
      })
    );
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          pendingSignal: null
        })
      })
    );
  });
});
