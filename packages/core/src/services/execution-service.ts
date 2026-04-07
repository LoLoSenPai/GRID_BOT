import { BotMode, ExecutionProvider } from "../domain/enums";
import type { ExecuteSwapParams, ExecutionEstimate, ExecutionQuote } from "../domain/types";
import type { ExecutionAdapter } from "../adapters/execution-adapter";
import type { Bot } from "../domain/types";

export class ExecutionService {
  constructor(
    private readonly adapters: Record<ExecutionProvider, ExecutionAdapter>,
    private readonly liveTradingEnabled: boolean
  ) {}

  getAdapter(bot: Bot): ExecutionAdapter {
    if (bot.mode === BotMode.Paper) {
      return this.adapters[ExecutionProvider.Paper];
    }

    if (!this.liveTradingEnabled) {
      throw new Error("Live trading is globally disabled.");
    }

    return this.adapters[bot.executionProvider];
  }

  async getQuote(bot: Bot, inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<ExecutionQuote> {
    return this.getAdapter(bot).getQuote(inputMint, outputMint, amount, slippageBps);
  }

  async estimateExecution(bot: Bot, params: ExecuteSwapParams): Promise<ExecutionEstimate> {
    return this.getAdapter(bot).estimateExecution(params);
  }

  async executeSwap(bot: Bot, params: ExecuteSwapParams) {
    return this.getAdapter(bot).executeSwap(params);
  }
}
