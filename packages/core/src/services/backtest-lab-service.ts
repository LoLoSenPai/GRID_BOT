import { DEFAULTS } from "@grid-bot/common";

import { BotMode, BotStatus, EntryMode, ExecutionProvider, GridType, MinOrderMode, OrderStatus, RecenterMode, StrategyMode, TradeSide } from "../domain/enums";
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
import { applyLotExecution, calculateNetSellPnl, isTradingLot, summarizeLots } from "./lot-accounting-service";
import { IndicatorService } from "./indicator-service";
import { MarketRegimeService } from "./market-regime-service";
import { RangePlanService } from "./range-plan-service";
import { ReboundZoneService, type ReboundRangeCandidate } from "./rebound-zone-service";
import { canApplyRangeChange, RecenterPolicyService } from "./recenter-policy-service";
import { evaluateFlatRecenter } from "./flat-recenter-service";
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
  rangeMethod?: "rebounds" | "distribution";
  strategyMode?: StrategyMode;
  maxDeployableUsd?: number;
  reserveQuoteAmount?: number;
  entryMode?: EntryMode;
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
  regimeBuyGuard: boolean;
  favorableRegimeEvaluations: number;
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
  const railCounts = [6, 10, 14];
  const candidates: BacktestConfig[] = [];

  for (const lowQuantile of lowQuantiles) {
    const lowPrice = round(quantile(sortedCloses, lowQuantile), 8);
    for (const highQuantile of highQuantiles.filter((value) => Math.abs(value + lowQuantile - 1) < 1e-8)) {
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

function generateReboundCandidates(ranges: ReboundRangeCandidate[], budgetUsd: number, strategyMode: StrategyMode,
  executionCost?: BacktestExecutionCostOverride): BacktestConfig[] {
  if (!Number.isFinite(budgetUsd) || budgetUsd < 10) return [];
  const candidates: BacktestConfig[] = [];
  // At most 18 candidates for the chosen objective. Geometry is not itself an edge.
  for (const range of ranges.slice(0, 3)) {
    for (const levelCount of [6, 10, 14]) {
      const minOrderQuoteAmount = getSuggestedMinOrderQuoteAmount(budgetUsd, levelCount);
      if (minOrderQuoteAmount < 5) continue;
      for (const gridType of [GridType.Arithmetic, GridType.Geometric]) {
        candidates.push(buildCandidateConfig({ budgetUsd, lowPrice: range.lowPrice, highPrice: range.highPrice,
          levelCount, gridType, strategyMode, minOrderQuoteAmount, executionCost }));
      }
    }
  }
  return candidates;
}

export function hasViableStep(config: BacktestConfig, natrPct: number): boolean {
  const slip = config.maxSlippageBps / 10_000;
  const fee = (config.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS) / 10_000;
  if (![slip, fee, config.lowPrice, config.highPrice, natrPct].every(Number.isFinite) ||
    slip < 0 || fee < 0 || slip >= 1 || fee >= 1 || config.lowPrice <= 0 || config.highPrice <= config.lowPrice || config.levelCount < 2) return false;
  const costFloorPct = (((1 + slip) * (1 + fee)) / ((1 - slip) * (1 - fee)) - 1) * 100;
  const minimumStepPct = Math.max(Math.max(0, natrPct) * 0.5, costFloorPct + 0.25);
  const step = (config.highPrice - config.lowPrice) / (config.levelCount - 1);
  const smallestStepPct = config.gridType === GridType.Geometric
    ? (Math.pow(config.highPrice / config.lowPrice, 1 / (config.levelCount - 1)) - 1) * 100
    : step / (config.highPrice - step) * 100;
  return smallestStepPct >= minimumStepPct;
}

export function compareBacktestLeaderboardEntries(left: BacktestLeaderboardEntry, right: BacktestLeaderboardEntry): number {
  // The last 30% is locked holdout: it must never influence rank or tie-breaking.
  const a = left.selectionMetrics ?? left.trainMetrics;
  const b = right.selectionMetrics ?? right.trainMetrics;
  return b.returnPct - a.returnPct || a.maxDrawdownPct - b.maxDrawdownPct ||
    a.timeOutOfRangePct - b.timeOutOfRangePct || b.closedCycleCount - a.closedCycleCount;

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

    const benchmarks = this.buildBenchmarks(prepared, config);
    const validationBenchmarks = this.buildBenchmarks({ ...prepared, candles: prepared.validationCandles }, {
      ...config, budgetUsd: continuousTrain.metrics.endingEquityUsd
    });
    const endPrice = prepared.candles.at(-1)!.close;
    const baseEquivalent = round(overallMetrics.endingEquityUsd / endPrice, 8);
    const buyAndHoldBaseEquivalent = round(benchmarks.buyAndHold.endingEquityUsd / endPrice, 8);

    return {
      series: prepared.series,
      config,
      benchmarks,
      validationBenchmarks,
      accumulation: {
        baseSymbol: prepared.series.symbol,
        heldBaseAmount: round(continuousValidation.state.availableBaseAmount, 8),
        retainedBaseAmount: round(continuousValidation.state.openLots.filter((lot) => lot.kind === "retained")
          .reduce((sum, lot) => sum + lot.remainingBaseAmount, 0), 8),
        baseEquivalent,
        buyAndHoldBaseEquivalent,
        excessBaseEquivalent: round(baseEquivalent - buyAndHoldBaseEquivalent, 8)
      },
      replayPoints,
      executions,
      recenterEvents,
      rangeAdjustmentEvents,
      recenterAdvice,
      trainMetrics: continuousTrain.metrics,
      validationMetrics: continuousValidation.metrics,
      overallMetrics,
      assumptions: this.buildAssumptions(config),
      meta: this.buildMeta(prepared)
    };
  }

  recommend(request: BacktestRecommendationRequest): BacktestRecommendation {
    const prepared = splitBacktestSeries(request.series);
    const trainingSeries = { ...prepared.series, candles: prepared.trainCandles };
    const selectionSplit = splitBacktestSeries(trainingSeries);
    const method = request.rangeMethod ?? "distribution";
    const strategyMode = request.strategyMode ?? (prepared.series.symbol.toUpperCase() === "BTC"
      ? StrategyMode.AccumulateBase : StrategyMode.AccumulateUsdc);
    const zoneAnalysis = method === "rebounds" ? new ReboundZoneService().analyze(selectionSplit.trainCandles) : null;
    const deployable = Math.max(0, Math.min(request.maxDeployableUsd ?? request.budgetUsd, request.budgetUsd - (request.reserveQuoteAmount ?? 0)));
    const rawCandidates = method === "rebounds"
      ? generateReboundCandidates(zoneAnalysis?.ranges ?? [], deployable, strategyMode, request.executionCost)
      : generateBacktestCandidates(trainingSeries, deployable, request.executionCost).filter((config) => config.strategyMode === strategyMode);
    const natrPct = this.indicatorService.compute(selectionSplit.trainCandles).latest?.atrPct14 ?? 0;
    const candidates = rawCandidates.filter((config) => hasViableStep(config, natrPct)).map((config) => ({ ...config,
      budgetUsd: request.budgetUsd, maxDeployableUsd: deployable,
      minOrderQuoteAmount: Math.min(config.minOrderQuoteAmount,
        Math.floor(deployable / (config.levelCount - 1) / (1 + (config.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS) / 10_000) * 1e8) / 1e8),
      reserveQuoteAmount: request.reserveQuoteAmount ?? 0, entryMode: request.entryMode ?? EntryMode.Normal }));
    if (!candidates.length) throw new Error(method === "rebounds"
      ? `No launch: no repeated-rebound range meets the independent-touch, volatility, cost and budget requirements. ${zoneAnalysis?.reasons.join(" ") ?? ""}`
      : "No launch: no distribution range meets the volatility, cost and budget requirements for this objective.");

    const ranked = candidates.map((candidate) => {
      const config = this.normalizeConfig(candidate);
      const fitting = this.simulateSegment(trainingSeries, config, selectionSplit.trainCandles, "train");
      const selection = this.simulateSegment(trainingSeries, config, selectionSplit.validationCandles, "train", fitting.state);
      return { rank: 0, config, trainMetrics: fitting.metrics, selectionMetrics: selection.metrics,
        validationMetrics: selection.metrics };
    }).sort(compareBacktestLeaderboardEntries);
    // Freeze order before accessing holdout, including for the displayed runners-up.
    const topFive = ranked.slice(0, 5).map((entry, index) => {
      const replay = this.replay({ series: prepared.series, config: entry.config });
      return { ...entry, rank: index + 1, trainMetrics: replay.trainMetrics,
        validationMetrics: replay.validationMetrics, replay };
    });
    const best = topFive[0]!;
    const bestReplay = best.replay;
    const insufficient = prepared.validationCandles.length < 30 || best.validationMetrics.closedCycleCount < 5;
    const profitable = best.validationMetrics.returnPct > 0;
    const latestClose = prepared.candles.at(-1)!.close;
    const stillInRange = latestClose >= best.config.lowPrice && latestClose <= best.config.highPrice;
    const objectiveSatisfied = strategyMode !== StrategyMode.AccumulateBase ||
      best.validationMetrics.endingEquityUsd > bestReplay.validationBenchmarks!.buyAndHold.endingEquityUsd;
    const stressConfig = { ...best.config, maxSlippageBps: best.config.maxSlippageBps * 2,
      executionFeeBps: (best.config.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS) * 2 };
    // One replay of the already selected configuration. Stress never reranks candidates.
    const stressReplay = this.replay({ series: prepared.series, config: stressConfig });
    const stressProfitable = stressReplay.validationMetrics.returnPct > 0;
    const stressObjectiveSatisfied = strategyMode !== StrategyMode.AccumulateBase ||
      stressReplay.validationMetrics.endingEquityUsd > stressReplay.validationBenchmarks!.buyAndHold.endingEquityUsd;
    const stressSufficient = prepared.validationCandles.length >= 30 && stressReplay.validationMetrics.closedCycleCount >= 5;
    const costStress = {
      maxSlippageBps: stressConfig.maxSlippageBps, executionFeeBps: stressConfig.executionFeeBps,
      validationMetrics: stressReplay.validationMetrics, overallMetrics: stressReplay.overallMetrics,
      passed: stressProfitable && stressObjectiveSatisfied && stressSufficient,
      reasons: [
        "Same selected configuration, doubled slippage and fees; no reranking after holdout.",
        stressProfitable ? "Positive net holdout under doubled costs." : "The doubled-cost holdout did not beat cash.",
        ...(strategyMode === StrategyMode.AccumulateBase ? [stressObjectiveSatisfied
          ? "The stress holdout beats a fresh buy-and-hold allocation of the same starting equity and reserve."
          : "The stress holdout does not beat the matched-capital buy-and-hold reference."] : []),
        ...(stressSufficient ? [] : ["Stress evidence is insufficient: fewer than 30 holdout candles or five closed cycles."])
      ]
    };
    const rejected = !stillInRange || !profitable || !objectiveSatisfied || !stressProfitable || !stressObjectiveSatisfied;
    const eligibility: NonNullable<BacktestRecommendation["eligibility"]> = {
      status: rejected ? "no_launch" : insufficient || !stressSufficient ? "insufficient_evidence" : "paper_candidate",
      reasons: [
        !stillInRange ? "The latest closed price is outside the fitted range; no launch recommendation."
          : !profitable ? "The locked holdout did not beat cash; no new launch is justified by this test."
          : !objectiveSatisfied ? "The BTC accumulation objective does not beat the matched-capital hold reference on holdout."
          : !stressProfitable || !stressObjectiveSatisfied ? "The selected configuration fails the frozen doubled-cost stress; no launch recommendation."
          : insufficient ? "Fewer than 30 holdout candles or five closed cycles: evidence is insufficient."
          : !stressSufficient ? "The doubled-cost stress has too few closed cycles for a paper recommendation."
          : "Positive locked holdout supports paper observation only, not a claim of future profitability.",
        "Candidates were generated from early training and ranked on a later training window; final holdout never affects rank."
      ]
    };
    const guidance = deriveBacktestOperatorGuidance(best.validationMetrics, prepared.series.resolution, bestReplay.recenterAdvice);
    return {
      rangeEvidence: {
        method, fittingFrom: selectionSplit.trainCandles[0]!.timestamp,
        fittingTo: selectionSplit.trainCandles.at(-1)!.timestamp,
        selected: zoneAnalysis?.ranges.find((range) => Math.abs(range.lowPrice - best.config.lowPrice) < 1e-7 && Math.abs(range.highPrice - best.config.highPrice) < 1e-7),
        reasons: zoneAnalysis?.reasons ?? ["Distribution baseline: bounds come from fitting-price quantiles, not repeated rebound detection."]
      },
      costStress,
      bestConfig: best.config,
      leaderboard: topFive.map(({ replay: _replay, ...entry }) => entry),
      bestReplay,
      eligibility,
      recenterAdvice: bestReplay.recenterAdvice,
      trainMetrics: best.trainMetrics,
      validationMetrics: best.validationMetrics,
      operatorGuidance: { ...guidance, status: eligibility.status === "no_launch" ? "Fragile" : "Caution",
        summary: eligibility.reasons[0]!,
        ...(eligibility.status !== "paper_candidate" ? {
          stopRule: "No new launch is recommended by this test.",
          recenterAction: "Recentering does not override missing evidence or failed cost stress."
        } : {}) },
      assumptions: bestReplay.assumptions,
      meta: { ...bestReplay.meta, candidateCount: candidates.length, evaluatedCount: ranked.length }
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
    const startingEquityUsd = state.totalEquityUsd;
    const startingRealizedPnlUsd = state.realizedPnlUsd;
    const startingUnrealizedPnlUsd = state.unrealizedPnlUsd;

    if (candles.length === 0) {
      const metrics = this.summarizeMetrics([], [], [], [], config.budgetUsd, state, series, config);
      return { state, replayPoints: [], executions: [], recenterEvents: [], rangeAdjustmentEvents: [], metrics };
    }

    const resolution = series.resolution?.match(/^(\d+)(m|h|d)$/);
    const intervalMs = resolution
      ? Number(resolution[1]) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[resolution[2]!] ?? 1)
      : this.candleReplayService.estimateIntervalMs(series.candles.slice(0, 2));
    const replayPoints: BacktestReplayPoint[] = [];
    const executions: BacktestReplayExecution[] = [];
    const recenterEvents: BacktestRecenterEvent[] = [];
    const rangeAdjustmentEvents: BacktestRangeAdjustmentEvent[] = [];
    let previousObservedPrice = state.currentPrice ?? candles[0]!.open;

    candles.forEach((candle) => {
      const path = this.candleReplayService.buildIntrabougiePath(candle, intervalMs);
      path.forEach((step) => {
        const activeConfig = state.config;
        const workerFlatAuto = activeConfig.recenterMode === RecenterMode.Auto && activeConfig.recenterModel === "worker_flat";
        const levels = this.gridStrategyService.calculateLevels(activeConfig.lowPrice, activeConfig.highPrice, activeConfig.levelCount, activeConfig.gridType);
        state.currentPrice = step.price;
        state.bot.currentPrice = step.price;
        state.status = this.getPassiveStatus(state, step.timestamp);
        state.bot.status = state.status;
        this.clearRecenterGuardWhenInside(state, step.price);

        if (workerFlatAuto && (state.status === BotStatus.Paused || state.status === BotStatus.Stopped)) {
          this.recalculatePortfolioState(state, step.price);
          replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
          previousObservedPrice = step.price;
          return;
        }

        const crossedSignals = previousObservedPrice !== null ? this.gridStrategyService.detectCrossedLevels(levels, previousObservedPrice, step.price) : [];
        const outOfRange = this.isOutOfRange(activeConfig, step.price);

        // The live worker clears an outside timer as soon as price re-enters and
        // returns from that tick. Preserve that lifecycle in synthetic replay.
        if (workerFlatAuto && !outOfRange && state.metadata.outsideSince) {
          state.metadata.outsideSince = null;
          state.metadata.outsideSide = null;
          state.metadata.outsideSourceObservedAt = null;
          state.recenterGuard = null;
          const resumedStatus = state.status === BotStatus.Paused || state.status === BotStatus.Stopped ? state.status : BotStatus.Running;
          state.status = resumedStatus;
          state.bot.status = resumedStatus;
          this.recalculatePortfolioState(state, step.price);
          replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
          previousObservedPrice = step.price;
          return;
        }
        const signal =
          outOfRange && step.price < activeConfig.lowPrice && !workerFlatAuto
            ? this.getOutOfRangeBoundaryBuySignal(state, step.price, step.timestamp, levels, crossedSignals, activeConfig)
            : outOfRange && step.price > activeConfig.highPrice
              ? this.getOutOfRangeRecoverySellSignal(state, step.price, step.timestamp, levels, crossedSignals, activeConfig)
              : outOfRange && workerFlatAuto
                ? null
              : this.getConfirmedSignalFromState(state, step.price, step.timestamp, levels, crossedSignals, activeConfig);

        if (workerFlatAuto && outOfRange && !signal) {
          const recenterEvent = this.applyWorkerFlatRecenterStep(state, step.price, step.timestamp, phase);
          if (recenterEvent) {
            recenterEvents.push(recenterEvent);
          }
          this.recalculatePortfolioState(state, step.price);
          replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
          previousObservedPrice = step.price;
          return;
        }

        if (outOfRange && !signal) {
          state.status = BotStatus.OutOfRange;
          state.bot.status = BotStatus.OutOfRange;
          state.metadata.pendingSignal = this.resolvePendingSignal(state, crossedSignals, levels, step.price, step.timestamp, activeConfig);
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

          if (signal.side === TradeSide.Buy) {
            const capacity = Math.max(0, Math.min(
              state.availableQuoteAmount - (activeConfig.reserveQuoteAmount ?? 0),
              (activeConfig.maxDeployableUsd ?? activeConfig.budgetUsd) - state.deployedQuoteAmount
            ));
            const feeFactor = 1 + (activeConfig.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS) / 10_000;
            orderIntent.requestedQuoteAmount = Math.floor(Math.min(orderIntent.requestedQuoteAmount, capacity / feeFactor) * 1e8) / 1e8;
            if (orderIntent.requestedQuoteAmount <= 0 ||
                (activeConfig.minOrderMode === MinOrderMode.Manual && orderIntent.requestedQuoteAmount < activeConfig.minOrderQuoteAmount)) {
              executions.push(this.createBlockedExecution(signal, orderIntent, step.timestamp, phase, ["Insufficient deployable cash after reserving execution fees."]));
              state.metadata.pendingSignal = null;
              this.recalculatePortfolioState(state, step.price);
              replayPoints.push(this.snapshotPoint(state, step.timestamp, phase));
              previousObservedPrice = step.price;
              return;
            }
          }
          this.recalculatePortfolioState(state, step.price);
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
          const netSellPnl = signal.side === TradeSide.Sell
            ? calculateNetSellPnl(state.openLots, orderIntent.matchedLotIds, report.inputAmount, report.outputAmount, report.feeAmount, activeConfig.strategyMode) : 0;
          if (signal.side === TradeSide.Sell && (netSellPnl === null || netSellPnl < -1e-8)) {
            executions.push(this.createBlockedExecution(signal, orderIntent, step.timestamp, phase, ["Expected net sell output does not recover matched trading cost after fees."]));
            state.metadata.pendingSignal = null;
          } else {
            executions.push(this.applyExecution(state, signal, orderIntent, report, step.timestamp, phase));
          }
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

      const closedCandle = { ...candle, timestamp: new Date(candle.timestamp.getTime() + intervalMs) };
      const adaptiveRangeEvent = this.maybeApplyAdaptiveRangePlan(state, closedCandle, phase);
      if (adaptiveRangeEvent) {
        rangeAdjustmentEvents.push(adaptiveRangeEvent);
      }

      const recenterEvent = state.config.recenterModel === "worker_flat"
        ? null
        : this.maybeApplySimulatedRecenter(state, closedCandle, phase, this.assessObservedRegime(state));
      if (recenterEvent) {
        recenterEvents.push(recenterEvent);
      }
    });

    const metrics = this.summarizeMetrics(replayPoints, executions, recenterEvents, rangeAdjustmentEvents, startingEquityUsd, state, series, config);
    metrics.realizedPnlUsd = round(state.realizedPnlUsd - startingRealizedPnlUsd, 8);
    metrics.unrealizedPnlUsd = round(state.unrealizedPnlUsd - startingUnrealizedPnlUsd, 8);
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
      regimeBuyGuard: false,
      favorableRegimeEvaluations: 0,
      recenterGuard: null,
      consecutiveOutsideCloses: 0,
      observedCandles: [],
      adaptiveBarsSinceLastEvaluation: 0
    };
  }

  private normalizeConfig(config: BacktestConfig): BacktestConfig {
    const strategyDefaults = STRATEGY_RUNTIME_DEFAULTS[config.strategyMode];
    const rangeControlMode = config.rangeControlMode ?? "static";
    return {
      ...config,
      budgetUsd: Math.max(0, round(config.budgetUsd, 2)),
      reserveQuoteAmount: Math.max(0, Math.min(config.budgetUsd, config.reserveQuoteAmount ?? 0)),
      maxDeployableUsd: Math.max(0, Math.min(config.budgetUsd - (config.reserveQuoteAmount ?? 0), config.maxDeployableUsd ?? config.budgetUsd)),
      entryMode: config.entryMode ?? EntryMode.Normal,
      autoRecenterMinIntervalMs: Math.max(0, config.autoRecenterMinIntervalMs ?? DEFAULTS.autoRecenterMinIntervalMs),
      autoRecenterMaxPerDay: Math.max(0, config.autoRecenterMaxPerDay ?? DEFAULTS.autoRecenterMaxPerDay),
      minOrderMode: config.minOrderMode ?? MinOrderMode.Auto,
      minOrderQuoteAmount: Math.max(0, round(config.minOrderQuoteAmount, 2)),
      maxSlippageBps: Math.max(0, config.maxSlippageBps),
      executionFeeBps: Math.max(0, config.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS),
      executionCostSource: config.executionCostSource ?? "fixed_pessimistic",
      recenterModel: rangeControlMode === "adaptive" ? "candle_defense" : config.recenterModel ?? "worker_flat",
      cooldownMs: Math.max(0, config.cooldownMs ?? strategyDefaults.cooldownMs),
      maxOrdersPerHour: Math.max(1, config.maxOrdersPerHour ?? strategyDefaults.maxOrdersPerHour),
      maxDrawdownPct: Math.max(0, config.maxDrawdownPct ?? 18),
      maxConsecutiveFailures: Math.max(1, config.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures),
      levelLockMs: Math.max(0, config.levelLockMs ?? strategyDefaults.levelLockMs),
      priceConfirmationWindowMs: Math.max(0, config.priceConfirmationWindowMs ?? strategyDefaults.priceConfirmationWindowMs),
      recenterMode: config.recenterMode ?? RecenterMode.Manual,
      rangeControlMode,
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
    if (signal.side === TradeSide.Buy && (state.regimeBuyGuard || state.recenterGuard?.allowNewBuys === false)) {
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
      levelPrice: signal.observedPrice,
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
    const lotUpdate = applyLotExecution({ lots: state.openLots, botId: state.bot.id, strategyMode: state.bot.strategyMode,
      side: signal.side, report, matchedLotIds: orderIntent.matchedLotIds, levelPrice: orderIntent.targetPrice, now });
    state.openLots = lotUpdate.lots;
    state.availableQuoteAmount = this.computeAvailableQuote(state.availableQuoteAmount, signal.side, report);
    state.availableBaseAmount = this.computeAvailableBase(state.availableBaseAmount, signal.side, report);
    state.realizedPnlUsd = round(state.realizedPnlUsd + lotUpdate.realizedPnlDelta, 8);
    this.recalculatePortfolioState(state, state.currentPrice ?? orderIntent.targetPrice);
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
    state.metadata.recentExecutions = [...state.metadata.recentExecutions, now.toISOString()].filter((time) => now.getTime() - new Date(time).getTime() < 3_600_000);
    state.consecutiveFailures = 0;

    return {
      id: `replay-${signal.side}-${signal.levelIndex}-${now.getTime()}`,
      orderKey: orderIntent.orderKey,
      phase,
      side: signal.side,
      levelIndex: signal.levelIndex,
      targetPrice: orderIntent.targetPrice,
      observedPrice: signal.observedPrice,
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
      if ((cycle.sellLevelIndex === signal.levelIndex || matchedLotIds.has(cycle.lotId)) &&
          !state.openLots.some((lot) => lot.id === cycle.lotId && lot.kind !== "retained")) {
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
    const summary = summarizeLots(state.openLots, currentPrice);
    state.deployedQuoteAmount = summary.tradingCostQuote;
    state.averageEntryPrice = summary.averageEntryPrice;
    state.unrealizedPnlUsd = summary.unrealizedPnlUsd;
    state.totalEquityUsd = round(state.availableQuoteAmount + state.availableBaseAmount * currentPrice, 8);
    state.metadata.equityHighWatermarkUsd = Math.max(state.metadata.equityHighWatermarkUsd ?? state.config.budgetUsd, state.totalEquityUsd);
  }

  private clearRecenterGuardWhenInside(state: BacktestRuntimeState, currentPrice: number) {
    if (!state.recenterGuard || this.isOutOfRange(state.config, currentPrice)) {
      return;
    }

    state.recenterGuard = null;
  }

  private applyWorkerFlatRecenterStep(
    state: BacktestRuntimeState,
    currentPrice: number,
    now: Date,
    phase: "train" | "validation"
  ): BacktestRecenterEvent | null {
    const decision = evaluateFlatRecenter({
      lowPrice: state.config.lowPrice,
      highPrice: state.config.highPrice,
      currentPrice,
      now,
      confirmationMs: state.config.priceConfirmationWindowMs,
      outsideSince: state.metadata.outsideSince ?? null,
      outsideSide: state.metadata.outsideSide ?? null,
      outsideSourceObservedAt: state.metadata.outsideSourceObservedAt ?? null,
      currentObservationId: now.toISOString(),
      requireSourceAdvance: false,
      lastRecenterAt: state.lastRecenterAt,
      recenterHistory: state.metadata.recenterHistory,
      minIntervalMs: state.config.autoRecenterMinIntervalMs ?? DEFAULTS.autoRecenterMinIntervalMs,
      maxPerDay: state.config.autoRecenterMaxPerDay ?? DEFAULTS.autoRecenterMaxPerDay,
      openTradingLotCount: state.openLots.filter(isTradingLot).length,
      unresolvedExecution: false
    });

    if (decision.action === "inside") {
      state.metadata.outsideSince = null;
      state.metadata.outsideSide = null;
      state.metadata.outsideSourceObservedAt = null;
      state.recenterGuard = null;
      const resumedStatus = state.status === BotStatus.Paused || state.status === BotStatus.Stopped ? state.status : BotStatus.Running;
      state.status = resumedStatus;
      state.bot.status = resumedStatus;
      return null;
    }

    if (decision.action !== "recenter") {
      state.metadata.outsideSince = decision.outsideSince;
      state.metadata.outsideSide = decision.outsideSide;
      state.metadata.outsideSourceObservedAt = decision.outsideSourceObservedAt;
      state.recenterGuard = decision.side
        ? { mode: "soft", side: decision.side, allowNewBuys: false, allowRecoverySells: true }
        : null;
      state.status = BotStatus.OutOfRange;
      state.bot.status = BotStatus.OutOfRange;
      return null;
    }

    if (decision.suggestedLowPrice === null || decision.suggestedHighPrice === null || decision.side === null) {
      return null;
    }

    const previousLowPrice = state.config.lowPrice;
    const previousHighPrice = state.config.highPrice;
    state.config = {
      ...state.config,
      lowPrice: decision.suggestedLowPrice,
      highPrice: decision.suggestedHighPrice
    };
    state.metadata.outsideSince = null;
    state.metadata.outsideSide = null;
    state.metadata.outsideSourceObservedAt = null;
    state.metadata.pendingSignal = null;
    state.metadata.levelLocks = {};
    state.metadata.gridCycles = {};
    const today = now.toISOString().slice(0, 10);
    state.metadata.recenterHistory = [
      ...state.metadata.recenterHistory.filter((time) => time.slice(0, 10) === today),
      now.toISOString()
    ];
    state.lastRecenterAt = now;
    state.recenterGuard = null;
    const resumedStatus = state.status === BotStatus.Paused || state.status === BotStatus.Stopped ? state.status : BotStatus.Running;
    state.status = resumedStatus;
    state.bot.status = resumedStatus;

    return {
      id: `recenter-${phase}-${now.getTime()}`,
      phase,
      timestamp: now,
      mode: "hybrid",
      side: decision.side,
      previousLowPrice,
      previousHighPrice,
      nextLowPrice: decision.suggestedLowPrice,
      nextHighPrice: decision.suggestedHighPrice,
      allowNewBuys: false,
      allowRecoverySells: true,
      applied: true,
      risk: "medium",
      reason: decision.reason
    };
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
      openCycleCount: state.openLots.filter((lot) => lot.kind !== "retained").length,
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

    if (state.openLots.filter((lot) => lot.kind !== "retained").length > 0) {
      if (guardUnchanged) {
        return null;
      }

      return buildEvent(
        false,
        `${decision.operatorAction} Guard-only in Lab v1 because open cycles keep their original exits.`
      );
    }

    if (!this.canChangeRange(state, candle.timestamp)) return buildEvent(false, "Range change deferred by the shared interval or daily limit.");
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
      budgetUsd: state.config.maxDeployableUsd ?? state.config.budgetUsd,
      maxSlippageBps: state.config.maxSlippageBps,
      executionFeeBps: state.config.executionFeeBps,
      minOrderQuoteAmount:
        state.config.minOrderMode === MinOrderMode.Auto
          ? getSuggestedMinOrderQuoteAmount(state.config.maxDeployableUsd ?? state.config.budgetUsd, state.config.levelCount)
          : state.config.minOrderQuoteAmount,
      indicators: latestIndicators,
      marketRegime
    });

    if (rangePlan.risk === "high" || marketRegime.regime !== "RANGE" || marketRegime.confidence < 0.45) {
      state.regimeBuyGuard = true;
      state.favorableRegimeEvaluations = 0;
      return null;
    }
    // A tick inside range cannot lift regime defense; require two favorable closed-bar evaluations.
    state.favorableRegimeEvaluations += 1;
    if (state.regimeBuyGuard && state.favorableRegimeEvaluations < 2) return null;
    state.regimeBuyGuard = false;

    if (state.openLots.filter((lot) => lot.kind !== "retained").length > 0 || state.deployedQuoteAmount > 0) {
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

    if (!this.canChangeRange(state, candle.timestamp)) return null;
    state.lastRecenterAt = candle.timestamp;
    state.metadata.recenterHistory = [...state.metadata.recenterHistory, candle.timestamp.toISOString()];
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
    const totalPnlUsd = round(endingEquityUsd - startingBudgetUsd, 8);
    const returnPct = startingBudgetUsd > 0 ? round(((endingEquityUsd - startingBudgetUsd) / startingBudgetUsd) * 100, 8) : 0;
    const maxDrawdownPct = computeMaxDrawdownPct(points, startingBudgetUsd);
    const maxOccupancyPct = points.reduce((max, point) => Math.max(max, point.occupancyPct), 0);
    const timeInRangePct = computeTimeRatio(points, true);
    const timeOutOfRangePct = computeTimeRatio(points, false);
    const closedCycleCount = executions.filter((execution) => execution.status === OrderStatus.Simulated && execution.side === TradeSide.Sell).length;
    const openCycleCount = endState.openLots.filter((lot) => lot.kind !== "retained").length;
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
      openCycleCount: state.openLots.filter((lot) => lot.kind !== "retained").length,
      maxOccupancyPct,
      consecutiveOutsideBars: countTrailingOutsideCloses(candles, state.config),
      marketRegime: this.assessObservedRegime(state)
    });
  }

  private snapshotPoint(state: BacktestRuntimeState, timestamp: Date, phase: "train" | "validation"): BacktestReplayPoint {
    const peak = Math.max(state.metadata.equityHighWatermarkUsd ?? state.config.budgetUsd, state.totalEquityUsd);
    const drawdownPct = peak > 0 ? round(Math.max(0, ((peak - state.totalEquityUsd) / peak) * 100), 8) : 0;
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
      retainedBaseAmount: round(state.openLots.filter((lot) => lot.kind === "retained")
        .reduce((sum, lot) => sum + lot.remainingBaseAmount, 0), 8),
      deployedQuoteAmount: state.deployedQuoteAmount,
      realizedPnlUsd: state.realizedPnlUsd,
      unrealizedPnlUsd: state.unrealizedPnlUsd,
      totalEquityUsd: state.totalEquityUsd,
      drawdownPct,
      occupancyPct
    };
  }

  private canChangeRange(state: BacktestRuntimeState, now: Date) {
    return canApplyRangeChange({ now, lastRecenterAt: state.lastRecenterAt,
      recenterHistory: state.metadata.recenterHistory,
      minIntervalMs: state.config.autoRecenterMinIntervalMs ?? DEFAULTS.autoRecenterMinIntervalMs,
      maxPerDay: state.config.autoRecenterMaxPerDay ?? DEFAULTS.autoRecenterMaxPerDay,
      openCycleCount: state.openLots.filter((lot) => lot.kind !== "retained").length });
  }

  private assessObservedRegime(state: BacktestRuntimeState) {
    return this.marketRegimeService.assess(state.observedCandles, this.indicatorService.compute(state.observedCandles));
  }

  private buildBenchmarks(prepared: PreparedSeries, config: BacktestConfig) {
    const first = prepared.candles[0]!.open;
    const last = prepared.candles.at(-1)!.close;
    const deployable = config.entryMode === EntryMode.SellOnly ? 0 : Math.max(0, Math.min(
      config.maxDeployableUsd ?? config.budgetUsd, config.budgetUsd - (config.reserveQuoteAmount ?? 0)));
    const spend = deployable / (1 + (config.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS) / 10_000);
    const tokens = spend / (first * (1 + config.maxSlippageBps / 10_000));
    const endingEquityUsd = round(config.budgetUsd - deployable + tokens * last, 8);
    return { cash: { endingEquityUsd: config.budgetUsd, returnPct: 0 },
      buyAndHold: { endingEquityUsd, returnPct: config.budgetUsd > 0 ? round((endingEquityUsd / config.budgetUsd - 1) * 100, 8) : 0 } };
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
      recenterModel: config.recenterModel,
      recenterScope: config.recenterMode === RecenterMode.Auto ? "simulated_when_auto_recenter" : "advisory_only",
      rangeControlMode: config.rangeControlMode === "adaptive" ? "adaptive_lab_only" : "static",
      outOfRangeModel: config.recenterMode === RecenterMode.Auto && config.recenterModel === "worker_flat"
        ? "pause_new_entries_allow_recovery_sells"
        : "pause_new_entries_allow_recovery_sells_and_single_l01_boundary_buy",
      excludedCosts: ["network fees", "rent", "priority fees", "failed transaction costs"],
      notes: [
        "Candle replay approximates intrabar order; it is not tick-level execution data.",
        "Ranking uses chronological selection within training only. The last 30% is a locked continuation holdout with carried lots and equity baseline.",
        "Signals fill at the observed price plus estimated costs; four OHLC observations cannot reproduce tick fills or latency.",
        "Replay starts in cash with no imported inventory; sell-only therefore cannot sell pre-existing wallet tokens.",
        config.recenterMode === RecenterMode.Manual
          ? "Manual mode keeps fixed rails and permits the worker's single lower-boundary buy and upper recovery exits."
          : config.recenterModel === "worker_flat"
            ? "Auto recenter shares the worker's flat-inventory decision, timing and frequency limits, evaluated at synthetic OHLC steps; live source freshness is not reproduced."
            : "Experimental candle-defense recenter evaluates regime and occupancy at candle close; it differs from worker auto-center.",
        config.executionCostSource === "calibrated_live_fills"
          ? "Execution cost is calibrated from recent successful live fills for this pair."
          : "Execution cost uses the fixed pessimistic Lab default.",
        config.rangeControlMode === "adaptive"
          ? "Adaptive range is simulated in Lab only and only shifts rails while no open cycles are present."
          : config.recenterMode === RecenterMode.Auto
            ? "Range width stays fixed while the selected recenter model may move its bounds."
            : "Range bounds remain fixed for this replay.",
        config.recenterMode === RecenterMode.Auto
          ? config.recenterModel === "worker_flat"
            ? "Worker-flat auto recenter is simulated in Lab only with synthetic OHLC observation times; it is not auto-applied to live bots."
            : "Candle-defense auto recenter is simulated in Lab only; it is not auto-applied to live bots."
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
        maxDeployableUsd: state.config.maxDeployableUsd ?? state.config.budgetUsd,
        reserveQuoteAmount: state.config.reserveQuoteAmount ?? 0,
        entryMode: state.config.entryMode,
        lowPrice: state.config.lowPrice,
        highPrice: state.config.highPrice,
        levelCount: state.config.levelCount,
        gridType: state.config.gridType,
        minOrderQuoteAmount:
          state.config.minOrderMode === MinOrderMode.Auto
            ? getSuggestedMinOrderQuoteAmount(state.config.maxDeployableUsd ?? state.config.budgetUsd, state.config.levelCount)
            : state.config.minOrderQuoteAmount,
        maxSlippageBps: state.config.maxSlippageBps,
        executionFeeBps: state.config.executionFeeBps,
        cooldownMs: state.config.cooldownMs,
        maxOrdersPerHour: state.config.maxOrdersPerHour,
        maxDrawdownPct: state.config.maxDrawdownPct,
        maxConsecutiveFailures: state.config.maxConsecutiveFailures,
        levelLockMs: state.config.levelLockMs,
        priceConfirmationWindowMs: state.config.priceConfirmationWindowMs,
        recenterMode: state.config.recenterMode,
        autoRecenterMinIntervalMs: state.config.autoRecenterMinIntervalMs ?? DEFAULTS.autoRecenterMinIntervalMs,
        autoRecenterMaxPerDay: state.config.autoRecenterMaxPerDay ?? DEFAULTS.autoRecenterMaxPerDay,
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
          ? execution.fillPrice - (execution.observedPrice ?? execution.targetPrice)
          : (execution.observedPrice ?? execution.targetPrice) - execution.fillPrice;

      return Math.max(0, (diff / (execution.observedPrice ?? execution.targetPrice)) * 10_000);
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
