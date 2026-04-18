import { describe, expect, it } from "vitest";

import type { MarketRegimeAssessment, RecenterPolicyInput } from "../domain/types";
import { RecenterPolicyService } from "../services/recenter-policy-service";

const service = new RecenterPolicyService();

function input(overrides: Partial<RecenterPolicyInput> = {}): RecenterPolicyInput {
  return {
    currentPrice: 105,
    lowPrice: 100,
    highPrice: 110,
    openCycleCount: 0,
    maxOccupancyPct: 30,
    consecutiveOutsideBars: 0,
    ...overrides
  };
}

function regime(regime: MarketRegimeAssessment["regime"], confidence = 0.8): MarketRegimeAssessment {
  return {
    regime,
    confidence,
    scores: {
      range: regime === "RANGE" ? 4 : 0,
      trendUp: regime === "TREND_UP" ? 4 : 0,
      trendDown: regime === "TREND_DOWN" ? 4 : 0,
      chaoticHighVol: regime === "CHAOTIC_HIGH_VOL" ? 4 : 0
    },
    reasons: [],
    evaluatedAt: new Date("2026-04-18T00:00:00.000Z")
  };
}

describe("RecenterPolicyService", () => {
  it("keeps the grid untouched while price is inside the range", () => {
    const decision = service.evaluate(input());

    expect(decision.mode).toBe("none");
    expect(decision.side).toBe("inside");
    expect(decision.allowNewBuys).toBe(true);
    expect(decision.allowRecoverySells).toBe(true);
    expect(decision.risk).toBe("low");
  });

  it("uses soft defense on the first outside bar", () => {
    const decision = service.evaluate(input({ currentPrice: 112, consecutiveOutsideBars: 1 }));

    expect(decision.mode).toBe("soft");
    expect(decision.side).toBe("above");
    expect(decision.allowNewBuys).toBe(false);
    expect(decision.allowRecoverySells).toBe(true);
    expect(decision.suggestedLowPrice).toBeNull();
  });

  it("uses hybrid recenter when open cycles still need exits", () => {
    const decision = service.evaluate(
      input({
        currentPrice: 116,
        openCycleCount: 2,
        consecutiveOutsideBars: 2,
        marketRegime: regime("TREND_UP")
      })
    );

    expect(decision.mode).toBe("hybrid");
    expect(decision.allowNewBuys).toBe(false);
    expect(decision.allowRecoverySells).toBe(true);
    expect(decision.suggestedLowPrice).toBeGreaterThan(100);
    expect(decision.suggestedHighPrice).toBeGreaterThan(110);
    expect(decision.operatorAction).toMatch(/free rails/i);
  });

  it("avoids shifting the range during chaotic high volatility", () => {
    const decision = service.evaluate(
      input({
        currentPrice: 116,
        consecutiveOutsideBars: 3,
        marketRegime: regime("CHAOTIC_HIGH_VOL")
      })
    );

    expect(decision.mode).toBe("soft");
    expect(decision.risk).toBe("high");
    expect(decision.allowNewBuys).toBe(false);
    expect(decision.allowRecoverySells).toBe(true);
  });

  it("recommends a hard recreate only after a confirmed directional breakout with no open cycle", () => {
    const decision = service.evaluate(
      input({
        currentPrice: 116,
        consecutiveOutsideBars: 3,
        openCycleCount: 0,
        marketRegime: regime("TREND_UP")
      })
    );

    expect(decision.mode).toBe("hard");
    expect(decision.allowNewBuys).toBe(false);
    expect(decision.allowRecoverySells).toBe(false);
    expect(decision.suggestedLowPrice).toBeGreaterThan(100);
  });

  it("does not recommend a full range move when occupancy is saturated", () => {
    const decision = service.evaluate(
      input({
        currentPrice: 95,
        consecutiveOutsideBars: 3,
        maxOccupancyPct: 98,
        marketRegime: regime("TREND_DOWN")
      })
    );

    expect(decision.mode).toBe("soft");
    expect(decision.side).toBe("below");
    expect(decision.risk).toBe("high");
    expect(decision.allowRecoverySells).toBe(true);
  });
});
