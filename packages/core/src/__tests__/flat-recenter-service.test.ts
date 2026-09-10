import { describe, expect, it } from "vitest";

import { evaluateFlatRecenter, type FlatRecenterInput } from "../services/flat-recenter-service";

const now = new Date("2026-09-10T12:00:00.000Z");
const firstSource = "2026-09-10T11:59:00.000Z";

function input(overrides: Partial<FlatRecenterInput> = {}): FlatRecenterInput {
  return {
    lowPrice: 100,
    highPrice: 110,
    currentPrice: 120,
    now,
    confirmationMs: 30_000,
    outsideSince: "2026-09-10T11:59:00.000Z",
    outsideSide: "above",
    outsideSourceObservedAt: firstSource,
    currentObservationId: "2026-09-10T12:00:00.000Z",
    requireSourceAdvance: true,
    lastRecenterAt: null,
    recenterHistory: [],
    minIntervalMs: 0,
    maxPerDay: 2,
    openTradingLotCount: 0,
    ...overrides
  };
}

describe("evaluateFlatRecenter", () => {
  it("requires the minimum 30-second confirmation window", () => {
    const result = evaluateFlatRecenter(input({
      outsideSince: new Date(now.getTime() - 29_999).toISOString(),
      outsideSourceObservedAt: firstSource,
      currentObservationId: now.toISOString()
    }));
    expect(result.action).toBe("wait");
    expect(result.reason).toMatch(/confirmation window/i);
  });

  it("starts a timer on the first outside observation", () => {
    const result = evaluateFlatRecenter(input({ outsideSince: null, outsideSide: null, outsideSourceObservedAt: null }));
    expect(result.action).toBe("wait");
    expect(result.outsideSince).toBe(now.toISOString());
    expect(result.outsideSide).toBe("above");
    expect(result.outsideSourceObservedAt).toBe(now.toISOString());
  });

  it("requires a distinct second source observation for live recenter", () => {
    const result = evaluateFlatRecenter(input({ currentObservationId: firstSource }));
    expect(result.action).toBe("wait");
    expect(result.reason).toMatch(/distinct fresh source/i);
  });

  it("does not require source advancement for a synthetic or paper caller", () => {
    const result = evaluateFlatRecenter(input({
      requireSourceAdvance: false,
      currentObservationId: firstSource,
      outsideSourceObservedAt: firstSource
    }));
    expect(result.action).toBe("recenter");
    expect(result.suggestedLowPrice).toBe(113.5);
    expect(result.suggestedHighPrice).toBe(123.5);
  });

  it("resets confirmation metadata when price returns inside", () => {
    const result = evaluateFlatRecenter(input({ currentPrice: 105 }));
    expect(result.action).toBe("inside");
    expect(result.side).toBeNull();
    expect(result.outsideSince).toBeNull();
    expect(result.outsideSide).toBeNull();
    expect(result.outsideSourceObservedAt).toBeNull();
  });

  it("resets the timer and source baseline when the breakout side flips", () => {
    const result = evaluateFlatRecenter(input({
      currentPrice: 90,
      outsideSide: "above",
      outsideSince: "2026-09-10T11:00:00.000Z",
      outsideSourceObservedAt: firstSource,
      currentObservationId: now.toISOString()
    }));
    expect(result.action).toBe("wait");
    expect(result.side).toBe("below");
    expect(result.outsideSince).toBe(now.toISOString());
    expect(result.outsideSourceObservedAt).toBe(now.toISOString());
  });

  it("holds while a trading lot remains open, after confirmation", () => {
    const result = evaluateFlatRecenter(input({ openTradingLotCount: 1 }));
    expect(result.action).toBe("hold_inventory");
    expect(result.reason).toMatch(/trading inventory/i);
  });

  it("allows the caller to recenter when only retained inventory remains", () => {
    const result = evaluateFlatRecenter(input({ openTradingLotCount: 0 }));
    expect(result.action).toBe("recenter");
  });

  it("holds when execution remains unresolved", () => {
    const result = evaluateFlatRecenter(input({ unresolvedExecution: true }));
    expect(result.action).toBe("hold_inventory");
    expect(result.reason).toMatch(/unresolved execution/i);
  });

  it("applies the cooldown and daily cap", () => {
    const cooldown = evaluateFlatRecenter(input({
      lastRecenterAt: new Date(now.getTime() - 1_000),
      minIntervalMs: 10_000
    }));
    expect(cooldown.action).toBe("rate_limited");

    const dailyCap = evaluateFlatRecenter(input({
      recenterHistory: ["2026-09-10T09:00:00.000Z", "2026-09-10T10:00:00.000Z"],
      maxPerDay: 2
    }));
    expect(dailyCap.action).toBe("rate_limited");
  });

  it("refuses malformed ranges and timestamps without throwing", () => {
    expect(evaluateFlatRecenter(input({ lowPrice: 0 })).action).toBe("wait");
    expect(evaluateFlatRecenter(input({ outsideSince: "not-a-date" })).action).toBe("wait");
    expect(evaluateFlatRecenter(input({ lastRecenterAt: new Date(Number.NaN) })).action).toBe("wait");
  });
});
