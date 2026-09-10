import { describe, expect, it } from "vitest";

import { ExecutionStatus, TradeSide } from "../domain/enums";
import { PaperExecutionAdapter } from "../adapters/paper-execution-adapter";

describe("PaperExecutionAdapter", () => {
  it.each([TradeSide.Buy, TradeSide.Sell])("estimates the same quantities, price and quote fees as a %s fill", async (tradeSide) => {
    const adapter = new PaperExecutionAdapter();
    const params = { botId: "bot", inputMint: tradeSide === TradeSide.Buy ? "USDC" : "SOL",
      outputMint: tradeSide === TradeSide.Buy ? "SOL" : "USDC", amount: tradeSide === TradeSide.Buy ? 200 : 1.8,
      tradeSide, inputDecimals: 6, outputDecimals: 9, slippageBps: 50, clientOrderId: "quote-parity", referencePrice: 121 };
    const estimate = await adapter.estimateExecution(params);
    const report = await adapter.executeSwap(params);
    expect(estimate.expectedOutputAmount).toBe(report.outputAmount);
    expect(estimate.estimatedFeeAmount).toBe(report.feeAmount);
    expect(estimate.expectedPrice).toBe(report.effectivePrice);
    expect(estimate.estimatedFeeAmount).toBeCloseTo(tradeSide === TradeSide.Buy ? 0.2 : 0.2178, 8);
  });
  it("simulates a buy execution report using the reference price", async () => {
    const adapter = new PaperExecutionAdapter();
    const report = await adapter.executeSwap({
      botId: "bot",
      inputMint: "USDC",
      outputMint: "SOL",
      amount: 100,
      tradeSide: TradeSide.Buy,
      inputDecimals: 6,
      outputDecimals: 9,
      slippageBps: 50,
      clientOrderId: "order-1",
      referencePrice: 100
    });
    expect(report.status).toBe(ExecutionStatus.Simulated);
    expect(report.outputAmount).toBeCloseTo(0.995, 6);
    expect(report.feeAmount).toBeCloseTo(0.1, 6);
  });

  it("simulates a sell execution report using the reference price", async () => {
    const adapter = new PaperExecutionAdapter();
    const report = await adapter.executeSwap({
      botId: "bot",
      inputMint: "SOL",
      outputMint: "USDC",
      amount: 1,
      tradeSide: TradeSide.Sell,
      inputDecimals: 9,
      outputDecimals: 6,
      slippageBps: 50,
      clientOrderId: "order-2",
      referencePrice: 100
    });

    expect(report.status).toBe(ExecutionStatus.Simulated);
    expect(report.outputAmount).toBeCloseTo(99.5, 6);
    expect(report.feeAmount).toBeCloseTo(0.1, 6);
  });
});
