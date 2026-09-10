import { describe, expect, it, vi, type Mock } from "vitest";

import type { AlertRepository, AlertSink, BotStateRepository, MarketPricePort, PendingExecutionAttempt, PriceSnapshotRepository, SystemLogRepository, TradeRepository } from "../domain/contracts";
import { AlertType, BotMode, BotStatus, ExecutionProvider, ExecutionStatus, GridType, LogLevel, OrderStatus, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
import type { BotAggregate, ExecuteSwapParams, ExecutionEstimate, ExecutionReport, MarketPrice, PositionLot } from "../domain/types";
import { AlertService } from "../services/alert-service";
import { BotEngineService } from "../services/bot-engine-service";
import { ExecutionService } from "../services/execution-service";
import { GridStrategyService } from "../services/grid-strategy-service";
import { MarketDataUnavailableError } from "../services/market-price-service";
import { RiskManagerService } from "../services/risk-manager-service";
import { PaperExecutionAdapter } from "../adapters/paper-execution-adapter";

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
      // Execution fixtures mix historic balances; drawdown behavior has dedicated RiskManager tests.
      maxDrawdownPct: 100,
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

type DurableTradeMocks = { [K in "getPendingExecution" | "prepareExecutionAttempt" | "saveExecutionResult" | "commitExecution"]-?: Mock<NonNullable<TradeRepository[K]>> };
function createTradeRepository(): TradeRepository & Record<string, ReturnType<typeof vi.fn>> & DurableTradeMocks {
  return {
    getPendingExecution: vi.fn<NonNullable<TradeRepository["getPendingExecution"]>>(async () => null),
    prepareExecutionAttempt: vi.fn<NonNullable<TradeRepository["prepareExecutionAttempt"]>>(async (input) => ({ ...input, executionId: "exec-row-1", orderId: "order-1" })),
    saveExecutionResult: vi.fn<NonNullable<TradeRepository["saveExecutionResult"]>>(async () => undefined),
    commitExecution: vi.fn<NonNullable<TradeRepository["commitExecution"]>>(async () => true),
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
  marketPriceError,
  liveTradingEnabled = false
}: {
  aggregate: BotAggregate;
  marketPrice: MarketPrice;
  executionReport?: ExecutionReport;
  executionEstimate?: ExecutionEstimate;
  executionError?: Error;
  marketPriceError?: Error;
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
    getLatestPrice: vi.fn(async () => {
      if (marketPriceError) {
        throw marketPriceError;
      }

      return marketPrice;
    })
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

  const paper = new PaperExecutionAdapter();
  const estimate = async (params: ExecuteSwapParams) => aggregate.bot.mode === BotMode.Paper && !executionEstimate && !executionReport
    ? paper.estimateExecution(params) : adapterEstimate;
  const executionAdapter = {
    getQuote: vi.fn(),
    estimateExecution: vi.fn(estimate),
    prepareExecution: vi.fn(estimate),
    executeSwap: vi.fn(async (params: ExecuteSwapParams) => aggregate.bot.mode === BotMode.Paper && !executionReport
      ? paper.executeSwap(params) : adapterReport),
    executePreparedSwap: vi.fn(async (_params?: ExecuteSwapParams, _prepared?: ExecutionEstimate, _previous?: ExecutionReport) => {
      if (executionError) {
        throw executionError;
      }
      return aggregate.bot.mode === BotMode.Paper ? executionAdapter.executeSwap(_params!) : adapterReport;
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
        source: "test-market",
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
        source: "test-market",
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

  it("keeps bots active when market data is temporarily unavailable", async () => {
    const aggregate = createAggregate();
    const { engine, botRepository, tradeRepository, logRepository, alert } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 121,
        confidence: 0.1,
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol"
      },
      marketPriceError: new MarketDataUnavailableError("Market data request failed with status 503", {
        provider: "test-market",
        status: 503,
        symbol: "SOL"
      })
    });

    await engine.runBot(aggregate.bot.id);

    expect(botRepository.updateBotStatus).not.toHaveBeenCalledWith(aggregate.bot.id, BotStatus.Error);
    expect(botRepository.createStateSnapshot).not.toHaveBeenCalled();
    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
    expect(alert.createAlert).not.toHaveBeenCalled();
    expect(logRepository.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: LogLevel.Warn,
        category: "market_data",
        message: "Market data retry deferred: Market data request failed with status 503"
      })
    );
  });

  it("restores the previous operational status after a temporary market data outage tripped error state", async () => {
    const aggregate = createAggregate({
      bot: { status: BotStatus.Error },
      latestState: {
        ...createAggregate().latestState,
        status: BotStatus.Running
      }
    });
    const { engine, botRepository, alert } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 121,
        confidence: 0.1,
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol"
      },
      marketPriceError: new MarketDataUnavailableError("Market data request failed with status 503", {
        provider: "test-market",
        status: 503,
        symbol: "SOL"
      })
    });

    await engine.runBot(aggregate.bot.id);

    expect(botRepository.updateBotStatus).toHaveBeenCalledWith(aggregate.bot.id, BotStatus.Running);
    expect(botRepository.updateBotStatus).not.toHaveBeenCalledWith(aggregate.bot.id, BotStatus.Error);
    expect(alert.createAlert).not.toHaveBeenCalled();
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
        source: "test-market",
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
        source: "test-market",
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
        source: "test-market",
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
        source: "test-market",
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
        source: "test-market",
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

  it("executes the lower boundary buy before marking the bot out_of_range below the lower bound", async () => {
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
        priceConfirmationWindowMs: 0
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
          recentExecutions: []
        }
      },
      position: null,
      openLots: []
    });

    const { engine, tradeRepository, botRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 81.5,
        confidence: 0.1,
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: TradeSide.Buy,
        levelIndex: 0,
        targetPrice: 82
      })
    );
    expect(botRepository.updateBotStatus).toHaveBeenCalledWith(aggregate.bot.id, BotStatus.Cooldown);
    expect(botRepository.updateBotStatus).not.toHaveBeenCalledWith(aggregate.bot.id, BotStatus.OutOfRange);
  });

  it("can recover an already out_of_range bot by buying the still-actionable bottom rail once", async () => {
    const aggregate = createAggregate({
      bot: {
        status: BotStatus.OutOfRange
      },
      config: {
        totalBudgetUsd: 50,
        maxDeployableUsd: 40,
        reserveQuoteAmount: 0,
        lowPrice: 82,
        highPrice: 85,
        levelCount: 4,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
        priceConfirmationWindowMs: 0
      },
      latestState: {
        ...createAggregate().latestState,
        status: BotStatus.OutOfRange,
        currentPrice: 81.7,
        availableQuoteAmount: 40,
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

    const { engine, tradeRepository, botRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 81.5,
        confidence: 0.1,
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: TradeSide.Buy,
        levelIndex: 0,
        targetPrice: 82
      })
    );
    expect(botRepository.updateBotStatus).toHaveBeenCalledWith(aggregate.bot.id, BotStatus.Cooldown);
  });

  it("executes the next actionable lower buy rail immediately when a drop crosses an already occupied level", async () => {
    const aggregate = createAggregate({
      config: {
        priceConfirmationWindowMs: 0,
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
        source: "test-market",
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

  it("defers a new crossed buy while its confirmation window is still open", async () => {
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

    const { engine, tradeRepository, botRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 82,
        confidence: 0.1,
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol",
      },
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ pendingSignal: expect.objectContaining({ side: TradeSide.Buy }) })
    }));
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
        priceConfirmationWindowMs: 0
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
        source: "test-market",
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

  it("blocks a live sell when estimated native fees make the cycle net-negative", async () => {
    const openedAt = new Date("2026-05-07T21:06:00.000Z");
    const aggregate = createAggregate({
      bot: {
        mode: BotMode.Live,
        strategyMode: StrategyMode.AccumulateUsdc,
        executionProvider: ExecutionProvider.Jupiter,
        currentPrice: 88.1
      },
      config: {
        totalBudgetUsd: 140,
        maxDeployableUsd: 140,
        reserveQuoteAmount: 0,
        lowPrice: 88,
        highPrice: 90.4,
        levelCount: 11,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
        maxSlippageBps: 50,
        priceConfirmationWindowMs: 0
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 88.1,
        availableQuoteAmount: 110,
        availableBaseAmount: 0.3408,
        deployedQuoteAmount: 30,
        averageEntryPrice: 88.02,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {
            "0": {
              buyLevelIndex: 0,
              sellLevelIndex: 1,
              lotId: "lot-tight",
              openedAt: openedAt.toISOString()
            }
          },
          recenterHistory: [],
          recentExecutions: []
        }
      },
      position: {
        baseAmount: 0.3408,
        quoteSpent: 30,
        averageEntryPrice: 88.02,
        realizedPnlUsd: 1.13,
        unrealizedPnlUsd: 0.08,
        totalFeesQuote: 0
      },
      openLots: [
        {
          id: "lot-tight",
          botId: "bot-1",
          originalBaseAmount: 0.3408,
          remainingBaseAmount: 0.3408,
          entryPrice: 88.02,
          costQuote: 30,
          openedByExecutionId: "exec-buy-tight",
          closedByExecutionId: null,
          openedAt,
          closedAt: null
        }
      ]
    });

    const { engine, tradeRepository, executionAdapter, logRepository, botRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 88.25,
        confidence: 0.1,
        source: "test-market",
        timestamp: new Date("2026-05-07T23:06:00.000Z"),
        feedId: "feed-sol"
      },
      executionEstimate: {
        provider: ExecutionProvider.Jupiter,
        inputMint: "SOL",
        outputMint: "USDC",
        inputAmount: 0.3408,
        expectedOutputAmount: 30.08,
        estimatedFeeAmount: 0,
        nativeFeeAmount: 0.00205,
        nativeFeeSymbol: "SOL",
        priceImpactPct: 0,
        expectedPrice: 88.25,
        requestId: "prepared-tight-sell"
      },
      liveTradingEnabled: true
    });

    await engine.runBot(aggregate.bot.id);

    expect(executionAdapter.prepareExecution).toHaveBeenCalledOnce();
    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
    expect(executionAdapter.executeSwap).not.toHaveBeenCalled();
    expect(executionAdapter.executePreparedSwap).not.toHaveBeenCalled();
    expect(logRepository.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: LogLevel.Warn,
        category: "execution_guard",
        message: expect.stringContaining("expected net output")
      })
    );
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          pendingSignal: expect.objectContaining({
            levelIndex: 1,
            side: TradeSide.Sell
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
        priceConfirmationWindowMs: 0
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
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol"
      },
      executionEstimate: preparedEstimate,
      executionReport: {
        provider: ExecutionProvider.Jupiter,
        status: ExecutionStatus.Filled,
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
    expect(executionAdapter.executePreparedSwap).toHaveBeenCalledWith(expect.any(Object), preparedEstimate, undefined);
    expect(executionAdapter.executeSwap).not.toHaveBeenCalled();
    expect(tradeRepository.prepareExecutionAttempt).toHaveBeenCalledOnce();
    expect(tradeRepository.commitExecution).toHaveBeenCalledOnce();
    expect(tradeRepository.saveExecutionResult.mock.invocationCallOrder[0]).toBeLessThan(executionAdapter.executePreparedSwap.mock.invocationCallOrder[0]!);
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
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol",
      },
      executionEstimate: preparedEstimate,
      executionError: new Error('Jupiter request failed with status 429: {"message":"Too many requests"}'),
      liveTradingEnabled: true,
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.finalizeExecution).not.toHaveBeenCalled();
    expect(tradeRepository.markOrderStatus).not.toHaveBeenCalledWith("order-1", "failed", expect.any(String));
    expect(botRepository.updateBotStatus).not.toHaveBeenCalledWith(aggregate.bot.id, BotStatus.Error);
    expect(tradeRepository.saveExecutionResult).toHaveBeenLastCalledWith(
      expect.any(Object), expect.objectContaining({ status: ExecutionStatus.Unknown }), true
    );
    expect(tradeRepository.commitExecution).not.toHaveBeenCalled();
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
        source: "test-market",
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
        source: "test-market",
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
        source: "test-market",
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

  it.each([false, true])("catches up exceeded sells with distinct order keys (shared exit rail: %s)", async (sharedExit) => {
    const openedAt = new Date("2026-04-17T10:00:00.000Z");
    const aggregate = createAggregate({
      bot: {
        strategyMode: StrategyMode.AccumulateUsdc,
      },
      config: {
        totalBudgetUsd: 50,
        maxDeployableUsd: 40,
        reserveQuoteAmount: 0,
        lowPrice: 80,
        highPrice: 90,
        levelCount: 6,
        gridType: GridType.Arithmetic,
        minOrderQuoteAmount: 10,
        cooldownMs: 300_000,
        priceConfirmationWindowMs: 10_000,
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: sharedExit ? 87.5 : 83.5,
        availableQuoteAmount: 20,
        availableBaseAmount: 0.240998,
        deployedQuoteAmount: 20,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {
            "1": {
              buyLevelIndex: 1,
              sellLevelIndex: 2,
              lotId: "lot-1",
              openedAt: openedAt.toISOString(),
            },
            "2": {
              buyLevelIndex: 2,
              sellLevelIndex: sharedExit ? 2 : 3,
              lotId: "lot-2",
              openedAt: openedAt.toISOString(),
            },
          },
          recenterHistory: [],
          recentExecutions: [],
        },
      },
      position: {
        baseAmount: 0.240998,
        quoteSpent: 20,
        averageEntryPrice: 82.99,
      },
      openLots: [
        {
          id: "lot-1",
          botId: "bot-1",
          originalBaseAmount: 0.121951,
          remainingBaseAmount: 0.121951,
          entryPrice: 82,
          costQuote: 10,
          openedByExecutionId: "exec-1",
          closedByExecutionId: null,
          openedAt,
          closedAt: null,
        },
        {
          id: "lot-2",
          botId: "bot-1",
          originalBaseAmount: 0.119047,
          remainingBaseAmount: 0.119047,
          entryPrice: 84,
          costQuote: 10,
          openedByExecutionId: "exec-2",
          closedByExecutionId: null,
          openedAt,
          closedAt: null,
        },
      ],
    });
    let currentAggregate = aggregate;
    let executionCount = 0;

    const { engine, tradeRepository, botRepository, executionAdapter } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 87.5,
        confidence: 0.1,
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol",
      },
    });

    vi.mocked(botRepository.getBotAggregate).mockImplementation(async () => currentAggregate);
    botRepository.updateBotStatus.mockImplementation(async (_botId: string, status: BotStatus) => {
      currentAggregate = {
        ...currentAggregate,
        bot: {
          ...currentAggregate.bot,
          status,
        },
      };
    });
    botRepository.createStateSnapshot.mockImplementation(async (snapshot) => {
      currentAggregate = {
        ...currentAggregate,
        bot: {
          ...currentAggregate.bot,
          status: snapshot.status,
        },
        latestState: {
          id: `snapshot-${executionCount}`,
          ...snapshot,
        },
      };
    });
    vi.mocked(tradeRepository.replaceLots).mockImplementation(async (_botId: string, lots: PositionLot[]) => {
      currentAggregate = {
        ...currentAggregate,
        openLots: lots,
      };
    });
    executionAdapter.executeSwap.mockImplementation(async (params) => {
      executionCount += 1;
      const amount = typeof params === "object" && params && "amount" in params ? Number(params.amount) : 0;
      return {
        provider: ExecutionProvider.Paper,
        status: ExecutionStatus.Simulated,
        executionId: `sim-sell-${executionCount}`,
        txId: null,
        inputAmount: amount,
        outputAmount: Number((amount * 87.5).toFixed(8)),
        effectivePrice: 87.5,
        feeAmount: 0,
      };
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledTimes(2);
    expect(tradeRepository.createOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        side: TradeSide.Sell,
        levelIndex: 2,
      }),
    );
    expect(tradeRepository.createOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        side: TradeSide.Sell,
        levelIndex: sharedExit ? 2 : 3,
      }),
    );
    expect(executionAdapter.executeSwap).toHaveBeenCalledTimes(2);
    const keys = vi.mocked(tradeRepository.createOrder).mock.calls.map(([order]) => order.orderKey);
    expect(new Set(keys).size).toBe(2);
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
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol"
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.createOrder).toHaveBeenCalledOnce();
    expect(tradeRepository.createExecution).toHaveBeenCalledOnce();
    expect(executionAdapter.executeSwap).toHaveBeenCalledOnce();
    expect(executionAdapter.executeSwap).toHaveBeenCalledWith(expect.objectContaining({ referencePrice: 118 }));
    expect(tradeRepository.markOrderStatus).toHaveBeenCalledWith("order-1", "simulated");
    expect(tradeRepository.replaceLots).toHaveBeenCalledWith(
      aggregate.bot.id,
      expect.arrayContaining([
        expect.objectContaining<Partial<PositionLot>>({
          botId: aggregate.bot.id,
          remainingBaseAmount: Number((250 / 118 * 0.995).toFixed(8))
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
        source: "test-market",
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
        source: "test-market",
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

  it("closes the sold lot for token accumulation instead of leaving retained base sellable", async () => {
    const aggregate = createAggregate({
      bot: {
        strategyMode: StrategyMode.AccumulateBase
      },
      config: {
        reserveQuoteAmount: 0,
        priceConfirmationWindowMs: 0
      },
      latestState: {
        ...createAggregate().latestState,
        currentPrice: 135,
        availableQuoteAmount: 1500,
        availableBaseAmount: 1,
        deployedQuoteAmount: 120,
        averageEntryPrice: 120,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 15,
        totalEquityUsd: 1635,
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          gridCycles: {
            "3": {
              buyLevelIndex: 3,
              sellLevelIndex: 4,
              lotId: "lot-token-profit",
              openedAt: "2026-04-01T00:00:00.000Z"
            }
          },
          recenterHistory: [],
          recentExecutions: []
        }
      },
      openLots: [
        {
          id: "lot-token-profit",
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

    const { engine, botRepository, tradeRepository } = createEngine({
      aggregate,
      marketPrice: {
        symbol: "SOL",
        pair: "SOL/USDC",
        price: 141,
        confidence: 0.1,
        source: "test-market",
        timestamp: new Date(),
        feedId: "feed-sol"
      },
      executionReport: {
        provider: ExecutionProvider.Paper,
        status: ExecutionStatus.Simulated,
        executionId: "sim-sell-token-profit",
        txId: null,
        inputAmount: 0.85106383,
        outputAmount: 120.5,
        effectivePrice: 141.586777,
        feeAmount: 0
      },
      executionEstimate: {
        provider: ExecutionProvider.Paper,
        inputMint: "SOL",
        outputMint: "USDC",
        inputAmount: 0.85106383,
        expectedOutputAmount: 120.5,
        expectedPrice: 141.586777,
        estimatedFeeAmount: 0,
        priceImpactPct: 0
      }
    });

    await engine.runBot(aggregate.bot.id);

    expect(tradeRepository.replaceLots).toHaveBeenCalledWith("bot-1", [expect.objectContaining({ kind: "retained", remainingBaseAmount: 0.14893617, costQuote: 0 })]);
    expect(botRepository.createStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        availableBaseAmount: 0.14893617,
        deployedQuoteAmount: 0,
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
        source: "test-market",
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
          source: "test-market",
          timestamp: new Date("2026-04-09T12:00:00.000Z"),
          feedId: "feed-sol"
        })
        .mockResolvedValueOnce({
          symbol: "SOL",
          pair: "SOL/USDC",
          price: 81.85,
          confidence: 0.1,
          source: "test-market",
          timestamp: new Date("2026-04-09T12:00:01.000Z"),
          feedId: "feed-sol"
        })
    };
    const executionAdapter = {
      getQuote: vi.fn(),
      estimateExecution: vi.fn(async () => ({ provider: ExecutionProvider.Paper, inputMint: "USDC", outputMint: "SOL",
        inputAmount: 50, expectedOutputAmount: 0.61, estimatedFeeAmount: 0.05, expectedPrice: 50 / 0.61, priceImpactPct: 0 })),
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


describe("paper execution cost guards", () => {
  it.each(["reserve", "deployment"])("blocks a paper buy whose principal fits but fees exceed %s", async (limit) => {
    const aggregate = createAggregate({
      config: { totalBudgetUsd: 1000, maxDeployableUsd: limit === "reserve" ? 300 : 250,
        reserveQuoteAmount: limit === "reserve" ? 500 : 0, minOrderQuoteAmount: 50 },
      latestState: { availableQuoteAmount: limit === "reserve" ? 550 : 1000,
        deployedQuoteAmount: limit === "reserve" ? 0 : 200, availableBaseAmount: 0,
        currentPrice: 121, totalEquityUsd: 1000, metadata: { levelLocks: {}, recenterHistory: [], recentExecutions: [],
          pendingSignal: { levelIndex: 2, side: TradeSide.Buy,
            firstObservedAt: new Date(Date.now() - 20_000).toISOString(), lastObservedPrice: 118 } } }
    });
    const { engine, tradeRepository, logRepository, executionAdapter } = createEngine({ aggregate,
      marketPrice: { symbol: "SOL", pair: "SOL/USDC", price: 118, confidence: 0,
        source: "test", timestamp: new Date(), feedId: "test" } });
    await engine.runBot(aggregate.bot.id);
    expect(executionAdapter.prepareExecution).toHaveBeenCalled();
    expect(tradeRepository.createOrder).not.toHaveBeenCalled();
    expect(executionAdapter.executeSwap).not.toHaveBeenCalled();
    expect(logRepository.writeLog).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("input and fees exceed") }));
  });
});

function pendingBuy(): PendingExecutionAttempt {
  return { botId: "bot-1", orderId: "order-durable", executionId: "execution-durable",
    signal: { side: TradeSide.Buy, levelIndex: 0, levelPrice: 100, observedPrice: 100,
      triggeredAt: new Date("2026-09-10T10:00:00Z"), idempotencyKey: "durable-buy" },
    orderIntent: { botId: "bot-1", orderKey: "durable-buy", side: TradeSide.Buy, levelIndex: 0,
      targetPrice: 100, requestedBaseAmount: 0, requestedQuoteAmount: 10, status: OrderStatus.Created, reason: "test" },
    executionParams: { botId: "bot-1", inputMint: "USDC", outputMint: "SOL", amount: 10,
      inputDecimals: 6, outputDecimals: 9, slippageBps: 50, tradeSide: TradeSide.Buy,
      clientOrderId: "durable-buy", referencePrice: 100 },
    preparedExecution: { provider: ExecutionProvider.Jupiter, inputMint: "USDC", outputMint: "SOL",
      inputAmount: 10, expectedOutputAmount: 0.1, expectedPrice: 100, estimatedFeeAmount: 0,
      priceImpactPct: 0, requestId: "immutable-order", rawQuote: { signedTransaction: "same-signed-bytes", txId: "tx-durable" } }
  };
}
const durableFill: ExecutionReport = { provider: ExecutionProvider.Jupiter, status: ExecutionStatus.Filled,
  executionId: "immutable-order", txId: "tx-durable", inputAmount: 10, outputAmount: 0.1,
  effectivePrice: 100, feeAmount: 0 };
function durableHarness(aggregate = createAggregate({ bot: { mode: BotMode.Live, executionProvider: ExecutionProvider.Jupiter },
  latestState: { availableBaseAmount: 0, availableQuoteAmount: 2000, deployedQuoteAmount: 0 }, openLots: [] })) {
  return createEngine({ aggregate, marketPrice: { symbol: "SOL", pair: "SOL/USDC", price: 100,
    confidence: 0, source: "test", timestamp: new Date(), feedId: "test" },
    marketPriceError: new Error("Market data is down"), executionReport: durableFill, liveTradingEnabled: true });
}

describe("durable execution recovery", () => {
  it("does no market lookup or new order when recovery polling races with an already resolved attempt", async () => {
    const harness = durableHarness();
    harness.tradeRepository.getPendingExecution.mockResolvedValue(null);
    await harness.engine.runBot("bot-1", { recoveryOnly: true });
    expect(harness.executionAdapter.prepareExecution).not.toHaveBeenCalled();
    expect(harness.tradeRepository.createOrder).not.toHaveBeenCalled();
    expect(harness.tradeRepository.prepareExecutionAttempt).not.toHaveBeenCalled();
    // The harness market provider throws: an attempted market lookup would report an engine error.
    expect(harness.logRepository.writeLog).not.toHaveBeenCalled();
  });
  it("preserves a saved Success through the uncertainty marker and bypasses the failure-only RPC check", async () => {
    const harness = durableHarness();
    const executeResponse = { status: "Success", code: 0, signature: "tx-durable", totalInputAmount: "10000000", totalOutputAmount: "100000000" };
    harness.tradeRepository.getPendingExecution.mockResolvedValue({ ...pendingBuy(), wasUncertain: true,
      result: { ...durableFill, status: ExecutionStatus.Unknown, rawReport: { executeResponse } } });
    await harness.engine.runBot("bot-1");
    expect(harness.executionAdapter.getExecutionReport).not.toHaveBeenCalled();
    expect(harness.tradeRepository.saveExecutionResult.mock.calls[0]?.[1].rawReport).toEqual(expect.objectContaining({ executeResponse }));
    expect(harness.executionAdapter.executePreparedSwap.mock.calls[0]?.[2]?.rawReport).toEqual({ executeResponse });
    expect(harness.tradeRepository.commitExecution).toHaveBeenCalledOnce();
  });
  it("resumes identical signed bytes after restart without preparing a new order, even with price feed down", async () => {
    let stored: PendingExecutionAttempt | null = pendingBuy();
    const first = durableHarness();
    first.tradeRepository.getPendingExecution.mockImplementation(async () => stored);
    first.tradeRepository.saveExecutionResult.mockImplementation(async (attempt, result, uncertain) => {
      stored = { ...attempt, result, wasUncertain: uncertain };
    });
    first.executionAdapter.executePreparedSwap.mockRejectedValueOnce(new Error("response lost"));
    await first.engine.runBot("bot-1");
    expect(stored?.result?.status).toBe(ExecutionStatus.Unknown);
    expect(first.tradeRepository.commitExecution).not.toHaveBeenCalled();
    const restarted = durableHarness();
    restarted.tradeRepository.getPendingExecution.mockImplementation(async () => stored);
    restarted.tradeRepository.saveExecutionResult.mockImplementation(first.tradeRepository.saveExecutionResult.getMockImplementation()!);
    restarted.tradeRepository.commitExecution.mockImplementation(async () => { stored = null; return true; });
    await restarted.engine.runBot("bot-1");
    expect(restarted.executionAdapter.prepareExecution).not.toHaveBeenCalled();
    expect(restarted.executionAdapter.executePreparedSwap.mock.calls[0]?.[1]).toEqual(pendingBuy().preparedExecution);
    expect(restarted.tradeRepository.commitExecution).toHaveBeenCalledOnce();
    expect(restarted.tradeRepository.commitExecution.mock.calls[0]?.[0].snapshot.availableBaseAmount).toBe(0.1);
    expect(stored).toBeNull();
  });

  it("does not release an uncertain attempt when an API later returns Failed without chain proof", async () => {
    const harness = durableHarness();
    harness.tradeRepository.getPendingExecution.mockResolvedValue({ ...pendingBuy(), wasUncertain: true });
    harness.executionAdapter.executePreparedSwap.mockResolvedValue({ ...durableFill, status: ExecutionStatus.Failed });
    await harness.engine.runBot("bot-1");
    expect(harness.tradeRepository.commitExecution).not.toHaveBeenCalled();
    expect(harness.tradeRepository.saveExecutionResult).toHaveBeenLastCalledWith(expect.any(Object),
      expect.objectContaining({ status: ExecutionStatus.Unknown, inputAmount: 0 }), true);
  });

  it("does not send when the durable uncertainty marker cannot be saved", async () => {
    const harness = durableHarness();
    harness.tradeRepository.getPendingExecution.mockResolvedValue(pendingBuy());
    harness.tradeRepository.saveExecutionResult.mockRejectedValue(new Error("database unavailable"));
    await harness.engine.runBot("bot-1");
    expect(harness.executionAdapter.executePreparedSwap).not.toHaveBeenCalled();
  });

  it("retries only accounting after a confirmed fill and a commit interruption", async () => {
    let stored: PendingExecutionAttempt = pendingBuy();
    const first = durableHarness();
    first.tradeRepository.getPendingExecution.mockImplementation(async () => stored);
    first.tradeRepository.saveExecutionResult.mockImplementation(async (attempt, result, uncertain) => {
      stored = { ...attempt, result, wasUncertain: uncertain };
    });
    first.tradeRepository.commitExecution.mockRejectedValueOnce(new Error("commit rolled back"));
    await first.engine.runBot("bot-1");
    expect(stored.result?.status).toBe(ExecutionStatus.Filled);
    const second = durableHarness();
    second.tradeRepository.getPendingExecution.mockResolvedValue(stored);
    await second.engine.runBot("bot-1");
    expect(second.executionAdapter.executePreparedSwap).not.toHaveBeenCalled();
    expect(second.tradeRepository.commitExecution).toHaveBeenCalledOnce();
  });

  it("records a chain-proven failed attempt once, increments failures and preserves a user pause", async () => {
    const aggregate = createAggregate({ bot: { mode: BotMode.Live, status: BotStatus.Paused, executionProvider: ExecutionProvider.Jupiter } });
    const harness = durableHarness(aggregate);
    harness.tradeRepository.getPendingExecution.mockResolvedValue({ ...pendingBuy(), wasUncertain: true,
      result: { ...durableFill, status: ExecutionStatus.Unknown } });
    harness.executionAdapter.getExecutionReport.mockResolvedValue({ ...durableFill, status: ExecutionStatus.Failed,
      inputAmount: 0, outputAmount: 0, rawReport: { rpcStatus: { err: "rejected" } } });
    await harness.engine.runBot("bot-1");
    expect(harness.executionAdapter.executePreparedSwap).not.toHaveBeenCalled();
    expect(harness.tradeRepository.commitExecution).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ status: BotStatus.Paused, consecutiveFailures: 1 }) }));
  });

  it("accounts actual native gas as an attributed expense without inventing a USDC debit", async () => {
    const harness = durableHarness();
    harness.tradeRepository.getPendingExecution.mockResolvedValue({ ...pendingBuy(), result: {
      ...durableFill, nativeFeeSymbol: "SOL", nativeFeeAmount: 0.001 } });
    await harness.engine.runBot("bot-1");
    const snapshot = harness.tradeRepository.commitExecution.mock.calls[0]![0].snapshot;
    expect(snapshot.availableQuoteAmount).toBe(1990);
    expect(snapshot.availableBaseAmount).toBe(0.1);
    // Recovery uses the last known mark 120; gas is paid from the wallet reserve outside the bot's swap balances.
    expect(snapshot.metadata.externalNativeFeesQuote).toBe(0.12);
    expect(snapshot.totalEquityUsd).toBe(2001.88);
  });
});

describe("persisted auto-recenter", () => {
  const price: MarketPrice = { symbol: "SOL", pair: "SOL/USDC", price: 180, source: "test", confidence: 0, timestamp: new Date(), feedId: "test" };
  it("requires a distinct source observation for live recenter even after the time window", async () => {
    const firstSource = new Date(Date.now() - 60_000);
    const aggregate = createAggregate({ bot: { mode: BotMode.Live, executionProvider: ExecutionProvider.Jupiter },
      config: { recenterMode: RecenterMode.Auto }, latestState: {
        metadata: { levelLocks: {}, recentExecutions: [], recenterHistory: [], outsideSide: "above",
          outsideSince: firstSource.toISOString(), outsideSourceObservedAt: firstSource.toISOString() } }, openLots: [] });
    const first = createEngine({ aggregate, marketPrice: { ...price, sourceObservedAt: firstSource }, liveTradingEnabled: true });
    first.botRepository.updateRange = vi.fn(async () => undefined);
    await first.engine.runBot("bot-1");
    expect(first.botRepository.updateRange).not.toHaveBeenCalled();
    const advanced = createEngine({ aggregate, marketPrice: { ...price, sourceObservedAt: new Date() }, liveTradingEnabled: true });
    advanced.botRepository.updateRange = vi.fn(async () => undefined);
    await advanced.engine.runBot("bot-1");
    expect(advanced.botRepository.updateRange).toHaveBeenCalledOnce();
  });
  it("saves real bounds and cleared grid state before reporting success", async () => {
    const aggregate = createAggregate({ config: { recenterMode: RecenterMode.Auto }, latestState: {
      metadata: { levelLocks: {}, recentExecutions: [], recenterHistory: [], outsideSide: "above",
        outsideSince: new Date(Date.now() - 60_000).toISOString() } }, openLots: [] });
    const harness = createEngine({ aggregate, marketPrice: price });
    const updateRange = vi.fn(async () => undefined);
    harness.botRepository.updateRange = updateRange;
    await harness.engine.runBot("bot-1");
    expect(updateRange).toHaveBeenCalledWith("bot-1", { lowPrice: 141, highPrice: 201 }, expect.objectContaining({
      status: BotStatus.Running, metadata: expect.objectContaining({ outsideSince: null, gridCycles: {} }) }));
    expect(harness.alert.createAlert).toHaveBeenCalledWith(expect.objectContaining({ type: AlertType.RecenterPerformed }));
    expect(updateRange.mock.invocationCallOrder[0]).toBeLessThan(harness.alert.createAlert.mock.invocationCallOrder[0]!);
  });
  it("does not announce a recenter when atomic persistence fails", async () => {
    const aggregate = createAggregate({ config: { recenterMode: RecenterMode.Auto }, latestState: {
      metadata: { levelLocks: {}, recentExecutions: [], recenterHistory: [], outsideSide: "above",
        outsideSince: new Date(Date.now() - 60_000).toISOString() } }, openLots: [] });
    const harness = createEngine({ aggregate, marketPrice: price });
    harness.botRepository.updateRange = vi.fn(async () => { throw new Error("rollback"); });
    await harness.engine.runBot("bot-1");
    expect(harness.alert.createAlert).not.toHaveBeenCalledWith(expect.objectContaining({ type: AlertType.RecenterPerformed }));
  });
  it("keeps existing rails while an unsold trading lot still exists", async () => {
    const aggregate = createAggregate({ config: { recenterMode: RecenterMode.Auto }, latestState: {
      metadata: { levelLocks: {}, recentExecutions: [], recenterHistory: [], outsideSide: "below",
        outsideSince: new Date(Date.now() - 60_000).toISOString() } }, openLots: [{ id: "held", botId: "bot-1",
        originalBaseAmount: 1, remainingBaseAmount: 1, costQuote: 120, entryPrice: 120, openedByExecutionId: "past",
        openedAt: new Date(), closedAt: null, closedByExecutionId: null }] });
    const harness = createEngine({ aggregate, marketPrice: { ...price, price: 80 } });
    const updateRange = vi.fn(async () => undefined); harness.botRepository.updateRange = updateRange;
    await harness.engine.runBot("bot-1");
    expect(updateRange).not.toHaveBeenCalled();
    expect(harness.tradeRepository.createOrder).not.toHaveBeenCalled();
    expect(harness.botRepository.createStateSnapshot).toHaveBeenCalledWith(expect.objectContaining({ status: BotStatus.OutOfRange }));
  });
});
