import { DEFAULTS, MINTS } from "@grid-bot/common/constants";
import { BotMode, BotStatus, ExecutionProvider, GridType, RecenterMode, StrategyMode } from "@grid-bot/core/enums";

interface BotRuntimeMetadataShape {
  levelLocks: Record<string, string>;
  pendingSignal: {
    levelIndex: number;
    side: "buy" | "sell";
    firstObservedAt: string;
    lastObservedPrice: number;
  } | null;
  gridCycles: Record<
    string,
    {
      buyLevelIndex: number;
      sellLevelIndex: number | null;
      lotId: string;
      openedAt: string;
    }
  >;
  recenterHistory: string[];
  recentExecutions: string[];
}

const DRAFT_FIELD_LABELS: Record<keyof BotFormDraft, string> = {
  presetId: "Pair preset",
  name: "Bot name",
  strategyMode: "Strategy",
  mode: "Mode",
  gridType: "Grid type",
  totalBudgetUsd: "Total budget",
  maxDeployableUsd: "Max deployable",
  reserveQuoteAmount: "USDC reserve",
  lowPrice: "Low price",
  highPrice: "High price",
  levelCount: "Levels",
  minOrderQuoteAmount: "Min order",
  maxSlippageBps: "Max slippage",
  cooldownMs: "Cooldown",
  maxOrdersPerHour: "Orders/hour limit",
  maxDrawdownPct: "Max drawdown",
  maxConsecutiveFailures: "Max consecutive failures",
  levelLockMs: "Level lock",
  priceConfirmationWindowMs: "Confirmation window",
  recenterMode: "Recenter mode",
  autoRecenterMinIntervalMs: "Auto recenter interval",
  autoRecenterMaxPerDay: "Auto recenter max/day",
  outOfRangePause: "Out of range policy"
};

const DRAFT_DIFF_FIELDS: Array<keyof BotFormDraft> = [
  "name",
  "strategyMode",
  "mode",
  "gridType",
  "totalBudgetUsd",
  "maxDeployableUsd",
  "reserveQuoteAmount",
  "lowPrice",
  "highPrice",
  "levelCount",
  "minOrderQuoteAmount",
  "maxSlippageBps",
  "cooldownMs",
  "maxOrdersPerHour",
  "maxDrawdownPct",
  "maxConsecutiveFailures",
  "levelLockMs",
  "priceConfirmationWindowMs",
  "recenterMode",
  "autoRecenterMinIntervalMs",
  "autoRecenterMaxPerDay",
  "outOfRangePause"
];

export const BOT_PAIR_PRESETS = {
  SOL_USDC: {
    id: "SOL_USDC",
    label: "SOL/USDC",
    baseMint: MINTS.SOL,
    quoteMint: MINTS.USDC,
    baseSymbol: "SOL",
    quoteSymbol: "USDC",
    baseDecimals: 9,
    quoteDecimals: 6,
    defaultName: "SOL / USDC Grid",
    defaults: {
      strategyMode: StrategyMode.Balanced,
      mode: BotMode.Paper,
      gridType: GridType.Arithmetic,
      totalBudgetUsd: 2_000,
      maxDeployableUsd: 1_500,
      reserveQuoteAmount: 500,
      lowPrice: 105,
      highPrice: 165,
      levelCount: 14,
      minOrderQuoteAmount: 50,
      maxSlippageBps: 50,
      cooldownMs: DEFAULTS.cooldownMs,
      maxOrdersPerHour: DEFAULTS.maxOrdersPerHour,
      maxDrawdownPct: 18,
      maxConsecutiveFailures: DEFAULTS.maxConsecutiveFailures,
      levelLockMs: DEFAULTS.levelLockMs,
      priceConfirmationWindowMs: DEFAULTS.priceConfirmationWindowMs,
      recenterMode: RecenterMode.Manual,
      autoRecenterMinIntervalMs: DEFAULTS.autoRecenterMinIntervalMs,
      autoRecenterMaxPerDay: DEFAULTS.autoRecenterMaxPerDay,
      outOfRangePause: true
    }
  },
  BTC_USDC: {
    id: "BTC_USDC",
    label: "BTC/USDC",
    baseMint: MINTS.BTC,
    quoteMint: MINTS.USDC,
    baseSymbol: "BTC",
    quoteSymbol: "USDC",
    baseDecimals: 6,
    quoteDecimals: 6,
    defaultName: "BTC / USDC Grid",
    defaults: {
      strategyMode: StrategyMode.AccumulateUsdc,
      mode: BotMode.Paper,
      gridType: GridType.Geometric,
      totalBudgetUsd: 2_000,
      maxDeployableUsd: 1_500,
      reserveQuoteAmount: 500,
      lowPrice: 56_000,
      highPrice: 76_000,
      levelCount: 12,
      minOrderQuoteAmount: 50,
      maxSlippageBps: 50,
      cooldownMs: DEFAULTS.cooldownMs,
      maxOrdersPerHour: DEFAULTS.maxOrdersPerHour,
      maxDrawdownPct: 18,
      maxConsecutiveFailures: DEFAULTS.maxConsecutiveFailures,
      levelLockMs: DEFAULTS.levelLockMs,
      priceConfirmationWindowMs: DEFAULTS.priceConfirmationWindowMs,
      recenterMode: RecenterMode.Manual,
      autoRecenterMinIntervalMs: DEFAULTS.autoRecenterMinIntervalMs,
      autoRecenterMaxPerDay: DEFAULTS.autoRecenterMaxPerDay,
      outOfRangePause: true
    }
  }
} as const;

