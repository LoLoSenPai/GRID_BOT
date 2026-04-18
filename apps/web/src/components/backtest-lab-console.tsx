"use client";

import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Play, RotateCcw } from "lucide-react";
import { GridType, MinOrderMode, RecenterMode, StrategyMode } from "@grid-bot/core/enums";

import { BacktestEquityChart } from "@/components/backtest-equity-chart";
import { BotPriceChart } from "@/components/bot-price-chart";
import { TimeRangeTabs } from "@/components/time-range-tabs";
import {
  LAB_LOOKBACK_OPTIONS,
  LAB_PAIR_OPTIONS,
  LAB_RESOLUTION_OPTIONS,
  type BacktestReplayRequestBody,
  type LabLookbackDays,
  type LabPair,
  type LabResolution
} from "@/lib/backtest-lab";
import { BOT_PAIR_PRESETS, getSuggestedMinOrderQuoteAmount, normalizeBotDraftCapital, type BotFormDraft } from "@/lib/bot-management";
import { calculateGridLevels } from "@/lib/bot-runtime";
import { formatGoalLabel, formatTradeMarkerLabel } from "@/lib/trade-display";
import { cn, formatCurrency, formatNumber, formatPercent } from "@/lib/utils";

type LabPrefillBot = {
  id: string;
  name: string;
  pairLabel: string;
  config: BotFormDraft;
};

type SerializedBacktestConfig = BacktestReplayRequestBody["config"] & {
  recenterMode?: string;
};

type SerializedBacktestMetrics = {
  startingBudgetUsd: number;
  endingEquityUsd: number;
  totalPnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  returnPct: number;
  maxDrawdownPct: number;
  maxOccupancyPct: number;
  timeInRangePct: number;
  timeOutOfRangePct: number;
  closedCycleCount: number;
  openCycleCount: number;
  executedBuyCount: number;
  executedSellCount: number;
  blockedOrderCount: number;
  simulatedOrderCount: number;
  recenterCount: number;
  totalFeesUsd: number;
  averageSlippageBps: number;
};

type SerializedBacktestReplayPoint = {
  timestamp: string;
  price: number;
  phase: "train" | "validation";
  activeLowPrice: number;
  activeHighPrice: number;
  totalEquityUsd: number;
};

type SerializedBacktestReplayExecution = {
  id: string;
  phase: "train" | "validation";
  side: "buy" | "sell";
  status: string;
  inputAmount: number;
  outputAmount: number;
  feeAmount: number;
  timestamp: string;
};

type SerializedBacktestRecenterEvent = {
  id: string;
  phase: "train" | "validation";
  timestamp: string;
  mode: "none" | "soft" | "hybrid" | "hard";
  side: "inside" | "above" | "below";
  previousLowPrice: number;
  previousHighPrice: number;
  nextLowPrice: number;
  nextHighPrice: number;
  allowNewBuys: boolean;
  allowRecoverySells: boolean;
  risk: "low" | "medium" | "high";
  reason: string;
};

type SerializedIndicatorSnapshot = {
  timestamp: string;
  close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  atr14: number | null;
  atrPct14: number | null;
  adx14: number | null;
  bollingerWidth20: number | null;
  donchianHigh20: number | null;
  donchianLow20: number | null;
  donchianWidthPct20: number | null;
  realizedVol20: number | null;
  volumeSma20: number | null;
  volumeRatio20: number | null;
};

type SerializedIndicatorSummary = {
  latest: SerializedIndicatorSnapshot | null;
  hasVolume: boolean;
};

type SerializedMarketRegime = {
  regime: "RANGE" | "TREND_UP" | "TREND_DOWN" | "CHAOTIC_HIGH_VOL";
  confidence: number;
  scores: {
    range: number;
    trendUp: number;
    trendDown: number;
    chaoticHighVol: number;
  };
  reasons: string[];
  evaluatedAt: string;
};

type SerializedRecenterAdvice = {
  mode: "none" | "soft" | "hybrid" | "hard";
  side: "inside" | "above" | "below";
  allowNewBuys: boolean;
  allowRecoverySells: boolean;
  suggestedLowPrice: number | null;
  suggestedHighPrice: number | null;
  risk: "low" | "medium" | "high";
  operatorAction: string;
  reasons: string[];
};

type SerializedRangePlan = {
  recommendedLowPrice: number;
  recommendedHighPrice: number;
  recommendedLevelCount: number;
  recommendedGridType: SerializedBacktestConfig["gridType"];
  widthPct: number;
  stepPct: number;
  basis: "atr" | "donchian" | "bollinger" | "current_range";
  confidence: number;
  risk: "low" | "medium" | "high";
  operatorAction: string;
  reasons: string[];
};

type SerializedStrategySelection = {
  recommendedFamily: "range_grid" | "trend_following" | "capital_defense";
  posture: "active" | "caution" | "pause" | "watch";
  confidence: number;
  operatorAction: string;
  reasons: string[];
  candidates: Array<{
    family: "range_grid" | "trend_following" | "capital_defense";
    score: number;
    reason: string;
  }>;
};

type SerializedBacktestAssumptions = {
  candleTraversal: "bullish_open_low_high_close_bearish_open_high_low_close";
  fillPolicy: "immediate_on_confirmed_level_cross";
  executionCostModel: "pessimistic_slippage_plus_fee";
  maxSlippageBps: number;
  executionFeeBps: number;
  trainValidationSplit: number;
  recenterMode: string;
  recenterScope: "advisory_only" | "simulated_when_auto_recenter";
  outOfRangeModel: "pause_new_entries_allow_recovery_sells";
  excludedCosts: string[];
  notes: string[];
};

type SerializedBacktestRunResult = {
  config: SerializedBacktestConfig;
  replayPoints: SerializedBacktestReplayPoint[];
  executions: SerializedBacktestReplayExecution[];
  recenterEvents: SerializedBacktestRecenterEvent[];
  recenterAdvice: SerializedRecenterAdvice;
  rangePlan?: SerializedRangePlan;
  strategySelection?: SerializedStrategySelection;
  indicators?: SerializedIndicatorSummary;
  marketRegime?: SerializedMarketRegime;
  trainMetrics: SerializedBacktestMetrics;
  validationMetrics: SerializedBacktestMetrics;
  overallMetrics: SerializedBacktestMetrics;
  assumptions: SerializedBacktestAssumptions;
  meta: {
    symbol: string;
    pair: string;
    resolution?: string;
    trainEndAt: string;
    historyWindow?: {
      from: string;
      to: string;
      source: string;
    };
  };
  series: {
    symbol: string;
    pair: string;
    resolution?: string;
    candles: Array<{
      timestamp: string;
      open: number;
      high: number;
      low: number;
      close: number;
    }>;
  };
};

