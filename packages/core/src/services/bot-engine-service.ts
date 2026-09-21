import {
  AlertType,
  BotMode,
  BotStatus,
  ExecutionProvider,
  ExecutionStatus,
  LogLevel,
  OrderStatus,
  RecenterMode,
  StrategyMode,
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
import type { PendingExecutionAttempt, ExecutionCommit } from "../domain/contracts";
import type {
  BotAggregate,
  BotRuntimeMetadata,
  ExecuteSwapParams,
  ExecutionEstimate,
  ExecutionReport,
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
import { isMarketDataUnavailableError } from "./market-price-service";
import { shouldPersistPassivePriceSnapshot, shouldPersistPassiveState } from "./passive-runtime-throttle";
import { RiskManagerService } from "./risk-manager-service";
import { round } from "../utils/math";
import { applyLotExecution, summarizeLots, isTradingLot, calculateNetSellPnl } from "./lot-accounting-service";
import { evaluateFlatRecenter } from "./flat-recenter-service";
import { Decimal } from "decimal.js";
import { eligibleCommittedExits } from "./lot-exit-commitment-service";

const HEARTBEAT_UPDATE_INTERVAL_MS = 2_000;
const QUOTE_GUARD_LOG_INTERVAL_MS = 60_000;
const EXECUTION_RETRY_LOG_INTERVAL_MS = 60_000;
const MARKET_DATA_RETRY_LOG_INTERVAL_MS = 60_000;
const MAX_SELL_CATCH_UP_PER_RUN = 4;

type SignalExecutionOutcome = "not_actionable" | "handled_no_execution" | "executed";

export class BotEngineService {
  private readonly passivePriceSnapshotWriteAt = new Map<string, number>();
  private readonly lastObservedPriceByBotId = new Map<string, number>();
  private readonly lastObservedRevisionByBotId = new Map<string, string>();
  private readonly lastHeartbeatWriteAt = new Map<string, number>();
  private readonly quoteGuardLogWriteAt = new Map<string, number>();
  private readonly executionRetryLogWriteAt = new Map<string, number>();
  private readonly marketDataRetryLogWriteAt = new Map<string, number>();
  private readonly runningBotIds = new Set<string>();
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
    for (const aggregate of bots) {
      await this.runBot(aggregate.bot.id);
    }
  }

  async runBotsForSymbol(symbol: string): Promise<void> {
    const normalizedSymbol = symbol.toUpperCase();
    const bots = await this.botRepository.listRunnableBots();
    const matchingBots = bots.filter((aggregate) => aggregate.bot.baseSymbol.toUpperCase() === normalizedSymbol);
    for (const aggregate of matchingBots) {
      await this.runBot(aggregate.bot.id);
    }
  }

  async runBot(botId: string, options?: { skipLock?: boolean; recoveryOnly?: boolean }): Promise<void> {
    const execute = async () => {
      const aggregate = await this.botRepository.getBotAggregate(botId);
      if (!aggregate) {
        return;
      }

      const now = new Date();

      try {
        const pendingAttempt = await this.tradeRepository.getPendingExecution?.(botId);
        if (pendingAttempt) {
          await this.resumeExecutionAttempt(aggregate, pendingAttempt, now);
          return;
        }
        if (options?.recoveryOnly) return;
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

        if (aggregate.portfolio) {
          const context = aggregate.portfolio;
          const exit = eligibleCommittedExits({ botId, price: marketPrice.price, now, lots: aggregate.openLots,
            commitments: context.exitCommitments.filter(e => !e.fulfilledAt) })[0];
          if (exit && await this.executeConfirmedSignal(aggregate, exit, marketPrice, now, levels, []) !== "not_actionable") return;
          const revision = context.band.activeRevision.id;
          if (this.lastObservedRevisionByBotId.get(botId) !== revision || aggregate.latestState?.metadata.revisionBaselinePending) {
            this.lastObservedRevisionByBotId.set(botId, revision);
            await this.persistPassiveState(aggregate, marketPrice.price, now,
              { pendingSignal: null, revisionBaselinePending: false, gridRevisionId: revision }, undefined, undefined, levels, []);
            return;
          }
          if (context.band.status !== "ACTIVE" || context.capitalBlockedReason || this.isOutOfRange(aggregate, marketPrice.price)) {
            await this.persistPassivePriceSnapshot(aggregate, marketPrice, now);
            await this.persistPassiveState(aggregate, marketPrice.price, now, { pendingSignal: null }, undefined, undefined, levels, []);
            return;
          }
        }

        if (this.isOutOfRange(aggregate, marketPrice.price)) {
          const lowerBoundaryBuySignal =
            marketPrice.price < aggregate.config.lowPrice && aggregate.config.recenterMode === RecenterMode.Manual
              ? this.getOutOfRangeBoundaryBuySignal(aggregate, marketPrice.price, now, levels, crossedSignals)
              : null;
          const upperBoundarySellSignal =
            marketPrice.price > aggregate.config.highPrice
              ? this.getOutOfRangeRecoverySellSignal(aggregate, marketPrice.price, now, levels, crossedSignals)
              : null;

          if (lowerBoundaryBuySignal?.side === TradeSide.Buy) {
            const handledLowerBoundaryBuy = await this.executeConfirmedSignal(
              aggregate,
              lowerBoundaryBuySignal,
              marketPrice,
              now,
              levels,
              crossedSignals
            );
            if (handledLowerBoundaryBuy !== "not_actionable") {
              return;
            }
          }

          if (upperBoundarySellSignal?.side === TradeSide.Sell) {
            const handledUpperBoundarySell = await this.executeSellCatchUp(
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
          await this.handleOutOfRange(aggregate, marketPrice.price, now, marketPrice);
          return;
        }

        if (aggregate.latestState?.metadata.outsideSince) {
          await this.persistPassiveState(aggregate, marketPrice.price, now, { outsideSince: null, outsideSide: null, outsideSourceObservedAt: null });
          return;
        }
        const signal = this.getConfirmedSignalFromState(aggregate, marketPrice.price, now, levels, crossedSignals);
        if (!signal) {
          await this.persistPassivePriceSnapshot(aggregate, marketPrice, now);
          await this.persistPassiveState(aggregate, marketPrice.price, now, {}, undefined, undefined, levels, crossedSignals);
          return;
        }

        const handledSignal =
          signal.side === TradeSide.Sell
            ? await this.executeSellCatchUp(aggregate, signal, marketPrice, now, levels, crossedSignals)
            : (await this.executeConfirmedSignal(aggregate, signal, marketPrice, now, levels, crossedSignals)) !== "not_actionable";
        if (!handledSignal) {
          await this.persistPassivePriceSnapshot(aggregate, marketPrice, now);
          await this.persistPassiveState(aggregate, marketPrice.price, now, { pendingSignal: null }, undefined, undefined, levels, crossedSignals);
          return;
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown bot engine error";
        if (isMarketDataUnavailableError(error)) {
          await this.handleMarketDataUnavailable(aggregate, now, message);
          return;
        }

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

    if (this.runningBotIds.has(botId)) {
      return;
    }

    this.runningBotIds.add(botId);
    try {
      await this.botRepository.withBotLock(botId, execute);
    } finally {
      this.runningBotIds.delete(botId);
    }
  }

  private async handleMarketDataUnavailable(aggregate: BotAggregate, now: Date, message: string) {
    const restoredStatus = await this.restoreOperationalStatusAfterMarketDataOutage(aggregate);
    await this.maybeWriteMarketDataRetryLog({
      botId: aggregate.bot.id,
      now,
      message,
      metadata: {
        baseSymbol: aggregate.bot.baseSymbol,
        quoteSymbol: aggregate.bot.quoteSymbol,
        restoredStatus,
      },
    });
  }

  private async restoreOperationalStatusAfterMarketDataOutage(aggregate: BotAggregate) {
    if (aggregate.bot.status !== BotStatus.Error) {
      return aggregate.bot.status;
    }

    const previousStatus = aggregate.latestState?.status;
    const restoredStatus = previousStatus && previousStatus !== BotStatus.Error ? previousStatus : BotStatus.Running;
    await this.botRepository.updateBotStatus(aggregate.bot.id, restoredStatus);
    return restoredStatus;
  }

  private async maybeWriteMarketDataRetryLog(input: {
    botId: string;
    now: Date;
    message: string;
    metadata?: Record<string, unknown>;
  }) {
    const lastWriteAt = this.marketDataRetryLogWriteAt.get(input.botId);
    if (lastWriteAt && input.now.getTime() - lastWriteAt < MARKET_DATA_RETRY_LOG_INTERVAL_MS) {
      return;
    }

    await this.logRepository.writeLog({
      botId: input.botId,
      level: LogLevel.Warn,
      category: "market_data",
      message: `Market data retry deferred: ${input.message}`,
      metadata: input.metadata,
    });
    this.marketDataRetryLogWriteAt.set(input.botId, input.now.getTime());
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
  ): Promise<SignalExecutionOutcome> {
    if (aggregate.portfolio && signal.side === TradeSide.Buy) {
      signal = { ...signal, gridRevisionId: aggregate.portfolio.band.activeRevision.id };
    }
    const botId = aggregate.bot.id;
    const orderIntent = this.gridStrategyService.buildOrderIntent(aggregate, signal);
    if (!orderIntent) {
      return "not_actionable";
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
      await this.persistPassiveState(aggregate, marketPrice.price, now, { pendingSignal: null }, risk.nextStatus, undefined, levels, crossedSignals);
      return "handled_no_execution";
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
      return "handled_no_execution";
    }

    const guardedOrderIntent = quoteGuard.orderIntent ?? orderIntent;
    const guardedExecutionParams = quoteGuard.executionParams ?? executionParams;

    await this.persistPriceSnapshot(botId, marketPrice, now);
    if (aggregate.bot.mode === BotMode.Live || aggregate.portfolio) {
      if (!this.tradeRepository.prepareExecutionAttempt || !this.tradeRepository.saveExecutionResult || !this.tradeRepository.commitExecution || !quoteGuard.preparedExecution) {
        throw new Error("Live execution requires durable preparation and atomic accounting.");
      }
      const attempt = await this.tradeRepository.prepareExecutionAttempt({
        botId, signal, orderIntent: guardedOrderIntent, executionParams: guardedExecutionParams,
        preparedExecution: quoteGuard.preparedExecution,
        expectedSnapshotId: aggregate.latestState?.id ?? null
      });
      return this.resumeExecutionAttempt(aggregate, attempt, now, marketPrice.price);
    }
    const order = await this.tradeRepository.createOrder(guardedOrderIntent);
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

    const report = await this.executePreparedSwapWithRetryState(
      aggregate,
      signal,
      marketPrice,
      now,
      levels,
      crossedSignals,
      execution.id,
      order.id,
      guardedExecutionParams,
      quoteGuard.preparedExecution
    );
    if (!report) {
      return "handled_no_execution";
    }

    const accountingReport = await this.withQuoteFeeAmount(aggregate, report, marketPrice.price);
    await this.tradeRepository.finalizeExecution(execution.id, accountingReport, null);
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
      return "handled_no_execution";
    }

    const lotUpdate = this.applyExecutionToLots(
      aggregate.openLots,
      aggregate.bot.id,
      aggregate.bot.strategyMode,
      signal.side,
      accountingReport,
      orderIntent,
      orderIntent.targetPrice
    );
    const nextState = this.computePortfolioState(aggregate, signal.side, accountingReport, marketPrice.price, lotUpdate.lots, lotUpdate.realizedPnlDelta);
    const nextGridCycles = this.applyExecutionToGridCycles(aggregate, signal, lotUpdate.openedLotId, orderIntent, lotUpdate.lots);
    await this.tradeRepository.replaceLots(botId, lotUpdate.lots);
    await this.tradeRepository.upsertPosition({
      botId,
      baseAmount: nextState.availableBaseAmount,
      quoteSpent: nextState.deployedQuoteAmount,
      averageEntryPrice: nextState.averageEntryPrice ?? 0,
      realizedPnlUsd: nextState.realizedPnlUsd,
      unrealizedPnlUsd: nextState.unrealizedPnlUsd,
      totalFeesQuote: round((aggregate.position?.totalFeesQuote ?? 0) + accountingReport.feeAmount, 8)
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
        ...aggregate.latestState?.metadata,
        externalNativeFeesQuote: (aggregate.latestState?.metadata.externalNativeFeesQuote ?? 0) + this.externalNativeFee(accountingReport),
        equityHighWatermarkUsd: Math.max(aggregate.latestState?.metadata.equityHighWatermarkUsd ?? aggregate.config.totalBudgetUsd, nextState.totalEquityUsd),
        levelLocks: {
          ...(aggregate.latestState?.metadata.levelLocks ?? {}),
          [String(signal.levelIndex)]: new Date(now.getTime() + aggregate.config.levelLockMs).toISOString()
        },
        pendingSignal: null,
        gridCycles: nextGridCycles,
        recenterHistory: aggregate.latestState?.metadata.recenterHistory ?? [],
        recentExecutions: [...(aggregate.latestState?.metadata.recentExecutions ?? []), now.toISOString()].filter((entry) => new Date(entry).getTime() >= now.getTime() - 3_600_000)
      }
    });

    return "executed";
  }

  private async resumeExecutionAttempt(
    aggregate: BotAggregate,
    attempt: PendingExecutionAttempt,
    now: Date,
    observedPrice?: number
  ): Promise<SignalExecutionOutcome> {
    const repository = this.tradeRepository;
    if (!repository.saveExecutionResult || !repository.commitExecution || !attempt.preparedExecution) {
      throw new Error("Unresolved execution requires reconciliation; new orders are blocked.");
    }
    let report = attempt.result;
    const terminal = (value?: ExecutionReport | null) => value?.status === ExecutionStatus.Filled || value?.status === ExecutionStatus.Failed ||
      (aggregate.bot.mode === BotMode.Paper && value?.status === ExecutionStatus.Simulated);
    if (!terminal(report)) {
      const unknown: ExecutionReport = {
        executionId: attempt.executionId, provider: aggregate.bot.executionProvider,
        status: ExecutionStatus.Unknown, txId: report?.txId ?? null,
        inputAmount: 0, outputAmount: 0, feeAmount: 0, effectivePrice: 0,
        rawReport: { ...(typeof report?.rawReport === "object" && report.rawReport !== null ? report.rawReport : {}),
          reason: "Submission may have reached the network; reconcile this attempt before another order.", reconciliationRequired: true }
      };
      // Write the uncertainty marker BEFORE sending: a crash after submission must resume the same bytes.
      await repository.saveExecutionResult(attempt, unknown, true);
      try {
        const cachedSuccess = (attempt.result?.rawReport as { executeResponse?: { status?: string; code?: number } } | undefined)?.executeResponse;
        if (attempt.wasUncertain && attempt.result?.txId && !(cachedSuccess?.status === "Success" && cachedSuccess.code === 0)) {
          const checked = await this.executionService.getAdapter(aggregate.bot).getExecutionReport(attempt.result.txId, attempt.preparedExecution);
          if (checked?.status === ExecutionStatus.Failed) report = checked;
        }
        if (!terminal(report)) {
          report = await this.executionService.executePreparedSwap(aggregate.bot, attempt.executionParams, attempt.preparedExecution, attempt.result ?? undefined);
          if (attempt.wasUncertain && report.status === ExecutionStatus.Failed) {
            report = { ...unknown, txId: report.txId ?? unknown.txId };
          }
        }
      } catch {
        // Do not store errors which may contain signed payloads, RPC URLs or credentials.
        report = unknown;
      }
      report = { ...report!, executionId: attempt.executionId };
      if (!terminal(report)) report = { ...report, status: ExecutionStatus.Unknown };
      await repository.saveExecutionResult(attempt, report, !terminal(report));
    }
    if (!report || !terminal(report)) {
      await this.maybeWriteExecutionRetryLog({ botId: aggregate.bot.id, now,
        message: "Unresolved execution retained; new orders blocked pending reconciliation.",
        metadata: { executionId: attempt.executionId, txId: report?.txId ?? null } });
      return "handled_no_execution";
    }
    const price = [observedPrice, aggregate.latestState?.currentPrice, report.effectivePrice, attempt.signal.observedPrice]
      .find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    if (!price) throw new Error("Confirmed execution awaits a valid accounting mark.");
    const accountingReport = await this.withQuoteFeeAmount(aggregate, { ...report, executionId: attempt.executionId }, price);
    const failed = report.status === ExecutionStatus.Failed;
    const lotUpdate = failed ? { lots: aggregate.openLots, realizedPnlDelta: 0, openedLotId: null }
      : applyLotExecution({ lots: aggregate.openLots, botId: aggregate.bot.id, strategyMode: aggregate.bot.strategyMode,
        side: attempt.signal.side, report: accountingReport, matchedLotIds: attempt.orderIntent.matchedLotIds,
        levelPrice: attempt.orderIntent.targetPrice, now });
    const state = this.computePortfolioState(aggregate, attempt.signal.side,
      failed ? { ...accountingReport, inputAmount: 0, outputAmount: 0 } : accountingReport,
      price, lotUpdate.lots, failed ? -accountingReport.feeAmount : lotUpdate.realizedPnlDelta);
    const metadata = aggregate.latestState?.metadata;
    const interrupted = aggregate.bot.status === BotStatus.Paused || aggregate.bot.status === BotStatus.Stopped;
    const status = interrupted ? aggregate.bot.status : failed ? BotStatus.Error : BotStatus.Cooldown;
    const commit: ExecutionCommit = {
      botId: aggregate.bot.id, executionId: attempt.executionId, orderId: attempt.orderId, report: accountingReport,
      lots: lotUpdate.lots,
      position: { botId: aggregate.bot.id, baseAmount: state.availableBaseAmount, quoteSpent: state.deployedQuoteAmount,
        averageEntryPrice: state.averageEntryPrice ?? 0, realizedPnlUsd: state.realizedPnlUsd,
        unrealizedPnlUsd: state.unrealizedPnlUsd, totalFeesQuote: round((aggregate.position?.totalFeesQuote ?? 0) + accountingReport.feeAmount, 8) },
      snapshot: { botId: aggregate.bot.id, ...state, status, currentPrice: price,
        consecutiveFailures: failed ? (aggregate.latestState?.consecutiveFailures ?? 0) + 1 : 0,
        lastExecutionAt: failed ? aggregate.latestState?.lastExecutionAt ?? null : now,
        lastProcessedAt: now, lastRecenterAt: aggregate.latestState?.lastRecenterAt ?? null,
        metadata: { ...metadata, levelLocks: { ...metadata?.levelLocks,
          ...(!failed ? { [String(attempt.signal.levelIndex)]: new Date(now.getTime() + aggregate.config.levelLockMs).toISOString() } : {}) },
          pendingSignal: null, recenterHistory: metadata?.recenterHistory ?? [],
          gridCycles: failed ? metadata?.gridCycles ?? {} : this.applyExecutionToGridCycles(aggregate, attempt.signal, lotUpdate.openedLotId, attempt.orderIntent, lotUpdate.lots),
          externalNativeFeesQuote: (metadata?.externalNativeFeesQuote ?? 0) + this.externalNativeFee(accountingReport),
          equityHighWatermarkUsd: Math.max(metadata?.equityHighWatermarkUsd ?? aggregate.config.totalBudgetUsd, state.totalEquityUsd),
          recentExecutions: [...(metadata?.recentExecutions ?? []), ...(!failed ? [now.toISOString()] : [])]
            .filter((date) => new Date(date).getTime() >= now.getTime() - 3_600_000) }
      }
    };
    const committed = await repository.commitExecution(commit);
    return committed && !failed ? "executed" : "handled_no_execution";
  }

  private async executeSellCatchUp(
    aggregate: BotAggregate,
    initialSignal: TriggerSignal,
    marketPrice: MarketPrice,
    now: Date,
    levels: Array<{ index: number; price: number }>,
    crossedSignals: TriggerSignal[]
  ): Promise<boolean> {
    let currentAggregate = aggregate;
    let currentSignal: TriggerSignal | null = initialSignal;
    let handledAny = false;

    for (let attempt = 0; attempt < MAX_SELL_CATCH_UP_PER_RUN && currentSignal?.side === TradeSide.Sell; attempt += 1) {
      const signalNow = attempt === 0 ? now : new Date(now.getTime() + attempt);
      const outcome = await this.executeConfirmedSignal(currentAggregate, currentSignal, marketPrice, signalNow, levels, attempt === 0 ? crossedSignals : []);
      if (outcome === "not_actionable") {
        return handledAny;
      }

      handledAny = true;
      if (outcome !== "executed") {
        return true;
      }

      const refreshedAggregate = await this.botRepository.getBotAggregate(currentAggregate.bot.id);
      if (!refreshedAggregate) {
        return true;
      }

      currentAggregate = refreshedAggregate;
      currentSignal = this.getConfirmedSignalFromState(
        currentAggregate,
        marketPrice.price,
        new Date(now.getTime() + attempt + 1),
        levels,
        []
      );

      if (currentSignal?.side !== TradeSide.Sell) {
        return true;
      }
    }

    return handledAny;
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
      slippageBps: signal.maxAdverseDriftBps ?? aggregate.config.maxSlippageBps,
      executionPolicy: { transactionSlippage: "provider_auto" },
      clientOrderId: orderIntent.orderKey,
      referencePrice: signal.observedPrice
    };
  }

  private async executePreparedSwapWithRetryState(
    aggregate: BotAggregate,
    signal: TriggerSignal,
    marketPrice: MarketPrice,
    now: Date,
    levels: Array<{ index: number; price: number }>,
    crossedSignals: TriggerSignal[],
    executionId: string,
    orderId: string,
    executionParams: ExecuteSwapParams,
    preparedExecution?: ExecutionEstimate
  ) {
    try {
      return await this.executionService.executePreparedSwap(aggregate.bot, executionParams, preparedExecution);
    } catch (error) {
      if (!this.isRetryableExecutionError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Retryable execution error";
      void executionId;
      void orderId;
      await this.maybeWriteExecutionRetryLog({
        botId: aggregate.bot.id,
        now,
        message,
        metadata: {
          side: signal.side,
          levelIndex: signal.levelIndex,
          targetPrice: signal.levelPrice,
          observedPrice: signal.observedPrice,
          checkedAt: now.toISOString()
        }
      });
      await this.persistPassiveState(
        aggregate,
        marketPrice.price,
        now,
        {
          pendingSignal: this.toPendingSignal(aggregate, signal, marketPrice.price)
        },
        aggregate.bot.status === BotStatus.Error ? BotStatus.Running : aggregate.bot.status,
        undefined,
        levels,
        crossedSignals
      );
      return null;
    }
  }

  private isRetryableExecutionError(error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    return (
      message.includes("429") ||
      message.includes("too many requests") ||
      message.includes("rate limit") ||
      message.includes("timeout") ||
      message.includes("fetch failed") ||
      message.includes("econnreset") ||
      message.includes("insufficient funds")
    );
  }

  private async maybeWriteExecutionRetryLog(input: {
    botId: string;
    now: Date;
    message: string;
    metadata?: Record<string, unknown>;
  }) {
    const lastWriteAt = this.executionRetryLogWriteAt.get(input.botId);
    if (lastWriteAt && input.now.getTime() - lastWriteAt < EXECUTION_RETRY_LOG_INTERVAL_MS) {
      return;
    }

    await this.logRepository.writeLog({
      botId: input.botId,
      level: LogLevel.Warn,
      category: "execution",
      message: `Execution retry deferred: ${input.message}`,
      metadata: input.metadata
    });
    this.executionRetryLogWriteAt.set(input.botId, input.now.getTime());
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
    orderIntent?: OrderIntent;
    executionParams?: ExecuteSwapParams;
  }> {
    const targetPrice = orderIntent.targetPrice;
    const maxAdverseDriftBps = Math.max(0, signal.maxAdverseDriftBps ?? aggregate.config.maxSlippageBps);

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

      // Paper's estimate already applies the configured synthetic slippage at the
      // observed price; it has no independent live quote drift to validate.
      if (aggregate.bot.mode !== BotMode.Paper && adverseDriftBps > maxAdverseDriftBps) {
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
      }

      if (this.isLiveAccumulateBaseSell(aggregate, signal)) {
        return await this.prepareQuoteSizedAccumulateBaseSell(
          aggregate, signal, orderIntent, executionParams, estimate, now
        );
      }

      const netProfitGuard = await this.validateNetSellQuote(aggregate, signal, orderIntent, estimate, estimatedPrice, now);
      if (!netProfitGuard.allowed) {
        return netProfitGuard;
      }
      if (signal.side === TradeSide.Buy) {
        const fee = await this.estimateQuoteFeeAmount(aggregate, estimate, estimatedPrice);
        const cost = estimate.inputAmount + fee;
        const available = aggregate.latestState?.availableQuoteAmount ?? aggregate.config.totalBudgetUsd;
        const deployed = aggregate.latestState?.deployedQuoteAmount ?? 0;
        if (cost > available - aggregate.config.reserveQuoteAmount + 1e-8 || deployed + cost > aggregate.config.maxDeployableUsd + 1e-8) {
          return { allowed: false, message: "Quote guard blocked buy: input and fees exceed the remaining deployment budget or reserve." };
        }
      }

      return {
        allowed: true,
        message: "Quote is inside the execution guard.",
        preparedExecution: estimate
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown quote estimation error";
      return {
        allowed: false,
        message: `Quote guard blocked ${signal.side}: could not validate execution quote (${message}).`,
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

  private async validateNetSellQuote(
    aggregate: BotAggregate,
    signal: TriggerSignal,
    orderIntent: OrderIntent,
    estimate: ExecutionEstimate,
    estimatedPrice: number,
    now: Date
  ): Promise<{
    allowed: boolean;
    message: string;
    metadata?: Record<string, unknown>;
  }> {
    if (signal.side !== TradeSide.Sell) {
      return { allowed: true, message: "Buy quotes do not require a net sell guard." };
    }

    const estimatedFeeQuote = await this.estimateQuoteFeeAmount(aggregate, estimate, estimatedPrice);
    const expectedNetQuoteOutput = round(estimate.expectedOutputAmount - estimatedFeeQuote, 8);
    const expectedNetPnl = calculateNetSellPnl(aggregate.openLots, orderIntent.matchedLotIds,
      orderIntent.requestedBaseAmount, estimate.expectedOutputAmount, estimatedFeeQuote, aggregate.bot.strategyMode);
    const appliesLiveSlippageFloor = aggregate.bot.mode === BotMode.Live;
    if (appliesLiveSlippageFloor && (estimate.minimumOutputAmount === undefined ||
      !Number.isFinite(estimate.minimumOutputAmount) || estimate.minimumOutputAmount <= 0)) {
      return { allowed: false, message: "Live sell omitted a valid provider minimum output; profitability cannot be protected." };
    }
    const minimumGrossQuoteOutput = appliesLiveSlippageFloor
      ? new Decimal(Math.min(estimate.expectedOutputAmount, estimate.minimumOutputAmount!))
          .toDecimalPlaces(aggregate.bot.quoteDecimals, Decimal.ROUND_DOWN)
          .toNumber()
      : estimate.expectedOutputAmount;
    const minimumNetQuoteOutput = round(minimumGrossQuoteOutput - estimatedFeeQuote, 8);
    const minimumNetPnl = appliesLiveSlippageFloor
      ? calculateNetSellPnl(aggregate.openLots, orderIntent.matchedLotIds,
          orderIntent.requestedBaseAmount, minimumGrossQuoteOutput, estimatedFeeQuote, aggregate.bot.strategyMode)
      : expectedNetPnl;
    const soldCostQuote = minimumNetPnl === null ? 0 : round(minimumNetQuoteOutput - minimumNetPnl, 8);

    if (minimumNetPnl !== null && minimumNetPnl >= 0) {
      return {
        allowed: true,
        message: appliesLiveSlippageFloor
          ? "Sell quote remains net profitable at the provider minimum output."
          : "Sell quote is expected to be net profitable."
      };
    }

    return {
      allowed: false,
      message:
        `Quote guard blocked sell: ${appliesLiveSlippageFloor ? "minimum" : "expected"} net output ` +
        `${minimumNetQuoteOutput.toFixed(8)} ` +
        `does not cover lot cost ${soldCostQuote.toFixed(8)} after estimated fees.`,
      metadata: {
        side: signal.side,
        levelIndex: signal.levelIndex,
        targetPrice: orderIntent.targetPrice,
        estimatedPrice,
        expectedOutputAmount: estimate.expectedOutputAmount,
        expectedNetQuoteOutput,
        minimumGrossQuoteOutput,
        minimumNetQuoteOutput,
        slippageToleranceBps: appliesLiveSlippageFloor ? Math.max(0, aggregate.config.maxSlippageBps) : 0,
        estimatedFeeQuote,
        soldCostQuote,
        expectedNetPnl,
        minimumNetPnl,
        requestedQuoteAmount: orderIntent.requestedQuoteAmount,
        requestedBaseAmount: orderIntent.requestedBaseAmount,
        checkedAt: now.toISOString()
      }
    };
  }

  private isLiveAccumulateBaseSell(aggregate: BotAggregate, signal: TriggerSignal): boolean {
    return aggregate.bot.mode === BotMode.Live &&
      aggregate.bot.strategyMode === StrategyMode.AccumulateBase &&
      signal.side === TradeSide.Sell;
  }

  private async prepareQuoteSizedAccumulateBaseSell(
    aggregate: BotAggregate,
    signal: TriggerSignal,
    orderIntent: OrderIntent,
    executionParams: ExecuteSwapParams,
    fullEstimate: ExecutionEstimate,
    now: Date
  ): Promise<{
    allowed: boolean;
    message: string;
    metadata?: Record<string, unknown>;
    preparedExecution?: ExecutionEstimate;
    orderIntent?: OrderIntent;
    executionParams?: ExecuteSwapParams;
  }> {
    const matchedLot = this.getWholeMatchedTradingLot(aggregate.openLots, orderIntent, aggregate.bot.baseDecimals);
    const wholeLotCostQuote = matchedLot?.costQuote ?? 0;
    const fullFeeQuote = await this.estimateQuoteFeeAmount(aggregate, fullEstimate, fullEstimate.expectedPrice);
    const fullNetOutput = new Decimal(fullEstimate.expectedOutputAmount).minus(fullFeeQuote);
    const positiveMargin = fullNetOutput.minus(wholeLotCostQuote);
    const baseAtom = new Decimal(10).pow(-aggregate.bot.baseDecimals);
    const quoteAtom = new Decimal(10).pow(-aggregate.bot.quoteDecimals);
    const fullAmount = new Decimal(executionParams.amount).toDecimalPlaces(aggregate.bot.baseDecimals, Decimal.ROUND_DOWN);

    if (!this.amountsMatchAtDecimals(fullEstimate.inputAmount, executionParams.amount, aggregate.bot.baseDecimals)) {
      return {
        allowed: false,
        message: "Quote guard blocked sell: the complete-lot prepared input differs from the requested trading lot.",
        metadata: { preparedInputAmount: fullEstimate.inputAmount, requestedInputAmount: executionParams.amount }
      };
    }

    if (wholeLotCostQuote <= 0 || !positiveMargin.isPositive()) {
      return {
        allowed: false,
        message: "Quote guard blocked sell: the complete lot quote does not cover the complete lot cost and estimated network fees.",
        metadata: {
          expectedOutputAmount: fullEstimate.expectedOutputAmount,
          estimatedFeeQuote: fullFeeQuote,
          wholeLotCostQuote,
          fullNetOutput: fullNetOutput.toNumber(),
          checkedAt: now.toISOString()
        }
      };
    }

    if (fullEstimate.minimumOutputAmount === undefined) {
      return {
        allowed: false,
        message: "Quote guard blocked sell: the live auto order omitted Jupiter's authoritative minimum output.",
        metadata: { expectedOutputAmount: fullEstimate.expectedOutputAmount, checkedAt: now.toISOString() }
      };
    }

    let sizingEstimate = fullEstimate;
    let sizingFeeQuote = fullFeeQuote;
    let priorAmountAtoms: string | null = null;
    for (let preparation = 2; preparation <= 3; preparation += 1) {
      const unitQuoteRate = new Decimal(sizingEstimate.expectedOutputAmount).div(sizingEstimate.inputAmount);
      const providerFloor = sizingEstimate.minimumOutputAmount;
      if (providerFloor === undefined) {
        break;
      }
      const actualSlippageBps = new Decimal(1).minus(new Decimal(providerFloor).div(sizingEstimate.expectedOutputAmount))
        .mul(10_000).ceil().clamp(0, 10_000).toNumber();
      const availableMarginBps = new Decimal(sizingEstimate.expectedOutputAmount)
        .minus(sizingFeeQuote).minus(wholeLotCostQuote).minus(quoteAtom)
        .div(sizingEstimate.expectedOutputAmount).mul(10_000).div(2).floor().clamp(0, 10_000).toNumber();
      const useManualFallback = preparation === 3 || actualSlippageBps > availableMarginBps;
      const transactionSlippageBps = Math.max(0, availableMarginBps);
      const protectedUnitRate = useManualFallback
        ? unitQuoteRate.mul(new Decimal(1).minus(new Decimal(transactionSlippageBps).div(10_000)))
        : new Decimal(providerFloor).div(sizingEstimate.inputAmount);
      if (!protectedUnitRate.isPositive()) {
        break;
      }

      const amountAtoms = new Decimal(wholeLotCostQuote)
        .plus(sizingFeeQuote)
        .plus(quoteAtom)
        .div(protectedUnitRate)
        .div(baseAtom)
        .ceil();
      const resizedAmount = amountAtoms.mul(baseAtom);
      if (!resizedAmount.isPositive() || resizedAmount.greaterThanOrEqualTo(fullAmount) || amountAtoms.toString() === priorAmountAtoms) {
        break;
      }
      priorAmountAtoms = amountAtoms.toString();

      const finalParams: ExecuteSwapParams = {
        ...executionParams,
        amount: resizedAmount.toNumber(),
        executionPolicy: useManualFallback
          ? { transactionSlippage: "bounded_manual", transactionSlippageBps }
          : { transactionSlippage: "provider_auto" }
      };
      const finalIntent: OrderIntent = {
        ...orderIntent,
        requestedBaseAmount: resizedAmount.toNumber(),
        requestedQuoteAmount: round(resizedAmount.mul(signal.observedPrice).toNumber(), 2)
      };
      const finalEstimate = await this.executionService.prepareExecution(aggregate.bot, finalParams);
      const driftFailure = this.validatePreparedQuoteDrift(aggregate, signal, finalIntent, finalEstimate, now);
      if (driftFailure) {
        return driftFailure;
      }

      if (!this.amountsMatchAtDecimals(finalEstimate.inputAmount, finalParams.amount, aggregate.bot.baseDecimals)) {
        return {
          allowed: false,
          message: "Quote guard blocked sell: the prepared input amount differs from the authorized quote-sized amount.",
          metadata: { preparedInputAmount: finalEstimate.inputAmount, authorizedInputAmount: finalParams.amount }
        };
      }

      const finalFeeQuote = await this.estimateQuoteFeeAmount(aggregate, finalEstimate, finalEstimate.expectedPrice);
      const minimumGrossOutput = this.minimumPreparedQuoteOutput(finalEstimate, aggregate.bot.quoteDecimals);
      if (minimumGrossOutput === null) {
        break;
      }
      const minimumNetOutput = new Decimal(minimumGrossOutput).minus(finalFeeQuote);
      const retainedBase = fullAmount.minus(resizedAmount);
      if (minimumNetOutput.greaterThanOrEqualTo(wholeLotCostQuote) && retainedBase.greaterThanOrEqualTo(baseAtom)) {
        return {
          allowed: true,
          message: "Quote-sized accumulate-base sell covers the complete lot cost and fees while retaining base.",
          preparedExecution: finalEstimate,
          orderIntent: finalIntent,
          executionParams: finalParams
        };
      }

      sizingEstimate = finalEstimate;
      sizingFeeQuote = finalFeeQuote;
    }

    return {
      allowed: false,
      message: "Quote guard blocked sell: no quote-sized amount covered the complete lot cost and fees while retaining base within three preparations.",
      metadata: {
        wholeLotCostQuote,
        fullInputAmount: fullAmount.toNumber(),
        initialProviderSlippageBps: new Decimal(1)
          .minus(new Decimal(fullEstimate.minimumOutputAmount).div(fullEstimate.expectedOutputAmount))
          .mul(10_000).ceil().clamp(0, 10_000).toNumber(),
        checkedAt: now.toISOString()
      }
    };
  }

  private validatePreparedQuoteDrift(
    aggregate: BotAggregate,
    signal: TriggerSignal,
    orderIntent: OrderIntent,
    estimate: ExecutionEstimate,
    now: Date
  ): { allowed: false; message: string; metadata: Record<string, unknown> } | null {
    const estimatedPrice = estimate.expectedPrice;
    const targetPrice = orderIntent.targetPrice;
    const adverseDriftBps = ((targetPrice - estimatedPrice) / targetPrice) * 10_000;
    const maxAdverseDriftBps = Math.max(0, signal.maxAdverseDriftBps ?? aggregate.config.maxSlippageBps);
    if (Number.isFinite(estimatedPrice) && estimatedPrice > 0 && adverseDriftBps <= maxAdverseDriftBps) {
      return null;
    }
    return {
      allowed: false,
      message: `Quote guard blocked sell: resized quote is outside the ${maxAdverseDriftBps} bps rail-drift limit.`,
      metadata: { targetPrice, estimatedPrice, adverseDriftBps, maxAdverseDriftBps, checkedAt: now.toISOString() }
    };
  }

  private amountsMatchAtDecimals(left: number, right: number, decimals: number): boolean {
    const scale = new Decimal(10).pow(decimals);
    const leftAtoms = new Decimal(left).mul(scale);
    const rightAtoms = new Decimal(right).mul(scale);
    return leftAtoms.isInteger() && rightAtoms.isInteger() && leftAtoms.equals(rightAtoms);
  }

  private minimumPreparedQuoteOutput(estimate: ExecutionEstimate, quoteDecimals: number): number | null {
    const providerFloor = estimate.minimumOutputAmount;
    return providerFloor === undefined
      ? null
      : new Decimal(providerFloor).toDecimalPlaces(quoteDecimals, Decimal.ROUND_DOWN).toNumber();
  }

  private getWholeMatchedTradingLot(
    openLots: PositionLot[],
    orderIntent: OrderIntent,
    baseDecimals: number
  ): PositionLot | null {
    const matchedIds = [...new Set(orderIntent.matchedLotIds ?? [])];
    if (matchedIds.length !== 1) {
      return null;
    }
    const lot = openLots.find((candidate) => candidate.id === matchedIds[0] && isTradingLot(candidate));
    if (!lot || lot.closedAt || lot.costQuote <= 0 || lot.remainingBaseAmount <= 0) {
      return null;
    }
    const scale = new Decimal(10).pow(baseDecimals);
    const sellableLotAtoms = new Decimal(lot.remainingBaseAmount).mul(scale).floor();
    const requestedAtoms = new Decimal(orderIntent.requestedBaseAmount).mul(scale);
    return requestedAtoms.isInteger() && requestedAtoms.equals(sellableLotAtoms) ? lot : null;
  }

  private estimateSoldCostQuote(openLots: PositionLot[], orderIntent: OrderIntent): number {
    const matchedLotIds = new Set(orderIntent.matchedLotIds ?? []);
    if (matchedLotIds.size === 0) {
      return 0;
    }

    let remainingToSell = orderIntent.requestedBaseAmount;
    let soldCostQuote = 0;

    for (const lot of openLots) {
      if (remainingToSell <= 0 || !matchedLotIds.has(lot.id) || lot.remainingBaseAmount <= 0) {
        continue;
      }

      const sold = Math.min(lot.remainingBaseAmount, remainingToSell);
      const costPerBase = lot.costQuote / lot.remainingBaseAmount;
      soldCostQuote = round(soldCostQuote + costPerBase * sold, 8);
      remainingToSell = round(remainingToSell - sold, 8);
    }

    return soldCostQuote;
  }

  private async estimateQuoteFeeAmount(
    aggregate: BotAggregate,
    estimate: ExecutionEstimate,
    quotePrice: number
  ): Promise<number> {
    if (estimate.estimatedFeeAmount > 0) {
      return estimate.estimatedFeeAmount;
    }

    if (estimate.nativeFeeSymbol !== "SOL" || !estimate.nativeFeeAmount || estimate.nativeFeeAmount <= 0) {
      return 0;
    }

    const feeQuotePrice = await this.getNativeFeeQuotePrice(aggregate, quotePrice);
    if (!feeQuotePrice || feeQuotePrice <= 0) {
      throw new Error("Cannot value native execution fees without a fresh SOL price.");
    }

    return round(estimate.nativeFeeAmount * feeQuotePrice, 8);
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

  private async handleOutOfRange(aggregate: BotAggregate, price: number, now: Date, marketPrice?: MarketPrice): Promise<void> {
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

    const decision = evaluateFlatRecenter({
      lowPrice: aggregate.config.lowPrice,
      highPrice: aggregate.config.highPrice,
      currentPrice: price,
      now,
      confirmationMs: aggregate.config.priceConfirmationWindowMs,
      outsideSince: aggregate.latestState?.metadata.outsideSince ?? null,
      outsideSide: aggregate.latestState?.metadata.outsideSide ?? null,
      outsideSourceObservedAt: aggregate.latestState?.metadata.outsideSourceObservedAt ?? null,
      currentObservationId: marketPrice?.sourceObservedAt?.toISOString() ?? null,
      requireSourceAdvance: aggregate.bot.mode === BotMode.Live,
      lastRecenterAt: aggregate.latestState?.lastRecenterAt ?? null,
      recenterHistory: history,
      minIntervalMs: aggregate.config.autoRecenterMinIntervalMs,
      maxPerDay: aggregate.config.autoRecenterMaxPerDay,
      // Retained lots are deliberately excluded by isTradingLot; they do not
      // represent an unpaired trading cycle that a range move must protect.
      openTradingLotCount: aggregate.openLots.filter(isTradingLot).length,
      unresolvedExecution: false
    });
    if (decision.action !== "recenter") {
      await this.persistPassiveState(aggregate, price, now, {
        outsideSince: decision.outsideSince,
        outsideSide: decision.outsideSide,
        outsideSourceObservedAt: decision.outsideSourceObservedAt
      }, BotStatus.OutOfRange);
      return;
    }
    if (!this.botRepository.updateRange) throw new Error("Auto-recenter requires atomic range persistence.");
    const lowPrice = decision.suggestedLowPrice;
    const highPrice = decision.suggestedHighPrice;
    if (lowPrice === null || highPrice === null) throw new Error("Auto-recenter produced no range.");
    const recentered = { ...aggregate, config: { ...aggregate.config, lowPrice, highPrice } };
    await this.persistPassiveState(recentered, price, now,
      { recenterHistory: [...history.filter((time) => time.slice(0, 10) === now.toISOString().slice(0, 10)), now.toISOString()],
        outsideSince: null, outsideSide: null, outsideSourceObservedAt: null, pendingSignal: null, levelLocks: {}, gridCycles: {} },
      BotStatus.Running, now, undefined, [], { lowPrice, highPrice });
    await this.alertService.emit({ botId, type: AlertType.RecenterPerformed, severity: "info",
      title: `${aggregate.bot.name} recentered`,
      message: `Range saved: ${lowPrice.toFixed(8)} – ${highPrice.toFixed(8)} after confirmed outside observations with no trading lots.` });
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

  private getOutOfRangeBoundaryBuySignal(
    aggregate: BotAggregate,
    currentPrice: number,
    now: Date,
    levels: Array<{ index: number; price: number }>,
    crossedSignals: TriggerSignal[]
  ): TriggerSignal | null {
    return this.gridDecisionService.getOutOfRangeBoundaryBuySignal({
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
    precomputedCrossedSignals?: TriggerSignal[],
    rangeChange?: { lowPrice: number; highPrice: number }
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
    const averageEntryPrice = summarizeLots(aggregate.openLots, currentPrice).averageEntryPrice;
    const unrealizedPnlUsd = availableBaseAmount > 0 ? round(availableBaseAmount * currentPrice - openCostBasis, 8) : 0;
    const totalEquityUsd = round(availableQuoteAmount + availableBaseAmount * currentPrice - (latest?.metadata.externalNativeFeesQuote ?? 0), 8);
    const metadata = {
      ...latest?.metadata,
      equityHighWatermarkUsd: Math.max(latest?.metadata.equityHighWatermarkUsd ?? aggregate.config.totalBudgetUsd, totalEquityUsd),
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

    const snapshot: ExecutionCommit["snapshot"] = {
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
    };
    if (rangeChange) await this.botRepository.updateRange!(aggregate.bot.id, rangeChange, snapshot);
    else await this.botRepository.createStateSnapshot(snapshot);
  }

  private resolvePendingSignal(
    aggregate: BotAggregate,
    crossedSignals: TriggerSignal[],
    levels: Array<{ index: number; price: number }>,
    currentPrice: number,
    now: Date
  ) {
    return this.gridDecisionService.resolvePendingSignal({
      allowBoundaryCatchUp: !aggregate.portfolio,
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
    strategyMode: StrategyMode,
    side: TradeSide,
    report: { executionId: string; inputAmount: number; outputAmount: number; feeAmount: number },
    orderIntent: { matchedLotIds?: string[] },
    levelPrice: number
  ): { lots: PositionLot[]; realizedPnlDelta: number; openedLotId: string | null } {
    return applyLotExecution({ lots: currentLots, botId, strategyMode, side, report,
      matchedLotIds: orderIntent.matchedLotIds, levelPrice, now: new Date() });
  }

  private async withQuoteFeeAmount<T extends { feeAmount: number; nativeFeeAmount?: number; nativeFeeSymbol?: string }>(
    aggregate: BotAggregate,
    report: T,
    quotePrice: number
  ): Promise<T> {
    if (report.feeAmount > 0 || report.nativeFeeSymbol !== "SOL" || !report.nativeFeeAmount || report.nativeFeeAmount <= 0) {
      return report;
    }

    const feeQuotePrice = await this.getNativeFeeQuotePrice(aggregate, quotePrice);
    if (!feeQuotePrice || feeQuotePrice <= 0) {
      throw new Error("Confirmed execution is awaiting a fresh SOL price to value its native fee.");
    }

    return {
      ...report,
      feeAmount: round(report.nativeFeeAmount * feeQuotePrice, 8)
    };
  }

  private async getNativeFeeQuotePrice(aggregate: BotAggregate, currentBotPrice: number) {
    if (aggregate.bot.baseSymbol.toUpperCase() === "SOL") {
      return currentBotPrice;
    }

    try {
      const solPrice = await this.marketPriceService.getLatestPrice({
        ...aggregate.bot,
        baseSymbol: "SOL",
        quoteSymbol: aggregate.bot.quoteSymbol
      });
      return solPrice.price;
    } catch {
      return null;
    }
  }

  private applyExecutionToGridCycles(
    aggregate: BotAggregate,
    signal: TriggerSignal,
    openedLotId: string | null,
    orderIntent: { matchedLotIds?: string[] },
    remainingLots: PositionLot[]
  ) {
    const currentCycles = this.getActiveGridCycles(aggregate);
    const nextCycles: Record<string, GridCycle> = { ...currentCycles };

    if (signal.side === TradeSide.Buy) {
      if (!openedLotId) {
        return nextCycles;
      }

      nextCycles[aggregate.portfolio ? `${aggregate.portfolio.band.activeRevision.id}:${signal.levelIndex}` : String(signal.levelIndex)] = {
        ...(aggregate.portfolio ? {
          gridRevisionId: aggregate.portfolio.band.activeRevision.id,
          buyTargetPrice: signal.levelPrice,
          sellTargetPrice: this.gridStrategyService.calculateLevels(aggregate.config.lowPrice, aggregate.config.highPrice,
            aggregate.config.levelCount, aggregate.config.gridType)[signal.levelIndex + 1]?.price ?? null,
        } : {}),
        buyLevelIndex: signal.levelIndex,
        sellLevelIndex: signal.levelIndex + 1 < aggregate.config.levelCount ? signal.levelIndex + 1 : null,
        lotId: openedLotId,
        openedAt: signal.triggeredAt.toISOString()
      };
      return nextCycles;
    }

    const matchedLotIds = new Set(orderIntent.matchedLotIds ?? []);
    for (const [key, cycle] of Object.entries(nextCycles)) {
      const matchesSoldLot = matchedLotIds.size > 0 ? matchedLotIds.has(cycle.lotId) : cycle.sellLevelIndex === signal.levelIndex;
      if (matchesSoldLot && !remainingLots.some((lot) => lot.id === cycle.lotId && isTradingLot(lot))) {
        delete nextCycles[key];
      }
    }

    return nextCycles;
  }

  private computePortfolioState(
    aggregate: BotAggregate,
    side: TradeSide,
    report: { inputAmount: number; outputAmount: number; feeAmount: number; nativeFeeAmount?: number; nativeFeeSymbol?: string },
    currentPrice: number,
    lots: PositionLot[],
    realizedPnlDelta: number
  ) {
    const quoteAmount = aggregate.latestState?.availableQuoteAmount ?? aggregate.config.totalBudgetUsd;
    const baseAmount = aggregate.latestState?.availableBaseAmount ?? 0;

    const externalFee = this.externalNativeFee(report);
    const quoteDebitFee = report.feeAmount - externalFee;
    const availableQuoteAmount =
      side === TradeSide.Buy ? round(quoteAmount - report.inputAmount - quoteDebitFee, 8) : round(quoteAmount + report.outputAmount - quoteDebitFee, 8);
    const availableBaseAmount =
      side === TradeSide.Buy ? round(baseAmount + report.outputAmount, 8) : round(baseAmount - report.inputAmount, 8);
    const totalBase = lots.filter(isTradingLot).reduce((sum, lot) => sum + lot.remainingBaseAmount, 0);
    const totalCost = round(lots.reduce((sum, lot) => sum + lot.costQuote, 0), 8);
    const averageEntryPrice = totalBase > 0 && totalCost > 0 ? round(totalCost / totalBase, 8) : null;
    const realizedPnlUsd = round((aggregate.latestState?.realizedPnlUsd ?? aggregate.position?.realizedPnlUsd ?? 0) + realizedPnlDelta, 8);
    const unrealizedPnlUsd = round(availableBaseAmount * currentPrice - totalCost, 8);
    const totalEquityUsd = round(availableQuoteAmount + availableBaseAmount * currentPrice - (aggregate.latestState?.metadata.externalNativeFeesQuote ?? 0) - externalFee, 8);

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

  private externalNativeFee(report: { feeAmount: number; nativeFeeAmount?: number; nativeFeeSymbol?: string }): number {
    return report.nativeFeeSymbol === "SOL" && (report.nativeFeeAmount ?? 0) > 0 ? report.feeAmount : 0;
  }

  private getActiveGridCycles(aggregate: BotAggregate): Record<string, GridCycle> {
    const openLotIds = new Set(aggregate.openLots.filter((lot) => lot.remainingBaseAmount > 0 && lot.costQuote > 0 && !lot.closedAt).map((lot) => lot.id));
    return Object.fromEntries(
      Object.entries(aggregate.latestState?.metadata.gridCycles ?? {}).filter(([, cycle]) => openLotIds.has(cycle.lotId))
    );
  }
}
