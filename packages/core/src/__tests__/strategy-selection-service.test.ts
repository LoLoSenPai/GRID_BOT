import { describe, expect, it } from "vitest";

import type { RangePlanDecision, StrategySelectionInput } from "../domain/types";
import { GridType } from "../domain/enums";
import { StrategySelectionService } from "../services/strategy-selection-service";

const baseRangePlan: RangePlanDecision = {
  recommendedLowPrice: 80,
  recommendedHighPrice: 88,
  recommendedLevelCount: 11,
  recommendedGridType: GridType.Arithmetic,
  widthPct: 10,
  stepPct: 1,
  basis: "donchian",
  confidence: 0.72,
  risk: "low",
  operatorAction: "Use this as a candidate.",
  reasons: []
};

function buildInput(overrides: Partial<StrategySelectionInput> = {}): StrategySelectionInput {
  return {
    marketRegime: {
      regime: "RANGE",
      confidence: 0.8,
      scores: { range: 5, trendUp: 1, trendDown: 0, chaoticHighVol: 0 },
      reasons: ["Range conditions."],
      evaluatedAt: new Date("2026-01-01T00:00:00Z")
    },
    rangePlan: baseRangePlan,
    validationMetrics: {
      timeInRangePct: 84,
      timeOutOfRangePct: 16,
      maxOccupancyPct: 64,
      maxDrawdownPct: 4,
      closedCycleCount: 12
    },
    ...overrides
  };
}

describe("StrategySelectionService", () => {
  it("selects active range grid when regime and validation are range-friendly", () => {
    const decision = new StrategySelectionService().select(buildInput());

    expect(decision.recommendedFamily).toBe("range_grid");
    expect(decision.activeLiveFamily).toBe("range_grid");
    expect(decision.posture).toBe("active");
    expect(decision.candidates[0]?.family).toBe("range_grid");
    expect(decision.candidates[0]?.readiness).toBe("live_ready");
    expect(decision.registry.find((strategy) => strategy.family === "range_grid")?.liveEnabled).toBe(true);
  });

  it("moves to capital defense in chaotic high volatility", () => {
    const decision = new StrategySelectionService().select(
      buildInput({
        marketRegime: {
          regime: "CHAOTIC_HIGH_VOL",
          confidence: 0.74,
          scores: { range: 1, trendUp: 1, trendDown: 1, chaoticHighVol: 5 },
          reasons: ["High volatility."],
          evaluatedAt: new Date("2026-01-01T00:00:00Z")
        },
        rangePlan: {
          ...baseRangePlan,
          risk: "high",
          widthPct: 30
        },
        validationMetrics: {
          timeInRangePct: 42,
          timeOutOfRangePct: 58,
          maxOccupancyPct: 98,
          maxDrawdownPct: 14,
          closedCycleCount: 2
        }
      })
    );

    expect(decision.recommendedFamily).toBe("capital_defense");
    expect(decision.activeLiveFamily).toBe("range_grid");
    expect(decision.posture).toBe("pause");
    expect(decision.candidates.find((candidate) => candidate.family === "capital_defense")?.readiness).toBe("advisory_only");
  });

  it("marks trend following as watch-only because live trend strategy is not implemented", () => {
    const decision = new StrategySelectionService().select(
      buildInput({
        marketRegime: {
          regime: "TREND_UP",
          confidence: 0.85,
          scores: { range: 1, trendUp: 6, trendDown: 0, chaoticHighVol: 1 },
          reasons: ["EMA slope up."],
          evaluatedAt: new Date("2026-01-01T00:00:00Z")
        },
        rangePlan: {
          ...baseRangePlan,
          risk: "medium"
        },
        validationMetrics: {
          timeInRangePct: 55,
          timeOutOfRangePct: 45,
          maxOccupancyPct: 78,
          maxDrawdownPct: 5,
          closedCycleCount: 4
        }
      })
    );

    expect(decision.recommendedFamily).toBe("trend_following");
    expect(decision.activeLiveFamily).toBe("range_grid");
    expect(decision.posture).toBe("watch");
    expect(decision.operatorAction).toContain("not live-ready");
    expect(decision.candidates.find((candidate) => candidate.family === "trend_following")?.liveEnabled).toBe(false);
  });
});
