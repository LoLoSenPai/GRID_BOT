"use client";

import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Play, Plus, RotateCcw } from "lucide-react";
import { BotMode, GridType, MinOrderMode, RecenterMode, StrategyMode } from "@grid-bot/core/enums";
import { useRouter } from "next/navigation";

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
import {
  BOT_PAIR_PRESETS,
  analyzeBotDraft,
  diffBotDraft,
  getSuggestedMinOrderQuoteAmount,
  normalizeBotDraftCapital,
  type BotDraftAnalysis,
  type BotDraftDiffItem,
  type BotFormDraft
} from "@/lib/bot-management";
import { calculateGridLevels } from "@/lib/bot-runtime";
import {
  LAB_BOT_DRAFT_STORAGE_KEY,
  buildBotDraftFromLabTransfer,
  createLabBotDraftTransfer
} from "@/lib/lab-draft-transfer";
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
  rangeControlMode?: "static" | "adaptive";
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
  rangeAdjustmentCount: number;
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
  applied: boolean;
  risk: "low" | "medium" | "high";
  reason: string;
};

type SerializedBacktestRangeAdjustmentEvent = {
  id: string;
  phase: "train" | "validation";
  timestamp: string;
  previousLowPrice: number;
  previousHighPrice: number;
  previousLevelCount: number;
  previousGridType: SerializedBacktestConfig["gridType"];
  nextLowPrice: number;
  nextHighPrice: number;
  nextLevelCount: number;
  nextGridType: SerializedBacktestConfig["gridType"];
  risk: "low" | "medium" | "high";
  basis: SerializedRangePlan["basis"];
  confidence: number;
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
  midPrice: number;
  midBasis: "current_price" | "donchian_mid" | "ema_cluster" | "current_range_mid";
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
  activeLiveFamily: "range_grid" | "trend_following" | "capital_defense";
  posture: "active" | "caution" | "pause" | "watch";
  liveAction: "keep_running" | "watch_only" | "pause_new_exposure" | "stop_or_recreate" | "paper_only";
  confidence: number;
  operatorAction: string;
  reasons: string[];
  candidates: Array<{
    family: "range_grid" | "trend_following" | "capital_defense";
    score: number;
    reason: string;
    readiness: "live_ready" | "paper_only" | "advisory_only" | "planned";
    liveEnabled: boolean;
  }>;
  registry: Array<{
    family: "range_grid" | "trend_following" | "capital_defense";
    label: string;
    readiness: "live_ready" | "paper_only" | "advisory_only" | "planned";
    liveEnabled: boolean;
    intendedRegimes: Array<"RANGE" | "TREND_UP" | "TREND_DOWN" | "CHAOTIC_HIGH_VOL">;
    summary: string;
    operatorUse: string;
    limitations: string[];
  }>;
};

type SerializedBacktestAssumptions = {
  candleTraversal: "bullish_open_low_high_close_bearish_open_high_low_close";
  fillPolicy: "immediate_on_confirmed_level_cross";
  executionCostModel: "pessimistic_slippage_plus_fee";
  executionCostSource: "fixed_pessimistic" | "calibrated_live_fills";
  maxSlippageBps: number;
  executionFeeBps: number;
  trainValidationSplit: number;
  recenterMode: string;
  recenterScope: "advisory_only" | "simulated_when_auto_recenter";
  rangeControlMode: "static" | "adaptive_lab_only";
  outOfRangeModel: "pause_new_entries_allow_recovery_sells";
  excludedCosts: string[];
  notes: string[];
};

type SerializedExecutionCostCalibration = {
  source: "fixed_pessimistic" | "calibrated_live_fills";
  sampleSize: number;
  buySampleSize: number;
  sellSampleSize: number;
  feeSampleSize: number;
  maxSlippageBps: number;
  executionFeeBps: number;
  averageAdverseSlippageBps: number;
  p50AdverseSlippageBps: number;
  p75AdverseSlippageBps: number;
  p90AdverseSlippageBps: number;
  maxAdverseSlippageBps: number;
  averageFeeBps: number;
  lookbackDays: number;
};

type SerializedBacktestRunResult = {
  config: SerializedBacktestConfig;
  replayPoints: SerializedBacktestReplayPoint[];
  executions: SerializedBacktestReplayExecution[];
  recenterEvents: SerializedBacktestRecenterEvent[];
  rangeAdjustmentEvents: SerializedBacktestRangeAdjustmentEvent[];
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
    executionCostCalibration?: SerializedExecutionCostCalibration;
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
    executionCostCalibration?: SerializedExecutionCostCalibration;
  };
};

type ScenarioComparisonId = "current_setup" | "current_recenter" | "optimizer_best" | "adaptive_plan" | "adaptive_recenter";

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

type LabConclusionTone = "neutral" | "positive" | "caution" | "danger";

type LabConclusion = {
  tone: LabConclusionTone;
  eyebrow: string;
  title: string;
  body: string;
  primaryAction: string;
  details: string[];
};

type LabDraftPreview = {
  analysis: BotDraftAnalysis;
  changes: BotDraftDiffItem[];
  forcedManualRecenter: boolean;
  draft: BotFormDraft;
};

type ScenarioAudit = {
  winner: ScenarioComparisonRow;
  current: ScenarioComparisonRow | null;
  netDelta: number;
  drawdownDelta: number;
  timeInRangeDelta: number;
  closedCyclesDelta: number;
  feesDelta: number;
  slippageDelta: number;
  reasons: string[];
};

type StressScenarioId = "base" | "higher_costs" | "slow_confirmation";

type StressScenarioDefinition = {
  id: StressScenarioId;
  label: string;
  description: string;
  config: SerializedBacktestConfig;
};

type StressScenarioRow = StressScenarioDefinition & {
  replay: SerializedBacktestRunResult;
};

type ReplayDefenseTimelineEntry = {
  id: string;
  timestamp: string;
  phase: SerializedBacktestReplayPoint["phase"];
  tone: "accent" | "green" | "amber" | "red";
  eyebrow: string;
  title: string;
  range: string;
  details: string[];
};

function inferPairFromDraft(draft: BotFormDraft): LabPair {
  const symbol = BOT_PAIR_PRESETS[draft.presetId].baseSymbol;
  if (symbol === "BTC") {
    return "BTC";
  }

  if (symbol === "HYPE") {
    return "HYPE";
  }

  return "SOL";
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
    rangeControlMode: "static",
    outOfRangePause: normalizedDraft.outOfRangePause
  };
}

function buildAdaptiveReplayConfig(baseConfig: SerializedBacktestConfig, rangePlan: SerializedRangePlan): SerializedBacktestConfig {
  return {
    ...baseConfig,
    lowPrice: rangePlan.recommendedLowPrice,
    highPrice: rangePlan.recommendedHighPrice,
    levelCount: rangePlan.recommendedLevelCount,
    gridType: rangePlan.recommendedGridType,
    rangeControlMode: "adaptive"
  };
}

