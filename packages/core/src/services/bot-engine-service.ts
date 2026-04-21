import {
  AlertType,
  BotMode,
  BotStatus,
  ExecutionProvider,
  ExecutionStatus,
  LogLevel,
  OrderStatus,
  RecenterMode,
  TradeSide
} from "../domain/enums";
import type {
  AlertRepository,
  BotStateRepository,
  MarketPricePort,
  PriceSnapshotRepository,
  SystemLogRepository,
  TradeRepository
} from "../domain/contracts";
import type {
  BotAggregate,
  BotRuntimeMetadata,
  ExecuteSwapParams,
  ExecutionEstimate,
  GridCycle,
  MarketPrice,
  OrderIntent,
  PositionLot,
  TriggerSignal
} from "../domain/types";
import { AlertService } from "./alert-service";
import { ExecutionService } from "./execution-service";
import { GridDecisionService } from "./grid-decision-service";
import { GridStrategyService } from "./grid-strategy-service";
import { shouldPersistPassivePriceSnapshot, shouldPersistPassiveState } from "./passive-runtime-throttle";
import { RiskManagerService } from "./risk-manager-service";
import { round } from "../utils/math";

const HEARTBEAT_UPDATE_INTERVAL_MS = 2_000;
const QUOTE_GUARD_LOG_INTERVAL_MS = 60_000;

export class BotEngineService {
  private readonly passivePriceSnapshotWriteAt = new Map<string, number>();
  private readonly lastObservedPriceByBotId = new Map<string, number>();
  private readonly lastHeartbeatWriteAt = new Map<string, number>();
  private readonly quoteGuardLogWriteAt = new Map<string, number>();
  private readonly gridDecisionService = new GridDecisionService();

  constructor(
    private readonly botRepository: BotStateRepository,
    private readonly tradeRepository: TradeRepository,
    private readonly priceSnapshotRepository: PriceSnapshotRepository,
    private readonly logRepository: SystemLogRepository,
    private readonly marketPriceService: MarketPricePort,
    private readonly executionService: ExecutionService,
    private readonly gridStrategyService: GridStrategyService,
    private readonly riskManagerService: RiskManagerService,
    private readonly alertService: AlertService
  ) {}

  async runCycle(): Promise<void> {
    const bots = await this.botRepository.listRunnableBots();
    await Promise.all(bots.map((aggregate) => this.runBot(aggregate.bot.id)));
  }

  async runBotsForSymbol(symbol: string): Promise<void> {
    const normalizedSymbol = symbol.toUpperCase();
    const bots = await this.botRepository.listRunnableBots();
    await Promise.all(
      bots
        .filter((aggregate) => aggregate.bot.baseSymbol.toUpperCase() === normalizedSymbol)
        .map((aggregate) => this.runBot(aggregate.bot.id))
    );
  }

