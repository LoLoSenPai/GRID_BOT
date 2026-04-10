import { describe, expect, it } from "vitest";

import { calculateBudgetRoiPct } from "./bot-metrics";

describe("bot-metrics", () => {
  it("calculates ROI against total bot budget", () => {
    expect(calculateBudgetRoiPct(0.56, 70)).toBeCloseTo(0.8, 6);
  });

  it("returns zero when budget is missing or invalid", () => {
    expect(calculateBudgetRoiPct(1, 0)).toBe(0);
    expect(calculateBudgetRoiPct(1, Number.NaN)).toBe(0);
  });
});
