import type { BacktestConfig } from "@grid-bot/core";
import { GridType, MinOrderMode, RecenterMode, StrategyMode } from "@grid-bot/core/enums";

export const LAB_PAIR_OPTIONS = ["SOL", "BTC"] as const;
export const LAB_LOOKBACK_OPTIONS = [30, 60, 90, 180] as const;
export const LAB_RESOLUTION_OPTIONS = ["5m", "30m", "1h", "4h"] as const;

export type LabPair = (typeof LAB_PAIR_OPTIONS)[number];
export type LabLookbackDays = (typeof LAB_LOOKBACK_OPTIONS)[number];
export type LabResolution = (typeof LAB_RESOLUTION_OPTIONS)[number];

export type BacktestRecommendRequestBody = {
  pair: LabPair;
  budgetUsd: number;
  lookbackDays: LabLookbackDays;
  resolution: LabResolution;
};

export type BacktestReplayRequestBody = BacktestRecommendRequestBody & {
  config: Pick<
    BacktestConfig,
    | "lowPrice"
    | "highPrice"
    | "levelCount"
    | "gridType"
    | "strategyMode"
    | "budgetUsd"
    | "minOrderMode"
    | "minOrderQuoteAmount"
    | "maxSlippageBps"
    | "cooldownMs"
    | "maxOrdersPerHour"
    | "maxDrawdownPct"
    | "maxConsecutiveFailures"
    | "levelLockMs"
    | "priceConfirmationWindowMs"
    | "outOfRangePause"
  >;
};

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object payload.");
  }

  return value as Record<string, unknown>;
}

function parseEnumValue<T extends string>(value: unknown, allowedValues: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowedValues.includes(value as T)) {
    throw new Error(`Unsupported ${label}.`);
  }

  return value as T;
}

function parseNumberEnumValue<T extends number>(value: unknown, allowedValues: readonly T[], label: string): T {
  if (typeof value !== "number" || !allowedValues.includes(value as T)) {
    throw new Error(`Unsupported ${label}.`);
  }

  return value as T;
}

function parseFiniteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}.`);
  }

  return value;
}

function parsePositiveNumber(value: unknown, label: string) {
  const parsed = parseFiniteNumber(value, label);
  if (parsed <= 0) {
    throw new Error(`${label} must be positive.`);
  }

  return parsed;
}

function parsePositiveInteger(value: unknown, label: string) {
  const parsed = parseFiniteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function parseBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${label}.`);
  }

  return value;
}

export function parseBacktestRecommendRequest(body: unknown): BacktestRecommendRequestBody {
  const record = asObject(body);

  return {
    pair: parseEnumValue(record.pair, LAB_PAIR_OPTIONS, "pair"),
    budgetUsd: parsePositiveNumber(record.budgetUsd, "budgetUsd"),
    lookbackDays: parseNumberEnumValue(record.lookbackDays, LAB_LOOKBACK_OPTIONS, "lookbackDays"),
    resolution: parseEnumValue(record.resolution, LAB_RESOLUTION_OPTIONS, "resolution")
  };
}

export function parseBacktestReplayRequest(body: unknown): BacktestReplayRequestBody {
  const record = asObject(body);
  const shared = parseBacktestRecommendRequest(body);
  const configRecord = asObject(record.config);

  return {
    ...shared,
    config: {
      budgetUsd: parsePositiveNumber(configRecord.budgetUsd, "config.budgetUsd"),
      lowPrice: parsePositiveNumber(configRecord.lowPrice, "config.lowPrice"),
      highPrice: parsePositiveNumber(configRecord.highPrice, "config.highPrice"),
      levelCount: parsePositiveInteger(configRecord.levelCount, "config.levelCount"),
      gridType: parseEnumValue(configRecord.gridType, [GridType.Arithmetic, GridType.Geometric] as const, "config.gridType"),
      strategyMode: parseEnumValue(
        configRecord.strategyMode,
        [StrategyMode.AccumulateUsdc, StrategyMode.Balanced, StrategyMode.AccumulateBase] as const,
        "config.strategyMode"
      ),
      minOrderMode: parseEnumValue(configRecord.minOrderMode, [MinOrderMode.Auto, MinOrderMode.Manual] as const, "config.minOrderMode"),
      minOrderQuoteAmount: parsePositiveNumber(configRecord.minOrderQuoteAmount, "config.minOrderQuoteAmount"),
      maxSlippageBps: Math.max(0, parseFiniteNumber(configRecord.maxSlippageBps, "config.maxSlippageBps")),
      cooldownMs: Math.max(0, parseFiniteNumber(configRecord.cooldownMs, "config.cooldownMs")),
      maxOrdersPerHour: parsePositiveInteger(configRecord.maxOrdersPerHour, "config.maxOrdersPerHour"),
      maxDrawdownPct: Math.max(0, parseFiniteNumber(configRecord.maxDrawdownPct, "config.maxDrawdownPct")),
      maxConsecutiveFailures: parsePositiveInteger(configRecord.maxConsecutiveFailures, "config.maxConsecutiveFailures"),
      levelLockMs: Math.max(0, parseFiniteNumber(configRecord.levelLockMs, "config.levelLockMs")),
      priceConfirmationWindowMs: Math.max(
        0,
        parseFiniteNumber(configRecord.priceConfirmationWindowMs, "config.priceConfirmationWindowMs")
      ),
      outOfRangePause: parseBoolean(configRecord.outOfRangePause, "config.outOfRangePause")
    }
  };
}

export function buildReplayConfig(input: BacktestReplayRequestBody["config"]): BacktestConfig {
  return {
    ...input,
    recenterMode: RecenterMode.Manual
  };
}
