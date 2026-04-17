import { describe, expect, it } from "vitest";

import type { HistoricalCandle } from "../domain/types";
import { IndicatorService } from "../services/indicator-service";
import { MarketRegimeService } from "../services/market-regime-service";

function candle(index: number, close: number, input: Partial<HistoricalCandle> = {}): HistoricalCandle {
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1, index)),
    open: input.open ?? close,
    high: input.high ?? close + 0.2,
    low: input.low ?? close - 0.2,
    close,
    volume: input.volume ?? 100,
    ...input
  };
}

function assess(candles: HistoricalCandle[]) {
  const indicators = new IndicatorService().compute(candles);
  return new MarketRegimeService().assess(candles, indicators);
}

describe("MarketRegimeService", () => {
  it("defaults to low-confidence range when there are not enough candles", () => {
    const result = assess([candle(0, 100), candle(1, 100.2)]);

    expect(result.regime).toBe("RANGE");
    expect(result.confidence).toBeLessThan(0.3);
    expect(result.reasons[0]).toContain("Not enough candles");
  });

  it("detects range conditions on contained sideways candles", () => {
    const candles = Array.from({ length: 80 }, (_, index) =>
      candle(index, 100 + Math.sin(index / 3) * 0.35, {
        high: 100.6,
        low: 99.4
      })
    );
    const result = assess(candles);

    expect(result.regime).toBe("RANGE");
    expect(result.scores.range).toBeGreaterThan(result.scores.trendUp);
    expect(result.reasons.join(" ")).toMatch(/ADX|contained|Bollinger/);
  });

  it("detects upward trend conditions", () => {
    const candles = Array.from({ length: 120 }, (_, index) =>
      candle(index, 100 + index * 0.35, {
        high: 101 + index * 0.35,
        low: 99 + index * 0.35
      })
    );
    const result = assess(candles);

    expect(result.regime).toBe("TREND_UP");
    expect(result.scores.trendUp).toBeGreaterThan(result.scores.trendDown);
    expect(result.reasons.join(" ")).toContain("EMA20 is above EMA50");
  });

  it("detects downward trend conditions", () => {
    const candles = Array.from({ length: 120 }, (_, index) =>
      candle(index, 150 - index * 0.35, {
        high: 151 - index * 0.35,
        low: 149 - index * 0.35
      })
    );
    const result = assess(candles);

    expect(result.regime).toBe("TREND_DOWN");
    expect(result.scores.trendDown).toBeGreaterThan(result.scores.trendUp);
    expect(result.reasons.join(" ")).toContain("EMA20 is below EMA50");
  });

  it("detects chaotic high-volatility conditions", () => {
    const candles = Array.from({ length: 80 }, (_, index) => {
      const close = index % 2 === 0 ? 100 + index * 0.1 : 90 - index * 0.1;
      return candle(index, close, {
        open: 95,
        high: close + 8,
        low: close - 8
      });
    });
    const result = assess(candles);

    expect(result.regime).toBe("CHAOTIC_HIGH_VOL");
    expect(result.scores.chaoticHighVol).toBeGreaterThanOrEqual(3);
    expect(result.reasons.join(" ")).toMatch(/ATR|Bollinger|vol/);
  });
});
