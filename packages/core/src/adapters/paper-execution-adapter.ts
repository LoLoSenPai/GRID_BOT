import { ExecutionProvider, ExecutionStatus } from "../domain/enums";
import type { ExecuteSwapParams, ExecutionEstimate, ExecutionQuote, ExecutionReport } from "../domain/types";
import type { ExecutionAdapter } from "./execution-adapter";

export const PAPER_EXECUTION_FEE_RATE = 0.001;

export class PaperExecutionAdapter implements ExecutionAdapter {
  private readonly reports = new Map<string, ExecutionReport>();
  private readonly feeRate = PAPER_EXECUTION_FEE_RATE;

  async getQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<ExecutionQuote> {
    return {
      provider: ExecutionProvider.Paper,
      inputMint,
      outputMint,
      inputAmount: amount,
      expectedOutputAmount: amount * (1 - slippageBps / 10_000),
      estimatedFeeAmount: amount * this.feeRate,
      priceImpactPct: slippageBps / 10_000,
      rawQuote: { mode: "paper" }
    };
  }

  async estimateExecution(params: ExecuteSwapParams): Promise<ExecutionEstimate> {
    const { outputAmount, feeAmount, effectivePrice } = this.calculateExecution(params);
    return {
      provider: ExecutionProvider.Paper,
      inputMint: params.inputMint, outputMint: params.outputMint, inputAmount: params.amount,
      expectedOutputAmount: outputAmount, estimatedFeeAmount: feeAmount,
      expectedPrice: effectivePrice, priceImpactPct: params.slippageBps / 10_000,
      rawQuote: { mode: "paper", referencePrice: params.referencePrice }
    };
  }

  async executeSwap(params: ExecuteSwapParams): Promise<ExecutionReport> {
    const { outputAmount, feeAmount, effectivePrice } = this.calculateExecution(params);
    const executionId = `paper-${params.clientOrderId}`;
    const report: ExecutionReport = {
      provider: ExecutionProvider.Paper,
      status: ExecutionStatus.Simulated,
      executionId,
      txId: executionId,
      inputAmount: params.amount,
      outputAmount,
      effectivePrice,
      feeAmount,
      rawReport: {
        simulatedAt: new Date().toISOString(),
        referencePrice: params.referencePrice
      }
    };
    this.reports.set(executionId, report);
    return report;
  }

  private calculateExecution(params: ExecuteSwapParams) {
    if (!params.referencePrice || params.referencePrice <= 0) {
      throw new Error("Paper execution requires a positive referencePrice.");
    }

    const slippageRatio = 1 - params.slippageBps / 10_000;
    const isBuy = params.tradeSide === "buy";
    const outputAmount =
      isBuy
        ? round((params.amount / params.referencePrice) * slippageRatio, 8)
        : round(params.amount * params.referencePrice * slippageRatio, 8);
    const feeAmount =
      isBuy
        ? round(params.amount * this.feeRate, 8)
        : round(params.amount * params.referencePrice * this.feeRate, 8);
    return {
      outputAmount,
      effectivePrice:
        isBuy
          ? round(params.amount / Math.max(outputAmount, Number.EPSILON), 8)
          : round(outputAmount / Math.max(params.amount, Number.EPSILON), 8),
      feeAmount
    };
  }

  async getExecutionReport(id: string): Promise<ExecutionReport | null> {
    return this.reports.get(id) ?? null;
  }
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