export const BOT_PAIR_PRESET_IDS = Object.keys(BOT_PAIR_PRESETS) as Array<keyof typeof BOT_PAIR_PRESETS>;
export const STRATEGY_MODE_OPTIONS = Object.values(StrategyMode);
export const BOT_MODE_OPTIONS = Object.values(BotMode);
export const GRID_TYPE_OPTIONS = Object.values(GridType);
export const RECENTER_MODE_OPTIONS = Object.values(RecenterMode);

export const BOT_BEHAVIOR_PRESETS = {
  token_stacker: {
    id: "token_stacker",
    label: "Token stacker",
    summary: "Buy each grid level once. Recycle only the cost on the way back up and keep the profit in SOL/BTC.",
    tags: ["slower", "bear market", "accumulate token"],
    operatorHint: "Good when you want to stack SOL/BTC during long downside or sideways phases.",
    cycleRule: "A buy level stays occupied until its paired sell closes the cycle.",
    exitRule: "Recover the quote spent, keep the profit in base asset.",
    strategyMode: StrategyMode.AccumulateBase,
    gridType: GridType.Arithmetic,
    levelCountByPair: {
      SOL_USDC: 12,
      BTC_USDC: 10
    },
    cooldownMs: 120_000,
    maxOrdersPerHour: 18,
    levelLockMs: 120_000,
    priceConfirmationWindowMs: 5_000
  },
  balanced_cycle: {
    id: "balanced_cycle",
    label: "Balanced cycle",
    summary: "Buy each level once, then recycle part of the move back into USDC while keeping part in SOL/BTC.",
    tags: ["medium pace", "balanced", "default"],
    operatorHint: "Good default if you want the bot to keep trading the range without fully abandoning token accumulation.",
    cycleRule: "A buy level stays occupied until the paired sell completes.",
    exitRule: "Split the profitable move between USDC recycling and base retention.",
    strategyMode: StrategyMode.Balanced,
    gridType: GridType.Arithmetic,
    levelCountByPair: {
      SOL_USDC: 16,
      BTC_USDC: 14
    },
    cooldownMs: 45_000,
    maxOrdersPerHour: 48,
    levelLockMs: 45_000,
    priceConfirmationWindowMs: 3_000
  },
  range_farmer: {
    id: "range_farmer",
    label: "Range farmer",
    summary: "Denser and faster. Sells the whole profitable lot to harvest many small USDC wins while the market chops.",
    tags: ["faster", "range", "accumulate usdc"],
    operatorHint: "Good when the market chops inside a range and you want many small closes rather than token stacking.",
    cycleRule: "A buy level stays occupied until the paired sell closes it. No rebuy on that same level before the exit.",
    exitRule: "Sell the whole profitable lot back out to maximize USDC recycling.",
    strategyMode: StrategyMode.AccumulateUsdc,
    gridType: GridType.Arithmetic,
    levelCountByPair: {
      SOL_USDC: 24,
      BTC_USDC: 18
    },
    cooldownMs: 15_000,
    maxOrdersPerHour: 96,
    levelLockMs: 15_000,
    priceConfirmationWindowMs: 1_000
  }
} as const;

