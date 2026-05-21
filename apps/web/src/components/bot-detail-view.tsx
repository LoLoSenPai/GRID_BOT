"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Gauge, Layers3, Radar, ShieldAlert, Wallet2 } from "lucide-react";

import { BotControlButtons } from "@/components/bot-control-buttons";
import { BotPriceChart } from "@/components/bot-price-chart";
import { SectionHeading } from "@/components/section-heading";
import { SpotPricePulse } from "@/components/spot-price-pulse";
import { StatusBadge } from "@/components/status-badge";
import { SurfaceCard } from "@/components/surface-card";
import { TimeRangeTabs } from "@/components/time-range-tabs";
import { calculateBudgetRoiPct } from "@/lib/bot-metrics";
import { HISTORY_RESOLUTION_OPTIONS, type CandlePoint, type HistoryResolution, bucketTimestamp, buildCandlesFromSnapshots } from "@/lib/charting";
import type { BotFormDraft } from "@/lib/bot-management";
import { calculateGridLevels, formatLevelCode, formatLevelLabel } from "@/lib/bot-runtime";
import { formatGoalLabel, formatTradeDisplay, formatTradeMarkerLabel } from "@/lib/trade-display";
import { cn, formatCurrency, formatDateTime, formatNumber } from "@/lib/utils";

const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
type HistoryCacheEntry = {
  symbol: BotDetailViewData["baseSymbol"];
  candles: CandlePoint[];
  sourceLabel: string;
  cappedLabel: string | null;
  fetchedAt: number;
};

const historyCache = new Map<string, HistoryCacheEntry>();
const historyRequestCache = new Map<string, Promise<HistoryCacheEntry>>();

export type BotDetailViewData = {
  id: string;
  name: string;
  baseSymbol: string;
  quoteSymbol: string;
  strategyMode: string;
  mode: string;
  status: string;
  behavior: {
    id: string;
    label: string;
    summary: string;
    operatorHint: string;
    cycleRule: string;
    exitRule: string;
    tags: string[];
  };
  currentPrice: number;
  lastHeartbeatAt: string | null;
  config: {
    lowPrice: number;
    highPrice: number;
    levelCount: number;
    gridType: string;
    minOrderQuoteAmount: number;
    maxDeployableUsd: number;
    reserveQuoteAmount: number;
    cooldownMs: number;
    maxOrdersPerHour: number;
    maxDrawdownPct: number;
    priceConfirmationWindowMs: number;
    recenterMode: string;
  };
  levels: number[];
  position: {
    baseAmount: number;
    averageEntryPrice: number;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;
  } | null;
  metrics: {
    deployedQuoteAmount: number;
    inventoryValue: number;
    rangeProgress: number;
    deployableUsage: number;
  };
  priceSnapshots: Array<{
    time: string;
    value: number;
  }>;
  initialCandles: CandlePoint[];
  initialHistorySourceLabel: string;
  orders: Array<{
    id: string;
    time: string;
    side: "buy" | "sell";
    status: string;
    levelIndex: number;
    targetPrice: number;
    requestedBaseAmount: number;
    requestedQuoteAmount: number;
    reason: string;
    execution: {
      id: string;
      time: string;
      status: string;
      provider: string;
      executionRef: string;
      txId: string | null;
      quoteAmount: number | null;
      baseAmount: number | null;
      feeAmount: number | null;
      effectivePrice: number | null;
      netEffectivePrice: number | null;
      errorMessage: string | null;
    } | null;
    executionSummary: string | null;
  }>;
  executions: Array<{
    id: string;
    orderId: string;
    time: string;
    status: string;
    side: "buy" | "sell";
    levelIndex: number;
    targetPrice: number;
    quoteAmount: number | null;
    baseAmount: number | null;
    feeAmount: number | null;
    effectivePrice: number | null;
    netEffectivePrice: number | null;
    provider: string;
    executionRef: string;
    txId: string | null;
    errorMessage: string | null;
    reason: string;
  }>;
  positionLots: Array<{
    id: string;
    remainingBaseAmount: number;
    entryPrice: number;
    costQuote: number;
    openedAt: string;
  }>;
  openCycles: Array<{
    id: string;
    lotId: string;
    buyLevelIndex: number;
    buyPrice: number;
    sellLevelIndex: number | null;
    sellPrice: number | null;
    remainingBaseAmount: number;
    costQuote: number;
    openedAt: string;
  }>;
  alerts: Array<{
    id: string;
    title: string;
    message: string;
    severity: string;
    createdAt: string;
  }>;
  systemLogs: Array<{
    id: string;
    category: string;
    message: string;
    level: string;
    createdAt: string;
  }>;
};

export type BotDetailRuntimeData = {
  currentPrice: number | null;
  lastHeartbeatAt: string | null;
  status: string;
  lastProcessedAt: string | null;
  lastExecutionAt: string | null;
  latestExecution: BotDetailViewData["executions"][number] | null;
  availableQuoteAmount: number | null;
  availableBaseAmount: number | null;
  deployedQuoteAmount: number | null;
  averageEntryPrice: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  totalEquityUsd: number | null;
};

type BotOrderView = BotDetailViewData["orders"][number];
type BotExecutionView = BotDetailViewData["executions"][number];
type BotOpenCycleView = BotDetailViewData["openCycles"][number];
type LiveRuntimeState = {
  botId: string;
  currentPrice: number | null;
  lastHeartbeatAt: string | null;
  status: string;
  lastProcessedAt: string | null;
  lastExecutionAt: string | null;
  latestExecution: BotExecutionView | null;
  availableQuoteAmount: number | null;
  availableBaseAmount: number | null;
  deployedQuoteAmount: number | null;
  averageEntryPrice: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  totalEquityUsd: number | null;
};

function isMarkerVisibleExecution(execution: BotExecutionView) {
  return execution.status === "submitted" || execution.status === "filled" || execution.status === "simulated";
}

type HistoryResponse = {
  candles: CandlePoint[];
  meta: {
    symbol: string;
    resolution: HistoryResolution;
    cappedByResolution: boolean;
    from: string;
    to: string;
    source: string;
  };
};

function getHistoryCacheKey(symbol: BotDetailViewData["baseSymbol"], resolution: HistoryResolution) {
  return `${symbol}:${resolution}`;
}

