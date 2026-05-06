import { describe, expect, it, vi } from "vitest";

import type { AlertRepository, AlertSink, BotStateRepository, MarketPricePort, PriceSnapshotRepository, SystemLogRepository, TradeRepository } from "../domain/contracts";
import { AlertType, BotMode, BotStatus, ExecutionProvider, ExecutionStatus, GridType, LogLevel, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
import type { BotAggregate, ExecutionEstimate, ExecutionReport, MarketPrice, PositionLot } from "../domain/types";
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
  executionReport,
  executionEstimate,
  executionError,
  liveTradingEnabled = false
}: {
  aggregate: BotAggregate;
  marketPrice: MarketPrice;
  executionReport?: ExecutionReport;
  executionEstimate?: ExecutionEstimate;
  executionError?: Error;
  liveTradingEnabled?: boolean;
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
  const adapterEstimate =
    executionEstimate ??
    ({
      provider: adapterReport.provider,
      inputMint: aggregate.bot.quoteMint,
      outputMint: aggregate.bot.baseMint,
      inputAmount: adapterReport.inputAmount,
      expectedOutputAmount: adapterReport.outputAmount,
      estimatedFeeAmount: adapterReport.feeAmount,
      priceImpactPct: 0,
      expectedPrice: adapterReport.effectivePrice
    } satisfies ExecutionEstimate);

  const executionAdapter = {
    getQuote: vi.fn(),
    estimateExecution: vi.fn(async () => adapterEstimate),
    prepareExecution: vi.fn(async () => adapterEstimate),
    executeSwap: vi.fn(async () => adapterReport),
    executePreparedSwap: vi.fn(async () => {
      if (executionError) {
        throw executionError;
      }
      return adapterReport;
    }),
    getExecutionReport: vi.fn()
  };
  const executionService = new ExecutionService(
    {
      [ExecutionProvider.Paper]: executionAdapter,
      [ExecutionProvider.Jupiter]: executionAdapter,
      [ExecutionProvider.Dflow]: executionAdapter
    },
    liveTradingEnabled
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

  it("returns out_of_range bots to running once price re-enters the configured band", async () => {
    const aggregate = createAggregate({
      bot: { status: BotStatus.OutOfRange },
      latestState: {
        ...createAggregate().latestState,
        status: BotStatus.OutOfRange,
        currentPrice: 170
      }
    });

    const { engine, botRepository, tradeRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 150,
        confidence: 0.2,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BotStatus.Running,
        currentPrice: 150
      })
    );
  });

  it("sells the terminal open cycle before marking the bot out_of_range above the upper bound", async () => {
    const aggregate = createAggregate({
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 159,
        availableQuoteAmount: 1450,
        availableBaseAmount: 0.4,
        deployedQuoteAmount: 50,
        averageEntryPrice: 125,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {
            "5": {
              buyLevelIndex: 5,
              sellLevelIndex: 6,
              lotId: "lot-top",
              openedAt: "2026-04-02T00:00:00.000Z"
            }
          },
          recenterHistory: [],
          recentExecutions: []
        }
      },
      position: {
        baseAmount: 0.4,
        quoteSpent: 50,
        averageEntryPrice: 125,
        realizedPnlUsd: 10,
        unrealizedPnlUsd: 14,
        totalFeesQuote: 0.1
      },
      openLots: [
        {
          id: "lot-top",
          botId: "bot-1",
          originalBaseAmount: 0.4,
          remainingBaseAmount: 0.4,
          entryPrice: 125,
          costQuote: 50,
          openedByExecutionId: "exec-buy-1",
          closedByExecutionId: null,
          openedAt: new Date("2026-04-02T00:00:00.000Z"),
          closedAt: null
        }
      ],
      config: {
        priceConfirmationWindowMs: 0
      }
    });

    const { engine, tradeRepository, botRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 161,
        confidence: 0.2,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      },
      executionReport: {
        provider: ExecutionProvider.Paper,
        status: ExecutionStatus.Simulated,
        executionId: "sim-sell-top",
        txId: null,
        inputAmount: 0.35625,
        outputAmount: 57,
        effectivePrice: 160,
        feeAmount: 0.05
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: TradeSide.Sell,
        levelIndex: 6,
        targetPrice: 160
      })
    );
    expect(botRepository.updateBotStatus).toHaveBeenCalledWith(aggregate.bot.id, BotStatus.Cooldown);
    expect(botRepository.updateBotStatus).not.toHaveBeenCalledWith(aggregate.bot.id, BotStatus.OutOfRange);
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BotStatus.Cooldown,
        currentPrice: 161,
        metadata: expect.objectContaining({
          gridCycles: {}
        })
      })
    );
  });

  it("recovers and sells an actionable top cycle while already out_of_range above the upper bound", async () => {
    const aggregate = createAggregate({
      bot: {
        status: BotStatus.OutOfRange
      },
      latestState: {
        ...createAggregate().latestState,
        status: BotStatus.OutOfRange,
        currentPrice: 161,
        availableQuoteAmount: 1450,
        availableBaseAmount: 0.4,
        deployedQuoteAmount: 50,
        averageEntryPrice: 125,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {
            "5": {
              buyLevelIndex: 5,
              sellLevelIndex: 6,
              lotId: "lot-top",
              openedAt: "2026-04-02T00:00:00.000Z"
            }
          },
          recenterHistory: [],
          recentExecutions: []
        }
      },
      position: {
        baseAmount: 0.4,
        quoteSpent: 50,
        averageEntryPrice: 125,
        realizedPnlUsd: 10,
        unrealizedPnlUsd: 14,
        totalFeesQuote: 0.1
      },
      openLots: [
        {
          id: "lot-top",
          botId: "bot-1",
          originalBaseAmount: 0.4,
          remainingBaseAmount: 0.4,
          entryPrice: 125,
          costQuote: 50,
          openedByExecutionId: "exec-buy-1",
          closedByExecutionId: null,
          openedAt: new Date("2026-04-02T00:00:00.000Z"),
          closedAt: null
        }
      ],
      config: {
        priceConfirmationWindowMs: 0
      }
    });

    const { engine, tradeRepository, botRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 161,
        confidence: 0.2,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      },
      executionReport: {
        provider: ExecutionProvider.Paper,
        status: ExecutionStatus.Simulated,
        executionId: "sim-sell-recovery",
        txId: null,
        inputAmount: 0.35625,
        outputAmount: 57,
        effectivePrice: 160,
        feeAmount: 0.05
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: TradeSide.Sell,
        levelIndex: 6,
        targetPrice: 160
      })
    );
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BotStatus.Cooldown,
        currentPrice: 161
      })
    );
  });

  it("executes the next actionable lower buy rail immediately when a drop crosses an already occupied level", async () => {
    const aggregate = createAggregate({
      config: {
        totalBudgetUsd: 50,
        maxDeployableUsd: 40,
        reserveQuoteAmount: 10,
        lowPrice: 82,
        highPrice: 85,
        levelCount: 4,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 83.2,
        availableQuoteAmount: 40,
        availableBaseAmount: 0.1204,
        deployedQuoteAmount: 10,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {
            "1": {
              buyLevelIndex: 1,
              sellLevelIndex: 2,
              lotId: "lot-1",
              openedAt: "2026-04-08T19:00:00.000Z",
            },
          },
          recenterHistory: [],
          recentExecutions: [],
        },
      },
      openLots: [
        {
          id: "lot-1",
          botId: "bot-1",
          originalBaseAmount: 0.1204,
          remainingBaseAmount: 0.1204,
          entryPrice: 83.03,
          costQuote: 10,
          openedByExecutionId: "exec-1",
          closedByExecutionId: null,
          openedAt: new Date("2026-04-08T19:00:00.000Z"),
          closedAt: null,
        },
      ],
    });

    const { engine, tradeRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 82,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol",
      },
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: TradeSide.Buy,
        levelIndex: 0,
        targetPrice: 82,
      }),
    );
  });

  it("executes an actionable crossed buy on the same tick even when confirmation is enabled", async () => {
    const aggregate = createAggregate({
      config: {
        totalBudgetUsd: 50,
        maxDeployableUsd: 40,
        reserveQuoteAmount: 10,
        lowPrice: 82,
        highPrice: 85,
        levelCount: 4,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
        priceConfirmationWindowMs: 10_000,
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 82.3,
        availableQuoteAmount: 40,
        availableBaseAmount: 0,
        deployedQuoteAmount: 0,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {},
          recenterHistory: [],
          recentExecutions: [],
        },
      },
      position: null,
      openLots: [],
    });

    const { engine, tradeRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 82,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol",
      },
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: TradeSide.Buy,
        levelIndex: 0,
        targetPrice: 82,
      }),
    );
  });

  it("blocks a live buy when the Jupiter quote is too far above the target rail", async () => {
    const aggregate = createAggregate({
      bot: {
        mode: BotMode.Live,
        executionProvider: ExecutionProvider.Jupiter
      },
      config: {
        totalBudgetUsd: 140,
        maxDeployableUsd: 140,
        reserveQuoteAmount: 0,
        lowPrice: 81,
        highPrice: 87,
        levelCount: 12,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
        maxSlippageBps: 50,
        priceConfirmationWindowMs: 10_000
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 85,
        availableQuoteAmount: 140,
        availableBaseAmount: 0,
        deployedQuoteAmount: 0,
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
    });

    const { engine, tradeRepository, executionAdapter, logRepository, botRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 84.8,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      },
      executionEstimate: {
        provider: ExecutionProvider.Jupiter,
        inputMint: "USDC",
        outputMint: "SOL",
        inputAmount: 12.73,
        expectedOutputAmount: 0.149,
        estimatedFeeAmount: 0,
        priceImpactPct: 0,
        expectedPrice: 85.45
      },
      liveTradingEnabled: true
    });

    await engine.runBot(aggregate.bot.id);

    expect(executionAdapter.prepareExecution).toHaveBeenCalledOnce();
    expect(executionAdapter.estimateExecution).not.toHaveBeenCalled();
    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
    expect(executionAdapter.executeSwap).not.toHaveBeenCalled();
    expect(executionAdapter.executePreparedSwap).not.toHaveBeenCalled();
    expect(logRepository.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: LogLevel.Warn,
        category: "execution_guard",
        message: expect.stringContaining("Quote guard blocked buy")
      })
    );
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          pendingSignal: expect.objectContaining({
            levelIndex: 7,
            side: TradeSide.Buy
          })
        })
      })
    );
  });

  it("executes a live trade with the same prepared Jupiter order that passed the quote guard", async () => {
    const aggregate = createAggregate({
      bot: {
        mode: BotMode.Live,
        executionProvider: ExecutionProvider.Jupiter
      },
      config: {
        totalBudgetUsd: 140,
        maxDeployableUsd: 140,
        reserveQuoteAmount: 0,
        lowPrice: 81,
        highPrice: 87,
        levelCount: 12,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
        maxSlippageBps: 50,
        priceConfirmationWindowMs: 10_000
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 85,
        availableQuoteAmount: 140,
        availableBaseAmount: 0,
        deployedQuoteAmount: 0,
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
    });
    const preparedEstimate: ExecutionEstimate = {
      provider: ExecutionProvider.Jupiter,
      inputMint: "USDC",
      outputMint: "SOL",
      inputAmount: 12.73,
      expectedOutputAmount: 0.15,
      estimatedFeeAmount: 0,
      priceImpactPct: 0,
      expectedPrice: 84.86,
      requestId: "prepared-order"
    };

    const { engine, tradeRepository, executionAdapter } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 84.8,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol"
      },
      executionEstimate: preparedEstimate,
      executionReport: {
        provider: ExecutionProvider.Jupiter,
        status: ExecutionStatus.Submitted,
        executionId: "prepared-order",
        txId: "tx-live",
        inputAmount: 12.73,
        outputAmount: 0.15,
        effectivePrice: 84.86,
        feeAmount: 0
      },
      liveTradingEnabled: true
    });

    await engine.runBot(aggregate.bot.id);

    expect(executionAdapter.prepareExecution).toHaveBeenCalledOnce();
    expect(executionAdapter.executePreparedSwap).toHaveBeenCalledWith(expect.any(Object), preparedEstimate);
    expect(executionAdapter.executeSwap).not.toHaveBeenCalled();
    expect(tradeRepository.createOrder).toHaveBeenCalledOnce();
  });

  it("keeps a live sell retryable when Jupiter execution is temporarily rate limited", async () => {
    const openedAt = new Date("2026-05-06T08:00:00.000Z");
    const aggregate = createAggregate({
      bot: {
        mode: BotMode.Live,
        executionProvider: ExecutionProvider.Jupiter,
      },
      config: {
        totalBudgetUsd: 150,
        maxDeployableUsd: 150,
        reserveQuoteAmount: 0,
        lowPrice: 86,
        highPrice: 87,
        levelCount: 6,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 86.8,
        availableQuoteAmount: 120,
        availableBaseAmount: 0.3457,
        deployedQuoteAmount: 30,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {
            "4": {
              buyLevelIndex: 4,
              sellLevelIndex: 5,
              lotId: "lot-1",
              openedAt: openedAt.toISOString(),
            },
          },
          recenterHistory: [],
          recentExecutions: [],
        },
      },
      openLots: [
        {
          id: "lot-1",
          botId: "bot-1",
          originalBaseAmount: 0.3457,
          remainingBaseAmount: 0.3457,
          entryPrice: 86.8,
          costQuote: 30,
          openedByExecutionId: "exec-buy-1",
          closedByExecutionId: null,
          openedAt,
          closedAt: null,
        },
      ],
    });
    const preparedEstimate: ExecutionEstimate = {
      provider: ExecutionProvider.Jupiter,
      inputMint: "SOL",
      outputMint: "USDC",
      inputAmount: 0.3457,
      expectedOutputAmount: 30.1,
      estimatedFeeAmount: 0,
      priceImpactPct: 0,
      expectedPrice: 87.05,
      requestId: "prepared-sell",
    };

    const { engine, botRepository, tradeRepository, logRepository, alert } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 88.2,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol",
      },
      executionEstimate: preparedEstimate,
      executionError: new Error('Jupiter request failed with status 429: {"message":"Too many requests"}'),
      liveTradingEnabled: true,
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.finalizeExecution).toHaveBeenCalledWith(
      "exec-row-1",
      expect.objectContaining({
        status: ExecutionStatus.Failed,
        outputAmount: 0,
      }),
      expect.objectContaining({
        message: expect.stringContaining("429"),
      }),
    );
    expect(tradeRepository.markOrderStatus).toHaveBeenCalledWith("order-1", "failed", expect.stringContaining("429"));
    expect(botRepository.updateBotStatus).not.toHaveBeenCalledWith(aggregate.bot.id, BotStatus.Error);
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        status: BotStatus.Running,
        metadata: expect.objectContaining({
          pendingSignal: expect.objectContaining({
            side: TradeSide.Sell,
            levelIndex: 5,
          }),
        }),
      }),
    );
    expect(logRepository.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: LogLevel.Warn,
        category: "execution",
        message: expect.stringContaining("Execution retry deferred"),
      }),
    );
    expect(alert.createAlert).not.toHaveBeenCalled();
  });

  it("executes an actionable crossed sell immediately even when confirmation is enabled", async () => {
    const aggregate = createAggregate({
      config: {
        totalBudgetUsd: 50,
        maxDeployableUsd: 40,
        reserveQuoteAmount: 0,
        lowPrice: 82,
        highPrice: 85,
        levelCount: 4,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
        priceConfirmationWindowMs: 10_000,
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 83.8,
        availableQuoteAmount: 30,
        availableBaseAmount: 0.1204,
        deployedQuoteAmount: 10,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {
            "1": {
              buyLevelIndex: 1,
              sellLevelIndex: 2,
              lotId: "lot-1",
              openedAt: "2026-04-08T19:00:00.000Z",
            },
          },
          recenterHistory: [],
          recentExecutions: [],
        },
      },
      position: {
        baseAmount: 0.1204,
        quoteSpent: 10,
        averageEntryPrice: 83.03,
      },
      openLots: [
        {
          id: "lot-1",
          botId: "bot-1",
          originalBaseAmount: 0.1204,
          remainingBaseAmount: 0.1204,
          entryPrice: 83.03,
          costQuote: 10,
          openedByExecutionId: "exec-1",
          closedByExecutionId: null,
          openedAt: new Date("2026-04-08T19:00:00.000Z"),
          closedAt: null,
        },
      ],
    });

    const { engine, tradeRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 84.2,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol",
      },
      executionReport: {
        provider: ExecutionProvider.Paper,
        status: ExecutionStatus.Simulated,
        executionId: "sim-sell-1",
        txId: null,
        inputAmount: 0.1204,
        outputAmount: 10.11,
        effectivePrice: 84,
        feeAmount: 0,
      },
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: TradeSide.Sell,
        levelIndex: 2,
        targetPrice: 84,
      }),
    );
  });

  it("executes an already exceeded profitable sell without a fresh crossing or cooldown wait", async () => {
    const recentExecutionAt = new Date();
    const aggregate = createAggregate({
      config: {
        totalBudgetUsd: 140,
        maxDeployableUsd: 140,
        reserveQuoteAmount: 0,
        lowPrice: 81,
        highPrice: 87,
        levelCount: 12,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
        cooldownMs: 300_000,
        priceConfirmationWindowMs: 10_000,
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 85.86,
        availableQuoteAmount: 127.27,
        availableBaseAmount: 0.15,
        deployedQuoteAmount: 12.73,
        lastExecutionAt: recentExecutionAt,
        metadata: {
          levelLocks: {
            "8": new Date(Date.now() + 60_000).toISOString(),
          },
          pendingSignal: null,
          gridCycles: {
            "7": {
              buyLevelIndex: 7,
              sellLevelIndex: 8,
              lotId: "lot-1",
              openedAt: recentExecutionAt.toISOString(),
            },
          },
          recenterHistory: [],
          recentExecutions: [recentExecutionAt.toISOString()],
        },
      },
      position: {
        baseAmount: 0.15,
        quoteSpent: 12.73,
        averageEntryPrice: 84.82,
      },
      openLots: [
        {
          id: "lot-1",
          botId: "bot-1",
          originalBaseAmount: 0.15,
          remainingBaseAmount: 0.15,
          entryPrice: 84.82,
          costQuote: 12.73,
          openedByExecutionId: "exec-1",
          closedByExecutionId: null,
          openedAt: recentExecutionAt,
          closedAt: null,
        },
      ],
    });

    const { engine, tradeRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 85.91,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol",
      },
      executionReport: {
        provider: ExecutionProvider.Paper,
        status: ExecutionStatus.Simulated,
        executionId: "sim-sell-1",
        txId: null,
        inputAmount: 0.15,
        outputAmount: 12.81,
        effectivePrice: 85.36,
        feeAmount: 0,
      },
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: TradeSide.Sell,
        levelIndex: 8,
        targetPrice: 85.36363636,
      }),
    );
  });

  it("executes an already exceeded sell by inferring the cycle from the open lot when metadata is missing", async () => {
    const recentExecutionAt = new Date();
    const aggregate = createAggregate({
      config: {
        totalBudgetUsd: 140,
        maxDeployableUsd: 140,
        reserveQuoteAmount: 0,
        lowPrice: 81,
        highPrice: 87,
        levelCount: 12,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
        cooldownMs: 300_000,
        priceConfirmationWindowMs: 10_000,
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 85.86,
        availableQuoteAmount: 127.27,
        availableBaseAmount: 0.15,
        deployedQuoteAmount: 12.73,
        lastExecutionAt: recentExecutionAt,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {},
          recenterHistory: [],
          recentExecutions: [recentExecutionAt.toISOString()],
        },
      },
      position: {
        baseAmount: 0.15,
        quoteSpent: 12.73,
        averageEntryPrice: 84.82,
      },
      openLots: [
        {
          id: "lot-1",
          botId: "bot-1",
          originalBaseAmount: 0.15,
          remainingBaseAmount: 0.15,
          entryPrice: 84.82,
          costQuote: 12.73,
          openedByExecutionId: "exec-1",
          closedByExecutionId: null,
          openedAt: recentExecutionAt,
          closedAt: null,
        },
      ],
    });

    const { engine, tradeRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 85.91,
        confidence: 0.1,
        source: "pyth",
        timestamp: new Date(),
        feedId: "feed-sol",
      },
      executionReport: {
        provider: ExecutionProvider.Paper,
        status: ExecutionStatus.Simulated,
        executionId: "sim-sell-1",
        txId: null,
        inputAmount: 0.15,
        outputAmount: 12.81,
        effectivePrice: 85.36,
        feeAmount: 0,
      },
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: TradeSide.Sell,
        levelIndex: 8,
        targetPrice: 85.36363636,
      }),
    );
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

  it("does not retrigger the same buy crossing when only the in-memory observed price changed", async () => {
    const aggregate = createAggregate({
      config: {
        totalBudgetUsd: 150,
        maxDeployableUsd: 150,
        reserveQuoteAmount: 0,
        lowPrice: 81,
        highPrice: 84,
        levelCount: 4,
        priceConfirmationWindowMs: 0
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 82.4,
        availableQuoteAmount: 150,
        availableBaseAmount: 0,
        deployedQuoteAmount: 0,
        averageEntryPrice: null,
        unrealizedPnlUsd: 0,
        totalEquityUsd: 150,
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
    });

    const botRepository = createBotRepository(aggregate);
    const tradeRepository = createTradeRepository();
    const priceSnapshotRepository: PriceSnapshotRepository & { createPriceSnapshot: ReturnType<typeof vi.fn> } = {
      createPriceSnapshot: vi.fn(async () => undefined)
    };
    const logRepository: SystemLogRepository & { writeLog: ReturnType<typeof vi.fn> } = {
      writeLog: vi.fn(async () => undefined)
    };
    const marketPriceService: MarketPricePort = {
      getLatestPrice: vi
        .fn()
        .mockResolvedValueOnce({
          symbol: "SOL",
          pair: "SOL/USDC",
          price: 81.9,
          confidence: 0.1,
          source: "pyth",
          timestamp: new Date("2026-04-09T12:00:00.000Z"),
          feedId: "feed-sol"
        })
        .mockResolvedValueOnce({
          symbol: "SOL",
          pair: "SOL/USDC",
          price: 81.85,
          confidence: 0.1,
          source: "pyth",
          timestamp: new Date("2026-04-09T12:00:01.000Z"),
          feedId: "feed-sol"
        })
    };
    const executionAdapter = {
      getQuote: vi.fn(),
      estimateExecution: vi.fn(),
      executeSwap: vi.fn(async () => ({
        provider: ExecutionProvider.Paper,
        status: ExecutionStatus.Simulated,
        executionId: "sim-1",
        txId: null,
        inputAmount: 50,
        outputAmount: 0.61,
        effectivePrice: 81.97,
        feeAmount: 0.05
      })),
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
    const engine = new BotEngineService(
      botRepository,
      tradeRepository,
      priceSnapshotRepository,
      logRepository,
      marketPriceService,
      executionService,
      new GridStrategyService(),
      new RiskManagerService(),
      alert.service
    );

    await engine.runBot(aggregate.bot.id);
    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledTimes(1);
  });
});