export type BotBehaviorPresetId = keyof typeof BOT_BEHAVIOR_PRESETS;
export const BOT_BEHAVIOR_PRESET_IDS = Object.keys(BOT_BEHAVIOR_PRESETS) as BotBehaviorPresetId[];

export type BotPairPresetId = (typeof BOT_PAIR_PRESET_IDS)[number];
export interface BotFormDraft {
  presetId: BotPairPresetId;
  name: string;
  strategyMode: StrategyMode;
  mode: BotMode;
  gridType: GridType;
  totalBudgetUsd: number;
  maxDeployableUsd: number;
  reserveQuoteAmount: number;
  lowPrice: number;
  highPrice: number;
  levelCount: number;
  minOrderQuoteAmount: number;
  maxSlippageBps: number;
  cooldownMs: number;
  maxOrdersPerHour: number;
  maxDrawdownPct: number;
  maxConsecutiveFailures: number;
  levelLockMs: number;
  priceConfirmationWindowMs: number;
  recenterMode: RecenterMode;
  autoRecenterMinIntervalMs: number;
  autoRecenterMaxPerDay: number;
  outOfRangePause: boolean;
}

export interface BotDraftIssue {
  tone: "error" | "warning";
  field?: keyof BotFormDraft;
  message: string;
}

export interface BotDraftSummary {
  executableCapitalUsd: number;
  reserveRatioPct: number;
  deployableHeadroomUsd: number;
  rangeWidthPct: number;
  levelBudgetUsd: number;
  provider: ExecutionProvider;
}

export interface BotDraftAnalysis {
  summary: BotDraftSummary;
  issues: BotDraftIssue[];
  blockingIssues: BotDraftIssue[];
  warnings: BotDraftIssue[];
  canSubmit: boolean;
}

export interface BotDraftDiffItem {
  field: keyof BotFormDraft;
  label: string;
  previous: string;
  next: string;
}

export class BotManagementValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BotManagementValidationError";
    this.status = status;
  }
}

export function createDraftFromPreset(
  presetId: BotPairPresetId,
  mode: BotMode = BotMode.Paper
): BotFormDraft {
  const preset = BOT_PAIR_PRESETS[presetId];

  return {
    presetId,
    name: preset.defaultName,
    strategyMode: preset.defaults.strategyMode,
    mode,
    gridType: preset.defaults.gridType,
    totalBudgetUsd: preset.defaults.totalBudgetUsd,
    maxDeployableUsd: preset.defaults.maxDeployableUsd,
    reserveQuoteAmount: preset.defaults.reserveQuoteAmount,
    lowPrice: preset.defaults.lowPrice,
    highPrice: preset.defaults.highPrice,
    levelCount: preset.defaults.levelCount,
    minOrderQuoteAmount: preset.defaults.minOrderQuoteAmount,
    maxSlippageBps: preset.defaults.maxSlippageBps,
    cooldownMs: preset.defaults.cooldownMs,
    maxOrdersPerHour: preset.defaults.maxOrdersPerHour,
    maxDrawdownPct: preset.defaults.maxDrawdownPct,
    maxConsecutiveFailures: preset.defaults.maxConsecutiveFailures,
    levelLockMs: preset.defaults.levelLockMs,
    priceConfirmationWindowMs: preset.defaults.priceConfirmationWindowMs,
    recenterMode: preset.defaults.recenterMode,
    autoRecenterMinIntervalMs: preset.defaults.autoRecenterMinIntervalMs,
    autoRecenterMaxPerDay: preset.defaults.autoRecenterMaxPerDay,
    outOfRangePause: preset.defaults.outOfRangePause
  };
}

