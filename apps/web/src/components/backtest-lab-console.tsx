"use client";

import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Play, RotateCcw } from "lucide-react";
import { GridType, MinOrderMode, StrategyMode } from "@grid-bot/core/enums";

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
};

type SerializedBacktestReplayPoint = {
  timestamp: string;
  price: number;
  phase: "train" | "validation";
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

type SerializedBacktestRunResult = {
  config: SerializedBacktestConfig;
  replayPoints: SerializedBacktestReplayPoint[];
  executions: SerializedBacktestReplayExecution[];
  indicators?: SerializedIndicatorSummary;
  marketRegime?: SerializedMarketRegime;
  trainMetrics: SerializedBacktestMetrics;
  validationMetrics: SerializedBacktestMetrics;
  overallMetrics: SerializedBacktestMetrics;
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
  leaderboard: Array<{
    rank: number;
    config: SerializedBacktestConfig;
    trainMetrics: SerializedBacktestMetrics;
    validationMetrics: SerializedBacktestMetrics;
  }>;
  bestReplay: SerializedBacktestRunResult;
  trainMetrics: SerializedBacktestMetrics;
  validationMetrics: SerializedBacktestMetrics;
  operatorGuidance: {
    status: "Healthy" | "Caution" | "Fragile";
    summary: string;
    stopRule: string;
    timeInRangePct: number;
    maxOccupancyPct: number;
  };
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
    outOfRangePause: normalizedDraft.outOfRangePause
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
    config.executionFeeBps ?? 10
  ].join(":");
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

export function BacktestLabConsole({
  bots,
  selectedBotId,
  onSelectBotId
}: {
  bots: LabPrefillBot[];
  selectedBotId: string | null;
  onSelectBotId: (botId: string | null) => void;
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

  const selectedBot = useMemo(() => bots.find((bot) => bot.id === selectedBotId) ?? bots[0] ?? null, [bots, selectedBotId]);
  const selectedBotReplayConfig = useMemo(
    () => (selectedBot ? buildReplayConfigFromDraft(selectedBot.config) : null),
    [selectedBot]
  );

  useEffect(() => {
    if (!selectedBot) {
      return;
    }

    setPair(inferPairFromDraft(selectedBot.config));
    setBudgetUsd(selectedBot.config.totalBudgetUsd);
  }, [selectedBot]);

  const displayedReplay = activeReplay ?? recommendation?.bestReplay ?? null;
  const displayedGuidance = recommendation?.operatorGuidance ?? null;
  const displayedIndicators = displayedReplay?.indicators ?? recommendation?.indicators ?? null;
  const latestIndicators = displayedIndicators?.latest ?? null;
  const displayedRegime = displayedReplay?.marketRegime ?? recommendation?.marketRegime ?? null;
  const chartLevels = useMemo(
    () =>
      displayedReplay
        ? calculateGridLevels({
            lowPrice: displayedReplay.config.lowPrice,
            highPrice: displayedReplay.config.highPrice,
            levelCount: displayedReplay.config.levelCount,
            gridType: displayedReplay.config.gridType
          })
        : [],
    [displayedReplay]
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
  const lastReplayPoint = displayedReplay?.replayPoints.at(-1) ?? null;

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

  async function runRecommendation() {
    setFeedback(null);
    setIsPending(true);
    try {
      const payload = await postJson<SerializedBacktestRecommendation>("/api/backtest/lab/recommend", {
        pair,
        budgetUsd,
        lookbackDays,
        resolution
      });
      setRecommendation(payload);
      setActiveReplay(payload.bestReplay);
      setActiveConfigKey(getConfigSignature(payload.bestConfig));
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
      const payload = await postJson<SerializedBacktestRunResult>("/api/backtest/lab/replay", {
        pair,
        budgetUsd,
        lookbackDays,
        resolution,
        config
      });
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
                  Search the current grid model on Pyth history, then replay the best config before you touch a live bot.
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
                {displayedReplay?.meta.historyWindow?.source ?? "pyth-history"} · {lookbackDays}d
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
            <div className="mt-1 text-sm text-white">Use a live bot as a starting point, then test hypothetical setups before touching production.</div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            <div className="space-y-3">
              <LabSection title="Setup" defaultOpen>
                <div className="grid gap-3">
                  <LabField label="Prefill from">
                    <select
                      value={selectedBot?.id ?? ""}
                      onChange={(event) => onSelectBotId(event.currentTarget.value || null)}
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
                      onClick={runRecommendation}
                      disabled={isPending || budgetUsd <= 0}
                      className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[var(--accent-line)] bg-[linear-gradient(180deg,rgba(121,184,255,0.18),rgba(121,184,255,0.1))] px-3.5 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--accent)] shadow-[0_10px_24px_rgba(58,120,255,0.16),inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-[rgba(121,184,255,0.45)] hover:bg-[linear-gradient(180deg,rgba(121,184,255,0.24),rgba(121,184,255,0.14))] hover:text-white disabled:pointer-events-none disabled:opacity-50"
                    >
                      <FlaskConical className="h-3.5 w-3.5 shrink-0" />
                      {isPending ? "Running…" : "Find best setup"}
                    </button>
                    <div className="text-[11px] leading-4 text-[var(--muted)]">
                      Search the current grid model on the selected history window and rank the winner on validation, not train.
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
                    {selectedBotReplayConfig ? (
                      <div className="text-[11px] leading-4 text-[var(--muted)]">
                        Run one backtest with the selected bot config as-is, without searching for a better one.
                      </div>
                    ) : null}
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
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">Use Find best setup to search the current strategy space and surface one concrete recommendation for this pair, budget, and window.</div>
                )}
              </LabSection>

              <LabSection title="Current replay" defaultOpen>
                {displayedReplay ? (
                  <div className="grid grid-cols-1 gap-2">
                    <LabMetric label="Train PnL" value={formatCurrency(displayedReplay.trainMetrics.totalPnlUsd)} hint={formatPercent(displayedReplay.trainMetrics.returnPct, 2)} />
                    <LabMetric label="Validation PnL" value={formatCurrency(displayedReplay.validationMetrics.totalPnlUsd)} hint={formatPercent(displayedReplay.validationMetrics.returnPct, 2)} />
                    <LabMetric label="Overall PnL" value={formatCurrency(displayedReplay.overallMetrics.totalPnlUsd)} hint={formatPercent(displayedReplay.overallMetrics.returnPct, 2)} />
                    <LabMetric label="Max occupancy" value={formatPercent(displayedReplay.validationMetrics.maxOccupancyPct, 1)} hint="Validation window" />
                  </div>
                ) : (
                  <div className="text-sm text-[var(--muted)]">No replay yet. Run Replay current setup to test the selected bot config, or Find best setup to search for a better one first.</div>
                )}
              </LabSection>

              <LabSection title="Market regime" defaultOpen>
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

              <LabSection title="Market indicators" defaultOpen>
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
                          {formatSpacingLabel(entry.config.gridType)} · {entry.config.levelCount} rails · {formatNumber(entry.config.lowPrice, entry.config.lowPrice >= 1000 ? 0 : 2)} →{" "}
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
