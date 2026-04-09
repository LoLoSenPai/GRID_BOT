"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  LineStyle,
  type BusinessDay,
  type CandlestickData,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";

import { bucketTimestamp, type CandlePoint, type HistoryResolution } from "@/lib/charting";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils";

type GridMarker = {
  time: string;
  side: "buy" | "sell";
  label: string;
};

type GridOrderLine = {
  id: string;
  side: "buy" | "sell";
  price: number;
  label: string;
};

const DEFAULT_VISIBLE_BARS: Record<HistoryResolution, number> = {
  "5m": 96,
  "30m": 96,
  "1h": 96,
  "4h": 96,
  "1d": 96,
  "1w": 96,
  "1mo": 96
};

function toUnixTimestamp(value: Time | undefined) {
  if (!value) {
    return null;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Math.floor(new Date(value).getTime() / 1000);
  }

  const businessDay = value as BusinessDay;
  return Math.floor(Date.UTC(businessDay.year, businessDay.month - 1, businessDay.day, 0, 0, 0, 0) / 1000);
}

function buildLiveCandle(
  candles: CandlePoint[],
  resolution: HistoryResolution,
  livePrice?: number | null,
  liveTime?: string | null,
  previousLiveCandle?: CandlestickData<Time> | null
) {
  if (!candles.length || !livePrice || !liveTime) {
    return null;
  }

  const liveTimestamp = new Date(liveTime).getTime();
  if (Number.isNaN(liveTimestamp)) {
    return null;
  }

  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) {
    return null;
  }

  const liveBucket = bucketTimestamp(liveTimestamp, resolution);
  const lastBucket = bucketTimestamp(new Date(lastCandle.time).getTime(), resolution);
  const currentBucketTime =
    liveBucket === lastBucket
      ? (Math.floor(new Date(lastCandle.time).getTime() / 1000) as UTCTimestamp)
      : (Math.floor(liveBucket / 1000) as UTCTimestamp);
  const seededCandle =
    previousLiveCandle && previousLiveCandle.time === currentBucketTime
      ? previousLiveCandle
      : null;

  if (liveBucket < lastBucket) {
    return null;
  }

  if (liveBucket === lastBucket) {
    return {
      time: currentBucketTime,
      open: seededCandle?.open ?? lastCandle.open,
      high: Math.max(lastCandle.high, seededCandle?.high ?? lastCandle.high, livePrice),
      low: Math.min(lastCandle.low, seededCandle?.low ?? lastCandle.low, livePrice),
      close: livePrice
    } satisfies CandlestickData<Time>;
  }

  return {
    time: currentBucketTime,
    open: seededCandle?.open ?? lastCandle.close,
    high: Math.max(seededCandle?.high ?? lastCandle.close, livePrice),
    low: Math.min(seededCandle?.low ?? lastCandle.close, livePrice),
    close: livePrice
  } satisfies CandlestickData<Time>;
}