function getFreshHistoryCacheEntry(symbol: BotDetailViewData["baseSymbol"], resolution: HistoryResolution) {
  const cacheKey = getHistoryCacheKey(symbol, resolution);
  const cached = historyCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.sourceLabel === "local snapshots") {
    return null;
  }

  if (Date.now() - cached.fetchedAt > HISTORY_CACHE_TTL_MS) {
    historyCache.delete(cacheKey);
    return null;
  }

  return cached;
}

async function requestHistory(symbol: BotDetailViewData["baseSymbol"], resolution: HistoryResolution) {
  const fresh = getFreshHistoryCacheEntry(symbol, resolution);
  if (fresh) {
    return fresh;
  }

  const cacheKey = getHistoryCacheKey(symbol, resolution);
  const inFlight = historyRequestCache.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const request = fetch(`/api/market-history?${new URLSearchParams({ symbol, resolution }).toString()}`)
    .then(async (response) => {
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `History request failed with status ${response.status}`);
      }

      return response.json() as Promise<HistoryResponse>;
    })
    .then((payload) => {
      const entry: HistoryCacheEntry = {
        symbol,
        candles: payload.candles,
        sourceLabel: payload.meta.source,
        cappedLabel: payload.meta.cappedByResolution ? `${HISTORY_RESOLUTION_OPTIONS.find((option) => option.value === resolution)?.label} capped` : null,
        fetchedAt: Date.now()
      };
      historyCache.set(cacheKey, entry);
      return entry;
    })
    .finally(() => {
      historyRequestCache.delete(cacheKey);
    });

  historyRequestCache.set(cacheKey, request);
  return request;
}

function getVisibleExtremes(candles: CandlePoint[], lowFallback: number, highFallback: number) {
  if (!candles.length) {
    return {
      low: lowFallback,
      high: highFallback
    };
  }

  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;

  for (const candle of candles) {
    if (candle.low < low) {
      low = candle.low;
    }

    if (candle.high > high) {
      high = candle.high;
    }
  }

  return {
    low: Number.isFinite(low) ? low : lowFallback,
    high: Number.isFinite(high) ? high : highFallback
  };
}

function mergeLivePriceIntoCandles(
  candles: CandlePoint[],
  resolution: HistoryResolution,
  livePrice: number | null,
  liveTime: string | null
) {
  if (!candles.length || !livePrice || !liveTime) {
    return candles;
  }

  const liveTimestamp = new Date(liveTime).getTime();
  if (Number.isNaN(liveTimestamp)) {
    return candles;
  }

  const liveBucket = bucketTimestamp(liveTimestamp, resolution);
  const nextCandles = [...candles];
  const lastIndex = nextCandles.length - 1;
  const lastCandle = nextCandles[lastIndex];
  if (!lastCandle) {
    return candles;
  }
  const lastBucket = bucketTimestamp(new Date(lastCandle.time).getTime(), resolution);

  if (liveBucket < lastBucket) {
    return candles;
  }

  if (liveBucket === lastBucket) {
    const nextClose = livePrice;
    const nextHigh = Math.max(lastCandle.high, livePrice);
    const nextLow = Math.min(lastCandle.low, livePrice);

    if (lastCandle.close === nextClose && lastCandle.high === nextHigh && lastCandle.low === nextLow) {
      return candles;
    }

    nextCandles[lastIndex] = {
      ...lastCandle,
      close: nextClose,
      high: nextHigh,
      low: nextLow
    };
    return nextCandles;
  }

  nextCandles.push({
    time: new Date(liveBucket).toISOString(),
    open: lastCandle.close,
    high: Math.max(lastCandle.close, livePrice),
    low: Math.min(lastCandle.close, livePrice),
    close: livePrice,
    volume: 0
  });

  return nextCandles;
}

