import { canApplyRangeChange, suggestHybridRange } from "./recenter-policy-service";

export type FlatRecenterSide = "above" | "below";
export type FlatRecenterAction = "inside" | "wait" | "hold_inventory" | "rate_limited" | "recenter";

export interface FlatRecenterInput {
  lowPrice: number;
  highPrice: number;
  currentPrice: number;
  now: Date;
  confirmationMs: number;
  outsideSince: string | null | undefined;
  outsideSide: FlatRecenterSide | null | undefined;
  outsideSourceObservedAt: string | null | undefined;
  currentObservationId: string | null;
  requireSourceAdvance: boolean;
  lastRecenterAt: Date | null | undefined;
  recenterHistory: string[];
  minIntervalMs: number;
  maxPerDay: number;
  openTradingLotCount: number;
  unresolvedExecution?: boolean;
}

export interface FlatRecenterDecision {
  action: FlatRecenterAction;
  side: FlatRecenterSide | null;
  outsideSince: string | null;
  outsideSide: FlatRecenterSide | null;
  outsideSourceObservedAt: string | null;
  suggestedLowPrice: number | null;
  suggestedHighPrice: number | null;
  reason: string;
}

/**
 * Decide whether an out-of-range bot may move its rails while flat.
 *
 * The function is deliberately free of repositories, clocks, and market calls. The
 * caller owns the observation and persistence lifecycle and supplies the lot count
 * after excluding retained inventory.
 */
export function evaluateFlatRecenter(input: FlatRecenterInput): FlatRecenterDecision {
  const nowMs = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  const lowPrice = Number(input.lowPrice);
  const highPrice = Number(input.highPrice);
  const currentPrice = Number(input.currentPrice);

  if (!Number.isFinite(nowMs) || !Number.isFinite(lowPrice) || !Number.isFinite(highPrice) ||
      !Number.isFinite(currentPrice) || lowPrice <= 0 || highPrice <= lowPrice || currentPrice <= 0) {
    return decision("wait", null, null, null, null, "Invalid range, current price, or timestamp input.");
  }

  if (!Number.isFinite(input.minIntervalMs) || input.minIntervalMs < 0 ||
      !Number.isFinite(input.maxPerDay) || input.maxPerDay < 0 ||
      !Number.isFinite(input.openTradingLotCount) || input.openTradingLotCount < 0 ||
      !input.recenterHistory.every((entry) => isValidTimestamp(entry)) ||
      (input.lastRecenterAt !== null && input.lastRecenterAt !== undefined && !isValidDate(input.lastRecenterAt))) {
    return decision("wait", null, null, null, null, "Invalid recenter timing or inventory input.");
  }

  const side: FlatRecenterSide | null = currentPrice > highPrice ? "above" : currentPrice < lowPrice ? "below" : null;
  if (!side) {
    return decision("inside", null, null, null, null, "Price is inside the configured range.");
  }

  const now = input.now.toISOString();
  const sameSide = input.outsideSide === side;
  const parsedOutsideSince = sameSide && input.outsideSince ? parseTimestamp(input.outsideSince) : null;
  // A missing or malformed timestamp starts a fresh confirmation window. This
  // prevents bad persisted metadata from authorizing an immediate range move.
  const outsideSince = parsedOutsideSince ? parsedOutsideSince.toISOString() : now;
  const elapsedMs = nowMs - new Date(outsideSince).getTime();
  const currentSource = normalizeObservationId(input.currentObservationId);
  const priorSource = sameSide ? normalizeObservationId(input.outsideSourceObservedAt) : null;
  const outsideSourceObservedAt = priorSource ?? currentSource;
  const confirmationMs = Number.isFinite(input.confirmationMs) ? Math.max(30_000, input.confirmationMs) : 30_000;

  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return decision("wait", side, outsideSince, side, outsideSourceObservedAt, "Outside timestamp is not elapsed yet.");
  }

  if (elapsedMs < confirmationMs) {
    return decision("wait", side, outsideSince, side, outsideSourceObservedAt, "Waiting for the outside confirmation window.");
  }

  if (input.requireSourceAdvance && (currentSource === null || outsideSourceObservedAt === null || currentSource === outsideSourceObservedAt)) {
    return decision("wait", side, outsideSince, side, outsideSourceObservedAt, "Waiting for a distinct fresh source observation.");
  }

  if (input.unresolvedExecution) {
    return decision("hold_inventory", side, outsideSince, side, outsideSourceObservedAt, "Unresolved execution prevents recentering.");
  }

  if (input.openTradingLotCount > 0) {
    return decision("hold_inventory", side, outsideSince, side, outsideSourceObservedAt, "Open trading inventory prevents recentering.");
  }

  const frequencyAllowed = canApplyRangeChange({
    now: input.now,
    lastRecenterAt: input.lastRecenterAt ?? null,
    recenterHistory: input.recenterHistory,
    minIntervalMs: input.minIntervalMs,
    maxPerDay: input.maxPerDay,
    openCycleCount: 0
  });
  if (!frequencyAllowed) {
    return decision("rate_limited", side, outsideSince, side, outsideSourceObservedAt, "Recenter frequency limits prevent recentering.");
  }

  const suggestedRange = suggestHybridRange({ currentPrice, lowPrice, highPrice, side });
  if (!Number.isFinite(suggestedRange.low) || !Number.isFinite(suggestedRange.high) || suggestedRange.high <= suggestedRange.low) {
    return decision("wait", side, outsideSince, side, outsideSourceObservedAt, "Unable to derive a valid recentered range.");
  }
  return decision("recenter", side, null, null, null, "Confirmed outside observation with flat inventory; recentering the range.", suggestedRange.low, suggestedRange.high);
}

function decision(
  action: FlatRecenterAction,
  side: FlatRecenterSide | null,
  outsideSince: string | null,
  outsideSide: FlatRecenterSide | null,
  outsideSourceObservedAt: string | null,
  reason: string,
  suggestedLowPrice: number | null = null,
  suggestedHighPrice: number | null = null
): FlatRecenterDecision {
  return { action, side, outsideSince, outsideSide, outsideSourceObservedAt, suggestedLowPrice, suggestedHighPrice, reason };
}

function normalizeObservationId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTimestamp(value: string): Date | null {
  if (!isValidTimestamp(value)) return null;
  return new Date(value);
}

function isValidTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}
