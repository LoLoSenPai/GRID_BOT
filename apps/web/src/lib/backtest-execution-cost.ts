import "server-only";

import { BotMode, ExecutionStatus, TradeSide } from "@grid-bot/core/enums";
import type { BacktestExecutionCostOverride, BacktestExecutionCostSource } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

import type { LabLookbackDays, LabPair } from "@/lib/backtest-lab";

const MAX_EXECUTION_SAMPLES = 500;
const MIN_CALIBRATION_SAMPLES = 5;

export type BacktestExecutionCostCalibration = BacktestExecutionCostOverride & {
  pair: LabPair;
  source: BacktestExecutionCostSource;
  sampleSize: number;
  buySampleSize: number;
  sellSampleSize: number;
  feeSampleSize: number;
  averageAdverseSlippageBps: number;
  p50AdverseSlippageBps: number;
  p75AdverseSlippageBps: number;
  p90AdverseSlippageBps: number;
  maxAdverseSlippageBps: number;
  averageFeeBps: number;
  lookbackDays: LabLookbackDays;
};

export async function fetchExecutionCostCalibration(input: {
  pair: LabPair;
  lookbackDays: LabLookbackDays;
}): Promise<BacktestExecutionCostCalibration> {
  const since = new Date(Date.now() - input.lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.execution.findMany({
    where: {
      mode: BotMode.Live as never,
      status: { in: [ExecutionStatus.Submitted, ExecutionStatus.Filled] as never },
      createdAt: { gte: since }
    },
    orderBy: { createdAt: "desc" },
    take: MAX_EXECUTION_SAMPLES,
    select: {
      quotePrice: true,
      executedInputAmount: true,
      executedOutputAmount: true,
      executedFeeAmount: true,
      order: {
        select: {
          side: true,
          targetPrice: true
        }
      },
      bot: {
        select: {
          baseSymbol: true,
          quoteSymbol: true
        }
      }
    }
  });

  const adverseSlippageBps: number[] = [];
  const feeBps: number[] = [];
  let buySampleSize = 0;
  let sellSampleSize = 0;

  for (const row of rows) {
    if (row.bot.baseSymbol !== input.pair || row.bot.quoteSymbol !== "USDC") {
      continue;
    }

    const side = row.order.side as TradeSide;
    const targetPrice = toNumber(row.order.targetPrice);
    const inputAmount = toNumber(row.executedInputAmount);
    const outputAmount = toNumber(row.executedOutputAmount);
    const effectivePriceFromAmounts =
      side === TradeSide.Buy
        ? inputAmount > 0 && outputAmount > 0
          ? inputAmount / outputAmount
          : null
        : inputAmount > 0 && outputAmount > 0
          ? outputAmount / inputAmount
          : null;
    const effectivePrice = effectivePriceFromAmounts ?? toNullableNumber(row.quotePrice);

    if (!isPositive(targetPrice) || !isPositive(effectivePrice)) {
      continue;
    }

    const rawAdverseBps =
      side === TradeSide.Buy
        ? ((effectivePrice - targetPrice) / targetPrice) * 10_000
        : ((targetPrice - effectivePrice) / targetPrice) * 10_000;

    adverseSlippageBps.push(Math.max(0, rawAdverseBps));
    if (side === TradeSide.Buy) {
      buySampleSize += 1;
    } else {
      sellSampleSize += 1;
    }

    const quoteNotional = side === TradeSide.Buy ? inputAmount : outputAmount;
    const feeAmount = toNumber(row.executedFeeAmount);
    if (feeAmount > 0 && quoteNotional > 0 && feeAmount <= quoteNotional * 0.02) {
      feeBps.push((feeAmount / quoteNotional) * 10_000);
    }
  }

  if (adverseSlippageBps.length < MIN_CALIBRATION_SAMPLES) {
    return buildFixedFallback(input, adverseSlippageBps.length, buySampleSize, sellSampleSize);
  }

  const p75AdverseSlippageBps = percentile(adverseSlippageBps, 0.75);
  const recommendedSlippageBps = clamp(roundUp(p75AdverseSlippageBps + 2, 1), 3, 50);
  const recommendedFeeBps = feeBps.length ? clamp(roundUp(percentile(feeBps, 0.75), 1), 0, 10) : 0;

  return {
    pair: input.pair,
    source: "calibrated_live_fills",
    sampleSize: adverseSlippageBps.length,
    buySampleSize,
    sellSampleSize,
    feeSampleSize: feeBps.length,
    maxSlippageBps: recommendedSlippageBps,
    executionFeeBps: recommendedFeeBps,
    averageAdverseSlippageBps: round(average(adverseSlippageBps), 2),
    p50AdverseSlippageBps: round(percentile(adverseSlippageBps, 0.5), 2),
    p75AdverseSlippageBps: round(p75AdverseSlippageBps, 2),
    p90AdverseSlippageBps: round(percentile(adverseSlippageBps, 0.9), 2),
    maxAdverseSlippageBps: round(Math.max(...adverseSlippageBps), 2),
    averageFeeBps: round(feeBps.length ? average(feeBps) : 0, 2),
    lookbackDays: input.lookbackDays
  };
}

export function applyExecutionCostCalibration<T extends { maxSlippageBps: number; executionFeeBps?: number; executionCostSource?: BacktestExecutionCostSource }>(
  config: T,
  calibration: BacktestExecutionCostCalibration
): T {
  return {
    ...config,
    maxSlippageBps: calibration.maxSlippageBps,
    executionFeeBps: calibration.executionFeeBps,
    executionCostSource: calibration.source
  };
}

function buildFixedFallback(
  input: { pair: LabPair; lookbackDays: LabLookbackDays },
  sampleSize: number,
  buySampleSize: number,
  sellSampleSize: number
): BacktestExecutionCostCalibration {
  return {
    pair: input.pair,
    source: "fixed_pessimistic",
    sampleSize,
    buySampleSize,
    sellSampleSize,
    feeSampleSize: 0,
    maxSlippageBps: 50,
    executionFeeBps: 10,
    averageAdverseSlippageBps: 0,
    p50AdverseSlippageBps: 0,
    p75AdverseSlippageBps: 0,
    p90AdverseSlippageBps: 0,
    maxAdverseSlippageBps: 0,
    averageFeeBps: 0,
    lookbackDays: input.lookbackDays
  };
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }

  return Number(value);
}

function toNullableNumber(value: unknown) {
  const parsed = toNumber(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundUp(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}