function StatCard({
  label,
  value,
  hint,
  tone = "default"
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "positive" | "negative" | "amber";
}) {
  const toneClass =
    tone === "positive"
      ? "text-[var(--green)]"
      : tone === "negative"
        ? "text-[var(--red)]"
        : tone === "amber"
          ? "text-[var(--amber)]"
          : "text-white";

  return (
    <SurfaceCard padding="md">
      <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-[var(--muted)]">{label}</div>
      <div className={`mt-3 text-2xl font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-2 text-sm text-[var(--muted)]">{hint}</div>
    </SurfaceCard>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[var(--line)] py-3 last:border-b-0 last:pb-0">
      <span className="text-sm text-[var(--muted)]">{label}</span>
      <span className="text-right text-sm font-medium text-white">{value}</span>
    </div>
  );
}

function BotChip({ label }: { label: string }) {
  return <span className="border border-[var(--line)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">{label}</span>;
}

function EmbeddedInlineMetric({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "positive" | "negative";
}) {
  const toneClass = tone === "positive" ? "text-[var(--green)]" : tone === "negative" ? "text-[var(--red)]" : "text-white";

  return (
    <div className="flex items-center gap-2 border-r border-[var(--line)] pr-4 last:border-r-0 last:pr-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</span>
      <span className={cn("text-sm font-medium", toneClass)}>{value}</span>
    </div>
  );
}


function formatOrderTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function BotDetailView({
  bot,
  embedded = false,
  previewDraft,
  embeddedActions,
  runtimeStreamUrl,
  runtimeData
}: {
  bot: BotDetailViewData;
  embedded?: boolean;
  previewDraft?: BotFormDraft | null;
  embeddedActions?: React.ReactNode;
  runtimeStreamUrl?: string | null;
  runtimeData?: BotDetailRuntimeData | null;
}) {
  const initialResolution: HistoryResolution = embedded ? "1h" : "4h";
  const [liveRuntime, setLiveRuntime] = useState<LiveRuntimeState>({
    botId: bot.id,
    currentPrice: bot.currentPrice,
    lastHeartbeatAt: bot.lastHeartbeatAt,
    status: bot.status,
    lastProcessedAt: null,
    lastExecutionAt: null,
    latestExecution: bot.executions[0] ?? null,
    availableQuoteAmount: runtimeData?.availableQuoteAmount ?? null,
    availableBaseAmount: runtimeData?.availableBaseAmount ?? (bot.position?.baseAmount ?? null),
    deployedQuoteAmount: runtimeData?.deployedQuoteAmount ?? bot.metrics.deployedQuoteAmount,
    averageEntryPrice: runtimeData?.averageEntryPrice ?? (bot.position?.averageEntryPrice ?? null),
    realizedPnlUsd: runtimeData?.realizedPnlUsd ?? (bot.position?.realizedPnlUsd ?? null),
    unrealizedPnlUsd: runtimeData?.unrealizedPnlUsd ?? (bot.position?.unrealizedPnlUsd ?? null),
    totalEquityUsd: runtimeData?.totalEquityUsd ?? bot.metrics.inventoryValue + (runtimeData?.availableQuoteAmount ?? 0)
  });
  const [resolution, setResolution] = useState<HistoryResolution>(initialResolution);
  const fallbackCandles = useMemo(() => buildCandlesFromSnapshots(bot.priceSnapshots, resolution), [bot.priceSnapshots, resolution]);
  const fallbackCandlesRef = useRef(fallbackCandles);
  const initialCache = getFreshHistoryCacheEntry(bot.baseSymbol, resolution);
  const [historyState, setHistoryState] = useState<{
    symbol: BotDetailViewData["baseSymbol"];
    candles: CandlePoint[];
    sourceLabel: string;
    cappedLabel: string | null;
    error: string | null;
    loading: boolean;
  }>({
    symbol: bot.baseSymbol,
    candles: initialCache?.candles ?? bot.initialCandles,
    sourceLabel: initialCache?.sourceLabel ?? bot.initialHistorySourceLabel,
    cappedLabel: initialCache?.cappedLabel ?? null,
    error: null,
    loading: false
  });

  useEffect(() => {
    const cacheKey = getHistoryCacheKey(bot.baseSymbol, initialResolution);
    const cached = historyCache.get(cacheKey);
    if (!cached || cached.candles.length < bot.initialCandles.length) {
      historyCache.set(cacheKey, {
        symbol: bot.baseSymbol,
        candles: bot.initialCandles,
        sourceLabel: bot.initialHistorySourceLabel,
        cappedLabel: null,
        fetchedAt: Date.now()
      });
    }
  }, [bot.baseSymbol, bot.initialCandles, bot.initialHistorySourceLabel, initialResolution]);

  useEffect(() => {
    fallbackCandlesRef.current = fallbackCandles;
  }, [fallbackCandles]);

  const activeHistoryState = useMemo(() => {
    if (historyState.symbol === bot.baseSymbol) {
      return historyState;
    }

    const cached = getFreshHistoryCacheEntry(bot.baseSymbol, resolution);

    return {
      symbol: bot.baseSymbol,
      candles: cached?.candles ?? [],
      sourceLabel: cached?.sourceLabel ?? "pyth-history",
      cappedLabel: cached?.cappedLabel ?? null,
      error: null,
      loading: !cached
    };
  }, [bot.baseSymbol, historyState, resolution]);

  useEffect(() => {
    setLiveRuntime({
      botId: bot.id,
      currentPrice: runtimeData?.currentPrice ?? bot.currentPrice,
      lastHeartbeatAt: runtimeData?.lastHeartbeatAt ?? bot.lastHeartbeatAt,
      status: runtimeData?.status ?? bot.status,
      lastProcessedAt: runtimeData?.lastProcessedAt ?? null,
      lastExecutionAt: runtimeData?.lastExecutionAt ?? null,
      latestExecution: runtimeData?.latestExecution ?? bot.executions[0] ?? null,
      availableQuoteAmount: runtimeData?.availableQuoteAmount ?? null,
      availableBaseAmount: runtimeData?.availableBaseAmount ?? (bot.position?.baseAmount ?? null),
      deployedQuoteAmount: runtimeData?.deployedQuoteAmount ?? bot.metrics.deployedQuoteAmount,
      averageEntryPrice: runtimeData?.averageEntryPrice ?? (bot.position?.averageEntryPrice ?? null),
      realizedPnlUsd: runtimeData?.realizedPnlUsd ?? (bot.position?.realizedPnlUsd ?? null),
      unrealizedPnlUsd: runtimeData?.unrealizedPnlUsd ?? (bot.position?.unrealizedPnlUsd ?? null),
      totalEquityUsd:
        runtimeData?.totalEquityUsd ??
        ((runtimeData?.availableQuoteAmount ?? 0) + (runtimeData?.availableBaseAmount ?? bot.position?.baseAmount ?? 0) * (runtimeData?.currentPrice ?? bot.currentPrice))
    });
  }, [
    bot.currentPrice,
    bot.executions,
    bot.id,
    bot.lastHeartbeatAt,
    bot.metrics.deployedQuoteAmount,
    bot.position?.averageEntryPrice,
    bot.position?.baseAmount,
    bot.position?.realizedPnlUsd,
    bot.position?.unrealizedPnlUsd,
    bot.status,
    runtimeData?.availableBaseAmount,
    runtimeData?.availableQuoteAmount,
    runtimeData?.averageEntryPrice,
    runtimeData?.currentPrice,
    runtimeData?.deployedQuoteAmount,
    runtimeData?.lastHeartbeatAt,
    runtimeData?.status,
    runtimeData?.lastProcessedAt,
    runtimeData?.lastExecutionAt,
    runtimeData?.latestExecution,
    runtimeData?.realizedPnlUsd,
    runtimeData?.totalEquityUsd,
    runtimeData?.unrealizedPnlUsd
  ]);

  useEffect(() => {
    const streamUrl = runtimeStreamUrl === undefined ? `/api/bots/${bot.id}/runtime?stream=1` : runtimeStreamUrl;

    if (!streamUrl || typeof window === "undefined" || typeof window.EventSource === "undefined") {
      return;
    }

    const source = new EventSource(streamUrl);
    const handleRuntime = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as {
          currentPrice: number | null;
          lastHeartbeatAt: string | null;
          status: string;
          lastProcessedAt: string | null;
          lastExecutionAt: string | null;
          runtime: {
            availableQuoteAmount: number;
            availableBaseAmount: number;
            deployedQuoteAmount: number;
            averageEntryPrice: number | null;
            realizedPnlUsd: number;
            unrealizedPnlUsd: number;
            totalEquityUsd: number;
          } | null;
          latestExecution?: BotExecutionView | null;
        };

        setLiveRuntime({
          botId: bot.id,
          currentPrice: payload.currentPrice,
          lastHeartbeatAt: payload.lastHeartbeatAt,
          status: payload.status,
          lastProcessedAt: payload.lastProcessedAt,
          lastExecutionAt: payload.lastExecutionAt,
          latestExecution: payload.latestExecution ?? null,
          availableQuoteAmount: payload.runtime?.availableQuoteAmount ?? null,
          availableBaseAmount: payload.runtime?.availableBaseAmount ?? null,
          deployedQuoteAmount: payload.runtime?.deployedQuoteAmount ?? null,
          averageEntryPrice: payload.runtime?.averageEntryPrice ?? null,
          realizedPnlUsd: payload.runtime?.realizedPnlUsd ?? null,
          unrealizedPnlUsd: payload.runtime?.unrealizedPnlUsd ?? null,
          totalEquityUsd: payload.runtime?.totalEquityUsd ?? null
        });
      } catch {
        return;
      }
    };

    source.addEventListener("runtime", handleRuntime as EventListener);
    return () => {
      source.removeEventListener("runtime", handleRuntime as EventListener);
      source.close();
    };
  }, [bot.id, runtimeStreamUrl]);

  useEffect(() => {
    let active = true;
    const cached = getFreshHistoryCacheEntry(bot.baseSymbol, resolution);

    if (cached) {
      setHistoryState({
        symbol: bot.baseSymbol,
        candles: cached.candles,
        sourceLabel: cached.sourceLabel,
        cappedLabel: cached.cappedLabel,
        error: null,
        loading: false
      });
      return () => {
        active = false;
      };
    }

    setHistoryState((current) => ({
      symbol: bot.baseSymbol,
      candles: current.symbol === bot.baseSymbol ? current.candles : [],
      sourceLabel: current.symbol === bot.baseSymbol ? current.sourceLabel : "pyth-history",
      cappedLabel: current.symbol === bot.baseSymbol ? current.cappedLabel : null,
      error: null,
      loading: true
    }));

    requestHistory(bot.baseSymbol, resolution)
      .then((entry) => {
        if (!active) {
          return;
        }

        const nextState = {
          symbol: bot.baseSymbol,
          candles: entry.candles.length ? entry.candles : fallbackCandlesRef.current,
          sourceLabel: entry.sourceLabel,
          cappedLabel: entry.cappedLabel,
          error: null,
          loading: false
        };
        setHistoryState(nextState);
      })
      .catch((error) => {
        if (!active) {
          return;
        }

        setHistoryState({
          symbol: bot.baseSymbol,
          candles: fallbackCandlesRef.current,
          sourceLabel: "local snapshots",
          cappedLabel: null,
          error: error instanceof Error ? error.message : "History request failed",
          loading: false
        });
      });

    return () => {
      active = false;
    };
  }, [bot.baseSymbol, resolution]);

  useEffect(() => {
    setHistoryState((current) => {
      if (current.symbol !== bot.baseSymbol || current.loading || current.sourceLabel !== "local snapshots") {
        return current;
      }

      if (current.candles === fallbackCandles) {
        return current;
      }

      return {
        ...current,
        candles: fallbackCandles
      };
    });
  }, [bot.baseSymbol, fallbackCandles]);
  const activeLiveRuntime = liveRuntime.botId === bot.id
    ? liveRuntime
    : {
        botId: bot.id,
        currentPrice: runtimeData?.currentPrice ?? bot.currentPrice,
        lastHeartbeatAt: runtimeData?.lastHeartbeatAt ?? bot.lastHeartbeatAt,
        status: runtimeData?.status ?? bot.status,
        lastProcessedAt: runtimeData?.lastProcessedAt ?? null,
        lastExecutionAt: runtimeData?.lastExecutionAt ?? null,
        latestExecution: runtimeData?.latestExecution ?? bot.executions[0] ?? null,
        availableQuoteAmount: runtimeData?.availableQuoteAmount ?? null,
        availableBaseAmount: runtimeData?.availableBaseAmount ?? (bot.position?.baseAmount ?? null),
        deployedQuoteAmount: runtimeData?.deployedQuoteAmount ?? bot.metrics.deployedQuoteAmount,
        averageEntryPrice: runtimeData?.averageEntryPrice ?? (bot.position?.averageEntryPrice ?? null),
        realizedPnlUsd: runtimeData?.realizedPnlUsd ?? (bot.position?.realizedPnlUsd ?? null),
        unrealizedPnlUsd: runtimeData?.unrealizedPnlUsd ?? (bot.position?.unrealizedPnlUsd ?? null),
        totalEquityUsd:
          runtimeData?.totalEquityUsd ??
          ((runtimeData?.availableQuoteAmount ?? 0) + (runtimeData?.availableBaseAmount ?? bot.position?.baseAmount ?? 0) * (runtimeData?.currentPrice ?? bot.currentPrice))
      };
  const recentOrders = useMemo(() => bot.orders.slice(0, 12), [bot.orders]);
  const latestExecution = activeLiveRuntime.latestExecution ?? bot.executions[0] ?? null;
  const visibleExecutions = useMemo(() => {
    const executionMap = new Map<string, BotExecutionView>();
    for (const execution of bot.executions) {
      if (isMarkerVisibleExecution(execution)) {
        executionMap.set(execution.id, execution);
      }
    }

    if (latestExecution && isMarkerVisibleExecution(latestExecution)) {
      executionMap.set(latestExecution.id, latestExecution);
    }

    return [...executionMap.values()].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
  }, [bot.executions, latestExecution]);
  const recentLogs = useMemo(() => bot.systemLogs.slice(0, 8), [bot.systemLogs]);
  const recentAlerts = useMemo(() => bot.alerts.slice(0, 6), [bot.alerts]);
  const previewLevels = useMemo(
    () =>
      previewDraft
        ? calculateGridLevels({
          lowPrice: previewDraft.lowPrice,
          highPrice: previewDraft.highPrice,
          levelCount: previewDraft.levelCount,
          gridType: previewDraft.gridType
        })
        : null,
    [previewDraft]
  );
  const chartLevels = previewLevels ?? bot.levels;
  const effectiveConfig = previewDraft
    ? {
      ...bot.config,
      lowPrice: previewDraft.lowPrice,
      highPrice: previewDraft.highPrice,
      levelCount: previewDraft.levelCount,
      gridType: previewDraft.gridType,
      minOrderQuoteAmount: previewDraft.minOrderQuoteAmount,
      maxDeployableUsd: previewDraft.maxDeployableUsd,
      reserveQuoteAmount: previewDraft.reserveQuoteAmount,
      cooldownMs: previewDraft.cooldownMs,
      maxOrdersPerHour: previewDraft.maxOrdersPerHour,
      maxDrawdownPct: previewDraft.maxDrawdownPct,
      priceConfirmationWindowMs: previewDraft.priceConfirmationWindowMs,
      recenterMode: previewDraft.recenterMode
    }
    : bot.config;
  const previewActive = Boolean(previewDraft);

  const markers = useMemo(
    () =>
      visibleExecutions.map((execution) => ({
        time: execution.time,
        side: execution.side,
        label: `${execution.side === "buy" ? "B" : "S"} ${formatTradeMarkerLabel({
          strategyMode: bot.strategyMode,
          side: execution.side,
          quoteAmount: execution.quoteAmount,
          baseAmount: execution.baseAmount,
          baseSymbol: bot.baseSymbol
        })}`
      })),
    [bot.baseSymbol, bot.strategyMode, visibleExecutions]
  );

  const displayedOpenCycles = useMemo(
    () => bot.openCycles.filter((cycle) => cycle.remainingBaseAmount > 0),
    [bot.openCycles]
  );

  const orderLines = useMemo(
    () =>
      displayedOpenCycles
        .flatMap((cycle) => {
          const lines: Array<{ id: string; side: "buy" | "sell"; price: number; label: string }> = [
            {
              id: `${cycle.id}-buy`,
              side: "buy",
              price: cycle.buyPrice,
              label: `B${formatLevelCode(cycle.buyLevelIndex)}`
            }
          ];

          if (cycle.sellLevelIndex !== null && cycle.sellPrice !== null) {
            lines.push({
              id: `${cycle.id}-sell`,
              side: "sell",
              price: cycle.sellPrice,
              label: `S${formatLevelCode(cycle.sellLevelIndex)}`
            });
          }

          return lines;
        })
        .sort((left, right) => left.price - right.price),
    [displayedOpenCycles]
  );

  const liveSpotPrice = activeLiveRuntime.currentPrice ?? bot.currentPrice;
  const livePriceTime = activeLiveRuntime.lastHeartbeatAt ?? bot.lastHeartbeatAt ?? bot.priceSnapshots.at(-1)?.time ?? null;
  const visibleCandles = useMemo(
    () => mergeLivePriceIntoCandles(activeHistoryState.candles, resolution, liveSpotPrice, livePriceTime),
    [activeHistoryState.candles, livePriceTime, liveSpotPrice, resolution]
  );
  const firstVisiblePrice = visibleCandles[0]?.open ?? liveSpotPrice ?? bot.currentPrice;
  const lastVisiblePrice = visibleCandles.at(-1)?.close ?? liveSpotPrice ?? bot.currentPrice;
  const visibleExtremes = useMemo(
    () => getVisibleExtremes(visibleCandles, effectiveConfig.lowPrice, effectiveConfig.highPrice),
    [effectiveConfig.highPrice, effectiveConfig.lowPrice, visibleCandles]
  );
  const visibleLow = visibleExtremes.low;
  const visibleHigh = visibleExtremes.high;
  const visibleDeltaPct = firstVisiblePrice ? ((lastVisiblePrice - firstVisiblePrice) / firstVisiblePrice) * 100 : 0;
  const currentPrice = liveSpotPrice || lastVisiblePrice;
  const goalLabel = formatGoalLabel(bot.strategyMode);
  const rangeProgress =
    effectiveConfig.highPrice > effectiveConfig.lowPrice
      ? Math.max(0, Math.min(100, ((currentPrice - effectiveConfig.lowPrice) / (effectiveConfig.highPrice - effectiveConfig.lowPrice)) * 100))
      : bot.metrics.rangeProgress;
  const latestAlert = recentAlerts[0] ?? bot.alerts[0] ?? null;
  const activeResolutionLabel = HISTORY_RESOLUTION_OPTIONS.find((option) => option.value === resolution)?.label ?? initialResolution;
  const displayBaseAmount = activeLiveRuntime.availableBaseAmount ?? bot.position?.baseAmount ?? 0;
  const displayAverageEntryPrice = activeLiveRuntime.averageEntryPrice ?? bot.position?.averageEntryPrice ?? null;
  const displayRealizedPnlUsd = activeLiveRuntime.realizedPnlUsd ?? bot.position?.realizedPnlUsd ?? 0;
  const displayUnrealizedPnlUsd = activeLiveRuntime.unrealizedPnlUsd ?? bot.position?.unrealizedPnlUsd ?? 0;
  const displayTotalPnlUsd = displayRealizedPnlUsd + displayUnrealizedPnlUsd;
  const displayDeployedQuoteAmount = activeLiveRuntime.deployedQuoteAmount ?? bot.metrics.deployedQuoteAmount;
  const displayInventoryValue = displayBaseAmount > 0 ? displayBaseAmount * currentPrice : 0;
  const displayTotalEquityUsd =
    activeLiveRuntime.totalEquityUsd ??
    ((activeLiveRuntime.availableQuoteAmount ?? 0) + displayInventoryValue);
  const displayBudgetUsd = previewDraft?.totalBudgetUsd ?? (bot.config.maxDeployableUsd + bot.config.reserveQuoteAmount);
  const displayRoiPct = calculateBudgetRoiPct(displayTotalPnlUsd, displayBudgetUsd);

  const handleResolutionChange = (nextResolution: HistoryResolution) => {
    if (nextResolution === resolution) {
      return;
    }

    const cached = getFreshHistoryCacheEntry(bot.baseSymbol, nextResolution);
    setHistoryState(
      cached
        ? {
          symbol: bot.baseSymbol,
          candles: cached.candles,
          sourceLabel: cached.sourceLabel,
          cappedLabel: cached.cappedLabel,
          error: null,
          loading: false
        }
        : {
          symbol: bot.baseSymbol,
          candles: [],
          sourceLabel: "pyth-history",
          cappedLabel: null,
          error: null,
          loading: true
        }
    );
    setResolution(nextResolution);
  };

  if (embedded) {
    return (
      <div className="flex h-full flex-col">
        {/* Metrics strip */}
        <div className="border-b border-[var(--line)] px-4 py-2 space-y-1.5">
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-[15px] font-semibold tracking-[-0.03em] text-white">
              {bot.baseSymbol}/{bot.quoteSymbol}
            </span>
            <EmbeddedInlineMetric label="Spot" value={<SpotPricePulse value={currentPrice || null} />} />
            <EmbeddedInlineMetric
              label="PnL"
              value={formatCurrency(displayTotalPnlUsd)}
              tone={displayTotalPnlUsd < 0 ? "negative" : "positive"}
            />
            <EmbeddedInlineMetric
              label="ROI"
              value={`${displayRoiPct >= 0 ? "+" : ""}${formatNumber(displayRoiPct, 2)}%`}
              tone={displayRoiPct < 0 ? "negative" : "positive"}
            />
            {previewActive ? <BotChip label="draft" /> : null}
            <BotChip label={goalLabel} />
            <span className="ml-auto font-mono text-[10px] text-[var(--muted)]">
              {formatNumber(effectiveConfig.lowPrice, effectiveConfig.lowPrice >= 1000 ? 0 : 2)}-{formatNumber(effectiveConfig.highPrice, effectiveConfig.highPrice >= 1000 ? 0 : 2)} - {effectiveConfig.levelCount} rails
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <EmbeddedInlineMetric label="Deployed" value={formatCurrency(displayDeployedQuoteAmount)} />
            <EmbeddedInlineMetric label={`${bot.baseSymbol}`} value={formatNumber(displayBaseAmount, 4)} />
            <EmbeddedInlineMetric label="Avg entry" value={displayAverageEntryPrice ? formatNumber(displayAverageEntryPrice, 2) : "--"} />
            <EmbeddedInlineMetric label="Realized" value={formatCurrency(displayRealizedPnlUsd)} tone={displayRealizedPnlUsd < 0 ? "negative" : "positive"} />
            <EmbeddedInlineMetric label="Unrealized" value={formatCurrency(displayUnrealizedPnlUsd)} tone={displayUnrealizedPnlUsd < 0 ? "negative" : "positive"} />
            <EmbeddedInlineMetric label="Occ" value={`${formatNumber(rangeProgress, 1)}%`} />
          </div>
        </div>

        {/* Chart area */}
        <div className="flex-1 space-y-1 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <TimeRangeTabs
              options={HISTORY_RESOLUTION_OPTIONS}
              value={resolution}
              pending={activeHistoryState.loading && activeHistoryState.candles.length === 0}
              onChange={(next) => handleResolutionChange(next as HistoryResolution)}
            />
            <span className="font-mono text-[10px] text-[var(--muted)]">
              {activeLiveRuntime.lastHeartbeatAt ? formatDateTime(activeLiveRuntime.lastHeartbeatAt) : "--"}
            </span>
          </div>

          <BotPriceChart
            key={`embedded-chart-${bot.baseSymbol}-${resolution}`}
            resolution={resolution}
            candles={activeHistoryState.candles}
            levels={chartLevels}
            markers={markers}
            orderLines={orderLines}
            currentPrice={currentPrice || null}
            currentPriceTime={livePriceTime}
            averageCost={displayAverageEntryPrice}
            loading={activeHistoryState.loading}
            resolutionLabel={activeResolutionLabel}
            sourceLabel={activeHistoryState.sourceLabel}
            cappedLabel={activeHistoryState.cappedLabel}
          />
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard
          label="Spot"
          value={currentPrice ? formatNumber(currentPrice, 2) : "--"}
          hint={`Visible low/high ${formatNumber(visibleLow, 2)} -> ${formatNumber(visibleHigh, 2)}`}
          tone="default"
        />
        <StatCard
          label="Window delta"
          value={`${visibleDeltaPct >= 0 ? "+" : ""}${formatNumber(visibleDeltaPct, 2)}%`}
          hint={`${visibleCandles.length} candles loaded`}
          tone={visibleDeltaPct >= 0 ? "positive" : "negative"}
        />
        <StatCard
          label="Inventory"
          value={displayBaseAmount > 0 ? `${formatNumber(displayBaseAmount, 5)} ${bot.baseSymbol}` : "--"}
          hint={`Market value ${formatCurrency(displayInventoryValue)}`}
          tone="default"
        />
        <StatCard
          label="Unrealized PnL"
          value={displayBaseAmount > 0 ? formatCurrency(displayUnrealizedPnlUsd) : "--"}
          hint={displayAverageEntryPrice ? `Avg cost ${formatNumber(displayAverageEntryPrice, 2)}` : "No open inventory"}
          tone={displayUnrealizedPnlUsd >= 0 ? "positive" : "negative"}
        />
      </div>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_360px]">
        <div className="space-y-6">
          <SurfaceCard padding="none" className="overflow-hidden">
            <div className="border-b border-[var(--line)] px-6 py-5">
              <SectionHeading
                eyebrow="Price action"
                title={`${bot.baseSymbol}/${bot.quoteSymbol} market board`}
                description={
                  embedded
                    ? "Market candles plus active grid rails."
                    : "The chart now runs on Pyth historical market data, while the bot keeps projecting its own grid and order rails over the market."
                }
                icon={Radar}
                actions={
                  <>
                    <StatusBadge status={activeLiveRuntime.status} />
                    {!embedded ? <BotControlButtons botId={bot.id} /> : null}
                  </>
                }
              />

              <div className="mt-4 flex flex-wrap gap-2">
                <BotChip label={bot.config.gridType} />
                <BotChip label={`${bot.config.levelCount} rails`} />
                <BotChip label={bot.behavior.label} />
                <BotChip label={goalLabel} />
                <BotChip label={bot.mode} />
                <BotChip label={bot.config.recenterMode.replaceAll("_", " ")} />
              </div>
            </div>

            <div className="space-y-5 px-6 py-5">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap gap-2">
                  <TimeRangeTabs
                    options={HISTORY_RESOLUTION_OPTIONS}
                    value={resolution}
                    pending={activeHistoryState.loading && activeHistoryState.candles.length === 0}
                    onChange={(next) => handleResolutionChange(next as HistoryResolution)}
                  />
                </div>
                <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                  Full history at {activeResolutionLabel} candles
                </div>
              </div>

              <BotPriceChart
                key={`full-chart-${bot.baseSymbol}-${resolution}`}
                resolution={resolution}
                candles={activeHistoryState.candles}
                levels={bot.levels}
                markers={markers}
                orderLines={orderLines}
                currentPrice={currentPrice || null}
                currentPriceTime={livePriceTime}
                averageCost={displayAverageEntryPrice}
                loading={activeHistoryState.loading}
                resolutionLabel={activeResolutionLabel}
                sourceLabel={activeHistoryState.sourceLabel}
                cappedLabel={activeHistoryState.cappedLabel}
              />

              <div className="grid gap-4 lg:grid-cols-3">
                <SurfaceCard tone="elevated" padding="sm">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-[var(--muted)]">Range occupancy</span>
                    <span>{formatNumber(rangeProgress, 1)}%</span>
                  </div>
                  <div className="mt-3 h-2 bg-white/8">
                    <div className="h-2 bg-[linear-gradient(90deg,#44d39c,#f8c86c)]" style={{ width: `${rangeProgress}%` }} />
                  </div>
                  <div className="mt-3 text-sm text-[var(--muted)]">
                    Confirmation window {Math.round(bot.config.priceConfirmationWindowMs / 1000)}s, cooldown {Math.round(bot.config.cooldownMs / 1000)}s.
                  </div>
                </SurfaceCard>

                <SurfaceCard tone="muted" padding="sm">
                  <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">History span</div>
                  <div className="mt-2 text-sm text-white">
                    {visibleCandles[0] ? formatDateTime(visibleCandles[0].time) : "--"} {"->"} {visibleCandles.at(-1) ? formatDateTime(visibleCandles.at(-1)!.time) : "--"}
                  </div>
                  <div className="mt-3 text-sm text-[var(--muted)]">{visibleExecutions.length} fills projected, {recentOrders.length} latest orders surfaced below</div>
                </SurfaceCard>

                <SurfaceCard tone="muted" padding="sm">
                  <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Feed health</div>
                  <div className="mt-2 text-sm font-medium text-white">
                    {activeLiveRuntime.lastHeartbeatAt ? `Worker ${formatDateTime(activeLiveRuntime.lastHeartbeatAt)}` : "No worker heartbeat"}
                  </div>
                  <div className="mt-3 text-sm text-[var(--muted)]">
                    {activeHistoryState.error ? `Fallback to local snapshots: ${activeHistoryState.error}` : "Historical feed loaded successfully"}
                  </div>
                </SurfaceCard>
              </div>
            </div>
          </SurfaceCard>

          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <SurfaceCard>
              <SectionHeading
                eyebrow="Trade tape"
                title="Latest orders"
                description={embedded ? "Recent orders for the selected bot." : "Orders keep the requested size visible, while fills summarize what actually traded."}
                icon={ArrowUpRight}
              />

              <div className="mt-5 space-y-3">
                {recentOrders.length ? (
                  recentOrders.map((order) => (
                    <div key={order.id} className="border border-[var(--line)] bg-[var(--panel-soft)] p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span
                            className={
                              order.side === "buy"
                                ? "inline-flex border border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--green)]"
                                : "inline-flex border border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--red)]"
                            }
                          >
                            {order.side}
                          </span>
                          <div className="text-sm font-medium">Level {order.levelIndex + 1}</div>
                        </div>
                        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">{order.status}</div>
                      </div>

                      <div className="mt-4 grid gap-3 text-sm text-[var(--muted)] md:grid-cols-4">
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Target</div>
                          <div className="mt-1 text-white">{formatNumber(order.targetPrice, 2)}</div>
                        </div>
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Quote</div>
                          <div className="mt-1 text-white">{formatCurrency(order.requestedQuoteAmount)}</div>
                        </div>
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Base</div>
                          <div className="mt-1 text-white">
                            {formatNumber(order.requestedBaseAmount, 6)} {bot.baseSymbol}
                          </div>
                        </div>
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Created</div>
                          <div className="mt-1 text-white">{formatOrderTimestamp(order.time)}</div>
                        </div>
                      </div>

                      <div className="mt-3 text-sm text-[var(--muted)]">Reason: {order.reason.replaceAll("_", " ")}</div>
                      {order.execution ? (
                        <div className="mt-3 border border-[var(--line)] bg-black/20 p-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
                              {order.execution.provider} {order.execution.status}
                            </span>
                            <span className="text-white">
                              {formatTradeDisplay({
                                side: order.side,
                                quoteAmount: order.execution.quoteAmount,
                                baseAmount: order.execution.baseAmount,
                                baseSymbol: bot.baseSymbol
                              }).compact}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--muted)]">
                            <span>{formatOrderTimestamp(order.execution.time)}</span>
                            {order.execution.effectivePrice ? <span>route @ {formatNumber(order.execution.effectivePrice, 2)}</span> : null}
                            {order.execution.feeAmount && order.execution.feeAmount > 0 ? (
                              <span>net @ {order.execution.netEffectivePrice ? formatNumber(order.execution.netEffectivePrice, 2) : "--"} after {formatCurrency(order.execution.feeAmount)} fees</span>
                            ) : null}
                            {order.execution.txId ? <span>{order.execution.txId}</span> : <span>{order.execution.executionRef}</span>}
                          </div>
                          {order.execution.errorMessage ? <div className="mt-2 text-xs text-[var(--red)]">{order.execution.errorMessage}</div> : null}
                        </div>
                      ) : order.executionSummary ? <div className="mt-3 text-sm text-[var(--muted)]">{order.executionSummary}</div> : null}
                    </div>
                  ))
                ) : (
                  <div className="border border-dashed border-[var(--line)] bg-[var(--panel-soft)] p-5 text-sm text-[var(--muted)]">
                    No executed trades recorded yet. Real fills and simulated executions will appear here once the bot actually trades.
                  </div>
                )}
              </div>
            </SurfaceCard>

            <SurfaceCard>
              <SectionHeading
                eyebrow="Open cycles"
                title="Grid cycles and cost basis"
                description={embedded ? "Open buy levels and their paired exits." : "Each buy level stays occupied until its paired sell closes. This is the live memory of the grid."}
                icon={Layers3}
              />

              <div className="mt-5 space-y-3">
                {displayedOpenCycles.length ? (
                  displayedOpenCycles.map((cycle) => (
                    <div key={cycle.id} className="border border-[var(--line)] bg-[var(--panel-soft)] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-medium">
                          Buy {formatLevelLabel(cycle.buyLevelIndex)}
                          {cycle.sellLevelIndex !== null ? ` -> Sell ${formatLevelLabel(cycle.sellLevelIndex)}` : " -> Exit open"}
                        </div>
                        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">cycle</div>
                      </div>
                      <div className="mt-3 grid gap-3 text-sm text-[var(--muted)] md:grid-cols-3">
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Buy rail</div>
                          <div className="mt-1 text-white">{formatNumber(cycle.buyPrice, 2)}</div>
                        </div>
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Sell rail</div>
                          <div className="mt-1 text-white">{cycle.sellPrice !== null ? formatNumber(cycle.sellPrice, 2) : "--"}</div>
                        </div>
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Opened</div>
                          <div className="mt-1 text-white">{formatOrderTimestamp(cycle.openedAt)}</div>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-3 text-sm text-[var(--muted)] md:grid-cols-3">
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Base still open</div>
                          <div className="mt-1 text-white">
                            {formatNumber(cycle.remainingBaseAmount, 6)} {bot.baseSymbol}
                          </div>
                        </div>
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Cost at risk</div>
                          <div className="mt-1 text-white">{formatCurrency(cycle.costQuote)}</div>
                        </div>
                        <div>
                          <div className="font-mono text-[11px] uppercase tracking-[0.2em]">Rule</div>
                          <div className="mt-1 text-white">{bot.behavior.label}</div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="border border-dashed border-[var(--line)] bg-[var(--panel-soft)] p-5 text-sm text-[var(--muted)]">
                    No open cycles yet. Once a buy fills, the bot will mark that buy level as occupied until the paired sell closes the cycle.
                  </div>
                )}
              </div>
            </SurfaceCard>
          </div>
        </div>

        <aside className="space-y-6 xl:sticky xl:top-8 xl:self-start">
          <SurfaceCard>
            <SectionHeading eyebrow="Style" title="Behavior preset" description={embedded ? "Active cycle logic." : "What this bot is trying to optimize before any fine tuning."} icon={Radar} />

            <div className="mt-5">
              <InfoRow label="Style" value={bot.behavior.label} />
              <InfoRow label="Goal" value={goalLabel} />
              <InfoRow label="Cycle rule" value={bot.behavior.cycleRule} />
              <InfoRow label="Exit rule" value={bot.behavior.exitRule} />
            </div>

            <SurfaceCard tone="muted" padding="sm" className="mt-5">
              <div className="text-sm text-[var(--muted)]">{bot.behavior.operatorHint}</div>
            </SurfaceCard>
          </SurfaceCard>

          <SurfaceCard>
            <SectionHeading eyebrow="Runtime" title="Execution deck" description={embedded ? "Current runtime state." : "Current operating state for the selected bot."} icon={Gauge} />

            <div className="mt-5">
              <InfoRow label="Status" value={activeLiveRuntime.status.replaceAll("_", " ")} />
              <InfoRow label="Mode" value={bot.mode} />
              <InfoRow label="Strategy" value={goalLabel} />
              <InfoRow label="Current price" value={currentPrice ? formatNumber(currentPrice, 2) : "--"} />
              <InfoRow label="Average cost" value={displayAverageEntryPrice ? formatNumber(displayAverageEntryPrice, 2) : "--"} />
              <InfoRow label="Range" value={`${formatNumber(bot.config.lowPrice, 2)} / ${formatNumber(bot.config.highPrice, 2)}`} />
            </div>
          </SurfaceCard>

          <SurfaceCard>
            <SectionHeading eyebrow="Exposure" title="Capital posture" description={embedded ? "Inventory and PnL." : "Inventory, reserve and PnL at a glance."} icon={Wallet2} />

            <div className="mt-5">
              <InfoRow label="Base inventory" value={displayBaseAmount > 0 ? `${formatNumber(displayBaseAmount, 6)} ${bot.baseSymbol}` : "--"} />
              <InfoRow label="Inventory value" value={formatCurrency(displayInventoryValue)} />
              <InfoRow label="Deployed quote" value={formatCurrency(displayDeployedQuoteAmount)} />
              <InfoRow label="USDC reserve" value={formatCurrency(bot.config.reserveQuoteAmount)} />
              <InfoRow label="Realized PnL" value={formatCurrency(displayRealizedPnlUsd)} />
              <InfoRow label="Unrealized PnL" value={formatCurrency(displayUnrealizedPnlUsd)} />
              <InfoRow label="Total equity" value={formatCurrency(displayTotalEquityUsd)} />
            </div>
          </SurfaceCard>

          <SurfaceCard>
            <SectionHeading eyebrow="Config" title="Grid parameters" description={embedded ? "Live rules in force." : "Parameters currently enforcing this strategy."} icon={ArrowDownRight} />

            <div className="mt-5">
              <InfoRow label="Grid" value={`${bot.config.gridType} / ${bot.config.levelCount} rails`} />
              <InfoRow label="Deployable cap" value={formatCurrency(bot.config.maxDeployableUsd)} />
              <InfoRow label="Min order" value={formatCurrency(bot.config.minOrderQuoteAmount)} />
              <InfoRow label="Cooldown" value={`${Math.round(bot.config.cooldownMs / 1000)}s`} />
              <InfoRow label="Confirmation" value={`${Math.round(bot.config.priceConfirmationWindowMs / 1000)}s`} />
              <InfoRow label="Max orders/hour" value={String(bot.config.maxOrdersPerHour)} />
              <InfoRow label="Max drawdown" value={`${formatNumber(bot.config.maxDrawdownPct, 2)}%`} />
            </div>
          </SurfaceCard>

          <SurfaceCard>
            <SectionHeading eyebrow="Ops trail" title="Alerts and logs" description={embedded ? "Latest bot-side events." : "Latest alerts and runtime events for this bot."} icon={ShieldAlert} />

            <SurfaceCard tone="muted" padding="sm" className="mt-5">
              <div className="text-sm font-medium">Latest alert</div>
              <div className="mt-2 text-sm text-[var(--muted)]">
                {latestAlert ? `${latestAlert.title}: ${latestAlert.message}` : "No alert on record for this bot."}
              </div>
            </SurfaceCard>

            <div className="mt-4 space-y-3">
              {recentLogs.length ? (
                recentLogs.map((log) => (
                  <div key={log.id} className="border border-[var(--line)] bg-[var(--panel-soft)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Activity className="h-4 w-4 text-[var(--accent)]" />
                        {log.category}
                      </div>
                      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{formatDateTime(log.createdAt)}</div>
                    </div>
                    <div className="mt-2 text-sm text-[var(--muted)]">{log.message}</div>
                  </div>
                ))
              ) : (
                <div className="border border-dashed border-[var(--line)] bg-[var(--panel-soft)] p-5 text-sm text-[var(--muted)]">
                  No runtime events recorded yet for this bot.
                </div>
              )}
            </div>
          </SurfaceCard>
        </aside>
      </section>
    </section>
  );
}
