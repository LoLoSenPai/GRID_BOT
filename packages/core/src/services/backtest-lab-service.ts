import { DEFAULTS } from "@grid-bot/common";

import { BotMode, BotStatus, ExecutionProvider, GridType, MinOrderMode, OrderStatus, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
import type {
  BacktestAssumptions,
  BacktestConfig,
  BacktestExecutionCostSource,
  BacktestLeaderboardEntry,
  BacktestMarketSeries,
  BacktestMetrics,
  BacktestOperatorGuidance,
  BacktestRangeAdjustmentEvent,
  BacktestRecommendation,
  BacktestRecenterEvent,
  BacktestReplayExecution,
  BacktestReplayPoint,
  BacktestRunMeta,
  BacktestRunResult,
  Bot,
  BotAggregate,
  BotRuntimeMetadata,
  GridCycle,
  HistoricalCandle,
  MarketRegimeAssessment,
  OrderIntent,
  PositionLot,
  RecenterPolicyDecision,
  TriggerSignal
} from "../domain/types";
import { round } from "../utils/math";
import { CandleReplayService } from "./candle-replay-service";
import { DEFAULT_EXECUTION_FEE_BPS, ExecutionCostModelService } from "./execution-cost-model-service";
import { GridDecisionService } from "./grid-decision-service";
import { GridStrategyService } from "./grid-strategy-service";
import { IndicatorService } from "./indicator-service";
import { MarketRegimeService } from "./market-regime-service";
import { RangePlanService } from "./range-plan-service";
import { RecenterPolicyService } from "./recenter-policy-service";
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

const ADAPTIVE_RANGE_MIN_CANDLES = 30;
const ADAPTIVE_RANGE_REPLAN_BARS = 12;
const ADAPTIVE_RANGE_MIN_MOVE_PCT = 1;
const ADAPTIVE_RANGE_OBSERVED_WINDOW = 250;

export interface BacktestReplayRequest {
  series: BacktestMarketSeries;
  config: BacktestConfig;
  marketRegime?: MarketRegimeAssessment | null;
}

export interface BacktestExecutionCostOverride {
  maxSlippageBps: number;
  executionFeeBps: number;
  source?: BacktestExecutionCostSource;
}

export interface BacktestRecommendationRequest {
  series: BacktestMarketSeries;
  budgetUsd: number;
  marketRegime?: MarketRegimeAssessment | null;
  executionCost?: BacktestExecutionCostOverride;
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
  recenterGuard: Pick<RecenterPolicyDecision, "mode" | "side" | "allowNewBuys" | "allowRecoverySells"> | null;
  consecutiveOutsideCloses: number;
  observedCandles: HistoricalCandle[];
  adaptiveBarsSinceLastEvaluation: number;
}

interface BacktestSegmentResult {
  state: BacktestRuntimeState;
  replayPoints: BacktestReplayPoint[];
  executions: BacktestReplayExecution[];
  recenterEvents: BacktestRecenterEvent[];
  rangeAdjustmentEvents: BacktestRangeAdjustmentEvent[];
}

interface PreparedSeries {
  series: BacktestMarketSeries;
  candles: HistoricalCandle[];
  trainCandles: HistoricalCandle[];
  validationCandles: HistoricalCandle[];
  splitIndex: number;
  estimatedIntervalMs: number;
}

const defaultCandleReplayService = new CandleReplayService();

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
    estimatedIntervalMs: defaultCandleReplayService.estimateIntervalMs(candles)
  };
}

export function generateBacktestCandidates(
  series: BacktestMarketSeries,
  budgetUsd: number,
  executionCost?: BacktestExecutionCostOverride
): BacktestConfig[] {
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
                minOrderQuoteAmount,
                executionCost
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
  resolution?: string,
  recenterAdvice?: RecenterPolicyDecision
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
    recenterAction: recenterAdvice?.operatorAction ?? "No recenter action is required while price stays inside the selected range.",
    timeInRangePct,
    maxOccupancyPct
  };
}

