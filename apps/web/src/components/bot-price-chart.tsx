"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  type SeriesMarker,
  type Time,
  type UTCTimestamp
} from "lightweight-charts";

import { bucketTimestamp, type CandlePoint, type HistoryResolution } from "@/lib/charting";
import { formatCurrency } from "@/lib/utils";

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

type VisibleGridOrderLine = {
  id: string;
  side: "buy" | "sell" | "mixed";
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

function toTimestampMs(value: Time | undefined) {
  const unixTimestamp = toUnixTimestamp(value);
  return unixTimestamp === null ? null : unixTimestamp * 1000;
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

  const previousDisplayedClose = previousLiveCandle?.close ?? lastCandle.close;

  return {
    time: currentBucketTime,
    open: seededCandle?.open ?? previousDisplayedClose,
    high: Math.max(seededCandle?.high ?? previousDisplayedClose, livePrice),
    low: Math.min(seededCandle?.low ?? previousDisplayedClose, livePrice),
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
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markerPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const staticPriceLinesRef = useRef<IPriceLine[]>([]);
  const spotPriceLineRef = useRef<IPriceLine | null>(null);
  const liveCandleRef = useRef<CandlestickData<Time> | null>(null);
  const visibleLogicalRangeRef = useRef<LogicalRange | null>(null);
  const isSyncingViewportRef = useRef(false);
  const isPinnedToRealtimeRef = useRef(true);
  const hasInitializedViewportRef = useRef(false);
  const hasUserNavigatedRef = useRef(false);
  const resolutionKeyRef = useRef(resolution);
  const sourceKeyRef = useRef(sourceLabel);
  const [liveMarkerAnchorBuckets, setLiveMarkerAnchorBuckets] = useState<number[]>([]);

  const orderedCandles = useMemo(() => [...candles].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime()), [candles]);
  const latestHistoricalCandleTime = orderedCandles.at(-1)?.time ?? null;
  const latestHistoricalBucket =
    latestHistoricalCandleTime === null ? null : bucketTimestamp(new Date(latestHistoricalCandleTime).getTime(), resolution);
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
  const markerAnchorTimes = useMemo(() => {
    const anchors = new Set<number>(orderedCandles.map((candle) => new Date(candle.time).getTime()));
    for (const anchor of liveMarkerAnchorBuckets) {
      anchors.add(anchor);
    }
    return [...anchors].sort((left, right) => left - right);
  }, [liveMarkerAnchorBuckets, orderedCandles]);
  const latestHistorical = orderedCandles.at(-1);
  const latestDisplay = liveCandle ?? latestHistorical ?? null;
  const staticBaselinePrice = latestHistorical?.close ?? currentPrice ?? null;
  const currentToneColor =
    latestDisplay && latestDisplay.close >= latestDisplay.open ? "#44d39c" : latestDisplay ? "#ff6b7a" : "#44d39c";
  const visibleOrderLines = useMemo<VisibleGridOrderLine[]>(() => {
    const grouped = orderLines.reduce<Map<string, { price: number; labels: string[]; sides: Set<"buy" | "sell"> }>>((accumulator, line) => {
      const key = line.price.toFixed(8);
      const existing = accumulator.get(key);

      if (existing) {
        existing.sides.add(line.side);
        if (!existing.labels.includes(line.label)) {
          existing.labels.push(line.label);
        }
        return accumulator;
      }

      accumulator.set(key, {
        price: line.price,
        labels: [line.label],
        sides: new Set([line.side])
      });

      return accumulator;
    }, new Map());

    return [...grouped.entries()]
      .map(([key, entry]) => ({
        id: key,
        side: (entry.sides.size > 1 ? "mixed" : [...entry.sides][0] ?? "buy") as VisibleGridOrderLine["side"],
        price: entry.price,
        label: entry.labels.join(" / ")
      }))
      .sort((left, right) => left.price - right.price);
  }, [orderLines]);
  const levelIndexesWithOrderOverlay = useMemo(
    () =>
      new Set(
        levels.reduce<number[]>((accumulator, level, index) => {
          if (visibleOrderLines.some((line) => Math.abs(line.price - level) < 0.000001)) {
            accumulator.push(index);
          }

          return accumulator;
        }, [])
      ),
    [levels, visibleOrderLines]
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
  }, [resolution, latestHistoricalCandleTime]);

  useEffect(() => {
    setLiveMarkerAnchorBuckets([]);
  }, [resolution]);

  useEffect(() => {
    setLiveMarkerAnchorBuckets((currentAnchors) => {
      const prunedAnchors =
        latestHistoricalBucket === null ? currentAnchors : currentAnchors.filter((anchor) => anchor > latestHistoricalBucket);

      if (!currentPriceTime) {
        return prunedAnchors;
      }

      const liveTimestamp = new Date(currentPriceTime).getTime();
      if (Number.isNaN(liveTimestamp)) {
        return prunedAnchors;
      }

      const liveBucket = bucketTimestamp(liveTimestamp, resolution);
      if (latestHistoricalBucket !== null && liveBucket <= latestHistoricalBucket) {
        return prunedAnchors;
      }

      if (prunedAnchors.includes(liveBucket)) {
        return prunedAnchors;
      }

      return [...prunedAnchors, liveBucket].sort((left, right) => left - right);
    });
  }, [currentPriceTime, latestHistoricalBucket, resolution]);

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

    const timeScale = chart.timeScale();
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

    timeScale.subscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
    resize();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      timeScale.unsubscribeVisibleLogicalRangeChange(handleVisibleLogicalRangeChange);
      markerPluginRef.current?.detach();
      markerPluginRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      staticPriceLinesRef.current = [];
      spotPriceLineRef.current = null;
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

    const snappedMarkers = markers.reduce<SeriesMarker<Time>[]>((accumulator, marker) => {
      if (!markerAnchorTimes.length) {
        return accumulator;
      }

      const markerTime = new Date(marker.time).getTime();
      const targetBucket = bucketTimestamp(markerTime, resolution);
      let snappedAnchorTime = markerAnchorTimes.find((anchor) => anchor === targetBucket) ?? null;
      let nearestDistance = Number.POSITIVE_INFINITY;

      if (snappedAnchorTime === null) {
        for (const anchor of markerAnchorTimes) {
          const candidateDistance = Math.abs(anchor - targetBucket);
          if (candidateDistance < nearestDistance) {
            snappedAnchorTime = anchor;
            nearestDistance = candidateDistance;
          }
        }
      }

      if (snappedAnchorTime === null) {
        return accumulator;
      }

      const snappedTime = Math.floor(snappedAnchorTime / 1000) as UTCTimestamp;
      accumulator.push({
        time: snappedTime,
        position: marker.side === "buy" ? "belowBar" : "aboveBar",
        shape: marker.side === "buy" ? "arrowUp" : "arrowDown",
        color: marker.side === "buy" ? "#7ff5c4" : "#ff7f8e",
        text: marker.label
      });
      return accumulator;
    }, []);

    markerPluginRef.current.setMarkers(snappedMarkers);
  }, [markerAnchorTimes, markers, resolution]);

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
        lineWidth: 1,
        axisLabelVisible: labeledLevelIndexes.includes(index) && !levelIndexesWithOrderOverlay.has(index),
        title:
          labeledLevelIndexes.includes(index) && !levelIndexesWithOrderOverlay.has(index)
            ? `L${String(index + 1).padStart(2, "0")}`
            : ""
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

    visibleOrderLines.forEach((line) => {
      nextPriceLines.push(
        series.createPriceLine({
          price: line.price,
          color:
            line.side === "buy"
              ? "rgba(68,211,156,0.86)"
              : line.side === "sell"
                ? "rgba(255,107,122,0.88)"
                : "rgba(121,184,255,0.9)",
          lineStyle: line.side === "mixed" ? LineStyle.LargeDashed : LineStyle.Dotted,
          lineWidth: 2,
          axisLabelVisible: true,
          title: line.label
        })
      );
    });

    staticPriceLinesRef.current = nextPriceLines;
  }, [averageCost, labeledLevelIndexes, levelIndexesWithOrderOverlay, levels, staticBaselinePrice, visibleOrderLines]);

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
      <div className="relative overflow-hidden border border-[var(--line)] bg-[radial-gradient(circle_at_top,rgba(121,184,255,0.08),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))]">
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
        </div>

        {loading && candles.length === 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 mx-auto w-fit border border-[var(--line)] bg-[rgba(6,10,16,0.9)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">
            Loading market history
          </div>
        ) : null}

        <div ref={containerRef} className="h-[460px] w-full" />
      </div>
    </div>
  );
}
