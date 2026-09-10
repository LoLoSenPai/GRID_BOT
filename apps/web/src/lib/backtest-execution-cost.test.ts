import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionStatus, TradeSide } from "@grid-bot/core/enums";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@grid-bot/db", () => ({
  prisma: { execution: { findMany: mocks.findMany } }
}));

import { fetchExecutionCostCalibration } from "./backtest-execution-cost";

function fill(side: TradeSide, adverseSlippageBps: number) {
  const targetPrice = 100;
  const effectivePrice = side === TradeSide.Buy
    ? targetPrice * (1 + adverseSlippageBps / 10_000)
    : targetPrice * (1 - adverseSlippageBps / 10_000);
  const inputAmount = side === TradeSide.Buy ? effectivePrice : 1;
  const outputAmount = side === TradeSide.Buy ? 1 : effectivePrice;
  const quoteNotional = side === TradeSide.Buy ? inputAmount : outputAmount;

  return {
    quotePrice: targetPrice,
    executedInputAmount: inputAmount,
    executedOutputAmount: outputAmount,
    executedFeeAmount: quoteNotional * 0.002,
    order: { side, targetPrice },
    bot: { baseSymbol: "SOL", quoteSymbol: "USDC" }
  };
}

describe("execution-cost calibration", () => {
  beforeEach(() => mocks.findMany.mockReset());

  it("queries resolved fills only and does not clip adverse quantiles", async () => {
    mocks.findMany.mockResolvedValue([
      ...Array.from({ length: 10 }, (_, index) => fill(TradeSide.Buy, 60 + index * 10)),
      ...Array.from({ length: 10 }, (_, index) => fill(TradeSide.Sell, 70 + index * 10))
    ]);

    const result = await fetchExecutionCostCalibration({ pair: "SOL", lookbackDays: 30 });

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: ExecutionStatus.Filled })
    }));
    expect(result.calibrationStatus).toBe("calibrated");
    expect(result.p90AdverseSlippageBps).toBeGreaterThan(100);
    expect(result.maxSlippageBps).toBeGreaterThan(100);
    expect(result.executionFeeBps).toBe(20);
  });

  it("uses explicit fallback costs and null observations when there are no resolved fills", async () => {
    mocks.findMany.mockResolvedValue([]);

    const result = await fetchExecutionCostCalibration({ pair: "SOL", lookbackDays: 30 });

    expect(result).toMatchObject({
      calibrationStatus: "insufficient_filled_samples",
      source: "fixed_pessimistic",
      maxSlippageBps: 50,
      executionFeeBps: 10,
      p90AdverseSlippageBps: null,
      averageFeeBps: null
    });
    expect(result.reasons).not.toHaveLength(0);
  });
});
