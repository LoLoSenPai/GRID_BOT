import { describe, expect, it } from "vitest";

import type { HistoricalCandle } from "../domain/types";
import { ReboundZoneService } from "../services/rebound-zone-service";

function candle(index: number, close: number, input: Partial<HistoricalCandle> = {}): HistoricalCandle {
  return {
    timestamp: new Date(Date.UTC(2026, 0, 1, index)),
    open: input.open ?? close,
    high: input.high ?? close + 0.4,
    low: input.low ?? close - 0.4,
    close,
    volume: 100,
    ...input
  };
}

function oscillation(): HistoricalCandle[] {
  const candles: HistoricalCandle[] = [];
  for (let index = 0; index < 42; index += 1) {
    const phase = index % 6;
    const close = phase === 0 || phase === 1 ? 96 : phase === 3 || phase === 4 ? 104 : 100;
    candles.push(candle(index, close, {
      high: phase === 3 || phase === 4 ? 106 : 101,
      low: phase === 0 ? 94 : phase === 1 ? 95 : phase === 3 || phase === 4 ? 103 : 99
    }));
  }
  candles[candles.length - 1] = candle(41, 100, { high: 101, low: 99 });
  return candles;
}

describe("ReboundZoneService", () => {
  it("detects an obvious repeated oscillation zone", () => {
    const result = new ReboundZoneService().analyze(oscillation());

    expect(result.ranges.length).toBeGreaterThan(0);
    expect(result.ranges[0]!.supportTouches).toBeGreaterThanOrEqual(3);
    expect(result.ranges[0]!.resistanceTouches).toBeGreaterThanOrEqual(3);
    expect(result.ranges[0]!.lowPrice).toBeLessThan(96);
    expect(result.ranges[0]!.highPrice).toBeGreaterThan(104);
    expect(result.ranges[0]!.reasons.join(" ")).toMatch(/independent|tolerance|inside/);
  });

  it("refuses a monotonic trend", () => {
    const candles = Array.from({ length: 40 }, (_, index) => candle(index, 90 + index, {
      high: 91 + index,
      low: 89 + index
    }));

    expect(new ReboundZoneService().analyze(candles).ranges).toEqual([]);
  });

  it("does not inflate touches from a prolonged single-zone visit", () => {
    const candles = Array.from({ length: 30 }, (_, index) => candle(index, 100, { high: 101, low: 99 }));
    for (const index of [5, 8, 11, 14]) {
      candles[index] = candle(index, 100, { high: 101, low: 98 });
    }
    for (const index of [17, 20, 23, 26]) {
      candles[index] = candle(index, 100, { high: 102, low: 99 });
    }

    const result = new ReboundZoneService().analyze(candles);
    expect(result.ranges).toEqual([]);
  });

  it("rejects an old range after a break with only one-bar re-entry", () => {
    const service = new ReboundZoneService();
    const candles = oscillation();
    candles.push(candle(42, 130, { high: 131, low: 129 }));
    candles.push(candle(43, 100, { high: 101, low: 99 }));

    expect(service.analyze(candles).ranges).toEqual([]);
  });

  it("does not use an unconfirmed late extremum", () => {
    const service = new ReboundZoneService();
    const baseline = service.analyze(oscillation());
    const candles = oscillation();
    candles[candles.length - 1] = candle(candles.length - 1, 100, { high: 120, low: 99 });

    const result = service.analyze(candles);
    expect(result.ranges[0]!.highPrice).toBe(baseline.ranges[0]!.highPrice);
    expect(result.ranges[0]!.lastResistanceAt.getTime()).toBeLessThan(candles.at(-1)!.timestamp.getTime());
  });

  it("is invariant to future candles when asOf is supplied", () => {
    const base = oscillation();
    const asOf = base[35]!.timestamp;
    const before = new ReboundZoneService().analyze(base, { asOf });
    const after = new ReboundZoneService().analyze([
      ...base,
      candle(42, 180, { high: 181, low: 179 }),
      candle(43, 181, { high: 182, low: 180 })
    ], { asOf });

    expect(after).toEqual(before);
  });

  it("rejects malformed, duplicate, and nonmonotonic known data", () => {
    const base = oscillation();
    const duplicate = [...base.slice(0, 10), base[9]!, ...base.slice(10)];
    const malformed = [...base.slice(0, 10), candle(10, -1), ...base.slice(11)];
    const nonmonotonic = [...base.slice(0, 10), base[8]!, ...base.slice(11)];
    const service = new ReboundZoneService();

    expect(service.analyze(duplicate).ranges).toEqual([]);
    expect(service.analyze(malformed).ranges).toEqual([]);
    expect(service.analyze(nonmonotonic).ranges).toEqual([]);
  });

  it("does not treat one giant wick as support", () => {
    const candles = oscillation().map((item) => ({ ...item }));
    candles[10] = candle(10, 100, { high: 101, low: 40 });

    const result = new ReboundZoneService().analyze(candles);
    expect(result.ranges.every((range) => range.lowPrice > 50)).toBe(true);
  });
});