function buildStressScenarioDefinitions(config: SerializedBacktestConfig): StressScenarioDefinition[] {
  const baseFeeBps = config.executionFeeBps ?? 10;
  const higherCostConfig: SerializedBacktestConfig = {
    ...config,
    maxSlippageBps: Math.max(config.maxSlippageBps * 2, 100),
    executionFeeBps: Math.max(baseFeeBps * 2, 20)
  };
  const slowConfirmationConfig: SerializedBacktestConfig = {
    ...config,
    priceConfirmationWindowMs: Math.max(config.priceConfirmationWindowMs, 3_000),
    levelLockMs: Math.max(config.levelLockMs, 3_000)
  };

  return [
    {
      id: "base",
      label: "Base replay",
      description: "Same assumptions as the selected replay.",
      config
    },
    {
      id: "higher_costs",
      label: "Higher costs",
      description: "Double slippage/fees, with a floor of 100 bps slippage and 20 bps fee.",
      config: higherCostConfig
    },
    {
      id: "slow_confirmation",
      label: "Slow confirmation",
      description: "At least 3s confirmation and rail lock to simulate late entries/exits.",
      config: slowConfirmationConfig
    }
  ];
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
    config.recenterMode ?? RecenterMode.Manual,
    config.rangeControlMode ?? "static"
  ].join(":");
}

function getValidationNet(metrics: SerializedBacktestMetrics) {
  return metrics.endingEquityUsd - metrics.startingBudgetUsd;
}

function getDefenseEventCount(metrics: SerializedBacktestMetrics) {
  return metrics.recenterCount + metrics.rangeAdjustmentCount;
}

function getConfigRangeWidthPct(config: SerializedBacktestConfig) {
  return config.lowPrice > 0 ? ((config.highPrice - config.lowPrice) / config.lowPrice) * 100 : 0;
}

function getConfigBudgetPerCycle(config: SerializedBacktestConfig) {
  return config.levelCount > 1 ? config.budgetUsd / (config.levelCount - 1) : 0;
}

function formatSignedCurrency(value: number) {
  return `${value >= 0 ? "+" : ""}${formatCurrency(value)}`;
}

function formatSignedPercent(value: number, digits = 1) {
  return `${value >= 0 ? "+" : ""}${formatPercent(value, digits)}`;
}