type SerializedBacktestRecommendation = {
  bestConfig: SerializedBacktestConfig;
  indicators?: SerializedIndicatorSummary;
  marketRegime?: SerializedMarketRegime;
  rangePlan?: SerializedRangePlan;
  strategySelection?: SerializedStrategySelection;
  leaderboard: Array<{
    rank: number;
    config: SerializedBacktestConfig;
    trainMetrics: SerializedBacktestMetrics;
    validationMetrics: SerializedBacktestMetrics;
  }>;
  bestReplay: SerializedBacktestRunResult;
  recenterAdvice: SerializedRecenterAdvice;
  trainMetrics: SerializedBacktestMetrics;
  validationMetrics: SerializedBacktestMetrics;
  operatorGuidance: {
    status: "Healthy" | "Caution" | "Fragile";
    summary: string;
    stopRule: string;
    recenterAction: string;
    timeInRangePct: number;
    maxOccupancyPct: number;
  };
  assumptions: SerializedBacktestAssumptions;
  meta: {
    symbol: string;
    pair: string;
    resolution?: string;
    trainEndAt: string;
    historyWindow?: {
      from: string;
      to: string;
      source: string;
    };
  };
};

type ScenarioComparisonId = "current_setup" | "current_recenter" | "optimizer_best" | "adaptive_plan";

type ScenarioComparisonRow = {
  id: ScenarioComparisonId;
  label: string;
  description: string;
  config: SerializedBacktestConfig;
  replay: SerializedBacktestRunResult;
};

type SerializedBacktestCompareResponse = {
  recommendation: SerializedBacktestRecommendation;
  rows: ScenarioComparisonRow[];
};

function inferPairFromDraft(draft: BotFormDraft): LabPair {
  const symbol = BOT_PAIR_PRESETS[draft.presetId].baseSymbol;
  return symbol === "BTC" ? "BTC" : "SOL";
}

function inferMinOrderMode(draft: BotFormDraft) {
  const normalizedDraft = normalizeBotDraftCapital({ ...draft });
  const suggestedMinOrder = getSuggestedMinOrderQuoteAmount(normalizedDraft);
  return Math.abs(normalizedDraft.minOrderQuoteAmount - suggestedMinOrder) < 0.000001 ? MinOrderMode.Auto : MinOrderMode.Manual;
}

function buildReplayConfigFromDraft(draft: BotFormDraft): SerializedBacktestConfig {
  const normalizedDraft = normalizeBotDraftCapital({ ...draft });
  return {
    budgetUsd: normalizedDraft.totalBudgetUsd,
    lowPrice: normalizedDraft.lowPrice,
    highPrice: normalizedDraft.highPrice,
    levelCount: normalizedDraft.levelCount,
    gridType: normalizedDraft.gridType as GridType,
    strategyMode: normalizedDraft.strategyMode as StrategyMode,
    minOrderMode: inferMinOrderMode(normalizedDraft),
    minOrderQuoteAmount: normalizedDraft.minOrderQuoteAmount,
    maxSlippageBps: normalizedDraft.maxSlippageBps,
    executionFeeBps: 10,
    cooldownMs: normalizedDraft.cooldownMs,
    maxOrdersPerHour: normalizedDraft.maxOrdersPerHour,
    maxDrawdownPct: normalizedDraft.maxDrawdownPct,
    maxConsecutiveFailures: normalizedDraft.maxConsecutiveFailures,
    levelLockMs: normalizedDraft.levelLockMs,
    priceConfirmationWindowMs: normalizedDraft.priceConfirmationWindowMs,
    recenterMode: RecenterMode.Manual,
    outOfRangePause: normalizedDraft.outOfRangePause
  };
}

function buildAdaptiveReplayConfig(baseConfig: SerializedBacktestConfig, rangePlan: SerializedRangePlan): SerializedBacktestConfig {
  return {
    ...baseConfig,
    lowPrice: rangePlan.recommendedLowPrice,
    highPrice: rangePlan.recommendedHighPrice,
    levelCount: rangePlan.recommendedLevelCount,
    gridType: rangePlan.recommendedGridType
  };
}

function getConfigSignature(config: SerializedBacktestConfig) {
  return [
    config.strategyMode,
    config.gridType,
    config.levelCount,
    config.lowPrice,
    config.highPrice,
    config.budgetUsd,
    config.minOrderQuoteAmount,
    config.maxSlippageBps,
    config.executionFeeBps ?? 10,
    config.recenterMode ?? RecenterMode.Manual
  ].join(":");
}

function getValidationNet(metrics: SerializedBacktestMetrics) {
  return metrics.endingEquityUsd - metrics.startingBudgetUsd;
}

function formatBps(value: number) {
  return `${formatNumber(value, value % 1 === 0 ? 0 : 1)} bps`;
}

function formatSpacingLabel(gridType: SerializedBacktestConfig["gridType"]) {
  return gridType === GridType.Geometric ? "Geometric" : "Arithmetic";
}

function formatHealthTone(status: "Healthy" | "Caution" | "Fragile") {
  switch (status) {
    case "Healthy":
      return "text-[var(--green)] border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)]";
    case "Fragile":
      return "text-[var(--red)] border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)]";
    default:
      return "text-[var(--amber)] border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)]";
  }
}

function formatOptionalNumber(value: number | null | undefined, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? formatNumber(value, digits) : "--";
}

function formatOptionalPercent(value: number | null | undefined, digits = 1) {
  return typeof value === "number" && Number.isFinite(value) ? formatPercent(value, digits) : "--";
}

function formatIndicatorPrice(value: number | null | undefined, pair: LabPair) {
  return formatOptionalNumber(value, pair === "BTC" ? 0 : 2);
}

function formatAdxHint(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Needs more candles";
  }

  if (value >= 25) {
    return "Trending pressure";
  }

  if (value >= 18) {
    return "Borderline trend";
  }

  return "Range-friendly";
}

function formatRegimeLabel(regime: SerializedMarketRegime["regime"]) {
  switch (regime) {
    case "TREND_UP":
      return "Trend up";
    case "TREND_DOWN":
      return "Trend down";
    case "CHAOTIC_HIGH_VOL":
      return "High vol";
    default:
      return "Range";
  }
}

function formatRegimeTone(regime: SerializedMarketRegime["regime"]) {
  switch (regime) {
    case "RANGE":
      return "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]";
    case "TREND_UP":
      return "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]";
    case "TREND_DOWN":
      return "border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] text-[var(--red)]";
    default:
      return "border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)] text-[var(--amber)]";
  }
}