export function applyPaperTurbo(draft: BotFormDraft, currentPrice?: number | null): BotFormDraft {
  const centerPrice = currentPrice && currentPrice > 0 ? currentPrice : (draft.lowPrice + draft.highPrice) / 2;
  const totalWidthRatio = draft.presetId === "BTC_USDC" ? 0.06 : 0.08;
  const halfWidthRatio = totalWidthRatio / 2;
  const lowPrice = roundDraftNumber(centerPrice * (1 - halfWidthRatio), centerPrice >= 1000 ? 0 : 2);
  const highPrice = roundDraftNumber(centerPrice * (1 + halfWidthRatio), centerPrice >= 1000 ? 0 : 2);

  return {
    ...draft,
    mode: BotMode.Paper,
    gridType: GridType.Arithmetic,
    lowPrice,
    highPrice,
    levelCount: draft.presetId === "BTC_USDC" ? 16 : 18,
    cooldownMs: 30_000,
    maxOrdersPerHour: 60,
    levelLockMs: 15_000,
    priceConfirmationWindowMs: 2_000,
    recenterMode: RecenterMode.Manual,
    outOfRangePause: true
  };
}

export function applyBehaviorPreset(draft: BotFormDraft, presetId: BotBehaviorPresetId): BotFormDraft {
  const preset = BOT_BEHAVIOR_PRESETS[presetId];

  return {
    ...draft,
    strategyMode: preset.strategyMode,
    gridType: preset.gridType ?? draft.gridType,
    levelCount: preset.levelCountByPair[draft.presetId],
    cooldownMs: preset.cooldownMs,
    maxOrdersPerHour: preset.maxOrdersPerHour,
    levelLockMs: preset.levelLockMs,
    priceConfirmationWindowMs: preset.priceConfirmationWindowMs
  };
}

export function inferBehaviorPresetId(draft: Pick<BotFormDraft, "presetId" | "strategyMode" | "cooldownMs" | "priceConfirmationWindowMs" | "levelCount">): BotBehaviorPresetId {
  if (draft.strategyMode === StrategyMode.AccumulateBase) {
    return "token_stacker";
  }

  if (draft.strategyMode === StrategyMode.AccumulateUsdc) {
    return "range_farmer";
  }

  return "balanced_cycle";
}

export function inferPresetId(baseSymbol: string): BotPairPresetId | null {
  if (baseSymbol === "SOL") {
    return "SOL_USDC";
  }

  if (baseSymbol === "BTC") {
    return "BTC_USDC";
  }

  return null;
}

export function getExecutionProviderForMode(mode: BotMode) {
  return mode === BotMode.Paper ? ExecutionProvider.Paper : ExecutionProvider.Jupiter;
}

