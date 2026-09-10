import "server-only";

import { BotMode, ExecutionStatus, TradeSide } from "@grid-bot/core/enums";
import type { BacktestExecutionCostOverride, BacktestExecutionCostSource } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

import type { LabLookbackDays, LabPair } from "@/lib/backtest-lab";
import type { BacktestExecutionCostMode } from "@/lib/backtest-lab";

const MAX_EXECUTION_SAMPLES = 500;
const MIN_CALIBRATION_SAMPLES = 20;
const MIN_SIDE_SAMPLES = 5;
const MIN_FEE_SAMPLES = 10;

export type BacktestExecutionCostCalibration = BacktestExecutionCostOverride & {
  pair: LabPair;
  source: BacktestExecutionCostSource;
  sampleSize: number;
  buySampleSize: number;
  sellSampleSize: number;
  feeSampleSize: number;
  calibrationStatus: "calibrated" | "insufficient_filled_samples";
  reasons: string[];
  averageAdverseSlippageBps: number | null;
  p50AdverseSlippageBps: number | null;
  p75AdverseSlippageBps: number | null;
  p90AdverseSlippageBps: number | null;
  maxAdverseSlippageBps: number | null;
  averageFeeBps: number | null;
  lookbackDays: LabLookbackDays;
};

export type BacktestExecutionCostResolution = {
  requestedMode: BacktestExecutionCostMode;
  calibratedBase: BacktestExecutionCostCalibration;
  applied: {
    mode: BacktestExecutionCostMode;
    source: BacktestExecutionCostSource;
    maxSlippageBps: number;
    executionFeeBps: number;
  };
};

export async function fetchExecutionCostCalibration(input: {
  pair: LabPair;
  lookbackDays: LabLookbackDays;
}): Promise<BacktestExecutionCostCalibration> {
  const since = new Date(Date.now() - input.lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.execution.findMany({
    where: {
      mode: BotMode.Live as never,
      status: ExecutionStatus.Filled as never,
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
    if (feeAmount > 0 && quoteNotional > 0) {
      feeBps.push((feeAmount / quoteNotional) * 10_000);
    }
  }

  const reasons: string[] = [];
  if (adverseSlippageBps.length < MIN_CALIBRATION_SAMPLES) {
    reasons.push(`Need at least ${MIN_CALIBRATION_SAMPLES} resolved fills; found ${adverseSlippageBps.length}.`);
  }
  if (buySampleSize < MIN_SIDE_SAMPLES || sellSampleSize < MIN_SIDE_SAMPLES) {
    reasons.push(`Need at least ${MIN_SIDE_SAMPLES} resolved fills on each side; found ${buySampleSize} buys and ${sellSampleSize} sells.`);
  }
  if (feeBps.length < MIN_FEE_SAMPLES) {
    reasons.push(`Need at least ${MIN_FEE_SAMPLES} fills with measured quote fees; found ${feeBps.length}.`);
  }

  if (reasons.length) {
    return buildFixedFallback(input, adverseSlippageBps, feeBps, buySampleSize, sellSampleSize, reasons);
  }

  const p75AdverseSlippageBps = percentile(adverseSlippageBps, 0.75);
  const p90AdverseSlippageBps = percentile(adverseSlippageBps, 0.9);
  const recommendedSlippageBps = Math.max(3, roundUp(p90AdverseSlippageBps + 2, 1));
  const recommendedFeeBps = roundUp(percentile(feeBps, 0.9), 1);

  return {
    pair: input.pair,
    source: "calibrated_live_fills",
    calibrationStatus: "calibrated",
    reasons: [],
    sampleSize: adverseSlippageBps.length,
    buySampleSize,
    sellSampleSize,
    feeSampleSize: feeBps.length,
    maxSlippageBps: recommendedSlippageBps,
    executionFeeBps: recommendedFeeBps,
    averageAdverseSlippageBps: round(average(adverseSlippageBps), 2),
    p50AdverseSlippageBps: round(percentile(adverseSlippageBps, 0.5), 2),
    p75AdverseSlippageBps: round(p75AdverseSlippageBps, 2),
    p90AdverseSlippageBps: round(p90AdverseSlippageBps, 2),
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
  adverseSlippageBps: number[],
  feeBps: number[],
  buySampleSize: number,
  sellSampleSize: number,
  reasons: string[]
): BacktestExecutionCostCalibration {
  return {
    pair: input.pair,
    source: "fixed_pessimistic",
    calibrationStatus: "insufficient_filled_samples",
    reasons,
    sampleSize: adverseSlippageBps.length,
    buySampleSize,
    sellSampleSize,
    feeSampleSize: feeBps.length,
    maxSlippageBps: 50,
    executionFeeBps: 10,
    averageAdverseSlippageBps: adverseSlippageBps.length ? round(average(adverseSlippageBps), 2) : null,
    p50AdverseSlippageBps: adverseSlippageBps.length ? round(percentile(adverseSlippageBps, 0.5), 2) : null,
    p75AdverseSlippageBps: adverseSlippageBps.length ? round(percentile(adverseSlippageBps, 0.75), 2) : null,
    p90AdverseSlippageBps: adverseSlippageBps.length ? round(percentile(adverseSlippageBps, 0.9), 2) : null,
    maxAdverseSlippageBps: adverseSlippageBps.length ? round(Math.max(...adverseSlippageBps), 2) : null,
    averageFeeBps: feeBps.length ? round(average(feeBps), 2) : null,
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

function round(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundUp(value: number, decimals: number) {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor) / factor;
}
