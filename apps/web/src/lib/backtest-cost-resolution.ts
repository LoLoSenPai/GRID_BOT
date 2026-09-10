import type { BacktestExecutionCostSource } from "@grid-bot/core";

import type {
  BacktestExecutionCostCalibration,
  BacktestExecutionCostResolution
} from "./backtest-execution-cost";
import type { BacktestExecutionCostMode } from "./backtest-lab";

export function resolveExecutionCosts<
  T extends {
    maxSlippageBps: number;
    executionFeeBps?: number;
    executionCostSource?: BacktestExecutionCostSource;
  }
>(
  config: T,
  calibration: BacktestExecutionCostCalibration,
  requestedMode: BacktestExecutionCostMode
): { config: T; resolution: BacktestExecutionCostResolution } {
  const appliedConfig = requestedMode === "calibrated"
    ? {
        ...config,
        maxSlippageBps: calibration.maxSlippageBps,
        executionFeeBps: calibration.executionFeeBps,
        executionCostSource: calibration.source
      }
    : {
        ...config,
        maxSlippageBps: config.maxSlippageBps,
        executionFeeBps: config.executionFeeBps ?? 10,
        executionCostSource: "fixed_pessimistic" as const
      };

  return {
    config: appliedConfig,
    resolution: {
      requestedMode,
      calibratedBase: calibration,
      applied: {
        mode: requestedMode,
        source: appliedConfig.executionCostSource ?? "fixed_pessimistic",
        maxSlippageBps: appliedConfig.maxSlippageBps,
        executionFeeBps: appliedConfig.executionFeeBps ?? 10
      }
    }
  };
}