export function analyzeBotDraft(draft: BotFormDraft, liveTradingEnabled: boolean): BotDraftAnalysis {
  const executableCapitalUsd = Math.max(0, draft.totalBudgetUsd - draft.reserveQuoteAmount);
  const reserveRatioPct = draft.totalBudgetUsd > 0 ? (draft.reserveQuoteAmount / draft.totalBudgetUsd) * 100 : 0;
  const deployableHeadroomUsd = executableCapitalUsd - draft.maxDeployableUsd;
  const rangeWidthPct = draft.lowPrice > 0 ? ((draft.highPrice - draft.lowPrice) / draft.lowPrice) * 100 : 0;
  const levelBudgetUsd = draft.levelCount > 0 ? draft.maxDeployableUsd / draft.levelCount : 0;

  const issues: BotDraftIssue[] = [];
  const addIssue = (issue: BotDraftIssue) => {
    issues.push(issue);
  };

  if (draft.name.trim().length < 3) {
    addIssue({ tone: "error", field: "name", message: "Bot name must contain at least 3 characters." });
  }

  if (draft.lowPrice >= draft.highPrice) {
    addIssue({ tone: "error", field: "lowPrice", message: "Low price must stay below high price." });
  }

  if (draft.reserveQuoteAmount > draft.totalBudgetUsd) {
    addIssue({ tone: "error", field: "reserveQuoteAmount", message: "USDC reserve cannot exceed total budget." });
  }

  if (draft.maxDeployableUsd > executableCapitalUsd) {
    addIssue({
      tone: "error",
      field: "maxDeployableUsd",
      message: "Max deployable must fit inside total budget minus reserve."
    });
  }

  if (draft.minOrderQuoteAmount > draft.maxDeployableUsd) {
    addIssue({
      tone: "error",
      field: "minOrderQuoteAmount",
      message: "Min order cannot exceed max deployable capital."
    });
  }

  if (draft.mode === BotMode.Live && !liveTradingEnabled) {
    addIssue({
      tone: "error",
      field: "mode",
      message: "Live trading is globally disabled. Keep the bot in paper mode."
    });
  }

  if (levelBudgetUsd < draft.minOrderQuoteAmount) {
    addIssue({
      tone: "warning",
      field: "levelCount",
      message: "Per-level budget is below the minimum order size. Parts of the grid may never arm."
    });
  }

  if (reserveRatioPct < 10) {
    addIssue({
      tone: "warning",
      field: "reserveQuoteAmount",
      message: "Reserve is under 10% of total budget. The bot will have less room to absorb downside."
    });
  }

  if (rangeWidthPct < 6) {
    addIssue({
      tone: "warning",
      field: "highPrice",
      message: "Range width is tight. Expect more frequent out-of-range states and churn."
    });
  }

  if (draft.recenterMode === RecenterMode.Manual && !draft.outOfRangePause) {
    addIssue({
      tone: "warning",
      field: "outOfRangePause",
      message: "Manual recenter without pause leaves the bot degraded while price sits outside the grid."
    });
  }

  if (draft.recenterMode === RecenterMode.Auto && draft.autoRecenterMinIntervalMs < 60 * 60 * 1000) {
    addIssue({
      tone: "warning",
      field: "autoRecenterMinIntervalMs",
      message: "Auto recenter interval is aggressive. Tight loops can cause repeated range shifts."
    });
  }

  if (draft.cooldownMs === 0 && draft.priceConfirmationWindowMs === 0) {
    addIssue({
      tone: "warning",
      field: "cooldownMs",
      message: "Zero cooldown and zero confirmation window increase the chance of noisy re-triggers."
    });
  }

  return {
    summary: {
      executableCapitalUsd,
      reserveRatioPct,
      deployableHeadroomUsd,
      rangeWidthPct,
      levelBudgetUsd,
      provider: getExecutionProviderForMode(draft.mode)
    },
    issues,
    blockingIssues: issues.filter((issue) => issue.tone === "error"),
    warnings: issues.filter((issue) => issue.tone === "warning"),
    canSubmit: !issues.some((issue) => issue.tone === "error")
  };
}

export function diffBotDraft(previous: BotFormDraft, next: BotFormDraft): BotDraftDiffItem[] {
  return DRAFT_DIFF_FIELDS.flatMap((field) => {
    if (Object.is(previous[field], next[field])) {
      return [];
    }

    return [
      {
        field,
        label: DRAFT_FIELD_LABELS[field],
        previous: formatDraftFieldValue(field, previous[field]),
        next: formatDraftFieldValue(field, next[field])
      }
    ];
  });
}

export function slugifyBotKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildBotKeyForMode(baseKey: string, mode: BotMode) {
  const normalizedBaseKey = slugifyBotKey(baseKey) || "grid-bot";
  const suffix = mode === BotMode.Live ? "live" : "paper";

  if (normalizedBaseKey.endsWith(`-${suffix}`)) {
    return normalizedBaseKey;
  }

  return `${normalizedBaseKey}-${suffix}`;
}

export function createInitialRuntimeMetadata(): BotRuntimeMetadataShape {
  return {
    levelLocks: {},
    pendingSignal: null,
    gridCycles: {},
    recenterHistory: [],
    recentExecutions: []
  };
}

export function createInitialStateSnapshot(input: {
  botId: string;
  status: BotStatus;
  totalBudgetUsd: number;
  currentPrice?: number | null;
}) {
  return {
    botId: input.botId,
    status: input.status as never,
    currentPrice: input.currentPrice ?? undefined,
    availableQuoteAmount: input.totalBudgetUsd,
    availableBaseAmount: 0,
    deployedQuoteAmount: 0,
    averageEntryPrice: null,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalEquityUsd: input.totalBudgetUsd,
    consecutiveFailures: 0,
    lastProcessedAt: new Date(),
    metadata: createInitialRuntimeMetadata() as never
  };
}

