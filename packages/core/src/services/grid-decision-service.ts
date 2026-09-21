import { BotStatus, TradeSide } from "../domain/enums";
import type { GridLevel, PendingSignal, TriggerSignal } from "../domain/types";
import { priceConfirmsTrigger } from "../utils/price-trigger";

interface SignalDecisionInput {
  botId: string;
  botStatus: BotStatus;
  latestStatus?: BotStatus | null;
  pendingSignal?: PendingSignal | null;
  currentPrice: number;
  now: Date;
  levels: GridLevel[];
  crossedSignals: TriggerSignal[];
  priceConfirmationWindowMs: number;
  canBuildOrder: (signal: TriggerSignal) => boolean;
}

interface PendingSignalInput {
  allowBoundaryCatchUp?: boolean;
  botId: string;
  pendingSignal?: PendingSignal | null;
  crossedSignals: TriggerSignal[];
  levels: GridLevel[];
  currentPrice: number;
  now: Date;
  canBuildOrder: (signal: TriggerSignal) => boolean;
}

interface OutOfRangeSignalInput {
  botId: string;
  botStatus: BotStatus;
  latestStatus?: BotStatus | null;
  pendingSignal?: PendingSignal | null;
  currentPrice: number;
  now: Date;
  levels: GridLevel[];
  crossedSignals: TriggerSignal[];
  priceConfirmationWindowMs: number;
  canBuildOrder: (signal: TriggerSignal) => boolean;
}

export class GridDecisionService {
  isOutOfRange(lowPrice: number, highPrice: number, price: number): boolean {
    return price < lowPrice || price > highPrice;
  }

  getConfirmedSignal(input: SignalDecisionInput): TriggerSignal | null {
    const actionableSignal = this.selectActionableCrossedSignal({
      botId: input.botId,
      crossedSignals: input.crossedSignals,
      now: input.now,
      canBuildOrder: input.canBuildOrder
    });
    const recoveringFromOutOfRange = this.isRecoveringFromOutOfRange(input.botStatus, input.latestStatus);

    // Confirmation gates new exposure only. Recovery exits remain immediately available.
    if (actionableSignal && (actionableSignal.side === TradeSide.Sell ||
        (!recoveringFromOutOfRange && input.priceConfirmationWindowMs <= 0))) {
      return this.materializeCrossedSignal(input.botId, actionableSignal, input.now);
    }

    const actionableSell = this.selectActionableSellAtCurrentPrice({
      botId: input.botId,
      levels: input.levels,
      currentPrice: input.currentPrice,
      now: input.now,
      canBuildOrder: input.canBuildOrder
    });
    if (actionableSell) {
      return actionableSell;
    }

    const pending = input.pendingSignal;
    if (!pending) {
      return null;
    }

    if (recoveringFromOutOfRange && pending.side === TradeSide.Buy) {
      return null;
    }

    const pendingLevel = input.levels.find((level) => level.index === pending.levelIndex);
    if (!pendingLevel) {
      return null;
    }

    if (!this.priceStillConfirms(pending.side, pendingLevel.price, input.currentPrice)) {
      return null;
    }

    if (pending.side === TradeSide.Buy && !this.confirmationElapsed(pending, input.now, input.priceConfirmationWindowMs)) {
      return null;
    }

    const candidate = {
      levelIndex: pending.levelIndex,
      side: pending.side,
      levelPrice: pendingLevel.price,
      observedPrice: input.currentPrice,
      idempotencyKey: `${input.botId}:${pending.side}:${pending.levelIndex}:${pending.firstObservedAt}`,
      triggeredAt: input.now
    };
    return input.canBuildOrder(candidate) ? candidate : null;
  }

  resolvePendingSignal(input: PendingSignalInput): PendingSignal | null {
    const boundaryLevel = input.levels[0];
    const boundary: TriggerSignal | null = input.allowBoundaryCatchUp !== false && boundaryLevel && this.priceStillConfirms(TradeSide.Buy, boundaryLevel.price, input.currentPrice)
      ? { levelIndex: boundaryLevel.index, side: TradeSide.Buy, levelPrice: boundaryLevel.price,
          observedPrice: input.currentPrice, idempotencyKey: `probe:${input.botId}:boundary`, triggeredAt: input.now }
      : null;
    const crossed = boundary && input.canBuildOrder(boundary) ? boundary : this.selectActionableCrossedSignal({
      botId: input.botId,
      crossedSignals: input.crossedSignals,
      now: input.now,
      canBuildOrder: input.canBuildOrder
    });

    if (crossed) {
      return {
        levelIndex: crossed.levelIndex,
        side: crossed.side,
        firstObservedAt:
          input.pendingSignal?.levelIndex === crossed.levelIndex && input.pendingSignal.side === crossed.side
            ? input.pendingSignal.firstObservedAt
            : input.now.toISOString(),
        lastObservedPrice: input.currentPrice
      };
    }

    const pending = input.pendingSignal;
    if (!pending) {
      return null;
    }

    const pendingLevel = input.levels.find((level) => level.index === pending.levelIndex);
    if (!pendingLevel) {
      return null;
    }

    if (!this.priceStillConfirms(pending.side, pendingLevel.price, input.currentPrice)) {
      return null;
    }

    if (!input.canBuildOrder({ levelIndex: pending.levelIndex, side: pending.side, levelPrice: pendingLevel.price,
      observedPrice: input.currentPrice, idempotencyKey: `probe:${input.botId}:pending`, triggeredAt: input.now })) return null;
    return {
      ...pending,
      lastObservedPrice: input.currentPrice
    };
  }

