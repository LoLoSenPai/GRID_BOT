import { ExecutionProvider } from "../domain/enums";
import type { ExecuteSwapParams, ExecutionEstimate, ExecutionQuote, ExecutionReport } from "../domain/types";
import type { ExecutionAdapter } from "./execution-adapter";

export class DflowAdapter implements ExecutionAdapter {
  async getQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<ExecutionQuote> {
    return {
      provider: ExecutionProvider.Dflow,
      inputMint,
      outputMint,
      inputAmount: amount,
      expectedOutputAmount: amount,
      estimatedFeeAmount: 0,
      priceImpactPct: slippageBps / 10_000,
      rawQuote: { message: "DFlow is prepared but disabled in V1." }
    };
  }

  async estimateExecution(params: ExecuteSwapParams): Promise<ExecutionEstimate> {
    const quote = await this.getQuote(params.inputMint, params.outputMint, params.amount, params.slippageBps);
    return {
      ...quote,
      expectedPrice: quote.expectedOutputAmount === 0 ? 0 : params.amount / quote.expectedOutputAmount
    };
  }

  async executeSwap(): Promise<ExecutionReport> {
    throw new Error("DFlow execution is not enabled in V1.");
  }

  async getExecutionReport(): Promise<ExecutionReport | null> {
    return null;
  }
}