export function cloneStateSnapshot(
  botId: string,
  status: BotStatus,
  latestState:
    | {
        currentPrice?: unknown;
        availableQuoteAmount?: unknown;
        availableBaseAmount?: unknown;
        deployedQuoteAmount?: unknown;
        averageEntryPrice?: unknown;
        realizedPnlUsd?: unknown;
        unrealizedPnlUsd?: unknown;
        totalEquityUsd?: unknown;
        consecutiveFailures?: unknown;
        lastExecutionAt?: Date | null;
        lastRecenterAt?: Date | null;
        metadata?: unknown;
      }
    | null,
  options?: {
    totalBudgetUsd?: number;
    currentPrice?: number | null;
  }
) {
  if (!latestState) {
    throw new BotManagementValidationError("Missing latest state snapshot for this bot.", 409);
  }

  const clonedSnapshot = {
    botId,
    status: status as never,
    currentPrice: numberOrNull(latestState.currentPrice),
    availableQuoteAmount: numberOrZero(latestState.availableQuoteAmount),
    availableBaseAmount: numberOrZero(latestState.availableBaseAmount),
    deployedQuoteAmount: numberOrZero(latestState.deployedQuoteAmount),
    averageEntryPrice: numberOrNull(latestState.averageEntryPrice),
    realizedPnlUsd: numberOrZero(latestState.realizedPnlUsd),
    unrealizedPnlUsd: numberOrZero(latestState.unrealizedPnlUsd),
    totalEquityUsd: numberOrZero(latestState.totalEquityUsd),
    consecutiveFailures: Math.max(0, Math.trunc(numberOrZero(latestState.consecutiveFailures))),
    lastExecutionAt: latestState.lastExecutionAt ?? undefined,
    lastProcessedAt: new Date(),
    lastRecenterAt: latestState.lastRecenterAt ?? undefined,
    metadata: cloneMetadata(latestState.metadata) as never
  };

  if (shouldRepairEmptyRuntimeState(clonedSnapshot, options?.totalBudgetUsd)) {
    clonedSnapshot.currentPrice = clonedSnapshot.currentPrice ?? options?.currentPrice ?? null;
    clonedSnapshot.availableQuoteAmount = options?.totalBudgetUsd ?? 0;
    clonedSnapshot.availableBaseAmount = 0;
    clonedSnapshot.deployedQuoteAmount = 0;
    clonedSnapshot.averageEntryPrice = null;
    clonedSnapshot.realizedPnlUsd = 0;
    clonedSnapshot.unrealizedPnlUsd = 0;
    clonedSnapshot.totalEquityUsd = options?.totalBudgetUsd ?? 0;
    clonedSnapshot.consecutiveFailures = 0;
    clonedSnapshot.lastExecutionAt = undefined;
  }

  return clonedSnapshot;
}

export function parseCreateBotPayload(payload: unknown, liveTradingEnabled: boolean) {
  const record = asRecord(payload);
  const presetId = readEnum(record, "presetId", BOT_PAIR_PRESET_IDS);
  const preset = BOT_PAIR_PRESETS[presetId];
  const draft = parseBotDraft(record, liveTradingEnabled);

  return {
    presetId,
    key: buildBotKeyForMode(draft.name || preset.defaultName, draft.mode),
    status: BotStatus.Paused,
    executionProvider: getExecutionProviderForMode(draft.mode),
    ...draft,
    ...preset
  };
}

export function parseUpdateBotPayload(payload: unknown, liveTradingEnabled: boolean) {
  const record = asRecord(payload);
  const draft = parseBotDraft(record, liveTradingEnabled);

  return {
    status: readOptionalEnum(record, "status", Object.values(BotStatus)),
    executionProvider: getExecutionProviderForMode(draft.mode),
    ...draft
  };
}