function formatRegimeScore(value: number) {
  return formatNumber(value, value % 1 === 0 ? 0 : 1);
}

function formatRecenterMode(mode: SerializedRecenterAdvice["mode"]) {
  switch (mode) {
    case "none":
      return "Keep";
    case "soft":
      return "Soft defense";
    case "hybrid":
      return "Hybrid recenter";
    case "hard":
      return "Hard recreate";
  }
}

function formatAssumptionRecenterMode(mode: string) {
  if (mode === RecenterMode.Manual) {
    return "Manual only";
  }

  if (mode === RecenterMode.Auto) {
    return "Simulated auto";
  }

  return mode.replaceAll("_", " ");
}

function formatRecenterTone(risk: SerializedRecenterAdvice["risk"]) {
  switch (risk) {
    case "low":
      return "text-[var(--green)] border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)]";
    case "high":
      return "text-[var(--red)] border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)]";
    default:
      return "text-[var(--amber)] border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)]";
  }
}

function formatRangePlanTone(risk: SerializedRangePlan["risk"]) {
  switch (risk) {
    case "low":
      return "text-[var(--green)] border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)]";
    case "high":
      return "text-[var(--red)] border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)]";
    default:
      return "text-[var(--amber)] border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)]";
  }
}

function formatRangePlanBasis(basis: SerializedRangePlan["basis"]) {
  switch (basis) {
    case "current_range":
      return "Current range";
    case "atr":
      return "ATR";
    case "donchian":
      return "Donchian";
    case "bollinger":
      return "Bollinger";
  }
}

function formatStrategyFamilyLabel(family: SerializedStrategySelection["recommendedFamily"]) {
  switch (family) {
    case "range_grid":
      return "Range grid";
    case "trend_following":
      return "Trend watch";
    case "capital_defense":
      return "Capital defense";
  }
}

function formatStrategyPostureTone(posture: SerializedStrategySelection["posture"]) {
  switch (posture) {
    case "active":
      return "text-[var(--green)] border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)]";
    case "pause":
      return "text-[var(--red)] border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)]";
    case "watch":
      return "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]";
    default:
      return "text-[var(--amber)] border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)]";
  }
}

function formatScenarioDescription(row: ScenarioComparisonRow) {
  const recenterSuffix = row.config.recenterMode === RecenterMode.Auto ? " | recenter" : "";
  return `${formatGoalLabel(row.config.strategyMode)} | ${formatSpacingLabel(row.config.gridType)} | ${row.config.levelCount} rails${recenterSuffix}`;
}