export class BacktestLabService {
  private readonly gridStrategyService: GridStrategyService;
  private readonly gridDecisionService: GridDecisionService;
  private readonly riskManagerService: RiskManagerService;
  private readonly recenterPolicyService: RecenterPolicyService;
  private readonly executionCostModelService: ExecutionCostModelService;
  private readonly candleReplayService: CandleReplayService;
  private readonly indicatorService: IndicatorService;
  private readonly marketRegimeService: MarketRegimeService;
  private readonly rangePlanService: RangePlanService;

  constructor(
    gridStrategyService = new GridStrategyService(),
    riskManagerService = new RiskManagerService(),
    gridDecisionService = new GridDecisionService(),
    recenterPolicyService = new RecenterPolicyService(),
    executionCostModelService = new ExecutionCostModelService(),
    candleReplayService = defaultCandleReplayService,
    indicatorService = new IndicatorService(),
    marketRegimeService = new MarketRegimeService(),
    rangePlanService = new RangePlanService()
  ) {
    this.gridStrategyService = gridStrategyService;
    this.riskManagerService = riskManagerService;
    this.gridDecisionService = gridDecisionService;
    this.recenterPolicyService = recenterPolicyService;
    this.executionCostModelService = executionCostModelService;
    this.candleReplayService = candleReplayService;
    this.indicatorService = indicatorService;
    this.marketRegimeService = marketRegimeService;
    this.rangePlanService = rangePlanService;
  }

  replay(request: BacktestReplayRequest): BacktestRunResult {
    const prepared = splitBacktestSeries(request.series);
    const config = this.normalizeConfig(request.config);
    const continuousTrain = this.simulateSegment(prepared.series, config, prepared.trainCandles, "train", undefined, request.marketRegime ?? null);
    const continuousValidation = this.simulateSegment(
      prepared.series,
      config,
      prepared.validationCandles,
      "validation",
      continuousTrain.state,
      request.marketRegime ?? null
    );
    const trainMetricsResult = this.simulateSegment(prepared.series, config, prepared.trainCandles, "train", undefined, request.marketRegime ?? null);
    const validationMetricsResult = this.simulateSegment(
      prepared.series,
      config,
      prepared.validationCandles,
      "validation",
      undefined,
      request.marketRegime ?? null
    );

    const replayPoints = [...continuousTrain.replayPoints, ...continuousValidation.replayPoints];
    const executions = [...continuousTrain.executions, ...continuousValidation.executions];
    const recenterEvents = [...continuousTrain.recenterEvents, ...continuousValidation.recenterEvents];
    const rangeAdjustmentEvents = [...continuousTrain.rangeAdjustmentEvents, ...continuousValidation.rangeAdjustmentEvents];
    const recenterAdvice = this.deriveRecenterAdvice(
      config,
      continuousValidation.state,
      continuousValidation.replayPoints.length ? continuousValidation.replayPoints : continuousTrain.replayPoints,
      prepared.validationCandles.length ? prepared.validationCandles : prepared.candles,
      request.marketRegime ?? null
    );
    const overallMetrics = this.summarizeMetrics(
      replayPoints,
      executions,
      recenterEvents,
      rangeAdjustmentEvents,
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
      recenterEvents,
      rangeAdjustmentEvents,
      recenterAdvice,
      trainMetrics: trainMetricsResult.metrics,
      validationMetrics: validationMetricsResult.metrics,
      overallMetrics,
      assumptions: this.buildAssumptions(config),
      meta: this.buildMeta(prepared)
    };
  }

