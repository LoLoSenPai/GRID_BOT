import { DEFAULTS } from "@grid-bot/common";

import { BotMode, BotStatus, ExecutionProvider, GridType, MinOrderMode, OrderStatus, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
import type {
  BacktestConfig,
  BacktestLeaderboardEntry,
  BacktestMarketSeries,
  BacktestMetrics,
  BacktestOperatorGuidance,
  BacktestRecommendation,
  BacktestReplayExecution,
  BacktestReplayPoint,
  BacktestRunMeta,
  BacktestRunResult,
  Bot,
  BotAggregate,
  BotRuntimeMetadata,
  GridCycle,
  HistoricalCandle,
  OrderIntent,
  PositionLot,
  TriggerSignal
} from "../domain/types";
import { round } from "../utils/math";
import { GridStrategyService } from "./grid-strategy-service";
import { RiskManagerService } from "./risk-manager-service";

const STRATEGY_RUNTIME_DEFAULTS: Record<
  StrategyMode,
  {
    cooldownMs: number;
    maxOrdersPerHour: number;
    levelLockMs: number;
    priceConfirmationWindowMs: number;
  }
> = {
  [StrategyMode.AccumulateBase]: {
    cooldownMs: 120_000,
    maxOrdersPerHour: 18,
    levelLockMs: 120_000,
    priceConfirmationWindowMs: 5_000
  },
  [StrategyMode.Balanced]: {
    cooldownMs: 45_000,
    maxOrdersPerHour: 48,
    levelLockMs: 45_000,
    priceConfirmationWindowMs: 3_000
  },
  [StrategyMode.AccumulateUsdc]: {
    cooldownMs: 15_000,
    maxOrdersPerHour: 96,
    levelLockMs: 15_000,
    priceConfirmationWindowMs: 0
  }
};

export interface BacktestReplayRequest {
  series: BacktestMarketSeries;
  config: BacktestConfig;
}

export interface BacktestRecommendationRequest {
  series: BacktestMarketSeries;
  budgetUsd: number;
}

interface BacktestRuntimeState {
  bot: Bot;
  config: BacktestConfig;
  status: BotStatus;
  currentPrice: number | null;
  availableQuoteAmount: number;
  availableBaseAmount: number;
  deployedQuoteAmount: number;
  averageEntryPrice: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalEquityUsd: number;
  consecutiveFailures: number;
  lastExecutionAt: Date | null;
  lastRecenterAt: Date | null;
  metadata: BotRuntimeMetadata;
  openLots: PositionLot[];
}

interface BacktestSegmentResult {
  state: BacktestRuntimeState;
  replayPoints: BacktestReplayPoint[];
  executions: BacktestReplayExecution[];
}

interface PreparedSeries {
  series: BacktestMarketSeries;
  candles: HistoricalCandle[];
  trainCandles: HistoricalCandle[];
  validationCandles: HistoricalCandle[];
  splitIndex: number;
  estimatedIntervalMs: number;
}

export function splitBacktestSeries(series: BacktestMarketSeries): PreparedSeries {
  const candles = [...series.candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  if (candles.length < 2) {
    throw new Error("Backtest requires at least two candles.");
  }

  const splitIndex = Math.min(Math.max(Math.floor(candles.length * 0.7), 1), candles.length - 1);
  return {
    series: { ...series, candles },
    candles,
    trainCandles: candles.slice(0, splitIndex),
    validationCandles: candles.slice(splitIndex),
    splitIndex,
    estimatedIntervalMs: estimateIntervalMs(candles)
  };
}

export function generateBacktestCandidates(series: BacktestMarketSeries, budgetUsd: number): BacktestConfig[] {
  const prepared = splitBacktestSeries(series);
  const trainCloses = prepared.trainCandles.map((candle) => candle.close).filter((value) => Number.isFinite(value) && value > 0);

  if (trainCloses.length < 2) {
    return [];
  }

  const sortedCloses = [...trainCloses].sort((left, right) => left - right);
  const lowQuantiles = [0.1, 0.2, 0.3];
  const highQuantiles = [0.7, 0.8, 0.9];
  const railCounts = Array.from({ length: 11 }, (_, index) => index + 6);
  const candidates: BacktestConfig[] = [];

  for (const lowQuantile of lowQuantiles) {
    const lowPrice = round(quantile(sortedCloses, lowQuantile), 8);
    for (const highQuantile of highQuantiles) {
      const highPrice = round(quantile(sortedCloses, highQuantile), 8);
      if (!(highPrice > lowPrice)) {
        continue;
      }

      const widthPct = ((highPrice - lowPrice) / lowPrice) * 100;
      if (widthPct < 4 || widthPct > 35) {
        continue;
      }

      for (const levelCount of railCounts) {
        const budgetPerCycleUsd = levelCount > 1 ? budgetUsd / (levelCount - 1) : 0;
        const minOrderQuoteAmount = getSuggestedMinOrderQuoteAmount(budgetUsd, levelCount);
        if (budgetPerCycleUsd < minOrderQuoteAmount) {
          continue;
        }

        for (const gridType of [GridType.Arithmetic, GridType.Geometric] as const) {
          for (const strategyMode of [
            StrategyMode.AccumulateUsdc,
            StrategyMode.Balanced,
            StrategyMode.AccumulateBase
          ] as const) {
            candidates.push(
              buildCandidateConfig({
                budgetUsd,
                lowPrice,
                highPrice,
                levelCount,
                gridType,
                strategyMode,
                minOrderQuoteAmount
              })
            );
          }
        }
      }
    }
  }

  return candidates;
}

export function compareBacktestLeaderboardEntries(left: BacktestLeaderboardEntry, right: BacktestLeaderboardEntry): number {
  const leftValidationGain = left.validationMetrics.endingEquityUsd - left.validationMetrics.startingBudgetUsd;
  const rightValidationGain = right.validationMetrics.endingEquityUsd - right.validationMetrics.startingBudgetUsd;

  if (rightValidationGain !== leftValidationGain) {
    return rightValidationGain - leftValidationGain;
  }

  if (left.validationMetrics.maxDrawdownPct !== right.validationMetrics.maxDrawdownPct) {
    return left.validationMetrics.maxDrawdownPct - right.validationMetrics.maxDrawdownPct;
  }

  if (left.validationMetrics.timeOutOfRangePct !== right.validationMetrics.timeOutOfRangePct) {
    return left.validationMetrics.timeOutOfRangePct - right.validationMetrics.timeOutOfRangePct;
  }

  if (left.validationMetrics.closedCycleCount !== right.validationMetrics.closedCycleCount) {
    return right.validationMetrics.closedCycleCount - left.validationMetrics.closedCycleCount;
  }

  const leftTrainGain = left.trainMetrics.endingEquityUsd - left.trainMetrics.startingBudgetUsd;
  const rightTrainGain = right.trainMetrics.endingEquityUsd - right.trainMetrics.startingBudgetUsd;
  return rightTrainGain - leftTrainGain;
}

export function deriveBacktestOperatorGuidance(
  metrics: Pick<BacktestMetrics, "timeInRangePct" | "maxOccupancyPct">,
  resolution?: string
): BacktestOperatorGuidance {
  const { timeInRangePct, maxOccupancyPct } = metrics;

  let status: BacktestOperatorGuidance["status"] = "Caution";
  if (timeInRangePct < 50 || maxOccupancyPct > 95) {
    status = "Fragile";
  } else if (timeInRangePct >= 70 && maxOccupancyPct <= 85) {
    status = "Healthy";
  }

  const summary =
    status === "Healthy"
      ? "Validation stayed inside the range most of the time and capital usage stayed controlled."
      : status === "Fragile"
        ? "Validation spent too much time outside the range or used too much capital."
        : "The config is usable, but one of range coverage or occupancy is borderline.";

  const resolutionLabel = resolution ? `${resolution}` : "the selected resolution";

  return {
    status,
    summary,
    stopRule: `Recreate if price closes outside the recommended range for 2 consecutive bars at ${resolutionLabel}.`,
    timeInRangePct,
    maxOccupancyPct
  };
}

export class BacktestLabService {
  private readonly gridStrategyService: GridStrategyService;
  private readonly riskManagerService: RiskManagerService;

  constructor(gridStrategyService = new GridStrategyService(), riskManagerService = new RiskManagerService()) {
    this.gridStrategyService = gridStrategyService;
    this.riskManagerService = riskManagerService;
  }

  replay(request: BacktestReplayRequest): BacktestRunResult {
    const prepared = splitBacktestSeries(request.series);
    const config = this.normalizeConfig(request.config);
    const continuousTrain = this.simulateSegment(prepared.series, config, prepared.trainCandles, "train");
    const continuousValidation = this.simulateSegment(
      prepared.series,
      config,
      prepared.validationCandles,
      "validation",
      continuousTrain.state
    );
    const trainMetricsResult = this.simulateSegment(prepared.series, config, prepared.trainCandles, "train");
    const validationMetricsResult = this.simulateSegment(prepared.series, config, prepared.validationCandles, "validation");

    const replayPoints = [...continuousTrain.replayPoints, ...continuousValidation.replayPoints];
    const executions = [...continuousTrain.executions, ...continuousValidation.executions];
    const overallMetrics = this.summarizeMetrics(
      replayPoints,
      executions,
      config.budgetUsd,
      continuousValidation.state,
      prepared.series,
      config
    );

    return {
      series: prepared.series,
      config,
      replayPoints,
      executions,
      trainMetrics: trainMetricsResult.metrics,
      validationMetrics: validationMetricsResult.metrics,
      overallMetrics,
      meta: this.buildMeta(prepared)
    };
  }

  recommend(request: BacktestRecommendationRequest): BacktestRecommendation {
    const prepared = splitBacktestSeries(request.series);
    const candidates = generateBacktestCandidates(prepared.series, request.budgetUsd);

    if (candidates.length === 0) {
      throw new Error("No viable backtest candidates were generated for the selected window.");
    }

    const leaderboard: BacktestLeaderboardEntry[] = candidates.map((config) => {
      const trainResult = this.simulateSegment(prepared.series, config, prepared.trainCandles, "train");
      const validationResult = this.simulateSegment(prepared.series, config, prepared.validationCandles, "validation");

      return {
        rank: 0,
        config,
        trainMetrics: trainResult.metrics,
        validationMetrics: validationResult.metrics
      };
    });

    leaderboard.sort(compareBacktestLeaderboardEntries);
    leaderboard.forEach((entry, index) => {
      entry.rank = index + 1;
    });

    const topFive = leaderboard.slice(0, 5);
    const best = topFive[0] ?? leaderboard[0];
    if (!best) {
      throw new Error("Backtest recommendation requires at least one ranked candidate.");
    }
    const bestReplay = this.replay({
      series: prepared.series,
      config: best.config
    });

    return {
      bestConfig: best.config,
      leaderboard: topFive,
      bestReplay,
      trainMetrics: best.trainMetrics,
      validationMetrics: best.validationMetrics,
      operatorGuidance: deriveBacktestOperatorGuidance(best.validationMetrics, prepared.series.resolution),
      meta: {
        ...bestReplay.meta,
        candidateCount: candidates.length,
        evaluatedCount: leaderboard.length
      }
    };
  }

  private simulateSegment(
    series: BacktestMarketSeries,
    config: BacktestConfig,
    candles: HistoricalCandle[],
    phase: "train" | "validation",
    initialState?: BacktestRuntimeState
  ): BacktestSegmentResult & { metrics: BacktestMetrics } {
    const state = initialState ?? this.createInitialState(series, config);

    if (candles.length === 0) {
      const metrics = this.summarizeMetrics([], [], config.budgetUsd, state, series, config);
      return { state, replayPoints: [], executions: [], metrics };
    }

    const levels = this.gridStrategyService.calculateLevels(config.lowPrice, config.highPrice, config.levelCount, config.gridType);
    const intervalMs = estimateIntervalMs(candles);
    const replayPoints: BacktestReplayPoint[] = [];
    const executions: BacktestReplayExecution[] = [];
    let previousObservedPrice = state.currentPrice ?? candles[0]!.open;

    candles.forEach((candle, candleIndex) => {
      const path = buildIntrabougiePath(candle, intervalMs);
      path.forEach((step, stepIndex) => {
        state.currentPrice = step.price;
        state.bot.currentPrice = step.price;
        state.status = this.getPassiveStatus(state, step.timestamp);
        state.bot.status = state.status;

        if (this.isOutOfRange(config, step.price)) {
          state.status = BotStatus.OutOfRange;
          state.bot.status = BotStatus.OutOfRange;
          state.metadata.pendingSignal = null;
          this.recalculatePortfolioState(state, step.price);
          replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
          previousObservedPrice = step.price;
          return;
        }

        const crossedSignals = previousObservedPrice !== null ? this.gridStrategyService.detectCrossedLevels(levels, previousObservedPrice, step.price) : [];
        const signal = this.getConfirmedSignalFromState(state, step.price, step.timestamp, levels, crossedSignals, config);

        if (signal) {
          const orderIntent = this.gridStrategyService.buildOrderIntent(this.toAggregate(state), signal);
          if (!orderIntent) {
            state.metadata.pendingSignal = null;
            this.recalculatePortfolioState(state, step.price);
            replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
            previousObservedPrice = step.price;
            return;
          }

          const marketPrice = this.toMarketPrice(series, step.price, step.timestamp);
          const risk = this.riskManagerService.evaluate(this.toAggregate(state), signal, orderIntent, marketPrice, step.timestamp);
          if (!risk.allowed) {
            if (risk.nextStatus) {
              state.status = risk.nextStatus;
              state.bot.status = risk.nextStatus;
            }
            state.metadata.pendingSignal = null;
            executions.push(this.createBlockedExecution(signal, orderIntent, step.timestamp, phase, risk.reasons));
            this.recalculatePortfolioState(state, step.price);
            replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
            previousObservedPrice = step.price;
            return;
          }

          const report = this.simulateExecution(signal, orderIntent, config);
          executions.push(this.applyExecution(state, signal, orderIntent, report, step.timestamp, phase));
          this.recalculatePortfolioState(state, step.price);
          replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
          previousObservedPrice = step.price;
          return;
        }

        state.metadata.pendingSignal = this.resolvePendingSignal(state, crossedSignals, levels, step.price, step.timestamp, config);
        this.recalculatePortfolioState(state, step.price);
        replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
        previousObservedPrice = step.price;
      });
    });

    const metrics = this.summarizeMetrics(replayPoints, executions, config.budgetUsd, state, series, config);
    return {
      state,
      replayPoints,
      executions,
      metrics
    };
  }

  private createInitialState(series: BacktestMarketSeries, config: BacktestConfig): BacktestRuntimeState {
    const bot: Bot = {
      id: `backtest-${series.symbol.toLowerCase()}`,
      key: `backtest-${series.symbol.toLowerCase()}-${config.levelCount}`,
      name: `${series.pair} Backtest`,
      baseMint: series.symbol,
      quoteMint: "USDC",
      baseSymbol: series.symbol,
      quoteSymbol: "USDC",
      baseDecimals: 9,
      quoteDecimals: 6,
      strategyMode: config.strategyMode,
      mode: BotMode.Paper,
      status: BotStatus.Running,
      executionProvider: ExecutionProvider.Paper,
      currentPrice: null
    };

    return {
      bot,
      config,
      status: BotStatus.Running,
      currentPrice: null,
      availableQuoteAmount: config.budgetUsd,
      availableBaseAmount: 0,
      deployedQuoteAmount: 0,
      averageEntryPrice: null,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      totalEquityUsd: config.budgetUsd,
      consecutiveFailures: 0,
      lastExecutionAt: null,
      lastRecenterAt: null,
      metadata: {
        levelLocks: {},
        pendingSignal: null,
        gridCycles: {},
        recenterHistory: [],
        recentExecutions: []
      },
      openLots: []
    };
  }

  private normalizeConfig(config: BacktestConfig): BacktestConfig {
    const strategyDefaults = STRATEGY_RUNTIME_DEFAULTS[config.strategyMode];
    return {
      ...config,
      budgetUsd: Math.max(0, round(config.budgetUsd, 2)),
      minOrderMode: config.minOrderMode ?? MinOrderMode.Auto,
      minOrderQuoteAmount: Math.max(0, round(config.minOrderQuoteAmount, 2)),
      maxSlippageBps: Math.max(0, config.maxSlippageBps),
      cooldownMs: Math.max(0, config.cooldownMs ?? strategyDefaults.cooldownMs),
      maxOrdersPerHour: Math.max(1, config.maxOrdersPerHour ?? strategyDefaults.maxOrdersPerHour),
      maxDrawdownPct: Math.max(0, config.maxDrawdownPct ?? 18),
      maxConsecutiveFailures: Math.max(1, config.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures),
      levelLockMs: Math.max(0, config.levelLockMs ?? strategyDefaults.levelLockMs),
      priceConfirmationWindowMs: Math.max(0, config.priceConfirmationWindowMs ?? strategyDefaults.priceConfirmationWindowMs),
      recenterMode: RecenterMode.Manual,
      outOfRangePause: config.outOfRangePause ?? true
    };
  }

  private getConfirmedSignalFromState(
    state: BacktestRuntimeState,
    currentPrice: number,
    now: Date,
    levels: Array<{ index: number; price: number }>,
    crossedSignals: TriggerSignal[],
    config: BacktestConfig
  ): TriggerSignal | null {
    const immediateSignal =
      config.priceConfirmationWindowMs === 0 ? this.selectActionableCrossedSignal(state, crossedSignals, now) : null;

    if (immediateSignal) {
      return {
        ...immediateSignal,
        idempotencyKey: `${state.bot.id}:${immediateSignal.side}:${immediateSignal.levelIndex}:${now.getTime()}`,
        triggeredAt: now
      };
    }

    const pending = state.metadata.pendingSignal;
    if (!pending) {
      return null;
    }

    const pendingLevel = levels.find((level) => level.index === pending.levelIndex);
    if (!pendingLevel) {
      return null;
    }

    if (!this.priceStillConfirms(pending.side, pendingLevel.price, currentPrice)) {
      return null;
    }

    if (now.getTime() - new Date(pending.firstObservedAt).getTime() < config.priceConfirmationWindowMs) {
      return null;
    }

    return {
      levelIndex: pending.levelIndex,
      side: pending.side,
      levelPrice: pendingLevel.price,
      observedPrice: currentPrice,
      idempotencyKey: `${state.bot.id}:${pending.side}:${pending.levelIndex}:${pending.firstObservedAt}`,
      triggeredAt: now
    };
  }

  private resolvePendingSignal(
    state: BacktestRuntimeState,
    crossedSignals: TriggerSignal[],
    levels: Array<{ index: number; price: number }>,
    currentPrice: number,
    now: Date,
    config: BacktestConfig
  ) {
    const pending = state.metadata.pendingSignal;
    const crossed = this.selectActionableCrossedSignal(state, crossedSignals, now);

    if (crossed) {
      return {
        levelIndex: crossed.levelIndex,
        side: crossed.side,
        firstObservedAt:
          pending?.levelIndex === crossed.levelIndex && pending.side === crossed.side ? pending.firstObservedAt : now.toISOString(),
        lastObservedPrice: currentPrice
      };
    }

    if (!pending) {
      return null;
    }

    const pendingLevel = levels.find((level) => level.index === pending.levelIndex);
    if (!pendingLevel) {
      return null;
    }

    if (!this.priceStillConfirms(pending.side, pendingLevel.price, currentPrice)) {
      return null;
    }

    if (now.getTime() - new Date(pending.firstObservedAt).getTime() < config.priceConfirmationWindowMs) {
      return null;
    }

    return {
      ...pending,
      lastObservedPrice: currentPrice
    };
  }

  private selectActionableCrossedSignal(state: BacktestRuntimeState, crossedSignals: TriggerSignal[], now: Date) {
    for (const signal of crossedSignals) {
      const probeSignal: TriggerSignal = {
        ...signal,
        idempotencyKey: `probe:${state.bot.id}:${signal.side}:${signal.levelIndex}:${now.getTime()}`,
        triggeredAt: now
      };

      if (this.gridStrategyService.buildOrderIntent(this.toAggregate(state), probeSignal)) {
        return signal;
      }
    }

    return null;
  }

  private priceStillConfirms(side: TradeSide, levelPrice: number, currentPrice: number) {
    if (side === TradeSide.Buy) {
      return currentPrice <= levelPrice;
    }

    return currentPrice >= levelPrice;
  }

  private simulateExecution(signal: TriggerSignal, orderIntent: OrderIntent, config: BacktestConfig) {
    const fillPrice =
      signal.side === TradeSide.Buy
        ? round(signal.levelPrice * (1 + config.maxSlippageBps / 10_000), 8)
        : round(signal.levelPrice * (1 - config.maxSlippageBps / 10_000), 8);

    if (signal.side === TradeSide.Buy) {
      const inputAmount = orderIntent.requestedQuoteAmount;
      const outputAmount = fillPrice > 0 ? round(inputAmount / fillPrice, 8) : 0;
      return {
        executionId: `bt-${signal.side}-${signal.levelIndex}-${signal.triggeredAt.getTime()}`,
        inputAmount,
        outputAmount,
        feeAmount: 0,
        fillPrice
      };
    }

    const inputAmount = orderIntent.requestedBaseAmount;
    const outputAmount = round(inputAmount * fillPrice, 8);
    return {
      executionId: `bt-${signal.side}-${signal.levelIndex}-${signal.triggeredAt.getTime()}`,
      inputAmount,
      outputAmount,
      feeAmount: 0,
      fillPrice
    };
  }

  private applyExecution(
    state: BacktestRuntimeState,
    signal: TriggerSignal,
    orderIntent: OrderIntent,
    report: { executionId: string; inputAmount: number; outputAmount: number; feeAmount: number; fillPrice: number },
    now: Date,
    phase: "train" | "validation"
  ): BacktestReplayExecution {
    const lotUpdate = this.applyExecutionToLots(state.openLots, state.bot.id, signal.side, report, orderIntent, orderIntent.targetPrice, now);
    state.openLots = lotUpdate.lots;
    state.availableQuoteAmount = this.computeAvailableQuote(state.availableQuoteAmount, signal.side, report);
    state.availableBaseAmount = this.computeAvailableBase(state.availableBaseAmount, signal.side, report);
    state.deployedQuoteAmount = round(state.openLots.reduce((sum, lot) => sum + lot.costQuote, 0), 8);
    state.averageEntryPrice =
      state.availableBaseAmount > 0 && state.deployedQuoteAmount > 0 ? round(state.deployedQuoteAmount / state.availableBaseAmount, 8) : null;
    state.realizedPnlUsd = round(state.realizedPnlUsd + lotUpdate.realizedPnlDelta, 8);
    state.unrealizedPnlUsd = state.currentPrice !== null ? round(state.availableBaseAmount * state.currentPrice - state.deployedQuoteAmount, 8) : 0;
    state.totalEquityUsd = round(state.availableQuoteAmount + state.availableBaseAmount * (state.currentPrice ?? orderIntent.targetPrice), 8);
    state.status = BotStatus.Cooldown;
    state.bot.status = BotStatus.Cooldown;
    state.lastExecutionAt = now;
    state.metadata.levelLocks = {
      ...state.metadata.levelLocks,
      [String(signal.levelIndex)]: new Date(now.getTime() + state.config.levelLockMs).toISOString()
    };
    state.metadata.pendingSignal = null;
    state.metadata.gridCycles = this.applyExecutionToGridCycles(state, signal, lotUpdate.openedLotId, orderIntent, now);
    state.metadata.recenterHistory = [...state.metadata.recenterHistory];
    state.metadata.recentExecutions = [...state.metadata.recentExecutions, now.toISOString()].slice(-50);
    state.consecutiveFailures = 0;

    return {
      id: `replay-${signal.side}-${signal.levelIndex}-${now.getTime()}`,
      orderKey: orderIntent.orderKey,
      phase,
      side: signal.side,
      levelIndex: signal.levelIndex,
      targetPrice: orderIntent.targetPrice,
      fillPrice: report.fillPrice,
      inputAmount: report.inputAmount,
      outputAmount: report.outputAmount,
      realizedPnlDelta: lotUpdate.realizedPnlDelta,
      status: OrderStatus.Simulated,
      reason: orderIntent.reason,
      timestamp: now,
      matchedLotIds: orderIntent.matchedLotIds
    };
  }

  private createBlockedExecution(
    signal: TriggerSignal,
    orderIntent: OrderIntent,
    timestamp: Date,
    phase: "train" | "validation",
    reasons: string[]
  ): BacktestReplayExecution {
    return {
      id: `blocked-${signal.side}-${signal.levelIndex}-${timestamp.getTime()}`,
      orderKey: orderIntent.orderKey,
      phase,
      side: signal.side,
      levelIndex: signal.levelIndex,
      targetPrice: orderIntent.targetPrice,
      fillPrice: orderIntent.targetPrice,
      inputAmount: signal.side === TradeSide.Buy ? orderIntent.requestedQuoteAmount : orderIntent.requestedBaseAmount,
      outputAmount: 0,
      realizedPnlDelta: 0,
      status: OrderStatus.Blocked,
      reason: orderIntent.reason,
      blockedReasons: reasons,
      timestamp,
      matchedLotIds: orderIntent.matchedLotIds
    };
  }

  private applyExecutionToLots(
    currentLots: PositionLot[],
    botId: string,
    side: TradeSide,
    report: { executionId: string; inputAmount: number; outputAmount: number; feeAmount: number },
    orderIntent: { matchedLotIds?: string[] },
    levelPrice: number,
    now: Date
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
            openedAt: now,
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

    const lots = currentLots
      .map((lot) => {
        if (remainingToSell <= 0 || !matchedLotIds.has(lot.id)) {
          return lot;
        }

        const sold = Math.min(lot.remainingBaseAmount, remainingToSell);
        const costPerBase = lot.remainingBaseAmount > 0 ? lot.costQuote / lot.remainingBaseAmount : 0;
        const soldCostQuote = round(costPerBase * sold, 8);
        const soldQuoteOutput = round(quotePerBase * sold, 8);
        remainingToSell = round(remainingToSell - sold, 8);
        const nextRemaining = round(lot.remainingBaseAmount - sold, 8);
        const nextCostQuote = round(Math.max(lot.costQuote - soldCostQuote, 0), 8);
        realizedPnlDelta = round(realizedPnlDelta + soldQuoteOutput - soldCostQuote, 8);
        return {
          ...lot,
          remainingBaseAmount: nextRemaining,
          costQuote: nextCostQuote,
          closedByExecutionId: nextRemaining === 0 ? report.executionId : lot.closedByExecutionId,
          closedAt: nextRemaining === 0 ? now : lot.closedAt
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
    state: BacktestRuntimeState,
    signal: TriggerSignal,
    openedLotId: string | null,
    orderIntent: { matchedLotIds?: string[] },
    now: Date
  ) {
    const currentCycles = state.metadata.gridCycles ?? {};
    const nextCycles: Record<string, GridCycle> = { ...currentCycles };

    if (signal.side === TradeSide.Buy) {
      if (!openedLotId) {
        return nextCycles;
      }

      nextCycles[String(signal.levelIndex)] = {
        buyLevelIndex: signal.levelIndex,
        sellLevelIndex: signal.levelIndex + 1 < state.config.levelCount ? signal.levelIndex + 1 : null,
        lotId: openedLotId,
        openedAt: now.toISOString()
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

  private computeAvailableQuote(availableQuote: number, side: TradeSide, report: { inputAmount: number; outputAmount: number; feeAmount: number }) {
    return side === TradeSide.Buy ? round(availableQuote - report.inputAmount, 8) : round(availableQuote + report.outputAmount, 8);
  }

  private computeAvailableBase(availableBase: number, side: TradeSide, report: { inputAmount: number; outputAmount: number; feeAmount: number }) {
    return side === TradeSide.Buy ? round(availableBase + report.outputAmount, 8) : round(availableBase - report.inputAmount, 8);
  }

  private recalculatePortfolioState(state: BacktestRuntimeState, currentPrice: number) {
    const totalCost = round(state.openLots.reduce((sum, lot) => sum + lot.costQuote, 0), 8);
    const totalBase = round(state.openLots.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0), 8);
    state.deployedQuoteAmount = totalCost;
    state.averageEntryPrice = totalBase > 0 && totalCost > 0 ? round(totalCost / totalBase, 8) : null;
    state.unrealizedPnlUsd = totalBase > 0 ? round(totalBase * currentPrice - totalCost, 8) : 0;
    state.totalEquityUsd = round(state.availableQuoteAmount + state.availableBaseAmount * currentPrice, 8);
  }

  private summarizeMetrics(
    points: BacktestReplayPoint[],
    executions: BacktestReplayExecution[],
    startingBudgetUsd: number,
    endState: BacktestRuntimeState,
    series: BacktestMarketSeries,
    config: BacktestConfig
  ): BacktestMetrics {
    const sampleCount = points.length;
    const endingEquityUsd = points.at(-1)?.totalEquityUsd ?? endState.totalEquityUsd;
    const realizedPnlUsd = points.at(-1)?.realizedPnlUsd ?? endState.realizedPnlUsd;
    const unrealizedPnlUsd = points.at(-1)?.unrealizedPnlUsd ?? endState.unrealizedPnlUsd;
    const totalPnlUsd = round(realizedPnlUsd + unrealizedPnlUsd, 8);
    const returnPct = startingBudgetUsd > 0 ? round(((endingEquityUsd - startingBudgetUsd) / startingBudgetUsd) * 100, 8) : 0;
    const maxDrawdownPct = computeMaxDrawdownPct(points, startingBudgetUsd);
    const maxOccupancyPct = points.reduce((max, point) => Math.max(max, point.occupancyPct), 0);
    const timeInRangePct = computeTimeRatio(points, config.lowPrice, config.highPrice, true);
    const timeOutOfRangePct = computeTimeRatio(points, config.lowPrice, config.highPrice, false);
    const closedCycleCount = executions.filter((execution) => execution.status === OrderStatus.Simulated && execution.side === TradeSide.Sell).length;
    const openCycleCount = endState.openLots.length;
    const executedBuyCount = executions.filter((execution) => execution.status === OrderStatus.Simulated && execution.side === TradeSide.Buy).length;
    const executedSellCount = executions.filter((execution) => execution.status === OrderStatus.Simulated && execution.side === TradeSide.Sell).length;
    const blockedOrderCount = executions.filter((execution) => execution.status === OrderStatus.Blocked).length;

    void series;

    return {
      sampleCount,
      startingBudgetUsd,
      endingEquityUsd,
      realizedPnlUsd,
      unrealizedPnlUsd,
      totalPnlUsd,
      returnPct,
      maxDrawdownPct,
      maxOccupancyPct,
      timeInRangePct,
      timeOutOfRangePct,
      closedCycleCount,
      openCycleCount,
      executedBuyCount,
      executedSellCount,
      blockedOrderCount
    };
  }

  private snapshotPoint(state: BacktestRuntimeState, timestamp: Date, phase: "train" | "validation"): BacktestReplayPoint {
    const drawdownPct = state.totalEquityUsd > 0 ? round(Math.max(0, ((state.config.budgetUsd - state.totalEquityUsd) / state.config.budgetUsd) * 100), 8) : 0;
    const occupancyPct = state.config.budgetUsd > 0 ? round((state.deployedQuoteAmount / state.config.budgetUsd) * 100, 8) : 0;

    return {
      timestamp,
      price: state.currentPrice ?? 0,
      phase,
      status: state.status,
      availableQuoteAmount: state.availableQuoteAmount,
      availableBaseAmount: state.availableBaseAmount,
      deployedQuoteAmount: state.deployedQuoteAmount,
      realizedPnlUsd: state.realizedPnlUsd,
      unrealizedPnlUsd: state.unrealizedPnlUsd,
      totalEquityUsd: state.totalEquityUsd,
      drawdownPct,
      occupancyPct
    };
  }

  private buildMeta(prepared: PreparedSeries): BacktestRunMeta {
    return {
      symbol: prepared.series.symbol,
      pair: prepared.series.pair,
      resolution: prepared.series.resolution,
      candleCount: prepared.candles.length,
      trainCandleCount: prepared.trainCandles.length,
      validationCandleCount: prepared.validationCandles.length,
      splitRatio: 0.7,
      startAt: prepared.candles[0]!.timestamp,
      trainEndAt: prepared.trainCandles[prepared.trainCandles.length - 1]!.timestamp,
      endAt: prepared.candles[prepared.candles.length - 1]!.timestamp,
      estimatedIntervalMs: prepared.estimatedIntervalMs
    };
  }

  private toAggregate(state: BacktestRuntimeState): BotAggregate {
    return {
      bot: state.bot,
      config: {
        id: "cfg-backtest",
        botId: state.bot.id,
        totalBudgetUsd: state.config.budgetUsd,
        maxDeployableUsd: state.config.budgetUsd,
        reserveQuoteAmount: 0,
        lowPrice: state.config.lowPrice,
        highPrice: state.config.highPrice,
        levelCount: state.config.levelCount,
        gridType: state.config.gridType,
        minOrderQuoteAmount:
          state.config.minOrderMode === MinOrderMode.Auto
            ? getSuggestedMinOrderQuoteAmount(state.config.budgetUsd, state.config.levelCount)
            : state.config.minOrderQuoteAmount,
        maxSlippageBps: state.config.maxSlippageBps,
        cooldownMs: state.config.cooldownMs,
        maxOrdersPerHour: state.config.maxOrdersPerHour,
        maxDrawdownPct: state.config.maxDrawdownPct,
        maxConsecutiveFailures: state.config.maxConsecutiveFailures,
        levelLockMs: state.config.levelLockMs,
        priceConfirmationWindowMs: state.config.priceConfirmationWindowMs,
        recenterMode: state.config.recenterMode,
        autoRecenterMinIntervalMs: DEFAULTS.autoRecenterMinIntervalMs,
        autoRecenterMaxPerDay: DEFAULTS.autoRecenterMaxPerDay,
        outOfRangePause: state.config.outOfRangePause
      },
      latestState: {
        id: `snapshot-${state.bot.id}`,
        botId: state.bot.id,
        status: state.status,
        currentPrice: state.currentPrice,
        availableQuoteAmount: state.availableQuoteAmount,
        availableBaseAmount: state.availableBaseAmount,
        deployedQuoteAmount: state.deployedQuoteAmount,
        averageEntryPrice: state.averageEntryPrice,
        realizedPnlUsd: state.realizedPnlUsd,
        unrealizedPnlUsd: state.unrealizedPnlUsd,
        totalEquityUsd: state.totalEquityUsd,
        consecutiveFailures: state.consecutiveFailures,
        lastExecutionAt: state.lastExecutionAt,
        lastProcessedAt: state.lastExecutionAt ?? new Date(),
        lastRecenterAt: state.lastRecenterAt,
        metadata: state.metadata
      },
      position: null,
      openLots: state.openLots
    };
  }

  private toMarketPrice(series: BacktestMarketSeries, price: number, timestamp: Date) {
    return {
      symbol: series.symbol,
      pair: series.pair,
      price,
      confidence: 0,
      source: "backtest",
      timestamp,
      feedId: `${series.symbol.toLowerCase()}-backtest`
    };
  }

  private isOutOfRange(config: BacktestConfig, price: number): boolean {
    return price < config.lowPrice || price > config.highPrice;
  }

  private getPassiveStatus(state: BacktestRuntimeState, now: Date): BotStatus {
    if (state.status === BotStatus.Cooldown && state.lastExecutionAt && now.getTime() - state.lastExecutionAt.getTime() > state.config.cooldownMs) {
      return BotStatus.Running;
    }

    if (state.status === BotStatus.OutOfRange) {
      return BotStatus.Running;
    }

    return state.status;
  }
}

function buildCandidateConfig(input: {
  budgetUsd: number;
  lowPrice: number;
  highPrice: number;
  levelCount: number;
  gridType: GridType;
  strategyMode: StrategyMode;
  minOrderQuoteAmount: number;
}): BacktestConfig {
  const strategyDefaults = STRATEGY_RUNTIME_DEFAULTS[input.strategyMode];
  return {
    budgetUsd: round(input.budgetUsd, 2),
    lowPrice: round(input.lowPrice, 8),
    highPrice: round(input.highPrice, 8),
    levelCount: input.levelCount,
    gridType: input.gridType,
    strategyMode: input.strategyMode,
    minOrderMode: MinOrderMode.Auto,
    minOrderQuoteAmount: round(input.minOrderQuoteAmount, 2),
    maxSlippageBps: 50,
    cooldownMs: strategyDefaults.cooldownMs,
    maxOrdersPerHour: strategyDefaults.maxOrdersPerHour,
    maxDrawdownPct: 18,
    maxConsecutiveFailures: DEFAULTS.maxConsecutiveFailures,
    levelLockMs: strategyDefaults.levelLockMs,
    priceConfirmationWindowMs: strategyDefaults.priceConfirmationWindowMs,
    recenterMode: RecenterMode.Manual,
    outOfRangePause: true
  };
}

function getSuggestedMinOrderQuoteAmount(budgetUsd: number, levelCount: number) {
  const budgetPerCycleUsd = levelCount > 1 ? budgetUsd / (levelCount - 1) : 0;
  if (budgetPerCycleUsd <= 0) {
    return 0;
  }

  if (budgetPerCycleUsd >= 100) {
    return round(budgetPerCycleUsd, 0);
  }

  if (budgetPerCycleUsd >= 25) {
    return round(budgetPerCycleUsd, 1);
  }

  return round(budgetPerCycleUsd, 2);
}

function estimateIntervalMs(candles: HistoricalCandle[]) {
  const deltas = candles
    .map((candle, index) => {
      const next = candles[index + 1];
      if (!next) {
        return null;
      }

      const delta = next.timestamp.getTime() - candle.timestamp.getTime();
      return delta > 0 ? delta : null;
    })
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  if (deltas.length === 0) {
    return 1;
  }

  return deltas[Math.floor(deltas.length / 2)]!;
}

function buildIntrabougiePath(candle: HistoricalCandle, intervalMs: number) {
  const start = candle.timestamp.getTime();
  const lowHighSplit = Math.max(1, Math.floor(intervalMs / 3));
  const midSplit = Math.max(lowHighSplit + 1, Math.floor((intervalMs * 2) / 3));
  const end = start + Math.max(intervalMs, 1);
  const bullish = candle.close >= candle.open;
  const orderedPrices = bullish ? [candle.open, candle.low, candle.high, candle.close] : [candle.open, candle.high, candle.low, candle.close];

  return orderedPrices.map((price, index) => ({
    price,
    timestamp: new Date([start, start + lowHighSplit, start + midSplit, end][index] ?? end)
  }));
}

function quantile(sortedValues: number[], q: number) {
  if (sortedValues.length === 0) {
    return 0;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0]!;
  }

  const position = (sortedValues.length - 1) * q;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex]!;
  }

  const weight = position - lowerIndex;
  return sortedValues[lowerIndex]! + (sortedValues[upperIndex]! - sortedValues[lowerIndex]!) * weight;
}

function computeMaxDrawdownPct(points: BacktestReplayPoint[], startingBudgetUsd: number) {
  let peak = startingBudgetUsd;
  let maxDrawdown = 0;

  for (const point of points) {
    peak = Math.max(peak, point.totalEquityUsd);
    if (peak <= 0) {
      continue;
    }

    const drawdown = ((peak - point.totalEquityUsd) / peak) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return round(maxDrawdown, 8);
}

function computeTimeRatio(points: BacktestReplayPoint[], lowPrice: number, highPrice: number, inRange: boolean) {
  if (points.length < 2) {
    return inRange ? 100 : 0;
  }

  let totalMs = 0;
  let qualifyingMs = 0;

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    const delta = Math.max(0, next.timestamp.getTime() - current.timestamp.getTime());
    totalMs += delta;
    const currentlyInRange = current.price >= lowPrice && current.price <= highPrice;
    if (currentlyInRange === inRange) {
      qualifyingMs += delta;
    }
  }

  if (totalMs === 0) {
    return inRange ? 100 : 0;
  }

  return round((qualifyingMs / totalMs) * 100, 8);
}
