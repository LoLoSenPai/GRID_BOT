import { describe, expect, it } from "vitest";

import { TradeSide } from "../domain/enums";
import { DEFAULT_EXECUTION_FEE_BPS, ExecutionCostModelService } from "../services/execution-cost-model-service";

const service = new ExecutionCostModelService();

describe("ExecutionCostModelService", () => {
  it("applies pessimistic buy slippage and quote-denominated fees", () => {
    const report = service.simulate({
      side: TradeSide.Buy,
      levelPrice: 100,
      requestedQuoteAmount: 10,
      maxSlippageBps: 50,
      executionFeeBps: 100
    });

    expect(report.fillPrice).toBe(100.5);
    expect(report.inputAmount).toBe(10);
    expect(report.outputAmount).toBeCloseTo(0.09950249, 8);
    expect(report.feeAmount).toBe(0.1);
  });

  it("applies pessimistic sell slippage and quote-output fees", () => {
    const report = service.simulate({
      side: TradeSide.Sell,
      levelPrice: 100,
      requestedBaseAmount: 0.2,
      maxSlippageBps: 50,
      executionFeeBps: 100
    });

    expect(report.fillPrice).toBe(99.5);
    expect(report.inputAmount).toBe(0.2);
    expect(report.outputAmount).toBe(19.9);
    expect(report.feeAmount).toBe(0.199);
  });

  it("uses the default execution fee when not provided", () => {
    const report = service.simulate({
      side: TradeSide.Buy,
      levelPrice: 100,
      requestedQuoteAmount: 10,
      maxSlippageBps: 0
    });

    expect(report.executionFeeBps).toBe(DEFAULT_EXECUTION_FEE_BPS);
    expect(report.feeAmount).toBe(0.01);
  });

  it("rejects invalid requested amounts", () => {
    expect(() =>
      service.simulate({
        side: TradeSide.Sell,
        levelPrice: 100,
        requestedBaseAmount: 0,
        maxSlippageBps: 0
      })
    ).toThrow("requestedBaseAmount must be a positive number.");
  });
});
