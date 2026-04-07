import { describe, expect, it, vi } from "vitest";

import type { ExecutionAdapter } from "../adapters/execution-adapter";
import { BotMode, BotStatus, ExecutionProvider, ExecutionStatus, StrategyMode } from "../domain/enums";
import type { Bot, ExecuteSwapParams } from "../domain/types";
import { ExecutionService } from "../services/execution-service";

function createAdapter(name: string): ExecutionAdapter {
  return {
    getQuote: vi.fn(async () => ({
      provider: ExecutionProvider.Paper,
      inputMint: "USDC",
      outputMint: "SOL",
      inputAmount: 100,
      expectedOutputAmount: 1,
      estimatedFeeAmount: 0.1,
      priceImpactPct: 0.01,
      requestId: `${name}-quote`
    })),
    estimateExecution: vi.fn(async () => ({
      provider: ExecutionProvider.Paper,
      inputMint: "USDC",
      outputMint: "SOL",
      inputAmount: 100,
      expectedOutputAmount: 1,
      estimatedFeeAmount: 0.1,
      priceImpactPct: 0.01,
      expectedPrice: 100,
      requestId: `${name}-estimate`
    })),
    executeSwap: vi.fn(async () => ({
      provider: ExecutionProvider.Paper,
      status: ExecutionStatus.Simulated,
      executionId: `${name}-exec`,
      txId: null,
      inputAmount: 100,
      outputAmount: 1,
      effectivePrice: 100,
      feeAmount: 0.1
    })),
    getExecutionReport: vi.fn(async (executionId: string) => ({
      provider: ExecutionProvider.Paper,
      status: ExecutionStatus.Simulated,
      executionId,
      txId: null,
      inputAmount: 100,
      outputAmount: 1,
      effectivePrice: 100,
      feeAmount: 0.1
    }))
  };
}

const paperBot: Bot = {
  id: "bot-paper",
  key: "paper",
  name: "Paper bot",
  baseMint: "SOL",
  quoteMint: "USDC",
  baseSymbol: "SOL",
  quoteSymbol: "USDC",
  baseDecimals: 9,
  quoteDecimals: 6,
  strategyMode: StrategyMode.Balanced,
  mode: BotMode.Paper,
  status: BotStatus.Running,
  executionProvider: ExecutionProvider.Jupiter,
  currentPrice: 120
};

const liveBot: Bot = {
  ...paperBot,
  id: "bot-live",
  key: "live",
  mode: BotMode.Live
};

const params: ExecuteSwapParams = {
  botId: "bot",
  inputMint: "USDC",
  outputMint: "SOL",
  amount: 100,
  inputDecimals: 6,
  outputDecimals: 9,
  slippageBps: 50,
  clientOrderId: "order-1"
};

describe("ExecutionService", () => {
  it("routes paper bots to the paper adapter", async () => {
    const paperAdapter = createAdapter("paper");
    const jupiterAdapter = createAdapter("jupiter");
    const service = new ExecutionService(
      {
        [ExecutionProvider.Paper]: paperAdapter,
        [ExecutionProvider.Jupiter]: jupiterAdapter,
        [ExecutionProvider.Dflow]: createAdapter("dflow")
      },
      false
    );

    const report = await service.executeSwap(paperBot, params);

    expect(report.executionId).toBe("paper-exec");
    expect(paperAdapter.executeSwap).toHaveBeenCalledOnce();
    expect(jupiterAdapter.executeSwap).not.toHaveBeenCalled();
  });

  it("blocks live execution when the global live flag is disabled", async () => {
    const service = new ExecutionService(
      {
        [ExecutionProvider.Paper]: createAdapter("paper"),
        [ExecutionProvider.Jupiter]: createAdapter("jupiter"),
        [ExecutionProvider.Dflow]: createAdapter("dflow")
      },
      false
    );

    await expect(service.executeSwap(liveBot, params)).rejects.toThrow("Live trading is globally disabled.");
  });
});
