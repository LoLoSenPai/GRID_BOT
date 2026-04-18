import { describe, expect, it } from "vitest";

import { CandleReplayService } from "../services/candle-replay-service";

const service = new CandleReplayService();

function candle(timestamp: string, open: number, high: number, low: number, close: number) {
  return {
    timestamp: new Date(timestamp),
    open,
    high,
    low,
    close
  };
}

describe("CandleReplayService", () => {
  it("uses open-low-high-close traversal for bullish candles", () => {
    const path = service.buildIntrabougiePath(candle("2026-04-01T00:00:00Z", 100, 110, 95, 105), 60_000);

    expect(path.map((point) => point.price)).toEqual([100, 95, 110, 105]);
    expect(path.map((point) => point.timestamp.getTime())).toEqual([
      Date.parse("2026-04-01T00:00:00Z"),
      Date.parse("2026-04-01T00:00:20Z"),
      Date.parse("2026-04-01T00:00:40Z"),
      Date.parse("2026-04-01T00:01:00Z")
    ]);
  });

  it("uses open-high-low-close traversal for bearish candles", () => {
    const path = service.buildIntrabougiePath(candle("2026-04-01T00:00:00Z", 105, 110, 95, 100), 60_000);

    expect(path.map((point) => point.price)).toEqual([105, 110, 95, 100]);
  });

  it("estimates interval from the median positive candle delta", () => {
    const candles = [
      candle("2026-04-01T00:00:00Z", 1, 1, 1, 1),
      candle("2026-04-01T00:05:00Z", 1, 1, 1, 1),
      candle("2026-04-01T00:10:00Z", 1, 1, 1, 1),
      candle("2026-04-01T00:40:00Z", 1, 1, 1, 1)
    ];

    expect(service.estimateIntervalMs(candles)).toBe(5 * 60_000);
  });

  it("falls back to a one millisecond interval when no positive delta exists", () => {
    expect(service.estimateIntervalMs([candle("2026-04-01T00:00:00Z", 1, 1, 1, 1)])).toBe(1);
  });
});