  recommend(request: BacktestRecommendationRequest): BacktestRecommendation {
    const prepared = splitBacktestSeries(request.series);
    const candidates = generateBacktestCandidates(prepared.series, request.budgetUsd, request.executionCost);

    if (candidates.length === 0) {
      throw new Error("No viable backtest candidates were generated for the selected window.");
    }

    const leaderboard: BacktestLeaderboardEntry[] = candidates.map((config) => {
      const trainResult = this.simulateSegment(prepared.series, config, prepared.trainCandles, "train", undefined, request.marketRegime ?? null);
      const validationResult = this.simulateSegment(prepared.series, config, prepared.validationCandles, "validation", undefined, request.marketRegime ?? null);

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
      config: best.config,
      marketRegime: request.marketRegime ?? null
    });

    return {
      bestConfig: best.config,
      leaderboard: topFive,
      bestReplay,
      recenterAdvice: bestReplay.recenterAdvice,
      trainMetrics: best.trainMetrics,
      validationMetrics: best.validationMetrics,
      operatorGuidance: deriveBacktestOperatorGuidance(best.validationMetrics, prepared.series.resolution, bestReplay.recenterAdvice),
      assumptions: bestReplay.assumptions,
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
    initialState?: BacktestRuntimeState,
    marketRegime?: MarketRegimeAssessment | null
  ): BacktestSegmentResult & { metrics: BacktestMetrics } {
    const state = initialState ?? this.createInitialState(series, config);

    if (candles.length === 0) {
      const metrics = this.summarizeMetrics([], [], [], [], config.budgetUsd, state, series, config);
      return { state, replayPoints: [], executions: [], recenterEvents: [], rangeAdjustmentEvents: [], metrics };
    }

    const intervalMs = this.candleReplayService.estimateIntervalMs(candles);
    const replayPoints: BacktestReplayPoint[] = [];
    const executions: BacktestReplayExecution[] = [];
    const recenterEvents: BacktestRecenterEvent[] = [];
    const rangeAdjustmentEvents: BacktestRangeAdjustmentEvent[] = [];
    let previousObservedPrice = state.currentPrice ?? candles[0]!.open;

    candles.forEach((candle) => {
      const path = this.candleReplayService.buildIntrabougiePath(candle, intervalMs);
      path.forEach((step) => {
        const activeConfig = state.config;
        const levels = this.gridStrategyService.calculateLevels(activeConfig.lowPrice, activeConfig.highPrice, activeConfig.levelCount, activeConfig.gridType);
        state.currentPrice = step.price;
        state.bot.currentPrice = step.price;
        state.status = this.getPassiveStatus(state, step.timestamp);
        state.bot.status = state.status;
        this.clearRecenterGuardWhenInside(state, step.price);

        const crossedSignals = previousObservedPrice !== null ? this.gridStrategyService.detectCrossedLevels(levels, previousObservedPrice, step.price) : [];
        const outOfRange = this.isOutOfRange(activeConfig, step.price);
        const signal =
          outOfRange && step.price < activeConfig.lowPrice
            ? this.getOutOfRangeBoundaryBuySignal(state, step.price, step.timestamp, levels, crossedSignals, activeConfig)
            : outOfRange && step.price > activeConfig.highPrice
              ? this.getOutOfRangeRecoverySellSignal(state, step.price, step.timestamp, levels, crossedSignals, activeConfig)
              : this.getConfirmedSignalFromState(state, step.price, step.timestamp, levels, crossedSignals, activeConfig);

        if (outOfRange && !signal) {
          state.status = BotStatus.OutOfRange;
          state.bot.status = BotStatus.OutOfRange;
          state.metadata.pendingSignal = null;
          this.recalculatePortfolioState(state, step.price);
          replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
          previousObservedPrice = step.price;
          return;
        }

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

          const report = this.simulateExecution(signal, orderIntent, activeConfig);
          executions.push(this.applyExecution(state, signal, orderIntent, report, step.timestamp, phase));
          this.recalculatePortfolioState(state, step.price);
          replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
          previousObservedPrice = step.price;
          return;
        }

        state.metadata.pendingSignal = this.resolvePendingSignal(state, crossedSignals, levels, step.price, step.timestamp, activeConfig);
        this.recalculatePortfolioState(state, step.price);
        replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
        previousObservedPrice = step.price;
      });

      state.observedCandles = [...state.observedCandles, candle].slice(-ADAPTIVE_RANGE_OBSERVED_WINDOW);
      state.adaptiveBarsSinceLastEvaluation += 1;

      const adaptiveRangeEvent = this.maybeApplyAdaptiveRangePlan(state, candle, phase);
      if (adaptiveRangeEvent) {
        rangeAdjustmentEvents.push(adaptiveRangeEvent);
      }

      const recenterEvent = this.maybeApplySimulatedRecenter(state, candle, phase, marketRegime ?? null);
      if (recenterEvent) {
        recenterEvents.push(recenterEvent);
      }
    });

    const metrics = this.summarizeMetrics(replayPoints, executions, recenterEvents, rangeAdjustmentEvents, config.budgetUsd, state, series, config);
    return {
      state,
      replayPoints,
      executions,
      recenterEvents,
      rangeAdjustmentEvents,
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
      openLots: [],
      recenterGuard: null,
      consecutiveOutsideCloses: 0,
      observedCandles: [],
      adaptiveBarsSinceLastEvaluation: 0
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
      executionFeeBps: Math.max(0, config.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS),
      executionCostSource: config.executionCostSource ?? "fixed_pessimistic",
      cooldownMs: Math.max(0, config.cooldownMs ?? strategyDefaults.cooldownMs),
      maxOrdersPerHour: Math.max(1, config.maxOrdersPerHour ?? strategyDefaults.maxOrdersPerHour),
      maxDrawdownPct: Math.max(0, config.maxDrawdownPct ?? 18),
      maxConsecutiveFailures: Math.max(1, config.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures),
      levelLockMs: Math.max(0, config.levelLockMs ?? strategyDefaults.levelLockMs),
      priceConfirmationWindowMs: Math.max(0, config.priceConfirmationWindowMs ?? strategyDefaults.priceConfirmationWindowMs),
      recenterMode: config.recenterMode ?? RecenterMode.Manual,
      rangeControlMode: config.rangeControlMode ?? "static",
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
    return this.gridDecisionService.getConfirmedSignal({
      botId: state.bot.id,
      botStatus: state.bot.status,
      latestStatus: state.status,
      pendingSignal: state.metadata.pendingSignal ?? null,
      currentPrice,
      now,
      levels,
      crossedSignals,
      priceConfirmationWindowMs: config.priceConfirmationWindowMs,
      canBuildOrder: (signal) => this.canBuildOrder(state, signal)
    });
  }

  private resolvePendingSignal(
    state: BacktestRuntimeState,
    crossedSignals: TriggerSignal[],
    levels: Array<{ index: number; price: number }>,
    currentPrice: number,
    now: Date,
    config: BacktestConfig
  ) {
    void config;
    return this.gridDecisionService.resolvePendingSignal({
      botId: state.bot.id,
      pendingSignal: state.metadata.pendingSignal ?? null,
      crossedSignals,
      levels,
      currentPrice,
      now,
      canBuildOrder: (signal) => this.canBuildOrder(state, signal)
    });
  }

  private getOutOfRangeRecoverySellSignal(
    state: BacktestRuntimeState,
    currentPrice: number,
    now: Date,
    levels: Array<{ index: number; price: number }>,
    crossedSignals: TriggerSignal[],
    config: BacktestConfig
  ): TriggerSignal | null {
    return this.gridDecisionService.getOutOfRangeRecoverySellSignal({
      botId: state.bot.id,
      botStatus: state.bot.status,
      latestStatus: state.status,
      pendingSignal: state.metadata.pendingSignal ?? null,
      currentPrice,
      now,
      levels,
      crossedSignals,
      priceConfirmationWindowMs: config.priceConfirmationWindowMs,
      canBuildOrder: (signal) => this.canBuildOrder(state, signal)
    });
  }

  private getOutOfRangeBoundaryBuySignal(
    state: BacktestRuntimeState,
    currentPrice: number,
    now: Date,
    levels: Array<{ index: number; price: number }>,
    crossedSignals: TriggerSignal[],
    config: BacktestConfig
  ): TriggerSignal | null {
    return this.gridDecisionService.getOutOfRangeBoundaryBuySignal({
      botId: state.bot.id,
      botStatus: state.bot.status,
      latestStatus: state.status,
      pendingSignal: state.metadata.pendingSignal ?? null,
      currentPrice,
      now,
      levels,
      crossedSignals,
      priceConfirmationWindowMs: config.priceConfirmationWindowMs,
      canBuildOrder: (signal) => this.canBuildOrder(state, signal)
    });
  }

  private canBuildOrder(state: BacktestRuntimeState, signal: TriggerSignal): boolean {
    if (signal.side === TradeSide.Buy && state.recenterGuard?.allowNewBuys === false) {
      return false;
    }

    if (signal.side === TradeSide.Sell && state.recenterGuard?.allowRecoverySells === false) {
      return false;
    }

    return Boolean(this.gridStrategyService.buildOrderIntent(this.toAggregate(state), signal));
  }

  private simulateExecution(signal: TriggerSignal, orderIntent: OrderIntent, config: BacktestConfig) {
    const report = this.executionCostModelService.simulate({
      side: signal.side,
      levelPrice: signal.levelPrice,
      requestedQuoteAmount: orderIntent.requestedQuoteAmount,
      requestedBaseAmount: orderIntent.requestedBaseAmount,
      maxSlippageBps: config.maxSlippageBps,
      executionFeeBps: config.executionFeeBps
    });

    return {
      executionId: `bt-${signal.side}-${signal.levelIndex}-${signal.triggeredAt.getTime()}`,
      inputAmount: report.inputAmount,
      outputAmount: report.outputAmount,
      feeAmount: report.feeAmount,
      fillPrice: report.fillPrice
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
      feeAmount: report.feeAmount,
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
      feeAmount: 0,
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
      const costQuote = round(report.inputAmount + report.feeAmount, 8);
      const entryPrice = report.outputAmount > 0 ? round(costQuote / report.outputAmount, 8) : levelPrice;
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
            costQuote,
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
    return side === TradeSide.Buy
      ? round(availableQuote - report.inputAmount - report.feeAmount, 8)
      : round(availableQuote + report.outputAmount - report.feeAmount, 8);
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

  private clearRecenterGuardWhenInside(state: BacktestRuntimeState, currentPrice: number) {
    if (!state.recenterGuard || this.isOutOfRange(state.config, currentPrice)) {
      return;
    }

    state.recenterGuard = null;
  }

  private maybeApplySimulatedRecenter(
    state: BacktestRuntimeState,
    candle: HistoricalCandle,
    phase: "train" | "validation",
    marketRegime: MarketRegimeAssessment | null
  ): BacktestRecenterEvent | null {
    if (state.config.recenterMode !== RecenterMode.Auto) {
      return null;
    }

    if (!this.isOutOfRange(state.config, candle.close)) {
      state.consecutiveOutsideCloses = 0;
      state.recenterGuard = null;
      return null;
    }

    state.consecutiveOutsideCloses += 1;
    const maxOccupancyPct = state.config.budgetUsd > 0 ? round((state.deployedQuoteAmount / state.config.budgetUsd) * 100, 8) : 0;
    const previousGuard = state.recenterGuard;
    const decision = this.recenterPolicyService.evaluate({
      currentPrice: candle.close,
      lowPrice: state.config.lowPrice,
      highPrice: state.config.highPrice,
      openCycleCount: state.openLots.length,
      maxOccupancyPct,
      consecutiveOutsideBars: state.consecutiveOutsideCloses,
      marketRegime
    });

    const nextGuard = {
      mode: decision.mode,
      side: decision.side,
      allowNewBuys: decision.allowNewBuys,
      allowRecoverySells: decision.allowRecoverySells
    };
    const guardUnchanged =
      previousGuard?.mode === nextGuard.mode &&
      previousGuard.side === nextGuard.side &&
      previousGuard.allowNewBuys === nextGuard.allowNewBuys &&
      previousGuard.allowRecoverySells === nextGuard.allowRecoverySells;

    state.recenterGuard = nextGuard;

    if ((decision.mode !== "hybrid" && decision.mode !== "hard") || decision.suggestedLowPrice === null || decision.suggestedHighPrice === null) {
      return null;
    }

    const previousLowPrice = state.config.lowPrice;
    const previousHighPrice = state.config.highPrice;
    const nextLowPrice = decision.suggestedLowPrice;
    const nextHighPrice = decision.suggestedHighPrice;
    const buildEvent = (applied: boolean, reason = decision.operatorAction): BacktestRecenterEvent => ({
      id: `recenter-${phase}-${candle.timestamp.getTime()}`,
      phase,
      timestamp: candle.timestamp,
      mode: decision.mode,
      side: decision.side,
      previousLowPrice,
      previousHighPrice,
      nextLowPrice,
      nextHighPrice,
      allowNewBuys: decision.allowNewBuys,
      allowRecoverySells: decision.allowRecoverySells,
      applied,
      risk: decision.risk,
      reason
    });

    if (state.openLots.length > 0) {
      if (guardUnchanged) {
        return null;
      }

      return buildEvent(
        false,
        `${decision.operatorAction} Guard-only in Lab v1 because open cycles keep their original exits.`
      );
    }

    state.config = {
      ...state.config,
      lowPrice: nextLowPrice,
      highPrice: nextHighPrice
    };
    state.metadata.pendingSignal = null;
    state.metadata.levelLocks = {};
    state.metadata.recenterHistory = [...state.metadata.recenterHistory, candle.timestamp.toISOString()].slice(-50);
    state.lastRecenterAt = candle.timestamp;
    state.consecutiveOutsideCloses = 0;

    return buildEvent(true);
  }

  private maybeApplyAdaptiveRangePlan(
    state: BacktestRuntimeState,
    candle: HistoricalCandle,
    phase: "train" | "validation"
  ): BacktestRangeAdjustmentEvent | null {
    if (state.config.rangeControlMode !== "adaptive") {
      return null;
    }

    if (state.observedCandles.length < ADAPTIVE_RANGE_MIN_CANDLES) {
      return null;
    }

    if (state.adaptiveBarsSinceLastEvaluation < ADAPTIVE_RANGE_REPLAN_BARS) {
      return null;
    }

    state.adaptiveBarsSinceLastEvaluation = 0;
    const indicators = this.indicatorService.compute(state.observedCandles);
    const latestIndicators = indicators.latest;
    if (!latestIndicators) {
      return null;
    }

    const marketRegime = this.marketRegimeService.assess(state.observedCandles, indicators);
    const rangePlan = this.rangePlanService.plan({
      currentPrice: candle.close,
      currentLowPrice: state.config.lowPrice,
      currentHighPrice: state.config.highPrice,
      currentLevelCount: state.config.levelCount,
      budgetUsd: state.config.budgetUsd,
      minOrderQuoteAmount:
        state.config.minOrderMode === MinOrderMode.Auto
          ? getSuggestedMinOrderQuoteAmount(state.config.budgetUsd, state.config.levelCount)
          : state.config.minOrderQuoteAmount,
      indicators: latestIndicators,
      marketRegime
    });

    if (rangePlan.risk === "high" || marketRegime.regime !== "RANGE" || marketRegime.confidence < 0.45) {
      state.recenterGuard = {
        mode: "soft",
        side: candle.close > state.config.highPrice ? "above" : candle.close < state.config.lowPrice ? "below" : "inside",
        allowNewBuys: false,
        allowRecoverySells: true
      };
      return null;
    }

    if (state.openLots.length > 0 || state.deployedQuoteAmount > 0) {
      return null;
    }

    const previousLowPrice = state.config.lowPrice;
    const previousHighPrice = state.config.highPrice;
    const previousLevelCount = state.config.levelCount;
    const previousGridType = state.config.gridType;
    const currentMid = (previousLowPrice + previousHighPrice) / 2;
    const currentWidth = previousHighPrice - previousLowPrice;
    const nextMid = (rangePlan.recommendedLowPrice + rangePlan.recommendedHighPrice) / 2;
    const nextWidth = rangePlan.recommendedHighPrice - rangePlan.recommendedLowPrice;
    const midMovePct = currentMid > 0 ? Math.abs(nextMid - currentMid) / currentMid * 100 : 0;
    const widthMovePct = currentWidth > 0 ? Math.abs(nextWidth - currentWidth) / currentWidth * 100 : 0;
    const structureChanged = previousLevelCount !== rangePlan.recommendedLevelCount || previousGridType !== rangePlan.recommendedGridType;

    if (!structureChanged && midMovePct < ADAPTIVE_RANGE_MIN_MOVE_PCT && widthMovePct < ADAPTIVE_RANGE_MIN_MOVE_PCT) {
      return null;
    }

    state.config = {
      ...state.config,
      lowPrice: rangePlan.recommendedLowPrice,
      highPrice: rangePlan.recommendedHighPrice,
      levelCount: rangePlan.recommendedLevelCount,
      gridType: rangePlan.recommendedGridType
    };
    state.metadata.pendingSignal = null;
    state.metadata.levelLocks = {};
    state.recenterGuard = null;

    return {
      id: `range-adjustment-${phase}-${candle.timestamp.getTime()}`,
      phase,
      timestamp: candle.timestamp,
      previousLowPrice,
      previousHighPrice,
      previousLevelCount,
      previousGridType,
      nextLowPrice: rangePlan.recommendedLowPrice,
      nextHighPrice: rangePlan.recommendedHighPrice,
      nextLevelCount: rangePlan.recommendedLevelCount,
      nextGridType: rangePlan.recommendedGridType,
      risk: rangePlan.risk,
      basis: rangePlan.basis,
      confidence: rangePlan.confidence,
      reason: rangePlan.operatorAction
    };
  }

  private summarizeMetrics(
    points: BacktestReplayPoint[],
    executions: BacktestReplayExecution[],
    recenterEvents: BacktestRecenterEvent[],
    rangeAdjustmentEvents: BacktestRangeAdjustmentEvent[],
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
    const timeInRangePct = computeTimeRatio(points, true);
    const timeOutOfRangePct = computeTimeRatio(points, false);
    const closedCycleCount = executions.filter((execution) => execution.status === OrderStatus.Simulated && execution.side === TradeSide.Sell).length;
    const openCycleCount = endState.openLots.length;
    const simulatedExecutions = executions.filter((execution) => execution.status === OrderStatus.Simulated);
    const executedBuyCount = simulatedExecutions.filter((execution) => execution.side === TradeSide.Buy).length;
    const executedSellCount = simulatedExecutions.filter((execution) => execution.side === TradeSide.Sell).length;
    const blockedOrderCount = executions.filter((execution) => execution.status === OrderStatus.Blocked).length;
    const simulatedOrderCount = simulatedExecutions.length;
    const recenterCount = recenterEvents.length;
    const rangeAdjustmentCount = rangeAdjustmentEvents.length;
    const totalFeesUsd = round(simulatedExecutions.reduce((sum, execution) => sum + execution.feeAmount, 0), 8);
    const averageSlippageBps = computeAverageSlippageBps(simulatedExecutions);

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
      blockedOrderCount,
      simulatedOrderCount,
      recenterCount,
      rangeAdjustmentCount,
      totalFeesUsd,
      averageSlippageBps
    };
  }

  private deriveRecenterAdvice(
    config: BacktestConfig,
    state: BacktestRuntimeState,
    replayPoints: BacktestReplayPoint[],
    candles: HistoricalCandle[],
    marketRegime: MarketRegimeAssessment | null
  ) {
    const fallbackPrice = candles.at(-1)?.close ?? config.lowPrice;
    const maxOccupancyPct = replayPoints.reduce((max, point) => Math.max(max, point.occupancyPct), 0);

    return this.recenterPolicyService.evaluate({
      currentPrice: state.currentPrice ?? fallbackPrice,
      lowPrice: state.config.lowPrice,
      highPrice: state.config.highPrice,
      openCycleCount: state.openLots.length,
      maxOccupancyPct,
      consecutiveOutsideBars: countTrailingOutsideCloses(candles, state.config),
      marketRegime
    });
  }

  private snapshotPoint(state: BacktestRuntimeState, timestamp: Date, phase: "train" | "validation"): BacktestReplayPoint {
    const drawdownPct = state.totalEquityUsd > 0 ? round(Math.max(0, ((state.config.budgetUsd - state.totalEquityUsd) / state.config.budgetUsd) * 100), 8) : 0;
    const occupancyPct = state.config.budgetUsd > 0 ? round((state.deployedQuoteAmount / state.config.budgetUsd) * 100, 8) : 0;

    return {
      timestamp,
      price: state.currentPrice ?? 0,
      phase,
      status: state.status,
      activeLowPrice: state.config.lowPrice,
      activeHighPrice: state.config.highPrice,
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

  private buildAssumptions(config: BacktestConfig): BacktestAssumptions {
    return {
      candleTraversal: "bullish_open_low_high_close_bearish_open_high_low_close",
      fillPolicy: "immediate_on_confirmed_level_cross_or_boundary_recovery",
      executionCostModel: "pessimistic_slippage_plus_fee",
      executionCostSource: config.executionCostSource ?? "fixed_pessimistic",
      maxSlippageBps: config.maxSlippageBps,
      executionFeeBps: config.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS,
      trainValidationSplit: 0.7,
      recenterMode: config.recenterMode,
      recenterScope: config.recenterMode === RecenterMode.Auto ? "simulated_when_auto_recenter" : "advisory_only",
      rangeControlMode: config.rangeControlMode === "adaptive" ? "adaptive_lab_only" : "static",
      outOfRangeModel: "pause_new_entries_allow_recovery_sells_and_single_l01_boundary_buy",
      excludedCosts: ["network fees", "rent", "priority fees", "failed transaction costs"],
      notes: [
        "Candle replay approximates intrabar order; it is not tick-level execution data.",
        "Ranking uses validation metrics before train metrics to reduce overfitting.",
        config.executionCostSource === "calibrated_live_fills"
          ? "Execution cost is calibrated from recent successful live fills for this pair."
          : "Execution cost uses the fixed pessimistic Lab default.",
        config.rangeControlMode === "adaptive"
          ? "Adaptive range is simulated in Lab only and only shifts rails while no open cycles are present."
          : "Range is static unless a Lab-only adaptive scenario is selected.",
        config.recenterMode === RecenterMode.Auto
          ? "Auto recenter is simulated in Lab only; it is not auto-applied to live bots."
          : "Recenter output is advisory in Lab unless a recenter simulation scenario is selected."
      ]
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
    return this.gridDecisionService.isOutOfRange(config.lowPrice, config.highPrice, price);
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
  executionCost?: BacktestExecutionCostOverride;
}): BacktestConfig {
  const strategyDefaults = STRATEGY_RUNTIME_DEFAULTS[input.strategyMode];
  const executionCost = input.executionCost;
  return {
    budgetUsd: round(input.budgetUsd, 2),
    lowPrice: round(input.lowPrice, 8),
    highPrice: round(input.highPrice, 8),
    levelCount: input.levelCount,
    gridType: input.gridType,
    strategyMode: input.strategyMode,
    rangeControlMode: "static",
    minOrderMode: MinOrderMode.Auto,
    minOrderQuoteAmount: round(input.minOrderQuoteAmount, 2),
    maxSlippageBps: Math.max(0, round(executionCost?.maxSlippageBps ?? 50, 2)),
    executionFeeBps: Math.max(0, round(executionCost?.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS, 2)),
    executionCostSource: executionCost?.source ?? "fixed_pessimistic",
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

function computeAverageSlippageBps(executions: BacktestReplayExecution[]) {
  const values = executions
    .map((execution) => {
      if (execution.targetPrice <= 0 || execution.fillPrice <= 0) {
        return null;
      }

      const diff =
        execution.side === TradeSide.Buy
          ? execution.fillPrice - execution.targetPrice
          : execution.targetPrice - execution.fillPrice;

      return Math.max(0, (diff / execution.targetPrice) * 10_000);
    })
    .filter((value): value is number => value !== null);

  if (values.length === 0) {
    return 0;
  }

  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 8);
}

function computeTimeRatio(points: BacktestReplayPoint[], inRange: boolean) {
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
    const currentlyInRange = current.price >= current.activeLowPrice && current.price <= current.activeHighPrice;
    if (currentlyInRange === inRange) {
      qualifyingMs += delta;
    }
  }

  if (totalMs === 0) {
    return inRange ? 100 : 0;
  }

  return round((qualifyingMs / totalMs) * 100, 8);
}

function countTrailingOutsideCloses(candles: HistoricalCandle[], config: Pick<BacktestConfig, "lowPrice" | "highPrice">) {
  let count = 0;

  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const close = candles[index]?.close;
    if (close === undefined || (close >= config.lowPrice && close <= config.highPrice)) {
      break;
    }

    count += 1;
  }

  return count;
}
