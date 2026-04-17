import { describe, expect, it } from "vitest";

import type { HistoricalCandle } from "../domain/types";
import { IndicatorService } from "../services/indicator-service";

function makeCandle(index: number, close: number, input: Partial<HistoricalCandle> = {}): HistoricalCandle {
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1, index)),
    open: input.open ?? close,
    high: input.high ?? close + 1,
    low: input.low ?? close - 1,
    close,
    volume: input.volume ?? 100 + index,
    ...input
  };
}

describe("IndicatorService", () => {
  it("computes EMA values once enough candles are available", () => {
    const candles = Array.from({ length: 60 }, (_, index) => makeCandle(index, 100 + index));
    const result = new IndicatorService().compute(candles);

    expect(result.series[18]?.ema20).toBeNull();
    expect(result.series[19]?.ema20).toBe(109.5);
    expect(result.latest?.ema20).toBeGreaterThan(result.latest?.ema50 ?? 0);
    expect(result.latest?.ema200).toBeNull();
  });

  it("computes ATR and Donchian width from high-low ranges", () => {
    const candles = Array.from({ length: 30 }, (_, index) =>
      makeCandle(index, 100, {
        high: 110 + index,
        low: 90,
        close: 100 + index * 0.1
      })
    );
    const result = new IndicatorService().compute(candles);

    expect(result.series[12]?.atr14).toBeNull();
    expect(result.series[13]?.atr14).toBeGreaterThan(20);
    expect(result.latest?.donchianHigh20).toBe(139);
    expect(result.latest?.donchianLow20).toBe(90);
    expect(result.latest?.donchianWidthPct20).toBeGreaterThan(50);
  });

  it("detects stronger ADX on directional candles than on flat candles", () => {
    const trending = Array.from({ length: 60 }, (_, index) =>
      makeCandle(index, 100 + index, {
        high: 101 + index,
        low: 99 + index
      })
    );
    const flat = Array.from({ length: 60 }, (_, index) =>
      makeCandle(index, 100 + Math.sin(index / 2) * 0.1, {
        high: 100.2,
        low: 99.8
      })
    );
    const service = new IndicatorService();

    expect(service.compute(trending).latest?.adx14).toBeGreaterThan(service.compute(flat).latest?.adx14 ?? 0);
  });

  it("computes Bollinger width, realized volatility, and volume metrics when available", () => {
    const candles = Array.from({ length: 40 }, (_, index) =>
      makeCandle(index, 100 + Math.sin(index / 2) * 5, {
        volume: 100 + index * 10
      })
    );
    const result = new IndicatorService().compute(candles);

    expect(result.hasVolume).toBe(true);
    expect(result.latest?.bollingerWidth20).toBeGreaterThan(0);
    expect(result.latest?.realizedVol20).toBeGreaterThan(0);
    expect(result.latest?.volumeSma20).toBeGreaterThan(0);
    expect(result.latest?.volumeRatio20).toBeGreaterThan(1);
  });

  it("leaves volume metrics empty when candles have no volume", () => {
    const candles = Array.from({ length: 40 }, (_, index) => makeCandle(index, 100 + index, { volume: null }));
    const result = new IndicatorService().compute(candles);

    expect(result.hasVolume).toBe(false);
    expect(result.latest?.volumeSma20).toBeNull();
    expect(result.latest?.volumeRatio20).toBeNull();
  });
});
