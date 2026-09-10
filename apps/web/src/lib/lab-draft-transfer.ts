import { BotMode, EntryMode, GridType, MinOrderMode, RecenterMode, StrategyMode } from "@grid-bot/core/enums";

import {
  createDraftFromPreset,
  normalizeBotDraftCapital,
  type BotFormDraft,
  type BotPairPresetId
} from "./bot-management";
import type { BacktestRecenterModel, BacktestReplayRequestBody, LabPair } from "./backtest-lab";

export const LAB_BOT_DRAFT_STORAGE_KEY = "grid-bot:lab-bot-draft:v1";

type LabDraftConfig = BacktestReplayRequestBody["config"];

export type LabBotDraftTransfer = {
  version: 1;
  source: "backtest-lab";
  createdAt: string;
  label: string;
  pairPresetId: BotPairPresetId;
  mode: BotMode;
  config: LabDraftConfig;
};

export type LabBotDraftBuildResult = {
  draft: BotFormDraft;
  minOrderMode: "auto" | "manual";
  forcedManualRecenter: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isGridType(value: unknown): value is GridType {
  return value === GridType.Arithmetic || value === GridType.Geometric;
}

function isStrategyMode(value: unknown): value is StrategyMode {
  return value === StrategyMode.AccumulateBase || value === StrategyMode.AccumulateUsdc || value === StrategyMode.Balanced;
}

function isMinOrderMode(value: unknown): value is MinOrderMode {
  return value === MinOrderMode.Auto || value === MinOrderMode.Manual;
}

function isRecenterMode(value: unknown): value is RecenterMode {
  return value === RecenterMode.Manual || value === RecenterMode.Auto;
}

function isRecenterModel(value: unknown): value is BacktestRecenterModel {
  return value === "worker_flat" || value === "candle_defense";
}

function isEntryMode(value: unknown): value is EntryMode {
  return value === EntryMode.Normal || value === EntryMode.SellOnly;
}

function isBotMode(value: unknown): value is BotMode {
  return value === BotMode.Paper || value === BotMode.Live;
}

function isPairPresetId(value: unknown): value is BotPairPresetId {
  return value === "SOL_USDC" || value === "BTC_USDC" || value === "HYPE_USDC";
}

function parseConfig(value: unknown): LabDraftConfig | null {
  if (!isObject(value)) {
    return null;
  }

  if (
    !isFiniteNumber(value.budgetUsd) ||
    !isFiniteNumber(value.lowPrice) ||
    !isFiniteNumber(value.highPrice) ||
    !isFiniteNumber(value.levelCount) ||
    !isGridType(value.gridType) ||
    !isStrategyMode(value.strategyMode) ||
    !isMinOrderMode(value.minOrderMode) ||
    !isFiniteNumber(value.minOrderQuoteAmount) ||
    !isFiniteNumber(value.maxSlippageBps) ||
    !isFiniteNumber(value.cooldownMs) ||
    !isFiniteNumber(value.maxOrdersPerHour) ||
    !isFiniteNumber(value.maxDrawdownPct) ||
    !isFiniteNumber(value.maxConsecutiveFailures) ||
    !isFiniteNumber(value.levelLockMs) ||
    !isFiniteNumber(value.priceConfirmationWindowMs) ||
    typeof value.outOfRangePause !== "boolean"
  ) {
    return null;
  }

  if (value.recenterModel !== undefined && !isRecenterModel(value.recenterModel)) {
    return null;
  }

  return {
    budgetUsd: value.budgetUsd,
    maxDeployableUsd: isFiniteNumber(value.maxDeployableUsd) ? value.maxDeployableUsd : value.budgetUsd,
    reserveQuoteAmount: isFiniteNumber(value.reserveQuoteAmount) ? value.reserveQuoteAmount : 0,
    entryMode: isEntryMode(value.entryMode) ? value.entryMode : EntryMode.Normal,
    lowPrice: value.lowPrice,
    highPrice: value.highPrice,
    levelCount: value.levelCount,
    gridType: value.gridType,
    strategyMode: value.strategyMode,
    rangeControlMode: value.rangeControlMode === "adaptive" ? "adaptive" : "static",
    minOrderMode: value.minOrderMode,
    minOrderQuoteAmount: value.minOrderQuoteAmount,
    maxSlippageBps: value.maxSlippageBps,
    executionFeeBps: isFiniteNumber(value.executionFeeBps) ? value.executionFeeBps : 10,
    cooldownMs: value.cooldownMs,
    maxOrdersPerHour: value.maxOrdersPerHour,
    maxDrawdownPct: value.maxDrawdownPct,
    maxConsecutiveFailures: value.maxConsecutiveFailures,
    levelLockMs: value.levelLockMs,
    priceConfirmationWindowMs: value.priceConfirmationWindowMs,
    recenterMode: isRecenterMode(value.recenterMode) ? value.recenterMode : RecenterMode.Manual,
    // Transfers created before the model field existed used candle-level defense.
    // Keep that behavior explicit so an old Lab result cannot silently become worker auto-center.
    recenterModel: isRecenterModel(value.recenterModel) ? value.recenterModel : "candle_defense",
    autoRecenterMinIntervalMs: isFiniteNumber(value.autoRecenterMinIntervalMs) ? value.autoRecenterMinIntervalMs : undefined,
    autoRecenterMaxPerDay: isFiniteNumber(value.autoRecenterMaxPerDay) ? value.autoRecenterMaxPerDay : undefined,
    outOfRangePause: value.outOfRangePause
  };
}

export function getLabPairPresetId(pair: LabPair): BotPairPresetId {
  if (pair === "BTC") {
    return "BTC_USDC";
  }

  if (pair === "HYPE") {
    return "HYPE_USDC";
  }

  return "SOL_USDC";
}

export function createLabBotDraftTransfer(input: {
  pair: LabPair;
  mode: BotMode;
  label: string;
  config: LabDraftConfig;
}): LabBotDraftTransfer {
  return {
    version: 1,
    source: "backtest-lab",
    createdAt: new Date().toISOString(),
    label: input.label,
    pairPresetId: getLabPairPresetId(input.pair),
    mode: input.mode,
    config: input.config
  };
}

export function parseLabBotDraftTransfer(raw: string | null): LabBotDraftTransfer | null {
  if (!raw) {
    return null;
  }

  try {
    const value = JSON.parse(raw) as unknown;
    if (!isObject(value) || value.version !== 1 || value.source !== "backtest-lab") {
      return null;
    }

    const config = parseConfig(value.config);
    if (!config || !isPairPresetId(value.pairPresetId) || !isBotMode(value.mode) || typeof value.label !== "string") {
      return null;
    }

    return {
      version: 1,
      source: "backtest-lab",
      createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
      label: value.label,
      pairPresetId: value.pairPresetId,
      mode: value.mode,
      config
    };
  } catch {
    return null;
  }
}

export function buildBotDraftFromLabTransfer(
  transfer: LabBotDraftTransfer,
  fallbackMode: BotMode
): LabBotDraftBuildResult {
  const mode = transfer.mode ?? fallbackMode;
  const minOrderMode = transfer.config.minOrderMode === MinOrderMode.Manual ? "manual" : "auto";
  const forcedManualRecenter =
    transfer.config.recenterMode === RecenterMode.Auto &&
    (transfer.config.recenterModel !== "worker_flat" || transfer.config.rangeControlMode === "adaptive");
  const recenterMode = forcedManualRecenter ? RecenterMode.Manual : transfer.config.recenterMode;
  const draft = normalizeBotDraftCapital({
    ...createDraftFromPreset(transfer.pairPresetId, mode),
    name: transfer.label,
    strategyMode: transfer.config.strategyMode,
    mode,
    entryMode: transfer.config.entryMode,
    gridType: transfer.config.gridType,
    totalBudgetUsd: transfer.config.budgetUsd,
    maxDeployableUsd: transfer.config.maxDeployableUsd,
    reserveQuoteAmount: transfer.config.reserveQuoteAmount,
    lowPrice: transfer.config.lowPrice,
    highPrice: transfer.config.highPrice,
    levelCount: transfer.config.levelCount,
    minOrderQuoteAmount: transfer.config.minOrderQuoteAmount,
    maxSlippageBps: transfer.config.maxSlippageBps,
    cooldownMs: transfer.config.cooldownMs,
    maxOrdersPerHour: transfer.config.maxOrdersPerHour,
    maxDrawdownPct: transfer.config.maxDrawdownPct,
    maxConsecutiveFailures: transfer.config.maxConsecutiveFailures,
    levelLockMs: transfer.config.levelLockMs,
    priceConfirmationWindowMs: transfer.config.priceConfirmationWindowMs,
    recenterMode,
    autoRecenterMinIntervalMs: transfer.config.autoRecenterMinIntervalMs ?? 6 * 60 * 60 * 1000,
    autoRecenterMaxPerDay: transfer.config.autoRecenterMaxPerDay ?? 2,
    outOfRangePause: transfer.config.outOfRangePause
  });

  return {
    draft,
    minOrderMode,
    forcedManualRecenter
  };
}
