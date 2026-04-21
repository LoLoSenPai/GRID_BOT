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
  botId: string;
  pendingSignal?: PendingSignal | null;
  crossedSignals: TriggerSignal[];
  levels: GridLevel[];
  currentPrice: number;
  now: Date;
  canBuildOrder: (signal: TriggerSignal) => boolean;
}

interface RecoverySellInput {
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

    if (actionableSignal && !(recoveringFromOutOfRange && actionableSignal.side === TradeSide.Buy)) {
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

    if (input.now.getTime() - new Date(pending.firstObservedAt).getTime() < input.priceConfirmationWindowMs) {
      return null;
    }

    return {
      levelIndex: pending.levelIndex,
      side: pending.side,
      levelPrice: pendingLevel.price,
      observedPrice: input.currentPrice,
      idempotencyKey: `${input.botId}:${pending.side}:${pending.levelIndex}:${pending.firstObservedAt}`,
      triggeredAt: input.now
    };
  }

  resolvePendingSignal(input: PendingSignalInput): PendingSignal | null {
    const crossed = this.selectActionableCrossedSignal({
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

    return {
      ...pending,
      lastObservedPrice: input.currentPrice
    };
  }

  getOutOfRangeRecoverySellSignal(input: RecoverySellInput): TriggerSignal | null {
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