function formatSignedNumber(value: number, digits = 0) {
  return `${value >= 0 ? "+" : ""}${formatNumber(value, digits)}`;
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

function formatRangePlanMidBasis(basis: SerializedRangePlan["midBasis"]) {
  switch (basis) {
    case "donchian_mid":
      return "Donchian mid";
    case "ema_cluster":
      return "EMA cluster";
    case "current_range_mid":
      return "Current range";
    case "current_price":
      return "Current price";
  }
}

function formatTimelinePrice(value: number) {
  return formatNumber(value, value >= 1000 ? 0 : 2);
}

function formatTimelineRange(lowPrice: number, highPrice: number) {
  return `${formatTimelinePrice(lowPrice)} -> ${formatTimelinePrice(highPrice)}`;
}

function formatRecenterSide(side: SerializedBacktestRecenterEvent["side"]) {
  switch (side) {
    case "above":
      return "Breakout above";
    case "below":
      return "Breakout below";
    default:
      return "Inside range";
  }
}

function formatDefenseTone(tone: ReplayDefenseTimelineEntry["tone"]) {
  switch (tone) {
    case "green":
      return "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.06)] text-[var(--green)]";
    case "amber":
      return "border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.06)] text-[var(--amber)]";
    case "red":
      return "border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.06)] text-[var(--red)]";
    default:
      return "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]";
  }
}

function buildReplayDefenseTimeline(replay: SerializedBacktestRunResult | null): ReplayDefenseTimelineEntry[] {
  if (!replay) {
    return [];
  }

  const recenterEntries: ReplayDefenseTimelineEntry[] = replay.recenterEvents.map((event) => ({
    id: `recenter-${event.id}`,
    timestamp: event.timestamp,
    phase: event.phase,
    tone: event.risk === "high" ? "red" : event.risk === "medium" ? "amber" : "green",
    eyebrow: "Recenter defense",
    title: `${formatRecenterMode(event.mode)} ${event.applied ? "applied" : "guard"} | ${formatRecenterSide(event.side)}`,
    range: `${event.applied ? "" : "Suggested "}${formatTimelineRange(event.previousLowPrice, event.previousHighPrice)} -> ${formatTimelineRange(event.nextLowPrice, event.nextHighPrice)}`,
    details: [
      event.applied ? "Range applied in replay" : "Guard only; existing rails were not moved",
      event.allowNewBuys ? "New buys allowed" : "New buys paused",
      event.allowRecoverySells ? "Recovery sells allowed" : "Recovery sells paused",
      event.reason
    ]
  }));

  const adaptiveEntries: ReplayDefenseTimelineEntry[] = replay.rangeAdjustmentEvents.map((event) => ({
    id: `adaptive-${event.id}`,
    timestamp: event.timestamp,
    phase: event.phase,
    tone: event.risk === "high" ? "red" : event.risk === "medium" ? "amber" : "accent",
    eyebrow: "Adaptive range",
    title: `Range shifted | ${formatRangePlanBasis(event.basis)}`,
    range: `${formatTimelineRange(event.previousLowPrice, event.previousHighPrice)} -> ${formatTimelineRange(event.nextLowPrice, event.nextHighPrice)}`,
    details: [
      `Rails ${event.previousLevelCount} -> ${event.nextLevelCount}`,
      `Confidence ${formatPercent(event.confidence * 100, 0)}`,
      event.reason
    ]
  }));

  return [...recenterEntries, ...adaptiveEntries]
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, 6);
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

function formatReadinessLabel(readiness: SerializedStrategySelection["registry"][number]["readiness"]) {
  switch (readiness) {
    case "live_ready":
      return "Live-ready";
    case "paper_only":
      return "Paper-only";
    case "advisory_only":
      return "Advisory";
    case "planned":
      return "Planned";
  }
}

function formatReadinessTone(readiness: SerializedStrategySelection["registry"][number]["readiness"]) {
  switch (readiness) {
    case "live_ready":
      return "border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] text-[var(--green)]";
    case "planned":
      return "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]";
    case "paper_only":
      return "border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)] text-[var(--amber)]";
    default:
      return "border-[color:rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.035)] text-[var(--muted)]";
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

function formatStrategyLiveActionLabel(action: SerializedStrategySelection["liveAction"]) {
  switch (action) {
    case "keep_running":
      return "Keep running";
    case "watch_only":
      return "Watch only";
    case "pause_new_exposure":
      return "Pause new buys";
    case "stop_or_recreate":
      return "Stop / recreate";
    case "paper_only":
      return "Paper only";
  }
}

function formatStrategyLiveActionTone(action: SerializedStrategySelection["liveAction"]) {
  switch (action) {
    case "keep_running":
      return "text-[var(--green)] border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)]";
    case "pause_new_exposure":
    case "paper_only":
      return "text-[var(--amber)] border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)]";
    case "stop_or_recreate":
      return "text-[var(--red)] border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)]";
    default:
      return "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]";
  }
}

function formatScenarioDescription(row: ScenarioComparisonRow) {
  const recenterSuffix = row.config.recenterMode === RecenterMode.Auto ? " | recenter" : "";
  const adaptiveSuffix = row.config.rangeControlMode === "adaptive" ? " | adaptive" : "";
  return `${formatGoalLabel(row.config.strategyMode)} | ${formatSpacingLabel(row.config.gridType)} | ${row.config.levelCount} rails${recenterSuffix}${adaptiveSuffix}`;
}

function formatScenarioLabel(id: ScenarioComparisonId) {
  switch (id) {
    case "current_setup":
      return "Current setup";
    case "current_recenter":
      return "Current + recenter";
    case "optimizer_best":
      return "Optimizer best";
    case "adaptive_plan":
      return "Adaptive plan";
    case "adaptive_recenter":
      return "Adaptive + recenter";
  }
}

function getScenarioSummaryAction(id: ScenarioComparisonId) {
  switch (id) {
    case "current_setup":
      return "Keep the current bot for now.";
    case "current_recenter":
      return "Keep the current config, but treat recenter as the next paper-only test.";
    case "optimizer_best":
      return "Consider recreating the bot with the optimizer config.";
    case "adaptive_plan":
      return "Consider recreating with the adaptive range candidate, preferably in paper first.";
    case "adaptive_recenter":
      return "Paper-test the adaptive range plus recenter defense before any live rollout.";
  }
}

function rankScenarioRows(rows: ScenarioComparisonRow[]) {
  return [...rows].sort((left, right) => {
    const netDelta = getValidationNet(right.replay.validationMetrics) - getValidationNet(left.replay.validationMetrics);
    if (Math.abs(netDelta) > 0.000001) {
      return netDelta;
    }

    const drawdownDelta = left.replay.validationMetrics.maxDrawdownPct - right.replay.validationMetrics.maxDrawdownPct;
    if (Math.abs(drawdownDelta) > 0.000001) {
      return drawdownDelta;
    }

    return right.replay.validationMetrics.timeInRangePct - left.replay.validationMetrics.timeInRangePct;
  });
}

function buildScenarioAudit(rows: ScenarioComparisonRow[]): ScenarioAudit | null {
  if (!rows.length) {
    return null;
  }

  const rankedRows = rankScenarioRows(rows);
  const winner = rankedRows[0] ?? null;
  if (!winner) {
    return null;
  }

  const current = rows.find((row) => row.id === "current_setup") ?? null;
  const winnerValidation = winner.replay.validationMetrics;
  const currentValidation = current?.replay.validationMetrics ?? null;
  const netDelta = currentValidation ? getValidationNet(winnerValidation) - getValidationNet(currentValidation) : 0;
  const drawdownDelta = currentValidation ? winnerValidation.maxDrawdownPct - currentValidation.maxDrawdownPct : 0;
  const timeInRangeDelta = currentValidation ? winnerValidation.timeInRangePct - currentValidation.timeInRangePct : 0;
  const closedCyclesDelta = currentValidation ? winnerValidation.closedCycleCount - currentValidation.closedCycleCount : 0;
  const feesDelta = currentValidation ? winnerValidation.totalFeesUsd - currentValidation.totalFeesUsd : 0;
  const slippageDelta = currentValidation ? winnerValidation.averageSlippageBps - currentValidation.averageSlippageBps : 0;
  const reasons = [
    current
      ? netDelta > 0.000001
        ? `${formatScenarioLabel(winner.id)} made ${formatCurrency(netDelta)} more validation equity than current.`
        : "The current setup is within the material threshold of the winner."
      : "No current setup baseline is available, so the winner is ranked against other Lab candidates only.",
    drawdownDelta < -0.000001
      ? `Drawdown improved by ${formatPercent(Math.abs(drawdownDelta), 1)}.`
      : drawdownDelta > 0.000001
        ? `Drawdown worsened by ${formatPercent(drawdownDelta, 1)}, so this is not a free improvement.`
        : "Drawdown is effectively unchanged.",
    timeInRangeDelta > 0.000001
      ? `It stayed in range ${formatPercent(timeInRangeDelta, 0)} more often.`
      : timeInRangeDelta < -0.000001
        ? `It spent ${formatPercent(Math.abs(timeInRangeDelta), 0)} less time in range.`
        : "Time in range is effectively unchanged.",
    getDefenseEventCount(winner.replay.overallMetrics) > 0
      ? `${getDefenseEventCount(winner.replay.overallMetrics)} defense event(s) were simulated; treat this as paper/advisory until validated live.`
      : "No recenter/adaptive defense event was needed by the winner."
  ];

  return {
    winner,
    current,
    netDelta,
    drawdownDelta,
    timeInRangeDelta,
    closedCyclesDelta,
    feesDelta,
    slippageDelta,
    reasons
  };
}

function getStressTone(row: StressScenarioRow, baseRow: StressScenarioRow | null): LabConclusionTone {
  const metrics = row.replay.validationMetrics;
  const net = getValidationNet(metrics);
  if (net < 0 || metrics.timeInRangePct < 50 || metrics.maxDrawdownPct > 20) {
    return "danger";
  }

  if (baseRow) {
    const baseMetrics = baseRow.replay.validationMetrics;
    const baseNet = getValidationNet(baseMetrics);
    if (
      net < baseNet * 0.5 ||
      metrics.maxDrawdownPct > baseMetrics.maxDrawdownPct + 5 ||
      metrics.timeInRangePct < baseMetrics.timeInRangePct - 15
    ) {
      return "caution";
    }
  }

  return "positive";
}

function buildLabConclusion({
  scenarioComparison,
  recommendation,
  displayedReplay
}: {
  scenarioComparison: ScenarioComparisonRow[];
  recommendation: SerializedBacktestRecommendation | null;
  displayedReplay: SerializedBacktestRunResult | null;
}): LabConclusion {
  if (scenarioComparison.length) {
    const rankedRows = rankScenarioRows(scenarioComparison);
    const best = rankedRows[0]!;
    const current = scenarioComparison.find((row) => row.id === "current_setup") ?? null;
    const bestNet = getValidationNet(best.replay.validationMetrics);
    const currentNet = current ? getValidationNet(current.replay.validationMetrics) : null;
    const currentGap = currentNet === null ? 0 : bestNet - currentNet;
    const budget = best.replay.validationMetrics.startingBudgetUsd || best.config.budgetUsd || 1;
    const materialGap = Math.max(1, budget * 0.002);
    const riskTone: LabConclusionTone =
      best.replay.validationMetrics.timeInRangePct < 50 || best.replay.validationMetrics.maxDrawdownPct > 20
        ? "danger"
        : best.replay.validationMetrics.timeInRangePct < 70 || best.replay.validationMetrics.maxDrawdownPct > 12
          ? "caution"
          : "positive";
    const bestLabel = formatScenarioLabel(best.id);
    const isCurrentGoodEnough = best.id === "current_setup" || currentGap <= materialGap;
    const defenseEvents = getDefenseEventCount(best.replay.overallMetrics);
    const details = [
      `Best validation result: ${bestLabel} at ${formatCurrency(bestNet)} net.`,
      currentNet === null ? null : `Current setup gap: ${formatCurrency(currentGap)} versus the best scenario.`,
      `Risk check: ${formatPercent(best.replay.validationMetrics.maxDrawdownPct, 1)} max drawdown, ${formatPercent(best.replay.validationMetrics.timeInRangePct, 0)} in range.`,
      defenseEvents > 0
        ? `${defenseEvents} defense event(s): ${best.replay.overallMetrics.recenterCount} recenter, ${best.replay.overallMetrics.rangeAdjustmentCount} adaptive shift.`
        : "No defensive recenter/adaptive event on the selected winner."
    ].filter((detail): detail is string => Boolean(detail));

    if (isCurrentGoodEnough) {
      return {
        tone: riskTone === "danger" ? "caution" : "positive",
        eyebrow: "Decision",
        title: "Keep the current bot for now",
        body: "The alternatives do not beat your current setup by enough on validation to justify recreating the bot immediately.",
        primaryAction: "Keep monitoring. Recreate only if price closes outside the range for the stop rule.",
        details
      };
    }

    if (best.id === "current_recenter") {
      return {
        tone: riskTone,
        eyebrow: "Decision",
        title: "Current config is close, recenter helps",
        body: "The Lab says the same setup performs better when recenter defense is simulated. This is a paper/Lab signal, not a live auto-recenter recommendation yet.",
        primaryAction: getScenarioSummaryAction(best.id),
        details
      };
    }

    return {
      tone: riskTone,
      eyebrow: "Decision",
      title: `${bestLabel} is the best candidate`,
      body: "The best validation result comes from a different configuration. Treat it as a recreate candidate, not a silent edit to the running bot.",
      primaryAction: getScenarioSummaryAction(best.id),
      details
    };
  }

  if (recommendation) {
    const net = getValidationNet(recommendation.validationMetrics);
    return {
      tone: recommendation.operatorGuidance.status === "Healthy" ? "positive" : recommendation.operatorGuidance.status === "Fragile" ? "danger" : "caution",
      eyebrow: "Optimizer result",
      title: `Optimizer found ${formatGoalLabel(recommendation.bestConfig.strategyMode)}`,
      body: "This is only the search winner. Run Compare scenarios before deciding whether it is better than the selected bot.",
      primaryAction: `Validation net ${formatCurrency(net)}. Next: Compare scenarios.`,
      details: [
        `${formatSpacingLabel(recommendation.bestConfig.gridType)}, ${recommendation.bestConfig.levelCount} rails.`,
        `Range ${formatNumber(recommendation.bestConfig.lowPrice, recommendation.bestConfig.lowPrice >= 1000 ? 0 : 2)} -> ${formatNumber(recommendation.bestConfig.highPrice, recommendation.bestConfig.highPrice >= 1000 ? 0 : 2)}.`,
        `Risk check: ${formatPercent(recommendation.validationMetrics.maxDrawdownPct, 1)} max drawdown, ${formatPercent(recommendation.validationMetrics.timeInRangePct, 0)} in range.`,
        "Optimizer configs stay static; use Compare scenarios to test recenter/adaptive variants."
      ]
    };
  }

  if (displayedReplay) {
    const net = getValidationNet(displayedReplay.validationMetrics);
    return {
      tone: net >= 0 ? "neutral" : "caution",
      eyebrow: "Single replay",
      title: "One setup replayed",
      body: "A single replay is useful for inspection, but it does not tell you whether this setup is better than the alternatives.",
      primaryAction: "Run Compare scenarios to get a real decision.",
      details: [
        `Validation net ${formatCurrency(net)}.`,
        `${formatPercent(displayedReplay.validationMetrics.maxDrawdownPct, 1)} max drawdown, ${formatPercent(displayedReplay.validationMetrics.timeInRangePct, 0)} in range.`,
        displayedReplay.overallMetrics.rangeAdjustmentCount > 0
          ? `${displayedReplay.overallMetrics.rangeAdjustmentCount} adaptive range shift(s) happened in this replay.`
          : "No adaptive range shift happened in this replay."
      ]
    };
  }

  return {
    tone: "neutral",
    eyebrow: "Start here",
    title: "Run Compare scenarios first",
    body: "The Lab is useful only after it compares your selected bot against recenter, optimizer, and adaptive alternatives on the same window.",
    primaryAction: "Pick the bot, budget, window, then click Compare scenarios.",
    details: ["Nothing here touches live trading.", "Use diagnostics only after the conclusion looks surprising."]
  };
}

function getConclusionToneClass(tone: LabConclusionTone) {
  switch (tone) {
    case "positive":
      return "border-[color:rgba(68,211,156,0.22)] bg-[linear-gradient(180deg,rgba(68,211,156,0.1),rgba(68,211,156,0.035))]";
    case "danger":
      return "border-[color:rgba(255,107,122,0.24)] bg-[linear-gradient(180deg,rgba(255,107,122,0.1),rgba(255,107,122,0.035))]";
    case "caution":
      return "border-[color:rgba(248,200,108,0.24)] bg-[linear-gradient(180deg,rgba(248,200,108,0.1),rgba(248,200,108,0.035))]";
    default:
      return "border-[var(--accent-line)] bg-[linear-gradient(180deg,rgba(121,184,255,0.1),rgba(121,184,255,0.035))]";
  }
}

function ScenarioComparisonBoard({
  rows,
  activeConfigKey,
  onSelect
}: {
  rows: ScenarioComparisonRow[];
  activeConfigKey: string | null;
  onSelect: (row: ScenarioComparisonRow) => void;
}) {
  if (!rows.length) {
    return (
      <section className="mb-3 border border-[var(--line)] bg-[linear-gradient(180deg,rgba(121,184,255,0.045),rgba(5,12,22,0.36))] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">Lab workflow</div>
            <div className="mt-1 text-base font-semibold text-white">Start with Compare scenarios</div>
            <div className="mt-1 max-w-3xl text-sm leading-5 text-[var(--muted)]">
              This is the main decision mode. It compares the selected bot against recenter, optimizer, adaptive, and adaptive+recenter candidates on the same history window.
            </div>
          </div>
          <div className="rounded-md border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--accent)]">
            No live mutation
          </div>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <div className="border border-[rgba(255,255,255,0.07)] bg-[rgba(0,0,0,0.14)] px-3 py-2">
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--accent)]">1. Compare</div>
            <div className="mt-1 text-sm text-white">Run the scenario board first.</div>
            <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">Current bot, recenter, optimizer winner, adaptive range, and the combo.</div>
          </div>
          <div className="border border-[rgba(255,255,255,0.07)] bg-[rgba(0,0,0,0.14)] px-3 py-2">
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--accent)]">2. Decide</div>
            <div className="mt-1 text-sm text-white">Read the top decision panel.</div>
            <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">It should tell you keep, recreate, or paper-test recenter.</div>
          </div>
          <div className="border border-[rgba(255,255,255,0.07)] bg-[rgba(0,0,0,0.14)] px-3 py-2">
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--accent)]">3. Inspect</div>
            <div className="mt-1 text-sm text-white">Open diagnostics only if needed.</div>
            <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">Regime, indicators, recenter, and assumptions explain surprises.</div>
          </div>
        </div>
      </section>
    );
  }

  const rankedRows = rankScenarioRows(rows);
  const winner = rankedRows[0] ?? null;

  return (
    <section className="mb-3 border border-[var(--line)] bg-[rgba(5,12,22,0.54)] px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">Decision board</div>
          <div className="mt-1 text-base font-semibold text-white">Same window, multiple ways to run the bot</div>
          <div className="mt-1 max-w-3xl text-sm leading-5 text-[var(--muted)]">
            Ranking uses validation first. Click a scenario to inspect its chart, equity curve, defense events, and assumptions.
          </div>
        </div>
        {winner ? (
          <div className="rounded-md border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3 py-2 text-right">
            <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted)]">Current winner</div>
            <div className="mt-0.5 text-sm font-medium text-white">{formatScenarioLabel(winner.id)}</div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 xl:grid-cols-5">
        {rankedRows.map((row) => {
          const active = getConfigSignature(row.config) === activeConfigKey;
          const winnerRow = winner?.id === row.id;
          const validationNet = getValidationNet(row.replay.validationMetrics);
          const defensiveCount = getDefenseEventCount(row.replay.validationMetrics);
          const fragile = row.replay.validationMetrics.timeInRangePct < 50 || row.replay.validationMetrics.maxDrawdownPct > 20;
          return (
            <button
              key={row.id}
              type="button"
              onClick={() => onSelect(row)}
              className={cn(
                "group flex min-h-[220px] flex-col rounded-md border px-3 py-3 text-left transition",
                active
                  ? "border-[var(--accent-line)] bg-[var(--accent-soft)] shadow-[0_0_0_1px_rgba(121,184,255,0.12)]"
                  : "border-[var(--line)] bg-[rgba(0,0,0,0.14)] hover:border-white/12 hover:bg-white/[0.035]"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-white">{row.label}</div>
                  <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">{formatScenarioDescription(row)}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {winnerRow ? (
                    <span className="rounded border border-[var(--accent-line)] bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--accent)]">
                      Winner
                    </span>
                  ) : null}
                  {fragile ? (
                    <span className="rounded border border-[color:rgba(248,200,108,0.22)] bg-[color:rgba(248,200,108,0.08)] px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--amber)]">
                      Fragile
                    </span>
                  ) : null}
                </div>
              </div>

              <div className={cn("mt-3 text-2xl font-semibold tracking-[-0.04em]", validationNet >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
                {formatCurrency(validationNet)}
              </div>
              <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Validation net</div>

              <div className="mt-3 grid grid-cols-2 gap-1.5">
                <ScenarioMiniMetric label="DD" value={formatPercent(row.replay.validationMetrics.maxDrawdownPct, 1)} />
                <ScenarioMiniMetric label="Range" value={formatPercent(row.replay.validationMetrics.timeInRangePct, 0)} />
                <ScenarioMiniMetric label="Cycles" value={formatNumber(row.replay.validationMetrics.closedCycleCount, 0)} />
                <ScenarioMiniMetric label="Defense" value={formatNumber(defensiveCount, 0)} />
              </div>

              <div className="mt-auto pt-3">
                <div className="border-t border-[rgba(255,255,255,0.07)] pt-2 text-[11px] leading-4 text-[var(--muted)]">
                  {getScenarioSummaryAction(row.id)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ScenarioMiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[rgba(255,255,255,0.07)] bg-[rgba(255,255,255,0.025)] px-2 py-1.5">
      <div className="font-mono text-[8px] uppercase tracking-[0.12em] text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 text-[11px] font-medium text-white">{value}</div>
    </div>
  );
}

function ScenarioAuditPanel({ audit }: { audit: ScenarioAudit | null }) {
  if (!audit) {
    return null;
  }

  const { winner, current } = audit;
  const winnerWidth = getConfigRangeWidthPct(winner.config);
  const currentWidth = current ? getConfigRangeWidthPct(current.config) : null;
  const winnerBudgetPerCycle = getConfigBudgetPerCycle(winner.config);
  const currentBudgetPerCycle = current ? getConfigBudgetPerCycle(current.config) : null;

  return (
    <section className="mb-3 border border-[var(--line)] bg-[rgba(5,12,22,0.46)] px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">Why this won</div>
          <div className="mt-1 text-base font-semibold text-white">
            {formatScenarioLabel(winner.id)} vs {current ? "current setup" : "Lab candidates"}
          </div>
          <div className="mt-1 max-w-3xl text-sm leading-5 text-[var(--muted)]">
            Winner selection is validation-first. These deltas explain whether the result is really better or just different.
          </div>
        </div>
        <div className="rounded-md border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3 py-2 text-right">
          <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted)]">Winner net delta</div>
          <div className={cn("mt-0.5 text-sm font-medium", audit.netDelta >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
            {current ? formatSignedCurrency(audit.netDelta) : formatCurrency(getValidationNet(winner.replay.validationMetrics))}
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <AuditDeltaCard
          label="Validation net"
          winner={formatCurrency(getValidationNet(winner.replay.validationMetrics))}
          current={current ? formatCurrency(getValidationNet(current.replay.validationMetrics)) : "--"}
          delta={current ? formatSignedCurrency(audit.netDelta) : "winner"}
          tone={audit.netDelta >= 0 ? "positive" : "negative"}
        />
        <AuditDeltaCard
          label="Max drawdown"
          winner={formatPercent(winner.replay.validationMetrics.maxDrawdownPct, 1)}
          current={current ? formatPercent(current.replay.validationMetrics.maxDrawdownPct, 1) : "--"}
          delta={current ? formatSignedPercent(audit.drawdownDelta, 1) : "winner"}
          tone={audit.drawdownDelta <= 0 ? "positive" : "negative"}
        />
        <AuditDeltaCard
          label="Time in range"
          winner={formatPercent(winner.replay.validationMetrics.timeInRangePct, 0)}
          current={current ? formatPercent(current.replay.validationMetrics.timeInRangePct, 0) : "--"}
          delta={current ? formatSignedPercent(audit.timeInRangeDelta, 0) : "winner"}
          tone={audit.timeInRangeDelta >= 0 ? "positive" : "negative"}
        />
        <AuditDeltaCard
          label="Closed cycles"
          winner={formatNumber(winner.replay.validationMetrics.closedCycleCount, 0)}
          current={current ? formatNumber(current.replay.validationMetrics.closedCycleCount, 0) : "--"}
          delta={current ? formatSignedNumber(audit.closedCyclesDelta, 0) : "winner"}
          tone={audit.closedCyclesDelta >= 0 ? "positive" : "negative"}
        />
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <AuditDeltaCard
          label="Range"
          winner={`${formatNumber(winner.config.lowPrice, winner.config.lowPrice >= 1000 ? 0 : 2)} -> ${formatNumber(winner.config.highPrice, winner.config.highPrice >= 1000 ? 0 : 2)}`}
          current={
            current
              ? `${formatNumber(current.config.lowPrice, current.config.lowPrice >= 1000 ? 0 : 2)} -> ${formatNumber(current.config.highPrice, current.config.highPrice >= 1000 ? 0 : 2)}`
              : "--"
          }
          delta={`${formatPercent(winnerWidth, 1)} width`}
          tone="neutral"
        />
        <AuditDeltaCard
          label="Rails / spacing"
          winner={`${winner.config.levelCount} ${formatSpacingLabel(winner.config.gridType)}`}
          current={current ? `${current.config.levelCount} ${formatSpacingLabel(current.config.gridType)}` : "--"}
          delta={`${winner.config.levelCount - 1} cycles`}
          tone="neutral"
        />
        <AuditDeltaCard
          label="Budget / cycle"
          winner={formatCurrency(winnerBudgetPerCycle)}
          current={currentBudgetPerCycle === null ? "--" : formatCurrency(currentBudgetPerCycle)}
          delta={currentBudgetPerCycle === null ? "winner" : formatSignedCurrency(winnerBudgetPerCycle - currentBudgetPerCycle)}
          tone="neutral"
        />
        <AuditDeltaCard
          label="Cost model"
          winner={`${formatCurrency(winner.replay.validationMetrics.totalFeesUsd)} fees`}
          current={current ? `${formatCurrency(current.replay.validationMetrics.totalFeesUsd)} fees` : "--"}
          delta={current ? `${formatSignedCurrency(audit.feesDelta)} | ${formatSignedNumber(audit.slippageDelta, 1)} bps` : "winner"}
          tone={audit.feesDelta <= 0 && audit.slippageDelta <= 0 ? "positive" : "neutral"}
        />
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {audit.reasons.map((reason) => (
          <div key={reason} className="border border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.14)] px-2.5 py-2 text-[11px] leading-4 text-[var(--muted)]">
            {reason}
          </div>
        ))}
      </div>
      {currentWidth !== null ? (
        <div className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
          Current range width {formatPercent(currentWidth, 1)}. Winner range width {formatPercent(winnerWidth, 1)}. Wider is not always safer; the validation metrics decide.
        </div>
      ) : null}
    </section>
  );
}

function AuditDeltaCard({
  label,
  winner,
  current,
  delta,
  tone
}: {
  label: string;
  winner: string;
  current: string;
  delta: string;
  tone: "positive" | "negative" | "neutral";
}) {
  const toneClass =
    tone === "positive"
      ? "text-[var(--green)]"
      : tone === "negative"
        ? "text-[var(--red)]"
        : "text-[var(--accent)]";

  return (
    <div className="rounded-md border border-[var(--line)] bg-[rgba(0,0,0,0.16)] px-2.5 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-[13px] font-medium text-white">{winner}</div>
      <div className="mt-0.5 text-[10px] text-[var(--muted)]">Current: {current}</div>
      <div className={cn("mt-1 font-mono text-[10px] uppercase tracking-[0.12em]", toneClass)}>{delta}</div>
    </div>
  );
}

function StressCheckPanel({
  rows,
  canRun,
  isPending,
  onRun,
  onSelect
}: {
  rows: StressScenarioRow[];
  canRun: boolean;
  isPending: boolean;
  onRun: () => void;
  onSelect: (row: StressScenarioRow) => void;
}) {
  const baseRow = rows.find((row) => row.id === "base") ?? null;

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onRun}
        disabled={!canRun || isPending}
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[var(--line)] bg-[rgba(255,255,255,0.015)] px-3 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--muted)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] disabled:pointer-events-none disabled:opacity-50"
      >
        <FlaskConical className="h-3.5 w-3.5 shrink-0" />
        {isPending ? "Running..." : "Run stress checks"}
      </button>
      <div className="text-[11px] leading-4 text-[var(--muted)]">
        Replays the selected config under harsher assumptions. It does not search, mutate, or touch live bots.
      </div>

      {rows.length ? (
        <div className="space-y-2">
          {rows.map((row) => {
            const tone = getStressTone(row, baseRow);
            const metrics = row.replay.validationMetrics;
            const baseNet = baseRow ? getValidationNet(baseRow.replay.validationMetrics) : null;
            const net = getValidationNet(metrics);
            const netDelta = baseNet === null || row.id === "base" ? null : net - baseNet;
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => onSelect(row)}
                className={cn(
                  "w-full rounded-md border px-2.5 py-2 text-left transition hover:border-white/12 hover:bg-white/[0.035]",
                  getConclusionToneClass(tone)
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-white">{row.label}</div>
                    <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">{row.description}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={cn("text-sm font-medium", net >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
                      {formatCurrency(net)}
                    </div>
                    {netDelta !== null ? (
                      <div className={cn("font-mono text-[9px] uppercase tracking-[0.12em]", netDelta >= 0 ? "text-[var(--green)]" : "text-[var(--red)]")}>
                        {formatSignedCurrency(netDelta)}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  <ScenarioMiniMetric label="DD" value={formatPercent(metrics.maxDrawdownPct, 1)} />
                  <ScenarioMiniMetric label="Range" value={formatPercent(metrics.timeInRangePct, 0)} />
                  <ScenarioMiniMetric label="Cycles" value={formatNumber(metrics.closedCycleCount, 0)} />
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2 text-[11px] leading-4 text-[var(--muted)]">
          Run this after selecting the replay or winning scenario you are considering turning into a bot.
        </div>
      )}
    </div>
  );
}

function LabDraftPreviewCard({ preview }: { preview: LabDraftPreview }) {
  const blocking = preview.analysis.blockingIssues.length;
  const warningCount = preview.analysis.warnings.length;
  const toneClass = blocking
    ? "border-[color:rgba(255,107,122,0.22)] bg-[color:rgba(255,107,122,0.07)] text-[var(--red)]"
    : warningCount
      ? "border-[color:rgba(248,200,108,0.22)] bg-[color:rgba(248,200,108,0.07)] text-[var(--amber)]"
      : "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]";
  const status = blocking ? "Blocked" : warningCount ? "Caution" : "Deployable";
  const topIssues = [...preview.analysis.blockingIssues, ...preview.analysis.warnings].slice(0, 2);

  return (
    <div className={cn("rounded-md border px-2.5 py-2", toneClass)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.14em]">Bot draft check</div>
          <div className="mt-0.5 text-sm font-medium text-white">{status}</div>
        </div>
        <div className="text-right font-mono text-[10px] uppercase tracking-[0.12em]">
          {preview.changes.length} change{preview.changes.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <ScenarioMiniMetric label="Budget / cycle" value={formatCurrency(preview.analysis.summary.budgetPerCycleUsd)} />
        <ScenarioMiniMetric label="Min order" value={formatCurrency(preview.draft.minOrderQuoteAmount)} />
        <ScenarioMiniMetric label="Rails" value={formatNumber(preview.draft.levelCount, 0)} />
        <ScenarioMiniMetric label="Width" value={formatPercent(preview.analysis.summary.rangeWidthPct, 1)} />
      </div>
      {preview.forcedManualRecenter ? (
        <div className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
          Recenter/adaptive simulation will be converted to manual review before creating the bot.
        </div>
      ) : null}
      {topIssues.length ? (
        <div className="mt-2 space-y-1">
          {topIssues.map((issue) => (
            <div key={`${issue.field ?? "draft"}:${issue.message}`} className="text-[10px] leading-4 text-[var(--muted)]">
              {issue.message}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
          Same validation rules as the bot creation form.
        </div>
      )}
    </div>
  );
}

export function BacktestLabConsole({
  bots,
  deskMode,
  liveTradingEnabled,
  selectedBotId,
  onSelectBotId
}: {
  bots: LabPrefillBot[];
  deskMode: BotMode;
  liveTradingEnabled: boolean;
  selectedBotId?: string | null;
  onSelectBotId?: (botId: string | null) => void;
}) {
  const router = useRouter();
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
  const [stressRows, setStressRows] = useState<StressScenarioRow[]>([]);
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
    setStressRows([]);
  }, [pair, budgetUsd, lookbackDays, resolution, selectedBot?.id]);

  const displayedReplay = activeReplay ?? recommendation?.bestReplay ?? null;
  const displayedGuidance = recommendation?.operatorGuidance ?? null;
  const displayedRecenterAdvice = displayedReplay?.recenterAdvice ?? recommendation?.recenterAdvice ?? null;
  const displayedRangePlan = displayedReplay?.rangePlan ?? recommendation?.rangePlan ?? null;
  const displayedStrategySelection = displayedReplay?.strategySelection ?? recommendation?.strategySelection ?? null;
  const displayedBaseConfig = displayedReplay?.config ?? recommendation?.bestConfig ?? null;
  const displayedAssumptions = displayedReplay?.assumptions ?? recommendation?.assumptions ?? null;
  const displayedCostCalibration = displayedReplay?.meta.executionCostCalibration ?? recommendation?.meta.executionCostCalibration ?? null;
  const draftPreview = useMemo<LabDraftPreview | null>(() => {
    if (!displayedBaseConfig) {
      return null;
    }

    const transfer = createLabBotDraftTransfer({
      pair,
      mode: selectedBot?.config.mode ?? deskMode,
      label: `${pair}/USDC Lab preview`,
      config: displayedBaseConfig
    });
    const result = buildBotDraftFromLabTransfer(transfer, deskMode);

    return {
      draft: result.draft,
      forcedManualRecenter: result.forcedManualRecenter,
      analysis: analyzeBotDraft(result.draft, liveTradingEnabled),
      changes: selectedBot ? diffBotDraft(selectedBot.config, result.draft) : []
    };
  }, [deskMode, displayedBaseConfig, liveTradingEnabled, pair, selectedBot]);
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
  const defenseTimeline = useMemo(() => buildReplayDefenseTimeline(displayedReplay), [displayedReplay]);
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

  function openConfigAsBotDraft(config: SerializedBacktestConfig | null) {
    if (!config) {
      setFeedback({
        tone: "error",
        message: "Run or select a replay before opening a bot draft."
      });
      return;
    }

    const lowLabel = formatNumber(config.lowPrice, config.lowPrice >= 1000 ? 0 : 2);
    const highLabel = formatNumber(config.highPrice, config.highPrice >= 1000 ? 0 : 2);
    const mode = selectedBot?.config.mode ?? deskMode;
    const transfer = createLabBotDraftTransfer({
      pair,
      mode,
      label: `${pair}/USDC Lab ${lowLabel}-${highLabel}`,
      config
    });
    const result = buildBotDraftFromLabTransfer(transfer, deskMode);
    const analysis = analyzeBotDraft(result.draft, liveTradingEnabled);
    if (analysis.blockingIssues.length) {
      setFeedback({
        tone: "error",
        message: `This Lab config cannot be opened as a bot draft yet: ${analysis.blockingIssues[0]?.message ?? "invalid draft"}`
      });
      return;
    }

    try {
      window.localStorage.setItem(LAB_BOT_DRAFT_STORAGE_KEY, JSON.stringify(transfer));
      router.push(`/bots?deskMode=${transfer.mode}&draft=lab`);
    } catch {
      setFeedback({
        tone: "error",
        message: "Unable to prepare the bot draft in this browser."
      });
    }
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
      setStressRows([]);
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
      setStressRows([]);
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Unable to replay this config."
      });
    } finally {
      setIsPending(false);
    }
  }

  async function runStressChecks() {
    if (!displayedBaseConfig || !displayedReplay) {
      setFeedback({
        tone: "error",
        message: "Select or run a replay before running stress checks."
      });
      return;
    }

    setFeedback(null);
    setIsPending(true);
    try {
      const definitions = buildStressScenarioDefinitions(displayedBaseConfig);
      const nextRows: StressScenarioRow[] = [];

      for (const definition of definitions) {
        if (definition.id === "base" && getConfigSignature(displayedReplay.config) === getConfigSignature(displayedBaseConfig)) {
          nextRows.push({ ...definition, replay: displayedReplay });
          continue;
        }

        const replay = await requestReplay(definition.config);
        nextRows.push({ ...definition, replay });
      }

      setStressRows(nextRows);
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Unable to run stress checks."
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
      setStressRows([]);
      const winner = rankScenarioRows(payload.rows)[0] ?? payload.rows[0] ?? null;
      if (winner) {
        setActiveReplay(winner.replay);
        setActiveConfigKey(getConfigSignature(winner.config));
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
  const labConclusion = useMemo(
    () => buildLabConclusion({ scenarioComparison, recommendation, displayedReplay }),
    [displayedReplay, recommendation, scenarioComparison]
  );
  const scenarioAudit = useMemo(() => buildScenarioAudit(scenarioComparison), [scenarioComparison]);

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

      <LabConclusionPanel conclusion={labConclusion} />
      <ScenarioAuditPanel audit={scenarioAudit} />
      <ScenarioComparisonBoard
        rows={scenarioComparison}
        activeConfigKey={activeConfigKey}
        onSelect={(row) => {
          setActiveReplay(row.replay);
          setActiveConfigKey(getConfigSignature(row.config));
        }}
      />

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
                      Best first step: current setup, recenter, optimizer best, adaptive plan, and adaptive+recenter on the same window.
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
                    {displayedBaseConfig ? (
                      <>
                        <button
                          type="button"
                          onClick={() => openConfigAsBotDraft(displayedBaseConfig)}
                          disabled={isPending || Boolean(draftPreview?.analysis.blockingIssues.length)}
                          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[var(--accent-line)] bg-[linear-gradient(180deg,rgba(121,184,255,0.16),rgba(121,184,255,0.08))] px-3 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-[rgba(121,184,255,0.45)] hover:bg-[rgba(121,184,255,0.14)] hover:text-white disabled:pointer-events-none disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5 shrink-0" />
                          Open as bot draft
                        </button>
                        <div className="text-[11px] leading-4 text-[var(--muted)]">
                          Opens a new `/bots` draft only. Adaptive/recenter simulation stays advisory; review before creating.
                        </div>
                        {draftPreview ? <LabDraftPreviewCard preview={draftPreview} /> : null}
                      </>
                    ) : null}
                  </div>
                </div>
              </LabSection>

              <LabSection title="Best setup found">
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

              <LabSection title="Current replay">
                {displayedReplay ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-2">
                      <LabMetric label="Train PnL" value={formatCurrency(displayedReplay.trainMetrics.totalPnlUsd)} hint={formatPercent(displayedReplay.trainMetrics.returnPct, 2)} />
                      <LabMetric label="Validation PnL" value={formatCurrency(displayedReplay.validationMetrics.totalPnlUsd)} hint={formatPercent(displayedReplay.validationMetrics.returnPct, 2)} />
                      <LabMetric label="Overall PnL" value={formatCurrency(displayedReplay.overallMetrics.totalPnlUsd)} hint={formatPercent(displayedReplay.overallMetrics.returnPct, 2)} />
                      <LabMetric label="Max occupancy" value={formatPercent(displayedReplay.validationMetrics.maxOccupancyPct, 1)} hint="Validation window" />
                      <LabMetric label="Fees" value={formatCurrency(displayedReplay.overallMetrics.totalFeesUsd)} hint={`${displayedReplay.overallMetrics.simulatedOrderCount} simulated fills`} />
                      <LabMetric label="Avg slippage" value={formatBps(displayedReplay.overallMetrics.averageSlippageBps)} hint="Pessimistic fill model" />
                      <LabMetric
                        label="Defense events"
                        value={formatNumber(getDefenseEventCount(displayedReplay.overallMetrics), 0)}
                        hint="Recenter + adaptive shifts"
                      />
                      <LabMetric
                        label="Open cycles"
                        value={formatNumber(displayedReplay.overallMetrics.openCycleCount, 0)}
                        hint={`${formatNumber(displayedReplay.overallMetrics.closedCycleCount, 0)} closed cycles`}
                      />
                    </div>

                    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Defense timeline</div>
                        <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Latest first</div>
                      </div>
                      {defenseTimeline.length ? (
                        <div className="mt-2 space-y-2">
                          {defenseTimeline.map((event) => (
                            <div key={event.id} className={cn("rounded-md border px-2 py-1.5", formatDefenseTone(event.tone))}>
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-mono text-[8px] uppercase tracking-[0.13em] opacity-80">{event.eyebrow}</div>
                                  <div className="mt-0.5 text-[11px] font-medium text-white">{event.title}</div>
                                </div>
                                <div className="shrink-0 text-right font-mono text-[9px] uppercase tracking-[0.12em] opacity-80">{event.phase}</div>
                              </div>
                              <div className="mt-1 font-mono text-[10px] text-white">{event.range}</div>
                              <div className="mt-1 space-y-0.5">
                                {event.details.map((detail) => (
                                  <div key={detail} className="text-[10px] leading-4 text-[var(--muted)]">
                                    {detail}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mt-2 text-[11px] leading-4 text-[var(--muted)]">
                          No simulated recenter or adaptive range shift happened in this replay.
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">No replay yet. Run Compare scenarios to compare your selected bot against Lab alternatives.</div>
                )}
              </LabSection>

              <LabSection title="Stress checks">
                <StressCheckPanel
                  rows={stressRows}
                  canRun={Boolean(displayedBaseConfig && displayedReplay)}
                  isPending={isPending}
                  onRun={runStressChecks}
                  onSelect={(row) => {
                    setActiveReplay(row.replay);
                    setActiveConfigKey(getConfigSignature(row.config));
                  }}
                />
              </LabSection>

              <LabSection title="Replay assumptions">
                {displayedAssumptions ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 gap-2">
                      <LabMetric label="Candle path" value="OHLC replay" hint="Bullish low-first, bearish high-first" />
                      <LabMetric
                        label="Cost model"
                        value={`${formatBps(displayedAssumptions.maxSlippageBps)} slip + ${formatBps(displayedAssumptions.executionFeeBps)} fee`}
                        hint={
                          displayedAssumptions.executionCostSource === "calibrated_live_fills" && displayedCostCalibration
                            ? `${displayedCostCalibration.sampleSize} live fills, p75 ${formatBps(displayedCostCalibration.p75AdverseSlippageBps)}`
                            : "Fixed pessimistic default"
                        }
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
                      <LabMetric
                        label="Range control"
                        value={displayedAssumptions.rangeControlMode === "adaptive_lab_only" ? "Adaptive Lab" : "Static"}
                        hint="Never auto-applies to live"
                      />
                    </div>
                    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2 text-[11px] leading-4 text-[var(--muted)]">
                      Excludes {displayedAssumptions.excludedCosts.join(", ")}. This is candle-level replay, not tick-level execution.
                    </div>
                    {displayedCostCalibration ? (
                      <div className="rounded-md border border-[var(--line)] bg-[rgba(121,184,255,0.04)] px-2.5 py-2 text-[11px] leading-4 text-[var(--muted)]">
                        Live calibration: {displayedCostCalibration.buySampleSize} buys / {displayedCostCalibration.sellSampleSize} sells, p90 adverse{" "}
                        {formatBps(displayedCostCalibration.p90AdverseSlippageBps)}, max observed {formatBps(displayedCostCalibration.maxAdverseSlippageBps)}.
                      </div>
                    ) : null}
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
                      <LabMetric label="Center" value={formatNumber(displayedRangePlan.midPrice, displayedRangePlan.midPrice >= 1000 ? 0 : 2)} hint={formatRangePlanMidBasis(displayedRangePlan.midBasis)} />
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
                    <div className={cn("rounded-md border px-3 py-2", formatStrategyLiveActionTone(displayedStrategySelection.liveAction))}>
                      <div className="font-mono text-[10px] uppercase tracking-[0.16em]">Live action</div>
                      <div className="mt-1 text-base font-medium text-white">{formatStrategyLiveActionLabel(displayedStrategySelection.liveAction)}</div>
                      <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">Read-only guidance. The worker will not auto-switch strategy in this phase.</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <LabMetric label="Selector confidence" value={formatPercent(displayedStrategySelection.confidence * 100, 0)} hint="Heuristic score" />
                      <LabMetric
                        label="Live engine today"
                        value={formatStrategyFamilyLabel(displayedStrategySelection.activeLiveFamily)}
                        hint={
                          displayedStrategySelection.activeLiveFamily === displayedStrategySelection.recommendedFamily
                            ? "Executable now"
                            : "Recommendation is watch/advisory"
                        }
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-2">
                      {displayedStrategySelection.candidates.map((candidate) => (
                        <div key={candidate.family} className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-white">
                              {formatStrategyFamilyLabel(candidate.family)}
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em]", formatReadinessTone(candidate.readiness))}>
                                {formatReadinessLabel(candidate.readiness)}
                              </span>
                              <span className="font-mono text-[10px] text-[var(--muted)]">{formatPercent(candidate.score * 100, 0)}</span>
                            </div>
                          </div>
                          <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">{candidate.reason}</div>
                        </div>
                      ))}
                    </div>
                    <div className="rounded-md border border-[var(--line)] bg-[var(--bg)] px-2.5 py-2">
                      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--muted)]">Strategy registry</div>
                      <div className="mt-2 space-y-2">
                        {displayedStrategySelection.registry.map((strategy) => (
                          <div key={strategy.family} className="rounded border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-2 py-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-white">{strategy.label}</div>
                              <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.1em]", formatReadinessTone(strategy.readiness))}>
                                {formatReadinessLabel(strategy.readiness)}
                              </span>
                            </div>
                            <div className="mt-1 text-[11px] leading-4 text-[var(--muted)]">{strategy.summary}</div>
                          </div>
                        ))}
                      </div>
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

function LabConclusionPanel({ conclusion }: { conclusion: LabConclusion }) {
  return (
    <section className={cn("mb-3 border px-4 py-3", getConclusionToneClass(conclusion.tone))}>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">{conclusion.eyebrow}</div>
          <div className="mt-1 text-xl font-semibold tracking-[-0.03em] text-white">{conclusion.title}</div>
          <div className="mt-1 max-w-3xl text-sm leading-5 text-[var(--muted)]">{conclusion.body}</div>
        </div>
        <div className="rounded-md border border-[var(--line)] bg-[rgba(0,0,0,0.16)] px-3 py-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[var(--muted)]">Operator action</div>
          <div className="mt-1 text-sm font-medium text-white">{conclusion.primaryAction}</div>
        </div>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {conclusion.details.map((detail) => (
          <div key={detail} className="border border-[rgba(255,255,255,0.06)] bg-[rgba(0,0,0,0.12)] px-2.5 py-2 text-[11px] leading-4 text-[var(--muted)]">
            {detail}
          </div>
        ))}
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
