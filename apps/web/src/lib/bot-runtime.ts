import type { BotFormDraft } from "@/lib/bot-management";

type PendingSignalMetadata = {
  levelIndex: number;
  side: "buy" | "sell";
  firstObservedAt: string;
  lastObservedPrice: number;
};

export function calculateGridLevels(config: Pick<BotFormDraft, "lowPrice" | "highPrice" | "levelCount" | "gridType">) {
  if (config.levelCount < 2) {
    return [];
  }

  if (config.gridType === "arithmetic") {
    const step = (config.highPrice - config.lowPrice) / (config.levelCount - 1);
    return Array.from({ length: config.levelCount }, (_, index) => round(config.lowPrice + step * index, 8));
  }

  const ratio = Math.pow(config.highPrice / config.lowPrice, 1 / (config.levelCount - 1));
  return Array.from({ length: config.levelCount }, (_, index) => round(config.lowPrice * ratio ** index, 8));
}

export function getNextGridTriggers(
  config: Pick<BotFormDraft, "lowPrice" | "highPrice" | "levelCount" | "gridType">,
  currentPrice: number | null
) {
  if (currentPrice === null || !Number.isFinite(currentPrice)) {
    return {
      nextBuyLevel: null,
      nextSellLevel: null
    };
  }

  const levels = calculateGridLevels(config);
  let nextBuyLevel: number | null = null;
  let nextSellLevel: number | null = null;

  for (const level of levels) {
    if (level < currentPrice) {
      nextBuyLevel = level;
      continue;
    }

    if (level > currentPrice) {
      nextSellLevel = level;
      break;
    }
  }

  return {
    nextBuyLevel,
    nextSellLevel
  };
}

export function formatLevelCode(levelIndex: number) {
  return String(levelIndex + 1).padStart(2, "0");
}

export function formatLevelLabel(levelIndex: number) {
  return `L${formatLevelCode(levelIndex)}`;
}

export function parsePendingSignal(
  metadata: unknown,
  confirmationWindowMs: number,
  now = new Date()
): (PendingSignalMetadata & { elapsedMs: number; remainingMs: number; ready: boolean }) | null {
  if (!metadata || typeof metadata !== "object" || !("pendingSignal" in metadata)) {
    return null;
  }

  const pendingSignal = (metadata as { pendingSignal?: unknown }).pendingSignal;
  if (!pendingSignal || typeof pendingSignal !== "object") {
    return null;
  }

  const record = pendingSignal as Record<string, unknown>;
  const levelIndex = typeof record.levelIndex === "number" ? record.levelIndex : null;
  const side = record.side === "buy" || record.side === "sell" ? record.side : null;
  const firstObservedAt = typeof record.firstObservedAt === "string" ? record.firstObservedAt : null;
  const lastObservedPrice = typeof record.lastObservedPrice === "number" ? record.lastObservedPrice : null;

  if (levelIndex === null || side === null || firstObservedAt === null || lastObservedPrice === null) {
    return null;
  }

  const elapsedMs = Math.max(0, now.getTime() - new Date(firstObservedAt).getTime());
  const remainingMs = Math.max(0, confirmationWindowMs - elapsedMs);

  return {
    levelIndex,
    side,
    firstObservedAt,
    lastObservedPrice,
    elapsedMs,
    remainingMs,
    ready: remainingMs === 0
  };
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