function parseBotDraft(record: Record<string, unknown>, liveTradingEnabled: boolean) {
  const name = readString(record, "name", 3, 80);
  const mode = readEnum(record, "mode", BOT_MODE_OPTIONS);
  const strategyMode = readEnum(record, "strategyMode", STRATEGY_MODE_OPTIONS);
  const gridType = readEnum(record, "gridType", GRID_TYPE_OPTIONS);
  const recenterMode = readEnum(record, "recenterMode", RECENTER_MODE_OPTIONS);
  const totalBudgetUsd = readNumber(record, "totalBudgetUsd", { min: 1 });
  const maxDeployableUsd = readNumber(record, "maxDeployableUsd", { min: 1 });
  const reserveQuoteAmount = readNumber(record, "reserveQuoteAmount", { min: 0 });
  const lowPrice = readNumber(record, "lowPrice", { min: 0.000001 });
  const highPrice = readNumber(record, "highPrice", { min: 0.000001 });
  const levelCount = readNumber(record, "levelCount", { min: 2, max: 64, integer: true });
  const minOrderQuoteAmount = readNumber(record, "minOrderQuoteAmount", { min: 1 });
  const maxSlippageBps = readNumber(record, "maxSlippageBps", { min: 1, max: 500, integer: true });
  const cooldownMs = readNumber(record, "cooldownMs", { min: 0, max: 86_400_000, integer: true });
  const maxOrdersPerHour = readNumber(record, "maxOrdersPerHour", { min: 1, max: 500, integer: true });
  const maxDrawdownPct = readNumber(record, "maxDrawdownPct", { min: 0, max: 100 });
  const maxConsecutiveFailures = readNumber(record, "maxConsecutiveFailures", { min: 1, max: 20, integer: true });
  const levelLockMs = readNumber(record, "levelLockMs", { min: 0, max: 86_400_000, integer: true });
  const priceConfirmationWindowMs = readNumber(record, "priceConfirmationWindowMs", { min: 0, max: 3_600_000, integer: true });
  const autoRecenterMinIntervalMs = readNumber(record, "autoRecenterMinIntervalMs", { min: 0, max: 604_800_000, integer: true });
  const autoRecenterMaxPerDay = readNumber(record, "autoRecenterMaxPerDay", { min: 0, max: 24, integer: true });
  const outOfRangePause = readBoolean(record, "outOfRangePause");

  if (mode === BotMode.Live && !liveTradingEnabled) {
    throw new BotManagementValidationError("Live trading is globally disabled. Keep the bot in paper mode.", 409);
  }

  if (lowPrice >= highPrice) {
    throw new BotManagementValidationError("The low price must be below the high price.");
  }

  if (reserveQuoteAmount > totalBudgetUsd) {
    throw new BotManagementValidationError("The quote reserve cannot exceed the total budget.");
  }

  if (maxDeployableUsd > totalBudgetUsd - reserveQuoteAmount) {
    throw new BotManagementValidationError("Max deployable capital must fit inside total budget minus reserve.");
  }

  if (minOrderQuoteAmount > maxDeployableUsd) {
    throw new BotManagementValidationError("The minimum order size cannot exceed the deployable capital.");
  }

  return {
    name,
    mode,
    strategyMode,
    gridType,
    totalBudgetUsd,
    maxDeployableUsd,
    reserveQuoteAmount,
    lowPrice,
    highPrice,
    levelCount,
    minOrderQuoteAmount,
    maxSlippageBps,
    cooldownMs,
    maxOrdersPerHour,
    maxDrawdownPct,
    maxConsecutiveFailures,
    levelLockMs,
    priceConfirmationWindowMs,
    recenterMode,
    autoRecenterMinIntervalMs,
    autoRecenterMaxPerDay,
    outOfRangePause
  };
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BotManagementValidationError("Invalid bot payload.");
  }

  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string, minLength: number, maxLength: number) {
  const value = record[key];
  if (typeof value !== "string") {
    throw new BotManagementValidationError(`Missing ${key}.`);
  }

  const trimmed = value.trim();
  if (trimmed.length < minLength || trimmed.length > maxLength) {
    throw new BotManagementValidationError(`${key} must contain between ${minLength} and ${maxLength} characters.`);
  }

  return trimmed;
}

function readEnum<T extends string>(record: Record<string, unknown>, key: string, values: readonly T[]) {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new BotManagementValidationError(`Invalid ${key}.`);
  }

  return value as T;
}

