import { describe, expect, it } from "vitest";

import { resolveExecutionCosts } from "./backtest-cost-resolution";
import type { BacktestExecutionCostCalibration } from "./backtest-execution-cost";

const calibration: BacktestExecutionCostCalibration = {
  pair: "SOL",
  source: "calibrated_live_fills",
  calibrationStatus: "calibrated",
  reasons: [],
  sampleSize: 30,
  buySampleSize: 15,
  sellSampleSize: 15,
  feeSampleSize: 30,
  maxSlippageBps: 84,
  executionFeeBps: 17,
  averageAdverseSlippageBps: 28,
  p50AdverseSlippageBps: 25,
  p75AdverseSlippageBps: 50,
  p90AdverseSlippageBps: 82,
  maxAdverseSlippageBps: 140,
  averageFeeBps: 12,
  lookbackDays: 30
};

describe("resolveExecutionCosts", () => {
  it("applies the calibrated base only when calibration is requested", () => {
    const result = resolveExecutionCosts({ maxSlippageBps: 120, executionFeeBps: 25 }, calibration, "calibrated");

    expect(result.config).toMatchObject({
      maxSlippageBps: 84,
      executionFeeBps: 17,
      executionCostSource: "calibrated_live_fills"
    });
    expect(result.resolution.applied).toEqual({
      mode: "calibrated",
      source: "calibrated_live_fills",
      maxSlippageBps: 84,
      executionFeeBps: 17
    });
  });

  it("preserves explicit stress costs and reports what the server applied", () => {
    const result = resolveExecutionCosts({ maxSlippageBps: 180, executionFeeBps: 42 }, calibration, "stress");

    expect(result.config).toMatchObject({
      maxSlippageBps: 180,
      executionFeeBps: 42,
      executionCostSource: "fixed_pessimistic"
    });
    expect(result.resolution.calibratedBase).toBe(calibration);
    expect(result.resolution.applied).toEqual({
      mode: "stress",
      source: "fixed_pessimistic",
      maxSlippageBps: 180,
      executionFeeBps: 42
    });
  });
});
