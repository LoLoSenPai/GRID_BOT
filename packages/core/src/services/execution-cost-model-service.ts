import { TradeSide } from "../domain/enums";
import type { ExecutionCostModelInput, ExecutionCostModelReport } from "../domain/types";
import { round } from "../utils/math";

export const DEFAULT_EXECUTION_FEE_BPS = 10;

export class ExecutionCostModelService {
  simulate(input: ExecutionCostModelInput): ExecutionCostModelReport {
    const levelPrice = assertPositive(input.levelPrice, "levelPrice");
    const maxSlippageBps = Math.max(0, input.maxSlippageBps);
    const executionFeeBps = Math.max(0, input.executionFeeBps ?? DEFAULT_EXECUTION_FEE_BPS);
    const fillPrice =
      input.side === TradeSide.Buy
        ? round(levelPrice * (1 + maxSlippageBps / 10_000), 8)
        : round(levelPrice * (1 - maxSlippageBps / 10_000), 8);

    if (input.side === TradeSide.Buy) {
      const inputAmount = assertPositive(input.requestedQuoteAmount, "requestedQuoteAmount");
      const outputAmount = round(inputAmount / fillPrice, 8);
      return {
        side: input.side,
        fillPrice,
        inputAmount,
        outputAmount,
        feeAmount: round((inputAmount * executionFeeBps) / 10_000, 8),
        maxSlippageBps,
        executionFeeBps
      };
    }

    const inputAmount = assertPositive(input.requestedBaseAmount, "requestedBaseAmount");
    const outputAmount = round(inputAmount * fillPrice, 8);
    return {
      side: input.side,
      fillPrice,
      inputAmount,
      outputAmount,
      feeAmount: round((outputAmount * executionFeeBps) / 10_000, 8),
      maxSlippageBps,
      executionFeeBps
    };
  }
}

function assertPositive(value: number | null | undefined, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }

  return value;
}