function readOptionalEnum<T extends string>(record: Record<string, unknown>, key: string, values: readonly T[]) {
  const value = record[key];

  if (typeof value === "undefined") {
    return undefined;
  }

  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new BotManagementValidationError(`Invalid ${key}.`);
  }

  return value as T;
}

function readBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new BotManagementValidationError(`Invalid ${key}.`);
  }

  return value;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  options: {
    min?: number;
    max?: number;
    integer?: boolean;
  }
) {
  const value = record[key];
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new BotManagementValidationError(`Invalid ${key}.`);
  }

  if (typeof options.min === "number" && value < options.min) {
    throw new BotManagementValidationError(`${key} must be at least ${options.min}.`);
  }

  if (typeof options.max === "number" && value > options.max) {
    throw new BotManagementValidationError(`${key} must be at most ${options.max}.`);
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new BotManagementValidationError(`${key} must be an integer.`);
  }

  return value;
}

function numberOrZero(value: unknown) {
  return decimalLikeToNumber(value) ?? 0;
}

function numberOrNull(value: unknown) {
  return decimalLikeToNumber(value);
}

function cloneMetadata(metadata: unknown) {
  if (!metadata) {
    return createInitialRuntimeMetadata();
  }

  return JSON.parse(JSON.stringify(metadata)) as BotRuntimeMetadataShape;
}

function decimalLikeToNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  if ("toNumber" in value && typeof value.toNumber === "function") {
    const numericValue = value.toNumber();
    return typeof numericValue === "number" && Number.isFinite(numericValue) ? numericValue : null;
  }

  if ("toString" in value && typeof value.toString === "function") {
    const numericValue = Number(value.toString());
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  return null;
}

function shouldRepairEmptyRuntimeState(
  snapshot: {
    availableQuoteAmount: number;
    availableBaseAmount: number;
    totalEquityUsd: number;
  },
  totalBudgetUsd?: number
) {
  return Boolean(totalBudgetUsd && totalBudgetUsd > 0 && snapshot.availableQuoteAmount === 0 && snapshot.availableBaseAmount === 0 && snapshot.totalEquityUsd === 0);
}

function formatDraftFieldValue(field: keyof BotFormDraft, value: BotFormDraft[keyof BotFormDraft]) {
  switch (field) {
    case "presetId":
      return BOT_PAIR_PRESETS[value as BotPairPresetId].label;
    case "strategyMode":
    case "gridType":
    case "recenterMode":
      return String(value).replaceAll("_", " ");
    case "mode":
      return value === BotMode.Paper ? "paper / paper" : "live / jupiter";
    case "outOfRangePause":
      return value ? "pause bot" : "keep degraded";
    case "totalBudgetUsd":
    case "maxDeployableUsd":
    case "reserveQuoteAmount":
    case "minOrderQuoteAmount":
      return formatUsd(Number(value));
    case "lowPrice":
    case "highPrice":
      return formatPrice(Number(value));
    case "maxDrawdownPct":
      return `${formatPlainNumber(Number(value), 2)}%`;
    case "maxSlippageBps":
      return `${formatPlainNumber(Number(value), 0)} bps`;
    case "cooldownMs":
    case "levelLockMs":
    case "priceConfirmationWindowMs":
    case "autoRecenterMinIntervalMs":
      return formatDuration(Number(value));
    default:
      return typeof value === "number" ? formatPlainNumber(value, Number.isInteger(value) ? 0 : 2) : String(value);
  }
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1000 ? 0 : value >= 1 ? 2 : 6
  }).format(value);
}

function formatPlainNumber(value: number, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits
  }).format(value);
}

function formatDuration(value: number) {
  if (value < 1000) {
    return `${value} ms`;
  }

  if (value < 60_000) {
    return `${formatPlainNumber(value / 1000, 0)} s`;
  }

  if (value < 3_600_000) {
    return `${formatPlainNumber(value / 60_000, 0)} min`;
  }

  if (value < 86_400_000) {
    return `${formatPlainNumber(value / 3_600_000, 0)} h`;
  }

  return `${formatPlainNumber(value / 86_400_000, 0)} d`;
}

function roundDraftNumber(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