  getOutOfRangeRecoverySellSignal(input: OutOfRangeSignalInput): TriggerSignal | null {
    const confirmedCrossing = this.getConfirmedSignal(input);
    if (confirmedCrossing?.side === TradeSide.Sell) {
      return confirmedCrossing;
    }

    return this.selectActionableSellAtCurrentPrice({
      botId: input.botId,
      levels: input.levels,
      currentPrice: input.currentPrice,
      now: input.now,
      canBuildOrder: input.canBuildOrder
    });
  }

  getOutOfRangeBoundaryBuySignal(input: OutOfRangeSignalInput): TriggerSignal | null {
    const boundaryLevel = input.levels[0];
    if (!boundaryLevel || !this.priceStillConfirms(TradeSide.Buy, boundaryLevel.price, input.currentPrice)) {
      return null;
    }

    const crossedBoundary = input.crossedSignals.find(
      (signal) => signal.side === TradeSide.Buy && signal.levelIndex === boundaryLevel.index
    );
    const candidate: TriggerSignal = crossedBoundary
      ? this.materializeCrossedSignal(input.botId, crossedBoundary, input.now)
      : {
          levelIndex: boundaryLevel.index,
          side: TradeSide.Buy,
          levelPrice: boundaryLevel.price,
          observedPrice: input.currentPrice,
          idempotencyKey: `${input.botId}:boundary:buy:${boundaryLevel.index}:${input.now.getTime()}`,
          triggeredAt: input.now
        };

    if (!input.canBuildOrder(candidate)) {
      return null;
    }

    if (input.priceConfirmationWindowMs > 0) {
      const pending = input.pendingSignal;
      if (!pending || pending.side !== TradeSide.Buy || pending.levelIndex !== boundaryLevel.index ||
          !this.confirmationElapsed(pending, input.now, input.priceConfirmationWindowMs)) return null;
      candidate.idempotencyKey = `${input.botId}:boundary:buy:${boundaryLevel.index}:${pending.firstObservedAt}`;
    }
    return candidate;
  }

  private confirmationElapsed(pending: PendingSignal, now: Date, windowMs: number) {
    const elapsed = now.getTime() - new Date(pending.firstObservedAt).getTime();
    return Number.isFinite(elapsed) && elapsed >= Math.max(0, windowMs);
  }

  priceStillConfirms(side: TradeSide, levelPrice: number, currentPrice: number): boolean {
    return priceConfirmsTrigger(side, levelPrice, currentPrice);
  }

  private selectActionableSellAtCurrentPrice(input: {
    botId: string;
    levels: GridLevel[];
    currentPrice: number;
    now: Date;
    canBuildOrder: (signal: TriggerSignal) => boolean;
  }): TriggerSignal | null {
    for (const level of [...input.levels].reverse()) {
      if (!this.priceStillConfirms(TradeSide.Sell, level.price, input.currentPrice)) {
        continue;
      }

      const candidate: TriggerSignal = {
        levelIndex: level.index,
        side: TradeSide.Sell,
        levelPrice: level.price,
        observedPrice: input.currentPrice,
        idempotencyKey: `${input.botId}:recovery:sell:${level.index}:${input.now.getTime()}`,
        triggeredAt: input.now
      };

      if (input.canBuildOrder(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private selectActionableCrossedSignal(input: {
    botId: string;
    crossedSignals: TriggerSignal[];
    now: Date;
    canBuildOrder: (signal: TriggerSignal) => boolean;
  }): TriggerSignal | null {
    for (const signal of input.crossedSignals) {
      const probeSignal: TriggerSignal = {
        ...signal,
        idempotencyKey: `probe:${input.botId}:${signal.side}:${signal.levelIndex}:${input.now.getTime()}`,
        triggeredAt: input.now
      };

      if (input.canBuildOrder(probeSignal)) {
        return signal;
      }
    }

    return null;
  }

  private materializeCrossedSignal(botId: string, signal: TriggerSignal, now: Date): TriggerSignal {
    return {
      ...signal,
      idempotencyKey: `${botId}:${signal.side}:${signal.levelIndex}:${now.getTime()}`,
      triggeredAt: now
    };
  }

  private isRecoveringFromOutOfRange(botStatus: BotStatus, latestStatus?: BotStatus | null): boolean {
    return botStatus === BotStatus.OutOfRange || latestStatus === BotStatus.OutOfRange;
  }
}