  async runBot(botId: string, options?: { skipLock?: boolean }): Promise<void> {
    const execute = async () => {
      const aggregate = await this.botRepository.getBotAggregate(botId);
      if (!aggregate) {
        return;
      }

      const now = new Date();

      try {
        const marketPrice = await this.marketPriceService.getLatestPrice(aggregate.bot);
        const previousObservedPrice =
          this.lastObservedPriceByBotId.get(botId) ?? aggregate.latestState?.currentPrice ?? null;
        this.lastObservedPriceByBotId.set(botId, marketPrice.price);
        await this.maybeSetBotHeartbeat(botId, marketPrice.price, now);
        const levels = this.gridStrategyService.calculateLevels(
          aggregate.config.lowPrice,
          aggregate.config.highPrice,
          aggregate.config.levelCount,
          aggregate.config.gridType
        );
        const crossedSignals = previousObservedPrice !== null
          ? this.gridStrategyService.detectCrossedLevels(levels, previousObservedPrice, marketPrice.price)
          : [];

        if (aggregate.bot.status === BotStatus.Error) {
          await this.botRepository.updateBotStatus(botId, BotStatus.Running);
          await this.logRepository.writeLog({
            botId,
            level: LogLevel.Info,
            category: "engine",
            message: "Recovered after successful market data fetch."
          });
        }

        if (aggregate.bot.status === BotStatus.Paused || aggregate.bot.status === BotStatus.Stopped) {
          await this.persistPassivePriceSnapshot(aggregate, marketPrice, now);
          await this.persistPassiveState(aggregate, marketPrice.price, now);
          return;
        }

        if (this.isOutOfRange(aggregate, marketPrice.price)) {
          const upperBoundarySellSignal =
            marketPrice.price > aggregate.config.highPrice
              ? this.getOutOfRangeRecoverySellSignal(aggregate, marketPrice.price, now, levels, crossedSignals)
              : null;

          if (upperBoundarySellSignal?.side === TradeSide.Sell) {
            const handledUpperBoundarySell = await this.executeConfirmedSignal(
              aggregate,
              upperBoundarySellSignal,
              marketPrice,
              now,
              levels,
              crossedSignals
            );
            if (handledUpperBoundarySell) {
              return;
            }
          }

          await this.persistPriceSnapshot(botId, marketPrice, now);
          await this.handleOutOfRange(aggregate, marketPrice.price, now);
          return;
        }

        const signal = this.getConfirmedSignalFromState(aggregate, marketPrice.price, now, levels, crossedSignals);
        if (!signal) {
          await this.persistPassivePriceSnapshot(aggregate, marketPrice, now);
          await this.persistPassiveState(aggregate, marketPrice.price, now, {}, undefined, undefined, levels, crossedSignals);
          return;
        }

        const handledSignal = await this.executeConfirmedSignal(aggregate, signal, marketPrice, now, levels, crossedSignals);
        if (!handledSignal) {
          await this.persistPassivePriceSnapshot(aggregate, marketPrice, now);
          await this.persistPassiveState(aggregate, marketPrice.price, now, { pendingSignal: null }, undefined, undefined, levels, crossedSignals);
          return;
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown bot engine error";
        await this.logRepository.writeLog({
          botId,
          level: LogLevel.Error,
          category: "engine",
          message
        });
        await this.botRepository.updateBotStatus(botId, BotStatus.Error);
        await this.alertService.emit({
          botId,
          type: AlertType.InfrastructureDegraded,
          severity: "critical",
          title: "Bot engine error",
          message
        });
      }
    };

    if (options?.skipLock) {
      await execute();
      return;
    }

    await this.botRepository.withBotLock(botId, execute);
  }

  private async persistPriceSnapshot(
    botId: string,
    marketPrice: {
      pair: string;
      source: string;
      price: number;
      confidence: number;
      feedId: string;
    },
    capturedAt: Date
  ) {
    await this.priceSnapshotRepository.createPriceSnapshot({
      botId,
      symbol: marketPrice.pair,
      source: marketPrice.source,
      price: marketPrice.price,
      confidence: marketPrice.confidence,
      feedId: marketPrice.feedId,
      status: "ok",
      capturedAt
    });
    this.passivePriceSnapshotWriteAt.set(botId, capturedAt.getTime());
  }

  private async maybeSetBotHeartbeat(botId: string, currentPrice: number | null, now: Date) {
    const lastUpdatedAt = this.lastHeartbeatWriteAt.get(botId);
    if (lastUpdatedAt && now.getTime() - lastUpdatedAt < HEARTBEAT_UPDATE_INTERVAL_MS) {
      return;
    }

    await this.botRepository.setBotHeartbeat(botId, currentPrice);
    this.lastHeartbeatWriteAt.set(botId, now.getTime());
  }

  private async persistPassivePriceSnapshot(
    aggregate: BotAggregate,
    marketPrice: {
      pair: string;
      source: string;
      price: number;
      confidence: number;
      feedId: string;
    },
    capturedAt: Date
  ) {
    const lastPersistedAtMs = this.passivePriceSnapshotWriteAt.get(aggregate.bot.id);
    const lastPersistedAt = lastPersistedAtMs
      ? new Date(lastPersistedAtMs)
      : aggregate.latestState?.lastProcessedAt ?? null;

    if (!shouldPersistPassivePriceSnapshot({ lastPersistedAt, now: capturedAt })) {
      return;
    }

    await this.persistPriceSnapshot(aggregate.bot.id, marketPrice, capturedAt);
  }

  private isOutOfRange(aggregate: BotAggregate, price: number): boolean {
    return this.gridDecisionService.isOutOfRange(aggregate.config.lowPrice, aggregate.config.highPrice, price);
  }

  private async executeConfirmedSignal(
    aggregate: BotAggregate,
    signal: TriggerSignal,
    marketPrice: MarketPrice,
    now: Date,
    levels: Array<{ index: number; price: number }>,
    crossedSignals: TriggerSignal[]
  ): Promise<boolean> {
    const botId = aggregate.bot.id;
    const orderIntent = this.gridStrategyService.buildOrderIntent(aggregate, signal);
    if (!orderIntent) {
      return false;
    }

    const risk = this.riskManagerService.evaluate(aggregate, signal, orderIntent, marketPrice, now);
    if (!risk.allowed) {
      await this.persistPriceSnapshot(botId, marketPrice, now);
      const blockedOrder = await this.tradeRepository.createOrder({
        ...orderIntent,
        status: OrderStatus.Blocked
      });
      await this.tradeRepository.markOrderStatus(blockedOrder.id, OrderStatus.Blocked, risk.reasons.join(", "));
      if (risk.nextStatus) {
        await this.botRepository.updateBotStatus(botId, risk.nextStatus);
      }
      if (risk.alertType) {
        await this.alertService.emit({
          botId,
          type: risk.alertType,
          severity: "warning",
          title: "Risk rule triggered",
          message: risk.reasons.join(", ")
        });
      }
      await this.persistPassiveState(aggregate, marketPrice.price, now, { pendingSignal: null }, undefined, undefined, levels, crossedSignals);
      return true;
    }

    const executionParams = this.buildExecutionParams(aggregate, signal, orderIntent);
    const quoteGuard = await this.validateExecutionQuote(aggregate, signal, orderIntent, executionParams, now);
    if (!quoteGuard.allowed) {
      await this.maybeWriteQuoteGuardLog(botId, now, quoteGuard.message, quoteGuard.metadata);
      await this.persistPassivePriceSnapshot(aggregate, marketPrice, now);
      await this.persistPassiveState(
        aggregate,
        marketPrice.price,
        now,
        {
          pendingSignal: this.toPendingSignal(aggregate, signal, marketPrice.price)
        },
        undefined,
        undefined,
        levels,
        crossedSignals
      );
      return true;
    }

    await this.persistPriceSnapshot(botId, marketPrice, now);
    const order = await this.tradeRepository.createOrder(orderIntent);
    const execution = await this.tradeRepository.createExecution({
      orderId: order.id,
      botId,
      provider: aggregate.bot.mode === "paper" ? ExecutionProvider.Paper : aggregate.bot.executionProvider,
      mode: aggregate.bot.mode,
      status: ExecutionStatus.Pending,
      executionRef: orderIntent.orderKey,
      txId: null,
      quotePrice: signal.levelPrice,
      expectedOutputAmount: null,
      expectedFeeAmount: null,
      executedInputAmount: null,
      executedOutputAmount: null,
      executedFeeAmount: null,
      errorCode: null,
      errorMessage: null,
      rawReport: null,
      completedAt: null
    });

    const report = await this.executionService.executePreparedSwap(aggregate.bot, executionParams, quoteGuard.preparedExecution);

    await this.tradeRepository.finalizeExecution(execution.id, report, null);
    await this.tradeRepository.markOrderStatus(
      order.id,
      report.status === ExecutionStatus.Failed
        ? OrderStatus.Failed
        : aggregate.bot.mode === "paper"
          ? OrderStatus.Simulated
          : OrderStatus.Submitted
    );

    if (report.status === ExecutionStatus.Failed) {
      await this.botRepository.updateBotStatus(botId, BotStatus.Error);
      await this.alertService.emit({
        botId,
        type: AlertType.ExecutionFailed,
        severity: "critical",
        title: `${aggregate.bot.name} execution failed`,
        message: "Execution adapter returned a failed status."
      });
      await this.persistPassiveState(aggregate, marketPrice.price, now, { pendingSignal: null }, BotStatus.Error);
      return true;
    }

    const lotUpdate = this.applyExecutionToLots(aggregate.openLots, aggregate.bot.id, signal.side, report, orderIntent, orderIntent.targetPrice);
    const nextState = this.computePortfolioState(aggregate, signal.side, report, marketPrice.price, lotUpdate.lots, lotUpdate.realizedPnlDelta);
    const nextGridCycles = this.applyExecutionToGridCycles(aggregate, signal, lotUpdate.openedLotId, orderIntent);
    await this.tradeRepository.replaceLots(botId, lotUpdate.lots);
    await this.tradeRepository.upsertPosition({
      botId,
      baseAmount: nextState.availableBaseAmount,
      quoteSpent: nextState.deployedQuoteAmount,
      averageEntryPrice: nextState.averageEntryPrice ?? 0,
      realizedPnlUsd: nextState.realizedPnlUsd,
      unrealizedPnlUsd: nextState.unrealizedPnlUsd,
      totalFeesQuote: round((aggregate.position?.totalFeesQuote ?? 0) + report.feeAmount, 8)
    });
    await this.tradeRepository.createInventorySnapshot({
      botId,
      baseAmount: nextState.availableBaseAmount,
      quoteAmount: nextState.availableQuoteAmount,
      reservedBaseAmount: 0,
      reservedQuoteAmount: aggregate.config.reserveQuoteAmount,
      averageCost: nextState.averageEntryPrice
    });
    await this.tradeRepository.createPnlSnapshot({
      botId,
      realizedPnlUsd: nextState.realizedPnlUsd,
      unrealizedPnlUsd: nextState.unrealizedPnlUsd,
      totalPnlUsd: nextState.realizedPnlUsd + nextState.unrealizedPnlUsd,
      equityUsd: nextState.totalEquityUsd,
      price: marketPrice.price
    });
    await this.botRepository.updateBotStatus(botId, BotStatus.Cooldown);
    await this.botRepository.createStateSnapshot({
      botId,
      status: BotStatus.Cooldown,
      currentPrice: marketPrice.price,
      availableQuoteAmount: nextState.availableQuoteAmount,
      availableBaseAmount: nextState.availableBaseAmount,
      deployedQuoteAmount: nextState.deployedQuoteAmount,
      averageEntryPrice: nextState.averageEntryPrice,
      realizedPnlUsd: nextState.realizedPnlUsd,
      unrealizedPnlUsd: nextState.unrealizedPnlUsd,
      totalEquityUsd: nextState.totalEquityUsd,
      consecutiveFailures: 0,
      lastExecutionAt: now,
      lastProcessedAt: now,
      lastRecenterAt: aggregate.latestState?.lastRecenterAt ?? null,
      metadata: {
        levelLocks: {
          ...(aggregate.latestState?.metadata.levelLocks ?? {}),
          [String(signal.levelIndex)]: new Date(now.getTime() + aggregate.config.levelLockMs).toISOString()
        },
        pendingSignal: null,
        gridCycles: nextGridCycles,
        recenterHistory: aggregate.latestState?.metadata.recenterHistory ?? [],
        recentExecutions: [...(aggregate.latestState?.metadata.recentExecutions ?? []), now.toISOString()].slice(-50)
      }
    });

    return true;
  }

  private buildExecutionParams(
    aggregate: BotAggregate,
    signal: TriggerSignal,
    orderIntent: OrderIntent
  ): ExecuteSwapParams {
    return {
      botId: aggregate.bot.id,
      inputMint: signal.side === TradeSide.Buy ? aggregate.bot.quoteMint : aggregate.bot.baseMint,
      outputMint: signal.side === TradeSide.Buy ? aggregate.bot.baseMint : aggregate.bot.quoteMint,
      amount: signal.side === TradeSide.Buy ? orderIntent.requestedQuoteAmount : orderIntent.requestedBaseAmount,
      tradeSide: signal.side,
      inputDecimals: signal.side === TradeSide.Buy ? aggregate.bot.quoteDecimals : aggregate.bot.baseDecimals,
      outputDecimals: signal.side === TradeSide.Buy ? aggregate.bot.baseDecimals : aggregate.bot.quoteDecimals,
      slippageBps: aggregate.config.maxSlippageBps,
      clientOrderId: orderIntent.orderKey,
      referencePrice: orderIntent.targetPrice
    };
  }

  private async validateExecutionQuote(
    aggregate: BotAggregate,
    signal: TriggerSignal,
    orderIntent: OrderIntent,
    executionParams: ExecuteSwapParams,
    now: Date
  ): Promise<{
    allowed: boolean;
    message: string;
    metadata?: Record<string, unknown>;
    preparedExecution?: ExecutionEstimate;
  }> {
    if (aggregate.bot.mode === BotMode.Paper) {
      return { allowed: true, message: "Paper execution does not require a live quote guard." };
    }

    const targetPrice = orderIntent.targetPrice;
    const maxAdverseDriftBps = Math.max(0, aggregate.config.maxSlippageBps);

    try {
      const estimate = await this.executionService.prepareExecution(aggregate.bot, executionParams);
      const estimatedPrice = estimate.expectedPrice;
      if (!Number.isFinite(estimatedPrice) || estimatedPrice <= 0 || !Number.isFinite(targetPrice) || targetPrice <= 0) {
        return {
          allowed: false,
          message: `Quote guard blocked ${signal.side}: invalid estimated price for level ${signal.levelIndex + 1}.`,
          metadata: {
            side: signal.side,
            levelIndex: signal.levelIndex,
            targetPrice,
            estimatedPrice
          }
        };
      }

      const adverseDriftBps =
        signal.side === TradeSide.Buy
          ? ((estimatedPrice - targetPrice) / targetPrice) * 10_000
          : ((targetPrice - estimatedPrice) / targetPrice) * 10_000;

      if (adverseDriftBps <= maxAdverseDriftBps) {
        return {
          allowed: true,
          message: "Quote is inside the execution guard.",
          preparedExecution: estimate
        };
      }

      return {
        allowed: false,
        message:
          `Quote guard blocked ${signal.side}: estimated ${estimatedPrice.toFixed(8)} is ` +
          `${Math.max(0, adverseDriftBps).toFixed(1)} bps worse than target ${targetPrice.toFixed(8)} ` +
          `(limit ${maxAdverseDriftBps} bps).`,
        metadata: {
          side: signal.side,
          levelIndex: signal.levelIndex,
          targetPrice,
          estimatedPrice,
          adverseDriftBps,
          maxAdverseDriftBps,
          requestedQuoteAmount: orderIntent.requestedQuoteAmount,
          requestedBaseAmount: orderIntent.requestedBaseAmount,
          checkedAt: now.toISOString()
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown quote estimation error";
      return {
        allowed: false,
        message: `Quote guard blocked ${signal.side}: could not validate Jupiter quote (${message}).`,
        metadata: {
          side: signal.side,
          levelIndex: signal.levelIndex,
          targetPrice,
          maxAdverseDriftBps,
          checkedAt: now.toISOString()
        }
      };
    }
  }

  private async maybeWriteQuoteGuardLog(
    botId: string,
    now: Date,
    message: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const lastWriteAt = this.quoteGuardLogWriteAt.get(botId);
    if (lastWriteAt && now.getTime() - lastWriteAt < QUOTE_GUARD_LOG_INTERVAL_MS) {
      return;
    }

    await this.logRepository.writeLog({
      botId,
      level: LogLevel.Warn,
      category: "execution_guard",
      message,
      metadata
    });
    this.quoteGuardLogWriteAt.set(botId, now.getTime());
  }

  private toPendingSignal(aggregate: BotAggregate, signal: TriggerSignal, currentPrice: number) {
    const currentPending = aggregate.latestState?.metadata.pendingSignal ?? null;
    const keepsSamePending =
      currentPending?.side === signal.side && currentPending.levelIndex === signal.levelIndex;

    return {
      levelIndex: signal.levelIndex,
      side: signal.side,
      firstObservedAt: keepsSamePending ? currentPending.firstObservedAt : signal.triggeredAt.toISOString(),
      lastObservedPrice: currentPrice
    };
  }

  private async handleOutOfRange(aggregate: BotAggregate, price: number, now: Date): Promise<void> {
    const botId = aggregate.bot.id;
    const history = aggregate.latestState?.metadata.recenterHistory ?? [];
    const alreadyOutOfRange =
      aggregate.bot.status === BotStatus.OutOfRange || aggregate.latestState?.status === BotStatus.OutOfRange;
    if (aggregate.config.recenterMode === RecenterMode.Manual) {
      await this.botRepository.updateBotStatus(botId, BotStatus.OutOfRange);
      if (!alreadyOutOfRange) {
        await this.alertService.emit({
          botId,
          type: AlertType.BotOutOfRange,
          severity: "warning",
          title: `${aggregate.bot.name} out of range`,
          message: `Price ${price.toFixed(2)} is outside the configured range.`
        });
      }
      await this.persistPassiveState(aggregate, price, now, {}, BotStatus.OutOfRange);
      return;
    }

    const lastRecenterAt = aggregate.latestState?.lastRecenterAt;
    const recenterCount24h = history.filter((entry) => now.getTime() - new Date(entry).getTime() < 86_400_000).length;
    if (
      (lastRecenterAt && now.getTime() - lastRecenterAt.getTime() < aggregate.config.autoRecenterMinIntervalMs) ||
      recenterCount24h >= aggregate.config.autoRecenterMaxPerDay
    ) {
      await this.botRepository.updateBotStatus(botId, BotStatus.OutOfRange);
      await this.persistPassiveState(aggregate, price, now, {}, BotStatus.OutOfRange);
      return;
    }

    await this.alertService.emit({
      botId,
      type: AlertType.RecenterPerformed,
      severity: "info",
      title: `${aggregate.bot.name} recentered`,
      message: `Auto-recenter executed at ${price.toFixed(2)}`
    });
    await this.persistPassiveState(
      aggregate,
      price,
      now,
      { recenterHistory: [...history, now.toISOString()].slice(-10) },
      BotStatus.Running,
      now
    );
  }

  private getConfirmedSignal(aggregate: BotAggregate, currentPrice: number, now: Date): TriggerSignal | null {
    const levels = this.gridStrategyService.calculateLevels(
      aggregate.config.lowPrice,
      aggregate.config.highPrice,
      aggregate.config.levelCount,
      aggregate.config.gridType
    );
    const crossedSignals = aggregate.latestState?.currentPrice
      ? this.gridStrategyService.detectCrossedLevels(levels, aggregate.latestState.currentPrice, currentPrice)
      : [];

    return this.getConfirmedSignalFromState(aggregate, currentPrice, now, levels, crossedSignals);
  }

  private getConfirmedSignalFromState(
    aggregate: BotAggregate,
    currentPrice: number,
    now: Date,
    levels: Array<{ index: number; price: number }>,
    crossedSignals: TriggerSignal[]
  ): TriggerSignal | null {
    return this.gridDecisionService.getConfirmedSignal({
      botId: aggregate.bot.id,
      botStatus: aggregate.bot.status,
      latestStatus: aggregate.latestState?.status,
      pendingSignal: aggregate.latestState?.metadata.pendingSignal ?? null,
      currentPrice,
      now,
      levels,
      crossedSignals,
      priceConfirmationWindowMs: aggregate.config.priceConfirmationWindowMs,
      canBuildOrder: (signal) => Boolean(this.gridStrategyService.buildOrderIntent(aggregate, signal))
    });
  }

  private getOutOfRangeRecoverySellSignal(
    aggregate: BotAggregate,
    currentPrice: number,
    now: Date,
    levels: Array<{ index: number; price: number }>,
    crossedSignals: TriggerSignal[]
  ): TriggerSignal | null {
    return this.gridDecisionService.getOutOfRangeRecoverySellSignal({
      botId: aggregate.bot.id,
      botStatus: aggregate.bot.status,
      latestStatus: aggregate.latestState?.status,
      pendingSignal: aggregate.latestState?.metadata.pendingSignal ?? null,
      currentPrice,
      now,
      levels,
      crossedSignals,
      priceConfirmationWindowMs: aggregate.config.priceConfirmationWindowMs,
      canBuildOrder: (signal) => Boolean(this.gridStrategyService.buildOrderIntent(aggregate, signal))
    });
  }

  private async persistPassiveState(
    aggregate: BotAggregate,
    currentPrice: number,
    now: Date,
    metadataPatch: Partial<BotRuntimeMetadata> = {},
    status = this.getPassiveStatus(aggregate, now),
    lastRecenterAt = aggregate.latestState?.lastRecenterAt ?? null,
    precomputedLevels?: Array<{ index: number; price: number }>,
    precomputedCrossedSignals?: TriggerSignal[]
  ): Promise<void> {
    const latest = aggregate.latestState;
    const levels =
      precomputedLevels ??
      this.gridStrategyService.calculateLevels(
        aggregate.config.lowPrice,
        aggregate.config.highPrice,
        aggregate.config.levelCount,
        aggregate.config.gridType
      );
    const crossedSignals =
      precomputedCrossedSignals ??
      (latest?.currentPrice ? this.gridStrategyService.detectCrossedLevels(levels, latest.currentPrice, currentPrice) : []);
    const pendingSignal = this.resolvePendingSignal(aggregate, crossedSignals, levels, currentPrice, now);
    const availableBaseAmount = latest?.availableBaseAmount ?? aggregate.position?.baseAmount ?? 0;
    const availableQuoteAmount = latest?.availableQuoteAmount ?? aggregate.config.totalBudgetUsd;
    const openCostBasis = round(aggregate.openLots.reduce((sum, lot) => sum + lot.costQuote, 0), 8);
    const averageEntryPrice = availableBaseAmount > 0 && openCostBasis > 0 ? round(openCostBasis / availableBaseAmount, 8) : null;
    const unrealizedPnlUsd = availableBaseAmount > 0 ? round(availableBaseAmount * currentPrice - openCostBasis, 8) : 0;
    const totalEquityUsd = round(availableQuoteAmount + availableBaseAmount * currentPrice, 8);
    const metadata = {
      levelLocks: latest?.metadata.levelLocks ?? {},
      pendingSignal,
      gridCycles: latest?.metadata.gridCycles ?? {},
      recenterHistory: latest?.metadata.recenterHistory ?? [],
      recentExecutions: latest?.metadata.recentExecutions ?? [],
      ...metadataPatch
    };

    if (
      !shouldPersistPassiveState({
        latestState: latest,
        status,
        metadata,
        lastExecutionAt: latest?.lastExecutionAt ?? null,
        lastRecenterAt,
        now
      })
    ) {
      return;
    }

    await this.botRepository.createStateSnapshot({
      botId: aggregate.bot.id,
      status,
      currentPrice,
      availableQuoteAmount,
      availableBaseAmount,
      deployedQuoteAmount: openCostBasis,
      averageEntryPrice,
      realizedPnlUsd: latest?.realizedPnlUsd ?? aggregate.position?.realizedPnlUsd ?? 0,
      unrealizedPnlUsd,
      totalEquityUsd,
      consecutiveFailures: latest?.consecutiveFailures ?? 0,
      lastExecutionAt: latest?.lastExecutionAt ?? null,
      lastProcessedAt: now,
      lastRecenterAt,
      metadata
    });
  }

  private resolvePendingSignal(
    aggregate: BotAggregate,
    crossedSignals: TriggerSignal[],
    levels: Array<{ index: number; price: number }>,
    currentPrice: number,
    now: Date
  ) {
    return this.gridDecisionService.resolvePendingSignal({
      botId: aggregate.bot.id,
      pendingSignal: aggregate.latestState?.metadata.pendingSignal ?? null,
      crossedSignals,
      levels,
      currentPrice,
      now,
      canBuildOrder: (signal) => Boolean(this.gridStrategyService.buildOrderIntent(aggregate, signal))
    });
  }

  private getPassiveStatus(aggregate: BotAggregate, now: Date): BotStatus {
    if (aggregate.bot.status === BotStatus.Error || aggregate.bot.status === BotStatus.OutOfRange) {
      return BotStatus.Running;
    }

    if (
      aggregate.bot.status === BotStatus.Cooldown &&
      aggregate.latestState?.lastExecutionAt &&
      now.getTime() - aggregate.latestState.lastExecutionAt.getTime() > aggregate.config.cooldownMs
    ) {
      return BotStatus.Running;
    }

    return aggregate.bot.status;
  }

  private applyExecutionToLots(
    currentLots: PositionLot[],
    botId: string,
    side: TradeSide,
    report: { executionId: string; inputAmount: number; outputAmount: number; feeAmount: number },
    orderIntent: { matchedLotIds?: string[] },
    levelPrice: number
  ): { lots: PositionLot[]; realizedPnlDelta: number; openedLotId: string | null } {
    if (side === TradeSide.Buy) {
      const entryPrice = report.outputAmount > 0 ? round(report.inputAmount / report.outputAmount, 8) : levelPrice;
      const openedLotId = `lot-${report.executionId}`;
      return {
        lots: [
          ...currentLots,
          {
            id: openedLotId,
            botId,
            originalBaseAmount: report.outputAmount,
            remainingBaseAmount: report.outputAmount,
            entryPrice,
            costQuote: report.inputAmount,
            openedByExecutionId: report.executionId,
            closedByExecutionId: null,
            openedAt: new Date(),
            closedAt: null
          }
        ],
        realizedPnlDelta: 0,
        openedLotId
      };
    }

    const matchedLotIds = new Set(orderIntent.matchedLotIds ?? currentLots.map((lot) => lot.id));
    let remainingToSell = report.inputAmount;
    let realizedPnlDelta = 0;
    const quotePerBase = report.inputAmount > 0 ? report.outputAmount / report.inputAmount : levelPrice;
    const feePerBase = report.inputAmount > 0 ? report.feeAmount / report.inputAmount : 0;

    const lots = currentLots
      .map((lot) => {
        if (remainingToSell <= 0 || !matchedLotIds.has(lot.id)) {
          return lot;
        }

        const sold = Math.min(lot.remainingBaseAmount, remainingToSell);
        const costPerBase = lot.remainingBaseAmount > 0 ? lot.costQuote / lot.remainingBaseAmount : 0;
        const soldCostQuote = round(costPerBase * sold, 8);
        const soldQuoteOutput = round(quotePerBase * sold, 8);
        const soldFeeQuote = round(feePerBase * sold, 8);
        remainingToSell = round(remainingToSell - sold, 8);
        const nextRemaining = round(lot.remainingBaseAmount - sold, 8);
        const nextCostQuote = round(Math.max(lot.costQuote - soldCostQuote, 0), 8);
        realizedPnlDelta = round(realizedPnlDelta + soldQuoteOutput - soldFeeQuote - soldCostQuote, 8);
        return {
          ...lot,
          remainingBaseAmount: nextRemaining,
          costQuote: nextCostQuote,
          closedByExecutionId: nextRemaining === 0 ? report.executionId : lot.closedByExecutionId,
          closedAt: nextRemaining === 0 ? new Date() : lot.closedAt
        };
      })
      .filter((lot) => lot.remainingBaseAmount > 0);

    return {
      lots,
      realizedPnlDelta,
      openedLotId: null
    };
  }

  private applyExecutionToGridCycles(
    aggregate: BotAggregate,
    signal: TriggerSignal,
    openedLotId: string | null,
    orderIntent: { matchedLotIds?: string[] }
  ) {
    const currentCycles = aggregate.latestState?.metadata.gridCycles ?? {};
    const nextCycles: Record<string, GridCycle> = { ...currentCycles };

    if (signal.side === TradeSide.Buy) {
      if (!openedLotId) {
        return nextCycles;
      }

      nextCycles[String(signal.levelIndex)] = {
        buyLevelIndex: signal.levelIndex,
        sellLevelIndex: signal.levelIndex + 1 < aggregate.config.levelCount ? signal.levelIndex + 1 : null,
        lotId: openedLotId,
        openedAt: signal.triggeredAt.toISOString()
      };
      return nextCycles;
    }

    const matchedLotIds = new Set(orderIntent.matchedLotIds ?? []);
    for (const [key, cycle] of Object.entries(nextCycles)) {
      if (cycle.sellLevelIndex === signal.levelIndex || matchedLotIds.has(cycle.lotId)) {
        delete nextCycles[key];
      }
    }

    return nextCycles;
  }

  private computePortfolioState(
    aggregate: BotAggregate,
    side: TradeSide,
    report: { inputAmount: number; outputAmount: number; feeAmount: number },
    currentPrice: number,
    lots: PositionLot[],
    realizedPnlDelta: number
  ) {
    const quoteAmount = aggregate.latestState?.availableQuoteAmount ?? aggregate.config.totalBudgetUsd;
    const baseAmount = aggregate.latestState?.availableBaseAmount ?? 0;

    const availableQuoteAmount =
      side === TradeSide.Buy ? round(quoteAmount - report.inputAmount - report.feeAmount, 8) : round(quoteAmount + report.outputAmount - report.feeAmount, 8);
    const availableBaseAmount =
      side === TradeSide.Buy ? round(baseAmount + report.outputAmount, 8) : round(baseAmount - report.inputAmount, 8);
    const totalBase = lots.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0);
    const totalCost = round(lots.reduce((sum, lot) => sum + lot.costQuote, 0), 8);
    const averageEntryPrice = totalBase > 0 && totalCost > 0 ? round(totalCost / totalBase, 8) : null;
    const realizedPnlUsd = round((aggregate.latestState?.realizedPnlUsd ?? aggregate.position?.realizedPnlUsd ?? 0) + realizedPnlDelta, 8);
    const unrealizedPnlUsd = totalBase > 0 ? round(totalBase * currentPrice - totalCost, 8) : 0;
    const totalEquityUsd = round(availableQuoteAmount + availableBaseAmount * currentPrice, 8);

    return {
      availableQuoteAmount,
      availableBaseAmount,
      deployedQuoteAmount: totalCost,
      averageEntryPrice,
      realizedPnlUsd,
      unrealizedPnlUsd,
      totalEquityUsd
    };
  }
}
