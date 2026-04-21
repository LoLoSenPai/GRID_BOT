import type { ExecuteSwapParams, ExecutionEstimate, ExecutionQuote, ExecutionReport } from "../domain/types";

export interface ExecutionAdapter {
  getQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<ExecutionQuote>;
  estimateExecution(params: ExecuteSwapParams): Promise<ExecutionEstimate>;
  prepareExecution?(params: ExecuteSwapParams): Promise<ExecutionEstimate>;
  executeSwap(params: ExecuteSwapParams): Promise<ExecutionReport>;
  executePreparedSwap?(params: ExecuteSwapParams, preparedExecution: ExecutionEstimate): Promise<ExecutionReport>;
  getExecutionReport(id: string): Promise<ExecutionReport | null>;
}