export function BacktestLabConsole({
  bots,
  selectedBotId,
  onSelectBotId
}: {
  bots: LabPrefillBot[];
  selectedBotId?: string | null;
  onSelectBotId?: (botId: string | null) => void;
}) {
  const [isPending, setIsPending] = useState(false);
  const [pair, setPair] = useState<LabPair>("SOL");
  const [budgetUsd, setBudgetUsd] = useState<number>(100);
  const [lookbackDays, setLookbackDays] = useState<LabLookbackDays>(90);
  const [resolution, setResolution] = useState<LabResolution>("1h");
  const [feedback, setFeedback] = useState<{ tone: "error" | "info"; message: string } | null>(null);
  const [recommendation, setRecommendation] = useState<SerializedBacktestRecommendation | null>(null);
  const [activeReplay, setActiveReplay] = useState<SerializedBacktestRunResult | null>(null);
  const [activeConfigKey, setActiveConfigKey] = useState<string | null>(null);
  const [scenarioComparison, setScenarioComparison] = useState<ScenarioComparisonRow[]>([]);
  const [localSelectedBotId, setLocalSelectedBotId] = useState<string | null>(selectedBotId ?? bots[0]?.id ?? null);
  const effectiveSelectedBotId = onSelectBotId ? selectedBotId ?? null : localSelectedBotId;
  const selectBotId = onSelectBotId ?? setLocalSelectedBotId;

  const selectedBot = useMemo(() => bots.find((bot) => bot.id === effectiveSelectedBotId) ?? bots[0] ?? null, [bots, effectiveSelectedBotId]);
  const selectedBotReplayConfig = useMemo(
    () => (selectedBot ? buildReplayConfigFromDraft(selectedBot.config) : null),
    [selectedBot]
  );
  const selectedBotRecenterReplayConfig = useMemo(
    () => (selectedBotReplayConfig ? { ...selectedBotReplayConfig, recenterMode: RecenterMode.Auto } : null),
    [selectedBotReplayConfig]
  );

  useEffect(() => {
    if (!selectedBot) {
      return;
    }

    setPair(inferPairFromDraft(selectedBot.config));
    setBudgetUsd(selectedBot.config.totalBudgetUsd);
  }, [selectedBot]);

  useEffect(() => {
    setFeedback(null);
    setRecommendation(null);
    setActiveReplay(null);
    setActiveConfigKey(null);
    setScenarioComparison([]);
  }, [pair, budgetUsd, lookbackDays, resolution, selectedBot?.id]);

  const displayedReplay = activeReplay ?? recommendation?.bestReplay ?? null;
  const displayedGuidance = recommendation?.operatorGuidance ?? null;
  const displayedRecenterAdvice = displayedReplay?.recenterAdvice ?? recommendation?.recenterAdvice ?? null;
  const displayedRangePlan = displayedReplay?.rangePlan ?? recommendation?.rangePlan ?? null;
  const displayedStrategySelection = displayedReplay?.strategySelection ?? recommendation?.strategySelection ?? null;
  const displayedBaseConfig = displayedReplay?.config ?? recommendation?.bestConfig ?? null;
  const displayedAssumptions = displayedReplay?.assumptions ?? recommendation?.assumptions ?? null;
  const adaptiveReplayConfig = useMemo(
    () => (displayedBaseConfig && displayedRangePlan ? buildAdaptiveReplayConfig(displayedBaseConfig, displayedRangePlan) : null),
    [displayedBaseConfig, displayedRangePlan]
  );
  const displayedIndicators = displayedReplay?.indicators ?? recommendation?.indicators ?? null;
  const latestIndicators = displayedIndicators?.latest ?? null;
  const displayedRegime = displayedReplay?.marketRegime ?? recommendation?.marketRegime ?? null;
  const lastReplayPoint = displayedReplay?.replayPoints.at(-1) ?? null;
  const chartLevels = useMemo(
    () =>
      displayedReplay
        ? calculateGridLevels({
            lowPrice: lastReplayPoint?.activeLowPrice ?? displayedReplay.config.lowPrice,
            highPrice: lastReplayPoint?.activeHighPrice ?? displayedReplay.config.highPrice,
            levelCount: displayedReplay.config.levelCount,
            gridType: displayedReplay.config.gridType
          })
        : [],
    [displayedReplay, lastReplayPoint?.activeHighPrice, lastReplayPoint?.activeLowPrice]
  );
  const chartMarkers = useMemo(
    () =>
      displayedReplay
        ? displayedReplay.executions
            .filter((execution) => execution.status === "simulated")
            .map((execution) => ({
              time: execution.timestamp,
              side: execution.side,
              label:
                execution.side === "buy"
                  ? formatTradeMarkerLabel({
                      strategyMode: displayedReplay.config.strategyMode,
                      side: "buy",
                      quoteAmount: execution.inputAmount,
                      baseAmount: execution.outputAmount,
                      baseSymbol: displayedReplay.series.symbol
                    })
                  : formatTradeMarkerLabel({
                      strategyMode: displayedReplay.config.strategyMode,
                      side: "sell",
                      quoteAmount: execution.outputAmount,
                      baseAmount: execution.inputAmount,
                      baseSymbol: displayedReplay.series.symbol
                    })
            }))
        : [],
    [displayedReplay]
  );
  const chartCandles = useMemo(
    () =>
      displayedReplay?.series.candles.map((candle) => ({
        time: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      })) ?? [],
    [displayedReplay]
  );
  async function postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const payload = (await response.json().catch(() => null)) as { error?: string } & T;
    if (!response.ok) {
      throw new Error(payload?.error ?? "The request failed.");
    }

    return payload;
  }

  function requestRecommendation() {
    return postJson<SerializedBacktestRecommendation>("/api/backtest/lab/recommend", {
      pair,
      budgetUsd,
      lookbackDays,
      resolution
    });
  }

  function requestReplay(config: SerializedBacktestConfig) {
    return postJson<SerializedBacktestRunResult>("/api/backtest/lab/replay", {
      pair,
      budgetUsd,
      lookbackDays,
      resolution,
      config
    });
  }

  function requestScenarioComparison(config: SerializedBacktestConfig) {
    return postJson<SerializedBacktestCompareResponse>("/api/backtest/lab/compare", {
      pair,
      budgetUsd,
      lookbackDays,
      resolution,
      config
    });
  }

  async function runRecommendation() {
    setFeedback(null);
    setIsPending(true);
    try {
      const payload = await requestRecommendation();
      setRecommendation(payload);
      setActiveReplay(payload.bestReplay);
      setActiveConfigKey(getConfigSignature(payload.bestConfig));
      setScenarioComparison([]);
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Unable to run the lab recommendation."
      });
    } finally {
      setIsPending(false);
    }
  }

  async function replayConfig(config: SerializedBacktestConfig) {
    setFeedback(null);
    setIsPending(true);
    try {
      const payload = await requestReplay(config);
      setActiveReplay(payload);
      setActiveConfigKey(getConfigSignature(config));
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Unable to replay this config."
      });
    } finally {
      setIsPending(false);
    }
  }

  async function runScenarioComparison() {
    if (!selectedBotReplayConfig) {
      setFeedback({
        tone: "error",
        message: "Select an existing bot before comparing scenarios."
      });
      return;
    }

    setFeedback(null);
    setIsPending(true);
    try {
      const payload = await requestScenarioComparison(selectedBotReplayConfig);
      setRecommendation(payload.recommendation);
      setScenarioComparison(payload.rows);
      const first = payload.rows[0] ?? null;
      if (first) {
        setActiveReplay(first.replay);
        setActiveConfigKey(getConfigSignature(first.config));
      }
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Unable to compare lab scenarios."
      });
    } finally {
      setIsPending(false);
    }
  }

  const bestValidationNet = recommendation ? recommendation.validationMetrics.endingEquityUsd - recommendation.validationMetrics.startingBudgetUsd : null;

  return (
    <section className="space-y-0">
      {feedback ? (
        <div
          className={cn(
            "mb-3 border px-4 py-2.5 text-sm",
            feedback.tone === "error"
              ? "border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] text-[var(--red)]"
              : "border-[var(--line)] bg-[var(--panel-soft)] text-white"
          )}
        >
          {feedback.message}
        </div>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 border-r border-[var(--line)]">
          <div className="border-b border-[var(--line)] px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Backtest lab</div>
                <div className="mt-1 text-sm text-white">
                  Compare your current grid against recenter and optimizer scenarios before changing a live bot.
                </div>
              </div>
              {displayedGuidance ? (
                <span className={cn("border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em]", formatHealthTone(displayedGuidance.status))}>
                  {displayedGuidance.status}
                </span>
              ) : null}
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <LabMetric label="Validation net" value={bestValidationNet === null ? "--" : formatCurrency(bestValidationNet)} hint="Validation-first ranking" />
              <LabMetric label="Max drawdown" value={recommendation ? formatPercent(recommendation.validationMetrics.maxDrawdownPct, 2) : "--"} hint="Validation window" />
              <LabMetric label="Time in range" value={recommendation ? formatPercent(recommendation.validationMetrics.timeInRangePct, 1) : "--"} hint="Validation window" />
              <LabMetric label="Closed cycles" value={recommendation ? formatNumber(recommendation.validationMetrics.closedCycleCount, 0) : "--"} hint="Validation window" />
            </div>
          </div>

          <div className="px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <TimeRangeTabs
                options={LAB_RESOLUTION_OPTIONS.map((value) => ({ label: value.toUpperCase(), value }))}
                value={resolution}
                pending={isPending}
                onChange={(next) => setResolution(next as LabResolution)}
              />
              <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
                {displayedReplay?.meta.historyWindow?.source ?? "pyth-history"} | {lookbackDays}d
              </div>
            </div>

            <div className="mt-3">
              <BotPriceChart
                key={`lab-chart-${pair}-${resolution}`}
                resolution={resolution}
                candles={chartCandles}
                levels={chartLevels}
                markers={chartMarkers}
                orderLines={[]}
                currentPrice={lastReplayPoint?.price ?? null}
                currentPriceTime={lastReplayPoint?.timestamp ?? null}
                averageCost={null}
                loading={isPending}
                resolutionLabel={resolution.toUpperCase()}
                sourceLabel={displayedReplay?.meta.historyWindow?.source ?? "pyth-history"}
                cappedLabel={null}
              />
            </div>

            <BacktestEquityChart
              className="mt-3"
              splitAt={displayedReplay?.meta.trainEndAt ?? null}
              points={
                displayedReplay?.replayPoints.map((point) => ({
                  time: point.timestamp,
                  equityUsd: point.totalEquityUsd
                })) ?? []
              }
            />
          </div>
        </div>

        <aside className="flex max-h-[calc(100vh-160px)] min-w-0 flex-col overflow-hidden bg-[var(--panel-soft)]/60">
          <div className="border-b border-[var(--line)] px-4 py-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Lab scope</div>
            <div className="mt-1 text-sm text-white">Start with a bot, run Compare scenarios, then read the winner and the risk flags.</div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            <div className="space-y-3">
              <LabSection title="Setup" defaultOpen>
                <div className="grid gap-3">
                  <LabField label="Prefill from">
                    <select
                      value={selectedBot?.id ?? ""}
                      onChange={(event) => selectBotId(event.currentTarget.value || null)}
                      className="h-9 w-full min-w-0 rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[13px] text-white"
                    >
                      {!bots.length ? <option value="">Custom</option> : null}
                      {bots.map((bot) => (
                        <option key={bot.id} value={bot.id}>
                          {bot.name}
                        </option>
                      ))}
                    </select>
                  </LabField>

                  <div className="grid grid-cols-1 gap-3">
                    <LabField label="Pair">
                      <div className="grid grid-cols-2 gap-2">
                        {LAB_PAIR_OPTIONS.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setPair(option)}
                            className={cn(
                              "min-w-0 rounded-md border px-2.5 py-2 text-[11px] font-medium transition",
                              pair === option
                                ? "border-[var(--accent-line)] bg-[var(--accent-soft)] text-white"
                                : "border-[var(--line)] bg-[var(--bg)] text-[var(--muted)] hover:bg-white/[0.04] hover:text-white"
                            )}
                          >
                            {option}/USDC
                          </button>
                        ))}
                      </div>
                    </LabField>
                    <LabField label="Budget">
                      <input
                        type="number"
                        min={1}
                        step={10}
                        value={budgetUsd}
                        onChange={(event) => setBudgetUsd(Number(event.currentTarget.value) || 0)}
                        className="h-9 w-full min-w-0 rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 text-[13px] text-white"
                      />
                    </LabField>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    <LabField label="Lookback">
                      <TimeRangeTabs
                        options={LAB_LOOKBACK_OPTIONS.map((value) => ({ label: `${value}D`, value: String(value) }))}
                        value={String(lookbackDays)}
                        pending={isPending}
                        onChange={(next) => setLookbackDays(Number(next) as LabLookbackDays)}
                      />
                    </LabField>
                    <LabField label="Optimization mode">
                      <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2 text-[11px] leading-4 text-[var(--muted)]">
                        Tests the current strategies and both spacing modes, then ranks on validation. No live execution tweaks in v1.
                      </div>
                    </LabField>
                  </div>

                  <div className="space-y-2">
                    <button
                      type="button"
                      onClick={runScenarioComparison}
                      disabled={isPending || budgetUsd <= 0}
                      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[var(--accent-line)] bg-[linear-gradient(180deg,rgba(121,184,255,0.18),rgba(121,184,255,0.1))] px-3.5 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--accent)] shadow-[0_10px_24px_rgba(58,120,255,0.16),inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-[rgba(121,184,255,0.45)] hover:bg-[linear-gradient(180deg,rgba(121,184,255,0.24),rgba(121,184,255,0.14))] hover:text-white disabled:pointer-events-none disabled:opacity-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                      {isPending ? "Running..." : "Compare scenarios"}
                    </button>
                    <div className="text-[11px] leading-4 text-[var(--muted)]">
                      Best first step: current setup, current + recenter, optimizer best, and adaptive plan on the same window.
                    </div>
                    {selectedBotReplayConfig ? (
                      <button
                        type="button"
                        onClick={() => replayConfig(selectedBotReplayConfig)}
                        disabled={isPending}
                        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.015)] px-3 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:border-white/12 hover:bg-white/[0.05] hover:text-white disabled:pointer-events-none disabled:opacity-50"
                      >
                        <Play className="h-3.5 w-3.5 shrink-0" />
                        Replay current setup
                      </button>
                    ) : null}
                    {selectedBotRecenterReplayConfig ? (
                      <button
                        type="button"
                        onClick={() => replayConfig(selectedBotRecenterReplayConfig)}
                        disabled={isPending}
                        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.015)] px-3 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] disabled:pointer-events-none disabled:opacity-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                        Replay with recenter
                      </button>
                    ) : null}
                    {selectedBotReplayConfig ? (
                      <div className="text-[11px] leading-4 text-[var(--muted)]">
                        Use these two buttons for quick one-off checks. They do not search for a better setup.
                      </div>
                    ) : null}
                    <button
                      type="button"
                      onClick={runRecommendation}
                      disabled={isPending || budgetUsd <= 0}
                      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.015)] px-3 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] disabled:pointer-events-none disabled:opacity-50"
                    >
                      <FlaskConical className="h-3.5 w-3.5 shrink-0" />
                      Find optimizer best
                    </button>
                    <div className="text-[11px] leading-4 text-[var(--muted)]">
                      Optional: search the parameter space without comparing against the selected bot.
                    </div>
                  </div>
                </div>
              </LabSection>

              <LabSection title="Best setup found" defaultOpen>
                {recommendation ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-2">
                      <LabMetric label="Goal" value={formatGoalLabel(recommendation.bestConfig.strategyMode)} hint="Current live strategy family" />
                      <LabMetric label="Spacing" value={formatSpacingLabel(recommendation.bestConfig.gridType)} hint={`${recommendation.bestConfig.levelCount} rails`} />
                      <LabMetric label="Range" value={`${formatNumber(recommendation.bestConfig.lowPrice, recommendation.bestConfig.lowPrice >= 1000 ? 0 : 2)} -> ${formatNumber(recommendation.bestConfig.highPrice, recommendation.bestConfig.highPrice >= 1000 ? 0 : 2)}`} hint="Optimizer proposed on train closes" />
                      <LabMetric label="Min order" value={formatCurrency(recommendation.bestConfig.minOrderQuoteAmount)} hint={`${recommendation.bestConfig.levelCount - 1} cycles`} />
                    </div>
                    <div className={cn("border px-3 py-2 text-sm", formatHealthTone(recommendation.operatorGuidance.status))}>
                      <div className="font-mono text-[10px] uppercase tracking-[0.16em]">{recommendation.operatorGuidance.status}</div>
                      <div className="mt-1 text-white">{recommendation.operatorGuidance.summary}</div>
                      <div className="mt-2 text-[11px] leading-4 text-[var(--muted)]">{recommendation.operatorGuidance.stopRule}</div>
                      <div className="mt-2 text-[11px] leading-4 text-[var(--muted)]">{recommendation.operatorGuidance.recenterAction}</div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">Use Compare scenarios first, or Find optimizer best if you only want the search winner.</div>
                )}
              </LabSection>

              <LabSection title="Current replay" defaultOpen>
                {displayedReplay ? (
                  <div className="grid grid-cols-1 gap-2">
                    <LabMetric label="Train PnL" value={formatCurrency(displayedReplay.trainMetrics.totalPnlUsd)} hint={formatPercent(displayedReplay.trainMetrics.returnPct, 2)} />
                    <LabMetric label="Validation PnL" value={formatCurrency(displayedReplay.validationMetrics.totalPnlUsd)} hint={formatPercent(displayedReplay.validationMetrics.returnPct, 2)} />
                    <LabMetric label="Overall PnL" value={formatCurrency(displayedReplay.overallMetrics.totalPnlUsd)} hint={formatPercent(displayedReplay.overallMetrics.returnPct, 2)} />
                    <LabMetric label="Max occupancy" value={formatPercent(displayedReplay.validationMetrics.maxOccupancyPct, 1)} hint="Validation window" />
                    <LabMetric label="Fees" value={formatCurrency(displayedReplay.overallMetrics.totalFeesUsd)} hint={`${displayedReplay.overallMetrics.simulatedOrderCount} simulated fills`} />
                    <LabMetric label="Avg slippage" value={formatBps(displayedReplay.overallMetrics.averageSlippageBps)} hint="Pessimistic fill model" />
                    <LabMetric
                      label="Recenters"
                      value={formatNumber(displayedReplay.overallMetrics.recenterCount, 0)}
                      hint={displayedReplay.assumptions.recenterScope === "simulated_when_auto_recenter" ? "Lab simulation" : "Advisory only"}
                    />
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">No replay yet. Run Compare scenarios to compare your selected bot against Lab alternatives.</div>
                )}
              </LabSection>

              <LabSection title="Replay assumptions">
                {displayedAssumptions ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-2">
                      <LabMetric label="Candle path" value="OHLC replay" hint="Bullish low-first, bearish high-first" />
                      <LabMetric
                        label="Cost model"
                        value={`${formatBps(displayedAssumptions.maxSlippageBps)} slip + ${formatBps(displayedAssumptions.executionFeeBps)} fee`}
                        hint="Pessimistic deterministic fills"
                      />
                      <LabMetric
                        label="Split"
                        value={`${formatPercent(displayedAssumptions.trainValidationSplit * 100, 0)} train`}
                        hint={`${formatPercent((1 - displayedAssumptions.trainValidationSplit) * 100, 0)} validation`}
                      />
                      <LabMetric
                        label="Recenter"
                        value={formatAssumptionRecenterMode(displayedAssumptions.recenterMode)}
                        hint={displayedAssumptions.recenterScope === "simulated_when_auto_recenter" ? "Lab simulation" : "Advisory only"}
                      />
                    </div>
                    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2 text-[11px] leading-4 text-[var(--muted)]">
                      Excludes {displayedAssumptions.excludedCosts.join(", ")}. This is candle-level replay, not tick-level execution.
                    </div>
                    <div className="space-y-1.5">
                      {displayedAssumptions.notes.map((note) => (
                        <div key={note} className="text-[11px] leading-4 text-[var(--muted)]">
                          {note}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">Run a replay or recommendation to see the exact simulation assumptions used for the result.</div>
                )}
              </LabSection>

              <LabSection title="Scenario comparison" defaultOpen>
                {scenarioComparison.length ? (
                  <div className="space-y-2">
                    {scenarioComparison.map((row) => {
                      const active = getConfigSignature(row.config) === activeConfigKey;
                      const validationNet = getValidationNet(row.replay.validationMetrics);
                      return (
                        <button
                          key={row.id}
                          type="button"
                          onClick={() => {
                            setActiveReplay(row.replay);
                            setActiveConfigKey(getConfigSignature(row.config));
                          }}
                          className={cn(
                            "w-full rounded-md border px-2.5 py-2 text-left transition",
                            active
                              ? "border-[var(--accent-line)] bg-[var(--accent-soft)]"
                              : "border-[var(--line)] bg-[var(--bg)] hover:border-white/12 hover:bg-white/[0.04]"
                          )}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-mono text-[10px] uppercase tracking-[0.13em] text-white">{row.label}</div>
                              <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">{formatScenarioDescription(row)}</div>
                              <div className="mt-1 text-[10px] leading-4 text-[var(--muted)]">{row.description}</div>
                            </div>
                            <div className={cn("shrink-0 font-mono text-[11px]", validationNet >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
                              {formatCurrency(validationNet)}
                            </div>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-1.5">
                            <div className="rounded border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-1.5 py-1">
                              <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--muted)]">DD</div>
                              <div className="mt-0.5 text-[10px] text-white">{formatPercent(row.replay.validationMetrics.maxDrawdownPct, 1)}</div>
                            </div>
                            <div className="rounded border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-1.5 py-1">
                              <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--muted)]">Range</div>
                              <div className="mt-0.5 text-[10px] text-white">{formatPercent(row.replay.validationMetrics.timeInRangePct, 0)}</div>
                            </div>
                            <div className="rounded border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-1.5 py-1">
                              <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--muted)]">Cycles</div>
                              <div className="mt-0.5 text-[10px] text-white">{formatNumber(row.replay.validationMetrics.closedCycleCount, 0)}</div>
                            </div>
                            <div className="rounded border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-1.5 py-1">
                              <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--muted)]">Fees</div>
                              <div className="mt-0.5 text-[10px] text-white">{formatCurrency(row.replay.validationMetrics.totalFeesUsd)}</div>
                            </div>
                            <div className="rounded border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-1.5 py-1">
                              <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--muted)]">Slip</div>
                              <div className="mt-0.5 text-[10px] text-white">{formatBps(row.replay.validationMetrics.averageSlippageBps)}</div>
                            </div>
                            <div className="rounded border border-[var(--line)] bg-[rgba(255,255,255,0.02)] px-1.5 py-1">
                              <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--muted)]">Blocked</div>
                              <div className="mt-0.5 text-[10px] text-white">{formatNumber(row.replay.validationMetrics.blockedOrderCount, 0)}</div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">
                    Use Compare scenarios to test the selected bot, selected bot + recenter, optimizer winner, and adaptive range plan on the same history window.
                  </div>
                )}
              </LabSection>

              <LabSection title="Diagnostics: adaptive range">
                {displayedRangePlan ? (
                  <div className="space-y-3">
                    <div className={cn("rounded-md border px-3 py-2", formatRangePlanTone(displayedRangePlan.risk))}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-mono text-[10px] uppercase tracking-[0.16em]">Lab-only suggestion</div>
                          <div className="mt-1 text-base font-medium text-white">
                            {formatNumber(displayedRangePlan.recommendedLowPrice, displayedRangePlan.recommendedLowPrice >= 1000 ? 0 : 2)} {"->"}{" "}
                            {formatNumber(displayedRangePlan.recommendedHighPrice, displayedRangePlan.recommendedHighPrice >= 1000 ? 0 : 2)}
                          </div>
                        </div>
                        <div className="text-right font-mono text-[11px] uppercase tracking-[0.12em]">{displayedRangePlan.risk}</div>
                      </div>
                      <div className="mt-2 text-[11px] leading-4 text-[var(--muted)]">{displayedRangePlan.operatorAction}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <LabMetric label="Rails" value={formatNumber(displayedRangePlan.recommendedLevelCount, 0)} hint={`${formatPercent(displayedRangePlan.stepPct, 2)} step`} />
                      <LabMetric label="Spacing" value={formatSpacingLabel(displayedRangePlan.recommendedGridType)} hint={`${formatPercent(displayedRangePlan.widthPct, 1)} width`} />
                      <LabMetric label="Basis" value={formatRangePlanBasis(displayedRangePlan.basis)} hint="Indicator source" />
                      <LabMetric label="Confidence" value={formatPercent(displayedRangePlan.confidence * 100, 0)} hint="Heuristic score" />
                    </div>
                    {adaptiveReplayConfig ? (
                      <button
                        type="button"
                        onClick={() => replayConfig(adaptiveReplayConfig)}
                        disabled={isPending}
                        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-[rgba(121,184,255,0.45)] hover:bg-[rgba(121,184,255,0.14)] hover:text-white disabled:pointer-events-none disabled:opacity-50"
                      >
                        <Play className="h-3.5 w-3.5 shrink-0" />
                        Replay adaptive plan
                      </button>
                    ) : null}
                    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
                      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Why</div>
                      <div className="mt-2 space-y-1.5">
                        {displayedRangePlan.reasons.map((reason) => (
                          <div key={reason} className="text-[11px] leading-4 text-[var(--muted)]">
                            {reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">Run a replay or recommendation to derive an adaptive range candidate from indicators and regime.</div>
                )}
              </LabSection>

              <LabSection title="Diagnostics: meta decision">
                {displayedStrategySelection ? (
                  <div className="space-y-3">
                    <div className={cn("rounded-md border px-3 py-2", formatStrategyPostureTone(displayedStrategySelection.posture))}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-mono text-[10px] uppercase tracking-[0.16em]">Read-only selector</div>
                          <div className="mt-1 text-base font-medium text-white">
                            {formatStrategyFamilyLabel(displayedStrategySelection.recommendedFamily)}
                          </div>
                        </div>
                        <div className="text-right font-mono text-[11px] uppercase tracking-[0.12em]">{displayedStrategySelection.posture}</div>
                      </div>
                      <div className="mt-2 text-[11px] leading-4 text-[var(--muted)]">{displayedStrategySelection.operatorAction}</div>
                    </div>
                    <LabMetric label="Selector confidence" value={formatPercent(displayedStrategySelection.confidence * 100, 0)} hint="Heuristic score" />
                    <div className="grid grid-cols-1 gap-2">
                      {displayedStrategySelection.candidates.map((candidate) => (
                        <div key={candidate.family} className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-white">
                              {formatStrategyFamilyLabel(candidate.family)}
                            </div>
                            <div className="font-mono text-[10px] text-[var(--muted)]">{formatPercent(candidate.score * 100, 0)}</div>
                          </div>
                          <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">{candidate.reason}</div>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
                      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Why</div>
                      <div className="mt-2 space-y-1.5">
                        {displayedStrategySelection.reasons.map((reason) => (
                          <div key={reason} className="text-[11px] leading-4 text-[var(--muted)]">
                            {reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">
                    Run a replay or recommendation to classify whether the current context favors range grid, defense, or a future trend module.
                  </div>
                )}
              </LabSection>

              <LabSection title="Diagnostics: recenter">
                {displayedRecenterAdvice ? (
                  <div className="space-y-3">
                    <div className={cn("rounded-md border px-3 py-2", formatRecenterTone(displayedRecenterAdvice.risk))}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-mono text-[10px] uppercase tracking-[0.16em]">
                            {displayedAssumptions?.recenterScope === "simulated_when_auto_recenter" ? "Lab simulation" : "Advisory only"}
                          </div>
                          <div className="mt-1 text-base font-medium text-white">{formatRecenterMode(displayedRecenterAdvice.mode)}</div>
                        </div>
                        <div className="text-right font-mono text-[11px] uppercase tracking-[0.12em]">{displayedRecenterAdvice.risk}</div>
                      </div>
                      <div className="mt-2 text-[11px] leading-4 text-[var(--muted)]">{displayedRecenterAdvice.operatorAction}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <LabMetric label="New buys" value={displayedRecenterAdvice.allowNewBuys ? "Allowed" : "Paused"} hint={`Breakout ${displayedRecenterAdvice.side}`} />
                      <LabMetric label="Recovery sells" value={displayedRecenterAdvice.allowRecoverySells ? "Allowed" : "Paused"} hint="Open cycle exits" />
                    </div>
                    {displayedRecenterAdvice.suggestedLowPrice !== null && displayedRecenterAdvice.suggestedHighPrice !== null ? (
                      <LabMetric
                        label="Suggested range"
                        value={`${formatNumber(displayedRecenterAdvice.suggestedLowPrice, displayedRecenterAdvice.suggestedLowPrice >= 1000 ? 0 : 2)} -> ${formatNumber(displayedRecenterAdvice.suggestedHighPrice, displayedRecenterAdvice.suggestedHighPrice >= 1000 ? 0 : 2)}`}
                        hint="Do not auto-apply in v1"
                      />
                    ) : null}
                    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
                      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Why</div>
                      <div className="mt-2 space-y-1.5">
                        {displayedRecenterAdvice.reasons.map((reason) => (
                          <div key={reason} className="text-[11px] leading-4 text-[var(--muted)]">
                            {reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">Run a replay or recommendation to get a recenter recommendation for the final simulated state.</div>
                )}
              </LabSection>

              <LabSection title="Diagnostics: market regime">
                {displayedRegime ? (
                  <div className="space-y-3">
                    <div className={cn("rounded-md border px-3 py-2", formatRegimeTone(displayedRegime.regime))}>
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-mono text-[10px] uppercase tracking-[0.16em]">Detected regime</div>
                          <div className="mt-1 text-base font-medium text-white">{formatRegimeLabel(displayedRegime.regime)}</div>
                        </div>
                        <div className="text-right font-mono text-[11px] uppercase tracking-[0.12em]">
                          {formatPercent(displayedRegime.confidence * 100, 0)}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <LabMetric label="Range" value={formatRegimeScore(displayedRegime.scores.range)} hint="Sideways score" />
                      <LabMetric label="Trend up" value={formatRegimeScore(displayedRegime.scores.trendUp)} hint="Momentum score" />
                      <LabMetric label="Trend down" value={formatRegimeScore(displayedRegime.scores.trendDown)} hint="Momentum score" />
                      <LabMetric label="High vol" value={formatRegimeScore(displayedRegime.scores.chaoticHighVol)} hint="Risk score" />
                    </div>
                    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
                      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Reasons</div>
                      <div className="mt-2 space-y-1.5">
                        {displayedRegime.reasons.map((reason) => (
                          <div key={reason} className="text-[11px] leading-4 text-[var(--muted)]">
                            {reason}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">Run a replay or recommendation to classify the market regime for this window.</div>
                )}
              </LabSection>

              <LabSection title="Diagnostics: indicators">
                {latestIndicators ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-2">
                      <LabMetric
                        label="ATR 14"
                        value={formatOptionalPercent(latestIndicators.atrPct14, 2)}
                        hint={`${formatIndicatorPrice(latestIndicators.atr14, pair)} price units`}
                      />
                      <LabMetric
                        label="ADX 14"
                        value={formatOptionalNumber(latestIndicators.adx14, 1)}
                        hint={formatAdxHint(latestIndicators.adx14)}
                      />
                      <LabMetric
                        label="EMA 20 / 50"
                        value={`${formatIndicatorPrice(latestIndicators.ema20, pair)} / ${formatIndicatorPrice(latestIndicators.ema50, pair)}`}
                        hint={`EMA 200 ${formatIndicatorPrice(latestIndicators.ema200, pair)}`}
                      />
                      <LabMetric
                        label="Bollinger 20"
                        value={formatOptionalPercent(latestIndicators.bollingerWidth20, 2)}
                        hint="Band width"
                      />
                      <LabMetric
                        label="Donchian 20"
                        value={formatOptionalPercent(latestIndicators.donchianWidthPct20, 2)}
                        hint={`${formatIndicatorPrice(latestIndicators.donchianLow20, pair)} -> ${formatIndicatorPrice(latestIndicators.donchianHigh20, pair)}`}
                      />
                      <LabMetric
                        label="Realized vol"
                        value={formatOptionalPercent(latestIndicators.realizedVol20, 2)}
                        hint="20-bar log-return stdev"
                      />
                    </div>
                    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2 text-[11px] leading-4 text-[var(--muted)]">
                      {displayedIndicators?.hasVolume
                        ? `Volume available: 20-bar ratio ${formatOptionalNumber(latestIndicators.volumeRatio20, 2)}x.`
                        : "No usable volume in this candle source yet; volume indicators stay disabled."}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">Run a replay or recommendation to compute read-only market indicators for the selected window.</div>
                )}
              </LabSection>
            </div>
          </div>
        </aside>
      </div>

      <div className="border-t border-[var(--line)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">Leaderboard</div>
          {recommendation ? (
            <button
              type="button"
              onClick={() => {
                setActiveReplay(recommendation.bestReplay);
                setActiveConfigKey(getConfigSignature(recommendation.bestConfig));
              }}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.015)] px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted)] transition hover:border-white/12 hover:bg-white/[0.05] hover:text-white"
            >
              <RotateCcw className="h-3 w-3" />
              Reset to best
            </button>
          ) : null}
        </div>

        {recommendation ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead className="border-b border-[var(--line)] bg-[var(--panel-soft)]/70 text-[var(--muted)]">
                <tr className="font-mono text-[10px] uppercase tracking-[0.14em]">
                  <th className="px-4 py-3">Rank</th>
                  <th className="px-4 py-3">Config</th>
                  <th className="px-4 py-3">Validation net</th>
                  <th className="px-4 py-3">Drawdown</th>
                  <th className="px-4 py-3">In range</th>
                  <th className="px-4 py-3">Closed cycles</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {recommendation.leaderboard.map((entry) => {
                  const key = getConfigSignature(entry.config);
                  const active = key === activeConfigKey;
                  const validationNet = entry.validationMetrics.endingEquityUsd - entry.validationMetrics.startingBudgetUsd;
                  return (
                    <tr
                      key={key}
                      className={cn(
                        "border-b border-[var(--line)] transition",
                        active ? "bg-[var(--accent-soft)]/60" : "hover:bg-white/[0.03]"
                      )}
                    >
                      <td className="px-4 py-3 font-mono text-[12px] text-white">#{entry.rank}</td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{formatGoalLabel(entry.config.strategyMode)}</div>
                        <div className="mt-1 text-[11px] text-[var(--muted)]">
                          {formatSpacingLabel(entry.config.gridType)} | {entry.config.levelCount} rails | {formatNumber(entry.config.lowPrice, entry.config.lowPrice >= 1000 ? 0 : 2)}{" -> "}
                          {formatNumber(entry.config.highPrice, entry.config.highPrice >= 1000 ? 0 : 2)}
                        </div>
                      </td>
                      <td className={cn("px-4 py-3 font-medium", validationNet >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
                        {formatCurrency(validationNet)}
                      </td>
                      <td className="px-4 py-3 text-white">{formatPercent(entry.validationMetrics.maxDrawdownPct, 2)}</td>
                      <td className="px-4 py-3 text-white">{formatPercent(entry.validationMetrics.timeInRangePct, 1)}</td>
                      <td className="px-4 py-3 text-white">{formatNumber(entry.validationMetrics.closedCycleCount, 0)}</td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => replayConfig(entry.config)}
                          disabled={isPending}
                          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.015)] px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted)] transition hover:border-white/12 hover:bg-white/[0.05] hover:text-white disabled:pointer-events-none disabled:opacity-50"
                        >
                          <Play className="h-3 w-3" />
                          Replay
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-4 py-6 text-sm text-[var(--muted)]">No leaderboard yet. Run the optimizer to compare configs.</div>
        )}
      </div>
    </section>
  );
}

function LabSection({
  title,
  defaultOpen = false,
  children
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-md border border-[var(--line)] bg-[var(--panel-soft)]">
      <button type="button" onClick={() => setOpen((current) => !current)} className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left">
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{title}</div>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? <div className="border-t border-[var(--line)] px-3 py-3">{children}</div> : null}
    </section>
  );
}

function LabField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
      {children}
    </div>
  );
}

function LabMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-[13px] font-medium text-white">{value}</div>
      <div className="mt-0.5 text-[10px] text-[var(--muted)]">{hint}</div>
    </div>
  );
}
