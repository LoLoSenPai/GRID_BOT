import { describe, expect, it } from "vitest";

import { GridType } from "../domain/enums";
import type { IndicatorSnapshot, MarketRegimeAssessment, RangePlanInput } from "../domain/types";
import { RangePlanService } from "../services/range-plan-service";

const service = new RangePlanService();

function indicators(overrides: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    timestamp: new Date("2026-04-18T00:00:00.000Z"),
    close: 100,
    ema20: 99,
    ema50: 98,
    ema200: 95,
    atr14: 1,
    atrPct14: 1,
    adx14: 14,
    bollingerWidth20: 6,
    donchianHigh20: 104,
    donchianLow20: 96,
    donchianWidthPct20: 8,
    realizedVol20: 0.8,
    volumeSma20: null,
    volumeRatio20: null,
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

function input(overrides: Partial<RangePlanInput> = {}): RangePlanInput {
  return {
    currentPrice: 100,
    currentLowPrice: 94,
    currentHighPrice: 106,
    currentLevelCount: 9,
    budgetUsd: 120,
    minOrderQuoteAmount: 12,
    indicators: indicators(),
    marketRegime: regime("RANGE"),
    ...overrides
  };
}

describe("RangePlanService", () => {
  it("derives a range plan from range-friendly indicators", () => {
    const plan = service.plan(input());

    expect(plan.risk).toBe("low");
    expect(plan.basis).toBe("donchian");
    expect(plan.recommendedLowPrice).toBeLessThan(100);
    expect(plan.recommendedHighPrice).toBeGreaterThan(100);
    expect(plan.recommendedLevelCount).toBeGreaterThanOrEqual(5);
    expect(plan.recommendedGridType).toBe(GridType.Arithmetic);
    expect(plan.reasons.join(" ")).toMatch(/RANGE|rails|Spacing/);
  });

  it("skews the range upward during an uptrend", () => {
    const plan = service.plan(
      input({
        marketRegime: regime("TREND_UP"),
        indicators: indicators({ atrPct14: 1.4, donchianWidthPct20: 12 })
      })
    );

    const distanceBelow = 100 - plan.recommendedLowPrice;
    const distanceAbove = plan.recommendedHighPrice - 100;

    expect(plan.risk).toBe("medium");
    expect(distanceBelow).toBeGreaterThan(distanceAbove);
  });

  it("marks chaotic high volatility as high risk and does not overstate confidence", () => {
    const plan = service.plan(
      input({
        marketRegime: regime("CHAOTIC_HIGH_VOL", 0.9),
        indicators: indicators({ atrPct14: 4, bollingerWidth20: 20, donchianWidthPct20: 22 })
      })
    );

    expect(plan.risk).toBe("high");
    expect(plan.widthPct).toBeLessThanOrEqual(35);
    expect(plan.confidence).toBeLessThan(0.8);
    expect(plan.operatorAction).toMatch(/Do not auto-recenter/i);
  });

  it("falls back to the current range without usable price data", () => {
    const plan = service.plan(input({ currentPrice: 0, indicators: null, marketRegime: null }));

    expect(plan.risk).toBe("high");
    expect(plan.basis).toBe("current_range");
    expect(plan.recommendedLowPrice).toBe(94);
    expect(plan.recommendedHighPrice).toBe(106);
  });
});
