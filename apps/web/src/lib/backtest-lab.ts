import type { BacktestConfig } from "@grid-bot/core";
import { EntryMode, GridType, MinOrderMode, RecenterMode, StrategyMode } from "@grid-bot/core/enums";

export const LAB_PAIR_OPTIONS = ["SOL", "BTC", "HYPE"] as const;
export const LAB_LOOKBACK_OPTIONS = [7, 14, 30, 60, 90, 180] as const;
export const LAB_RESOLUTION_OPTIONS = ["5m", "30m", "1h", "4h"] as const;
const MAX_LOOKBACK_BY_RESOLUTION: Record<LabResolution, LabLookbackDays> = {
  "5m": 14,
  "30m": 30,
  "1h": 180,
  "4h": 180
};

export type LabPair = (typeof LAB_PAIR_OPTIONS)[number];
export type LabLookbackDays = (typeof LAB_LOOKBACK_OPTIONS)[number];
export type LabResolution = (typeof LAB_RESOLUTION_OPTIONS)[number];
export type BacktestExecutionCostMode = "calibrated" | "fixed" | "stress";
export type BacktestRangeMethod = "rebounds" | "distribution";
export type BacktestRecenterModel = "worker_flat" | "candle_defense";

export type BacktestExecutionCostRequest = {
  mode: BacktestExecutionCostMode;
};

export type BacktestRecommendRequestBody = {
  pair: LabPair;
  budgetUsd: number;
  maxDeployableUsd: number;
  reserveQuoteAmount: number;
  entryMode: EntryMode;
  lookbackDays: LabLookbackDays;
  resolution: LabResolution;
  rangeMethod?: BacktestRangeMethod;
  strategyMode?: StrategyMode;
};

type BacktestReplayConfig = Pick<
    BacktestConfig,
    | "lowPrice"
    | "highPrice"
    | "levelCount"
    | "gridType"
    | "strategyMode"
    | "rangeControlMode"
    | "budgetUsd"
    | "minOrderMode"
    | "minOrderQuoteAmount"
    | "maxSlippageBps"
    | "executionFeeBps"
    | "cooldownMs"
    | "maxOrdersPerHour"
    | "maxDrawdownPct"
    | "maxConsecutiveFailures"
    | "levelLockMs"
    | "priceConfirmationWindowMs"
    | "recenterMode"
    | "outOfRangePause"
  > & {
    maxDeployableUsd: number;
    reserveQuoteAmount: number;
    entryMode: EntryMode;
    recenterModel?: BacktestRecenterModel;
    autoRecenterMinIntervalMs?: number;
    autoRecenterMaxPerDay?: number;
  };

export type BacktestReplayRequestBody = BacktestRecommendRequestBody & {
  config: BacktestReplayConfig;
  executionCosts: BacktestExecutionCostRequest;
};

export type BacktestCompareRequestBody = BacktestReplayRequestBody;

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

function parseOptionalFiniteNumber(value: unknown, label: string, fallback: number) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return parseFiniteNumber(value, label);
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

