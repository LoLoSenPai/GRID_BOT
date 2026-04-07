"use client";

import { useEffect, useMemo, useState } from "react";

import { BotPriceChart } from "@/components/bot-price-chart";
import { SurfaceCard } from "@/components/surface-card";
import { TimeRangeTabs } from "@/components/time-range-tabs";
import { HISTORY_RESOLUTION_OPTIONS, type CandlePoint, type HistoryResolution } from "@/lib/charting";
import type { BotFormDraft } from "@/lib/bot-management";
import { calculateGridLevels } from "@/lib/bot-runtime";
import { formatCurrency, formatNumber } from "@/lib/utils";

type HistoryCacheEntry = {
  candles: CandlePoint[];
  sourceLabel: string;
  fetchedAt: number;
};

const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const historyCache = new Map<string, HistoryCacheEntry>();
const historyRequestCache = new Map<string, Promise<HistoryCacheEntry>>();

function getHistoryCacheKey(symbol: "SOL" | "BTC", resolution: HistoryResolution) {
  return `${symbol}:${resolution}`;
}

function getFreshHistoryCacheEntry(symbol: "SOL" | "BTC", resolution: HistoryResolution) {
  const cacheKey = getHistoryCacheKey(symbol, resolution);
  const cached = historyCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.fetchedAt > HISTORY_CACHE_TTL_MS) {
    historyCache.delete(cacheKey);
    return null;
  }

  return cached;
}

async function requestHistory(symbol: "SOL" | "BTC", resolution: HistoryResolution) {
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

      return response.json() as Promise<{
        candles: CandlePoint[];
        meta: {
          source: string;
        };
      }>;
    })
    .then((payload) => {
      const entry: HistoryCacheEntry = {
        candles: payload.candles,
        sourceLabel: payload.meta.source,
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

export function BotConfigPreview({
  symbol,
  draft,
  currentPrice,
  currentPriceTime
}: {
  symbol: "SOL" | "BTC";
  draft: BotFormDraft;
  currentPrice: number | null;
  currentPriceTime?: string | null;
}) {
  const [resolution, setResolution] = useState<HistoryResolution>("1h");
  const [historyState, setHistoryState] = useState<{
    candles: CandlePoint[];
    sourceLabel: string;
    loading: boolean;
    error: string | null;
  }>({
    candles: [],
    sourceLabel: "pyth-history",
    loading: true,
    error: null
  });

  const levels = useMemo(() => calculateGridLevels(draft), [draft]);
  const gridStep = useMemo(() => {
    if (levels.length < 2) {
      return null;
    }

    const firstLevel = levels[0];
    const secondLevel = levels[1];
    if (typeof firstLevel !== "number" || typeof secondLevel !== "number") {
      return null;
    }

    return Math.abs(secondLevel - firstLevel);
  }, [levels]);

  useEffect(() => {
    let active = true;
    const cached = getFreshHistoryCacheEntry(symbol, resolution);

    if (cached) {
      setHistoryState({
        candles: cached.candles,
        sourceLabel: cached.sourceLabel,
        loading: false,
        error: null
      });
      return () => {
        active = false;
      };
    }

    setHistoryState((current) => ({
      ...current,
      loading: true,
      error: null
    }));

    requestHistory(symbol, resolution)
      .then((entry) => {
        if (!active) {
          return;
        }

        setHistoryState({
          candles: entry.candles,
          sourceLabel: entry.sourceLabel,
          loading: false,
          error: null
        });
      })
      .catch((error) => {
        if (!active) {
          return;
        }

        setHistoryState({
          candles: [],
          sourceLabel: "unavailable",
          loading: false,
          error: error instanceof Error ? error.message : "History request failed"
        });
      });

    return () => {
      active = false;
    };
  }, [resolution, symbol]);

  return (
    <SurfaceCard padding="sm" className="space-y-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Grid preview</div>
          <div className="mt-2 text-sm text-white">
            {symbol}/USDC | {draft.levelCount} rails | {draft.gridType}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="border border-[var(--line)] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">
            {historyState.error ? "history unavailable" : historyState.sourceLabel}
          </span>
          <TimeRangeTabs options={HISTORY_RESOLUTION_OPTIONS} value={resolution} onChange={(next) => setResolution(next as HistoryResolution)} />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <PreviewMetric label="Range" value={`${formatNumber(draft.lowPrice, 2)} -> ${formatNumber(draft.highPrice, 2)}`} hint="Editable bounds" />
        <PreviewMetric label="Rails" value={String(draft.levelCount)} hint="Grid density" />
        <PreviewMetric label="Capital / rail" value={formatCurrency(draft.maxDeployableUsd / Math.max(draft.levelCount, 1))} hint="Deployment split" />
        <PreviewMetric label="Spot" value={currentPrice ? formatNumber(currentPrice, currentPrice >= 1000 ? 0 : 2) : "--"} hint="Current market price" />
      </div>

      <BotPriceChart
        resolution={resolution}
        candles={historyState.candles}
        levels={levels}
        markers={[]}
        orderLines={[]}
        currentPrice={currentPrice}
        currentPriceTime={currentPriceTime}
        averageCost={null}
        loading={historyState.loading}
        resolutionLabel={HISTORY_RESOLUTION_OPTIONS.find((option) => option.value === resolution)?.label ?? "1h"}
        sourceLabel={historyState.error ? "history unavailable" : historyState.sourceLabel}
      />

      <div className="grid gap-3 md:grid-cols-2">
        <PreviewMetric
          label="Step"
          value={gridStep !== null ? formatNumber(gridStep, symbol === "BTC" ? 0 : 2) : "--"}
          hint="Average distance between rails"
        />
        <PreviewMetric label="Min order" value={formatCurrency(draft.minOrderQuoteAmount)} hint="Minimum quote used on entry" />
      </div>
    </SurfaceCard>
  );
}

function PreviewMetric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="border border-[var(--line)] bg-[var(--bg)] px-4 py-3">
      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">{label}</div>
      <div className="mt-2 text-base font-semibold text-white">{value}</div>
      <div className="mt-1 text-xs text-[var(--muted)]">{hint}</div>
    </div>
  );
}