export function BotPriceChart({
  resolution,
  candles,
  levels,
  markers,
  orderLines,
  currentPrice,
  currentPriceTime,
  averageCost,
  loading,
  resolutionLabel,
  sourceLabel,
  cappedLabel
}: {
  resolution: HistoryResolution;
  candles: CandlePoint[];
  levels: number[];
  markers: GridMarker[];
  orderLines: GridOrderLine[];
  currentPrice?: number | null;
  currentPriceTime?: string | null;
  averageCost?: number | null;
  loading?: boolean;
  resolutionLabel: string;
  sourceLabel: string;
  cappedLabel?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markerPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const staticPriceLinesRef = useRef<IPriceLine[]>([]);
  const spotPriceLineRef = useRef<IPriceLine | null>(null);
  const liveCandleRef = useRef<CandlestickData<Time> | null>(null);
  const markerLookupRef = useRef<Record<number, GridMarker[]>>({});
  const visibleLogicalRangeRef = useRef<LogicalRange | null>(null);
  const isSyncingViewportRef = useRef(false);
  const isPinnedToRealtimeRef = useRef(true);
  const hasInitializedViewportRef = useRef(false);
  const hasUserNavigatedRef = useRef(false);
  const resolutionKeyRef = useRef(resolution);
  const sourceKeyRef = useRef(sourceLabel);

  const orderedCandles = useMemo(() => [...candles].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime()), [candles]);
  const chartData = useMemo<CandlestickData<Time>[]>(
    () =>
      orderedCandles.map((candle) => ({
        time: Math.floor(new Date(candle.time).getTime() / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
      })),
    [orderedCandles]
  );
  const liveCandle = useMemo(
    () => buildLiveCandle(candles, resolution, currentPrice, currentPriceTime, liveCandleRef.current),
    [candles, currentPrice, currentPriceTime, resolution]
  );
  const latestHistorical = orderedCandles.at(-1);
  const latestDisplay = liveCandle ?? latestHistorical ?? null;
  const staticBaselinePrice = latestHistorical?.close ?? currentPrice ?? null;
  const currentToneColor =
    latestDisplay && latestDisplay.close >= latestDisplay.open ? "#44d39c" : latestDisplay ? "#ff6b7a" : "#44d39c";
  const visibleOrderLines = useMemo(
    () =>
      orderLines.reduce<GridOrderLine[]>((accumulator, line) => {
        if (accumulator.some((entry) => entry.side === line.side && Math.abs(entry.price - line.price) < 0.000001)) {
          return accumulator;
        }

        accumulator.push(line);
        return accumulator;
      }, []),
    [orderLines]
  );
  const nearestLevelIndex = useMemo(
    () =>
      staticBaselinePrice === null
        ? -1
        : levels.reduce(
          (closest, level, index) =>
            closest === -1 || Math.abs(level - staticBaselinePrice) < Math.abs((levels[closest] ?? level) - staticBaselinePrice) ? index : closest,
          -1
        ),
    [levels, staticBaselinePrice]
  );
  const labeledLevelIndexes = useMemo(
    () =>
      levels.reduce<number[]>((accumulator, _level, index) => {
        if (index === 0 || index === levels.length - 1 || index === nearestLevelIndex || Math.abs(index - nearestLevelIndex) <= 1) {
          accumulator.push(index);
        }

        return accumulator;
      }, []),
    [levels, nearestLevelIndex]
  );

  const captureViewport = () => {
    const timeScale = chartRef.current?.timeScale();
    if (!timeScale) {
      return;
    }

    visibleLogicalRangeRef.current = timeScale.getVisibleLogicalRange();
    isPinnedToRealtimeRef.current = timeScale.scrollPosition() <= 0.5;
  };

  const runViewportMutation = (callback: () => void) => {
    isSyncingViewportRef.current = true;
    callback();
    captureViewport();
    isSyncingViewportRef.current = false;
  };

  const getDefaultVisibleLogicalRange = (barCount: number): LogicalRange => {
    const visibleBars = Math.min(DEFAULT_VISIBLE_BARS[resolution], Math.max(barCount, 1));
    const to = Math.max(barCount - 1 + 3, visibleBars);
    const from = Math.max(to - visibleBars, 0);

    return { from, to } as LogicalRange;
  };

  const getRealtimeVisibleLogicalRange = (barCount: number): LogicalRange => {
    const currentRange = visibleLogicalRangeRef.current;
    const span =
      currentRange && Number.isFinite(currentRange.to - currentRange.from) ? Math.max(currentRange.to - currentRange.from, 10) : DEFAULT_VISIBLE_BARS[resolution];
    const to = Math.max(barCount - 1 + 3, span);
    const from = Math.max(to - span, 0);

    return { from, to } as LogicalRange;
  };

  useEffect(() => {
    liveCandleRef.current = null;
  }, [resolution, orderedCandles.at(-1)?.time]);

  useEffect(() => {
    liveCandleRef.current = liveCandle;
  }, [liveCandle]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#91a5bc"
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.06)" }
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.08)",
        scaleMargins: {
          top: 0.12,
          bottom: 0.12
        }
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: {
        vertLine: {
          color: "rgba(255,255,255,0.16)",
          labelBackgroundColor: "#0f1721"
        },
        horzLine: {
          color: "rgba(255,255,255,0.16)",
          labelBackgroundColor: "#0f1721"
        }
      }
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#44d39c",
      borderUpColor: "#44d39c",
      wickUpColor: "#44d39c",
      downColor: "#ff6b7a",
      borderDownColor: "#ff6b7a",
      wickDownColor: "#ff6b7a",
      priceLineVisible: false
    });

    const tooltip = tooltipRef.current;
    const timeScale = chart.timeScale();
    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      if (!tooltip || !containerRef.current || !param.point || !param.time || !seriesRef.current) {
        if (tooltip) {
          tooltip.style.opacity = "0";
        }
        return;
      }

      if (
        param.point.x < 0 ||
        param.point.y < 0 ||
        param.point.x > containerRef.current.clientWidth ||
        param.point.y > 430
      ) {
        tooltip.style.opacity = "0";
        return;
      }

      const candle = param.seriesData.get(seriesRef.current);
      const unixTime = toUnixTimestamp(param.time);

      if (!candle || unixTime === null) {
        tooltip.style.opacity = "0";
        return;
      }

      const typedCandle = candle as CandlestickData<Time>;
      const marker = markerLookupRef.current[unixTime]?.[0];

      tooltip.style.opacity = "1";
      tooltip.style.left = `${Math.max(18, Math.min(param.point.x + 14, containerRef.current.clientWidth - 220))}px`;
      tooltip.style.top = `${Math.max(18, Math.min(param.point.y + 14, 300))}px`;
      tooltip.innerHTML = `
        <div class="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">${formatDateTime(new Date(unixTime * 1000).toISOString())}</div>
        <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <span class="text-[var(--muted)]">O</span><span>${formatNumber(typedCandle.open, 2)}</span>
          <span class="text-[var(--muted)]">H</span><span>${formatNumber(typedCandle.high, 2)}</span>
          <span class="text-[var(--muted)]">L</span><span>${formatNumber(typedCandle.low, 2)}</span>
          <span class="text-[var(--muted)]">C</span><span>${formatNumber(typedCandle.close, 2)}</span>
        </div>
        ${marker
          ? `<div class="${marker.side === "buy" ? "mt-3 border border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--green)]" : "mt-3 border border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--red)]"}">${marker.label}</div>`
          : ""
        }
      `;
    };
    const handleVisibleLogicalRangeChange = (range: LogicalRange | null) => {
      if (!range || isSyncingViewportRef.current) {
        return;
      }

      visibleLogicalRangeRef.current = { from: range.from, to: range.to } as LogicalRange;
      isPinnedToRealtimeRef.current = timeScale.scrollPosition() <= 0.5;
      hasUserNavigatedRef.current = true;
    };

    const resize = () => {
      chart.applyOptions({
        width: containerRef.current?.clientWidth ?? 640,
        height: 430
      });
    };

    chartRef.current = chart;
    seriesRef.current = series;
    markerPluginRef.current = createSeriesMarkers(series, []);

    chart.subscribeCrosshairMove(handleCrosshairMove);
    timeScale.subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
    resize();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      timeScale.unsubscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
      markerPluginRef.current?.detach();
      markerPluginRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      staticPriceLinesRef.current = [];
      spotPriceLineRef.current = null;
      markerLookupRef.current = {};
      visibleLogicalRangeRef.current = null;
      isSyncingViewportRef.current = false;
      isPinnedToRealtimeRef.current = true;
      hasInitializedViewportRef.current = false;
      hasUserNavigatedRef.current = false;
      resolutionKeyRef.current = resolution;
      sourceKeyRef.current = sourceLabel;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) {
      return;
    }

    const series = seriesRef.current;
    const chart = chartRef.current;
    const timeScale = chart.timeScale();
    series.setData(chartData);
    if (!chartData.length) {
      visibleLogicalRangeRef.current = null;
      hasInitializedViewportRef.current = false;
      isPinnedToRealtimeRef.current = true;
      hasUserNavigatedRef.current = false;
      resolutionKeyRef.current = resolution;
      sourceKeyRef.current = sourceLabel;
      return;
    }

    const resolutionChanged = resolutionKeyRef.current !== resolution;
    const sourceChanged = sourceKeyRef.current !== sourceLabel;

    if (resolutionChanged) {
      visibleLogicalRangeRef.current = null;
      hasInitializedViewportRef.current = false;
      isPinnedToRealtimeRef.current = true;
      hasUserNavigatedRef.current = false;
      resolutionKeyRef.current = resolution;
    }

    if (!hasInitializedViewportRef.current || (!hasUserNavigatedRef.current && sourceChanged)) {
      runViewportMutation(() => {
        timeScale.setVisibleLogicalRange(getDefaultVisibleLogicalRange(chartData.length));
      });
      hasInitializedViewportRef.current = true;
      sourceKeyRef.current = sourceLabel;
      return;
    }

    if (!visibleLogicalRangeRef.current || isPinnedToRealtimeRef.current) {
      runViewportMutation(() => {
        timeScale.setVisibleLogicalRange(getRealtimeVisibleLogicalRange(chartData.length));
      });
      sourceKeyRef.current = sourceLabel;
      return;
    }

    const { from, to } = visibleLogicalRangeRef.current;
    runViewportMutation(() => {
      timeScale.setVisibleLogicalRange({ from, to });
    });
    sourceKeyRef.current = sourceLabel;
  }, [chartData, resolution, sourceLabel]);

  useEffect(() => {
    if (!markerPluginRef.current) {
      return;
    }

    const snappedMarkerEntries: Array<{ snappedTime: number; marker: GridMarker }> = [];
    const snappedMarkers = markers.reduce<SeriesMarker<Time>[]>((accumulator, marker) => {
      const markerTime = new Date(marker.time).getTime();
      let nearest: CandlePoint | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (const candle of orderedCandles) {
        const candidateDistance = Math.abs(new Date(candle.time).getTime() - markerTime);
        if (candidateDistance < nearestDistance) {
          nearest = candle;
          nearestDistance = candidateDistance;
        }
      }

      if (!nearest) {
        return accumulator;
      }

      const snappedTime = Math.floor(new Date(nearest.time).getTime() / 1000) as UTCTimestamp;
      accumulator.push({
        time: snappedTime,
        position: marker.side === "buy" ? "belowBar" : "aboveBar",
        shape: marker.side === "buy" ? "arrowUp" : "arrowDown",
        color: marker.side === "buy" ? "#7ff5c4" : "#ff7f8e",
        text: marker.label
      });
      snappedMarkerEntries.push({ snappedTime, marker });
      return accumulator;
    }, []);

    markerLookupRef.current = snappedMarkerEntries.reduce<Record<number, GridMarker[]>>((accumulator, entry) => {
      const bucket = accumulator[entry.snappedTime] ?? [];
      bucket.push(entry.marker);
      accumulator[entry.snappedTime] = bucket;
      return accumulator;
    }, {});

    markerPluginRef.current.setMarkers(snappedMarkers);
  }, [markers, orderedCandles]);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    if (!liveCandle) {
      return;
    }

    seriesRef.current.update(liveCandle);
  }, [liveCandle]);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    const series = seriesRef.current;
    staticPriceLinesRef.current.forEach((line) => series.removePriceLine(line));

    const nextPriceLines = levels.map((level, index) =>
      series.createPriceLine({
        price: level,
        color:
          staticBaselinePrice === null
            ? "rgba(255,255,255,0.10)"
            : level <= staticBaselinePrice
              ? "rgba(68,211,156,0.14)"
              : "rgba(248,200,108,0.16)",
        lineStyle: LineStyle.Dashed,
        lineWidth: index === nearestLevelIndex ? 2 : 1,
        axisLabelVisible: labeledLevelIndexes.includes(index),
        title: labeledLevelIndexes.includes(index) ? `L${String(index + 1).padStart(2, "0")}` : ""
      })
    );

    if (averageCost) {
      nextPriceLines.push(
        series.createPriceLine({
          price: averageCost,
          color: "rgba(248,200,108,0.95)",
          lineStyle: LineStyle.LargeDashed,
          lineWidth: 2,
          axisLabelVisible: true,
          title: "Avg"
        })
      );
    }

    visibleOrderLines.slice(-8).forEach((line) => {
      nextPriceLines.push(
        series.createPriceLine({
          price: line.price,
          color: line.side === "buy" ? "rgba(68,211,156,0.86)" : "rgba(255,107,122,0.88)",
          lineStyle: LineStyle.Dotted,
          lineWidth: 2,
          axisLabelVisible: true,
          title: line.label
        })
      );
    });

    staticPriceLinesRef.current = nextPriceLines;
  }, [averageCost, labeledLevelIndexes, levels, nearestLevelIndex, staticBaselinePrice, visibleOrderLines]);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    const series = seriesRef.current;
    if (spotPriceLineRef.current) {
      series.removePriceLine(spotPriceLineRef.current);
      spotPriceLineRef.current = null;
    }

    if (!currentPrice) {
      return;
    }

    spotPriceLineRef.current = series.createPriceLine({
      price: currentPrice,
      color: currentToneColor,
      lineStyle: LineStyle.Solid,
      lineWidth: 2,
      axisLabelVisible: false,
      title: ""
    });
  }, [currentPrice, currentToneColor]);

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden border border-[var(--line)] bg-[radial-gradient(circle_at_top,rgba(127,245,196,0.05),transparent_32%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))]">
        <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-wrap gap-2">
          <span className="border border-[var(--line)] bg-white/[0.06] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-white">
            {resolutionLabel}
          </span>
          <span className="border border-[color:rgba(68,211,156,0.18)] bg-[color:rgba(68,211,156,0.08)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--green)]">
            Buy rails
          </span>
          <span className="border border-[color:rgba(255,107,122,0.18)] bg-[color:rgba(255,107,122,0.08)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--red)]">
            Sell rails
          </span>
          <span className="border border-[var(--line)] bg-white/[0.06] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
            {sourceLabel}
          </span>
          {cappedLabel ? (
            <span className="border border-[color:rgba(248,200,108,0.18)] bg-[color:rgba(248,200,108,0.08)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--amber)]">
              {cappedLabel}
            </span>
          ) : null}
        </div>

        {loading && candles.length === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 mx-auto w-fit border border-[var(--line)] bg-[rgba(6,10,16,0.9)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
            Loading market history
          </div>
        ) : null}

        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-20 w-[200px] border border-[var(--line)] bg-[rgba(6,10,16,0.94)] p-3 shadow-[0_18px_40px_rgba(0,0,0,0.28)] opacity-0 transition-opacity"
        />

        <div ref={containerRef} className="h-[460px] w-full" />
      </div>
    </div>
  );
}