function parseOptionalNonNegativeInteger(value: unknown, label: string, fallback: number) {
  const parsed = value === undefined || value === null ? fallback : parseFiniteNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function parseBoolean(value: unknown, label: string) {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${label}.`);
  }

  return value;
}

export function getDefaultBacktestRecenterModel(
  recenterMode: RecenterMode,
  rangeControlMode: "static" | "adaptive"
): BacktestRecenterModel {
  return recenterMode === RecenterMode.Auto && rangeControlMode === "static" ? "worker_flat" : "candle_defense";
}

export function getLabDefaultStrategyMode(pair: LabPair): StrategyMode {
  switch (pair) {
    case "BTC":
      return StrategyMode.AccumulateBase;
    case "SOL":
    case "HYPE":
      return StrategyMode.AccumulateUsdc;
  }
}

export function parseBacktestRecommendRequest(body: unknown): BacktestRecommendRequestBody {
  const record = asObject(body);
  const lookbackDays = parseNumberEnumValue(record.lookbackDays, LAB_LOOKBACK_OPTIONS, "lookbackDays");
  const resolution = parseEnumValue(record.resolution, LAB_RESOLUTION_OPTIONS, "resolution");
  const maxLookbackDays = MAX_LOOKBACK_BY_RESOLUTION[resolution];

  if (lookbackDays > maxLookbackDays) {
    throw new Error(`${resolution} Lab runs are capped at ${maxLookbackDays}d on this VPS.`);
  }

  const budgetUsd = parsePositiveNumber(record.budgetUsd, "budgetUsd");
  const reserveQuoteAmount = Math.max(0, parseOptionalFiniteNumber(record.reserveQuoteAmount, "reserveQuoteAmount", 0));
  const maxDeployableUsd = Math.max(
    0,
    parseOptionalFiniteNumber(record.maxDeployableUsd, "maxDeployableUsd", budgetUsd - reserveQuoteAmount)
  );

  if (reserveQuoteAmount > budgetUsd || maxDeployableUsd > budgetUsd - reserveQuoteAmount) {
    throw new Error("Deployable capital and reserve must fit inside budgetUsd.");
  }

  return {
    pair: parseEnumValue(record.pair, LAB_PAIR_OPTIONS, "pair"),
    budgetUsd,
    maxDeployableUsd,
    reserveQuoteAmount,
    entryMode:
      record.entryMode === undefined
        ? EntryMode.Normal
        : parseEnumValue(record.entryMode, [EntryMode.Normal, EntryMode.SellOnly] as const, "entryMode"),
    lookbackDays,
    resolution,
    rangeMethod:
      record.rangeMethod === undefined
        ? "rebounds"
        : parseEnumValue(record.rangeMethod, ["rebounds", "distribution"] as const, "rangeMethod"),
    ...(record.strategyMode === undefined
      ? {}
      : {
          strategyMode: parseEnumValue(
            record.strategyMode,
            [StrategyMode.AccumulateUsdc, StrategyMode.Balanced, StrategyMode.AccumulateBase] as const,
            "strategyMode"
          )
        })
  };
}

export function parseBacktestReplayRequest(body: unknown): BacktestReplayRequestBody {
  const record = asObject(body);
  const shared = parseBacktestRecommendRequest(body);
  const configRecord = asObject(record.config);

  const rangeControlMode =
    configRecord.rangeControlMode === undefined
      ? "static"
      : parseEnumValue(configRecord.rangeControlMode, ["static", "adaptive"] as const, "config.rangeControlMode");
  const recenterMode =
    configRecord.recenterMode === undefined
      ? RecenterMode.Manual
      : parseEnumValue(configRecord.recenterMode, [RecenterMode.Manual, RecenterMode.Auto] as const, "config.recenterMode");
  const config: BacktestReplayRequestBody["config"] = {
      budgetUsd: parsePositiveNumber(configRecord.budgetUsd, "config.budgetUsd"),
      maxDeployableUsd: Math.max(
        0,
        parseOptionalFiniteNumber(configRecord.maxDeployableUsd, "config.maxDeployableUsd", shared.maxDeployableUsd)
      ),
      reserveQuoteAmount: Math.max(
        0,
        parseOptionalFiniteNumber(configRecord.reserveQuoteAmount, "config.reserveQuoteAmount", shared.reserveQuoteAmount)
      ),
      entryMode:
        configRecord.entryMode === undefined
          ? shared.entryMode
          : parseEnumValue(configRecord.entryMode, [EntryMode.Normal, EntryMode.SellOnly] as const, "config.entryMode"),
      lowPrice: parsePositiveNumber(configRecord.lowPrice, "config.lowPrice"),
      highPrice: parsePositiveNumber(configRecord.highPrice, "config.highPrice"),
      levelCount: parsePositiveInteger(configRecord.levelCount, "config.levelCount"),
      gridType: parseEnumValue(configRecord.gridType, [GridType.Arithmetic, GridType.Geometric] as const, "config.gridType"),
      strategyMode: parseEnumValue(
        configRecord.strategyMode,
        [StrategyMode.AccumulateUsdc, StrategyMode.Balanced, StrategyMode.AccumulateBase] as const,
        "config.strategyMode"
      ),
      rangeControlMode,
      minOrderMode: parseEnumValue(configRecord.minOrderMode, [MinOrderMode.Auto, MinOrderMode.Manual] as const, "config.minOrderMode"),
      minOrderQuoteAmount: parsePositiveNumber(configRecord.minOrderQuoteAmount, "config.minOrderQuoteAmount"),
      maxSlippageBps: Math.max(0, parseFiniteNumber(configRecord.maxSlippageBps, "config.maxSlippageBps")),
      executionFeeBps: Math.max(0, parseOptionalFiniteNumber(configRecord.executionFeeBps, "config.executionFeeBps", 10)),
      cooldownMs: Math.max(0, parseFiniteNumber(configRecord.cooldownMs, "config.cooldownMs")),
      maxOrdersPerHour: parsePositiveInteger(configRecord.maxOrdersPerHour, "config.maxOrdersPerHour"),
      maxDrawdownPct: Math.max(0, parseFiniteNumber(configRecord.maxDrawdownPct, "config.maxDrawdownPct")),
      maxConsecutiveFailures: parsePositiveInteger(configRecord.maxConsecutiveFailures, "config.maxConsecutiveFailures"),
      levelLockMs: Math.max(0, parseFiniteNumber(configRecord.levelLockMs, "config.levelLockMs")),
      priceConfirmationWindowMs: Math.max(
        0,
        parseFiniteNumber(configRecord.priceConfirmationWindowMs, "config.priceConfirmationWindowMs")
      ),
      recenterMode,
      recenterModel:
        configRecord.recenterModel === undefined
          ? getDefaultBacktestRecenterModel(recenterMode, rangeControlMode)
          : parseEnumValue(
              configRecord.recenterModel,
              ["worker_flat", "candle_defense"] as const,
              "config.recenterModel"
            ),
      autoRecenterMinIntervalMs: parseOptionalNonNegativeInteger(
        configRecord.autoRecenterMinIntervalMs,
        "config.autoRecenterMinIntervalMs",
        6 * 60 * 60 * 1000
      ),
      autoRecenterMaxPerDay: parseOptionalNonNegativeInteger(configRecord.autoRecenterMaxPerDay, "config.autoRecenterMaxPerDay", 2),
      outOfRangePause: parseBoolean(configRecord.outOfRangePause, "config.outOfRangePause")
  };

  if (config.reserveQuoteAmount > config.budgetUsd || config.maxDeployableUsd > config.budgetUsd - config.reserveQuoteAmount) {
    throw new Error("config.maxDeployableUsd and config.reserveQuoteAmount must fit inside config.budgetUsd.");
  }

  return {
    ...shared,
    config,
    executionCosts: {
      mode:
        record.executionCosts === undefined
          ? "calibrated"
          : parseEnumValue(asObject(record.executionCosts).mode, ["calibrated", "fixed", "stress"] as const, "executionCosts.mode")
    }
  };
}

export function parseBacktestCompareRequest(body: unknown): BacktestCompareRequestBody {
  return parseBacktestReplayRequest(body);
}

export function buildReplayConfig(
  input: BacktestReplayRequestBody["config"]
): BacktestConfig & { recenterModel: BacktestRecenterModel } {
  const recenterMode = input.recenterMode ?? RecenterMode.Manual;
  const rangeControlMode = input.rangeControlMode ?? "static";
  return {
    ...input,
    recenterMode,
    rangeControlMode,
    recenterModel: input.recenterModel ?? getDefaultBacktestRecenterModel(recenterMode, rangeControlMode)
  } as BacktestConfig & { recenterModel: BacktestRecenterModel };
}

export function getLabLookbackOptions(resolution: LabResolution): LabLookbackDays[] {
  const maxLookbackDays = MAX_LOOKBACK_BY_RESOLUTION[resolution];
  return LAB_LOOKBACK_OPTIONS.filter((days) => days <= maxLookbackDays);
}
