import { EntryMode, OrderStatus, StrategyMode, TradeSide, type GridType } from "../domain/enums";
import type { BotAggregate, GridCycle, GridLevel, OrderIntent, PositionLot, TriggerSignal } from "../domain/types";
import { round } from "../utils/math";
import { priceMoveTouchesLevel } from "../utils/price-trigger";

const PRICE_EPSILON = 0.00000001;

export class GridStrategyService {
  calculateLevels(lowPrice: number, highPrice: number, levelCount: number, gridType: GridType): GridLevel[] {
    if (levelCount < 2) {
      throw new Error("Grid must contain at least two levels.");
    }

    if (gridType === "arithmetic") {
      const step = (highPrice - lowPrice) / (levelCount - 1);
      return Array.from({ length: levelCount }, (_, index) => ({
        index,
        price: round(lowPrice + step * index, 8)
      }));
    }

    const ratio = Math.pow(highPrice / lowPrice, 1 / (levelCount - 1));
    return Array.from({ length: levelCount }, (_, index) => ({
      index,
      price: round(lowPrice * ratio ** index, 8)
    }));
  }

  detectCrossedLevels(levels: GridLevel[], previousPrice: number, currentPrice: number): TriggerSignal[] {
    if (previousPrice === currentPrice) {
      return [];
    }

    const side = currentPrice < previousPrice ? TradeSide.Buy : TradeSide.Sell;

    return levels
      .filter((level) => priceMoveTouchesLevel(level.price, previousPrice, currentPrice))
      .filter((level) => this.isExecutableLevel(level.index, levels.length, side))
      .sort((left, right) => (side === TradeSide.Buy ? right.price - left.price : left.price - right.price))
      .map((level) => ({
        levelIndex: level.index,
        side,
        levelPrice: level.price,
        observedPrice: currentPrice,
        idempotencyKey: "",
        triggeredAt: new Date()
      }));
  }

  remapOpenLotsToGridCycles(levels: GridLevel[], openLots: PositionLot[]): Record<string, GridCycle> {
    const cycles: Record<string, GridCycle> = {};
    const activeLots = openLots
      .filter((lot) => this.isOpenLotSellable(lot))
      .sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime());

    for (const lot of activeLots) {
      const cycle = this.inferGridCycleForLot(levels, lot);
      if (!cycle) {
        continue;
      }

      const levelKey = String(cycle.buyLevelIndex);
      const cycleKey = cycles[levelKey] ? `lot:${lot.id}` : levelKey;
      cycles[cycleKey] = cycle;
    }

    return cycles;
  }

  buildOrderIntent(bot: BotAggregate, signal: TriggerSignal): OrderIntent | null {
    const snapshot = bot.latestState;
    const gridCycles = snapshot?.metadata.gridCycles ?? {};
    const availableQuote = snapshot?.availableQuoteAmount ?? bot.config.totalBudgetUsd;
    const tradeCycleCount = Math.max(1, bot.config.levelCount - 1);
    const targetNotional = round(bot.config.maxDeployableUsd / tradeCycleCount, 2);
    const requestedQuoteAmount = Math.max(targetNotional, bot.config.minOrderQuoteAmount);

    if (!this.isExecutableLevel(signal.levelIndex, bot.config.levelCount, signal.side)) {
      return null;
    }

    if (signal.side === TradeSide.Buy) {
      if (bot.config.entryMode === EntryMode.SellOnly) {
        return null;
      }

      if (this.isBuyLevelOccupied(gridCycles, signal.levelIndex)) {
        return null;
      }

      const spendableQuote = availableQuote - bot.config.reserveQuoteAmount;
      if (spendableQuote < bot.config.minOrderQuoteAmount) {
        return null;
      }

      return {
        botId: bot.bot.id,
        orderKey: signal.idempotencyKey,
        side: TradeSide.Buy,
        levelIndex: signal.levelIndex,
        targetPrice: signal.levelPrice,
        requestedBaseAmount: round(requestedQuoteAmount / signal.levelPrice, 8),
        requestedQuoteAmount: Math.min(requestedQuoteAmount, round(spendableQuote, 2)),
        status: OrderStatus.Created,
        reason: `${bot.bot.strategyMode}: buy level ${signal.levelIndex + 1}`
      };
    }

    const sellPlan = this.buildSellPlan(bot, signal.levelIndex, signal.levelPrice);
    if (!sellPlan) {
      return null;
    }

    return {
      botId: bot.bot.id,
      orderKey: signal.idempotencyKey,
      side: TradeSide.Sell,
      levelIndex: signal.levelIndex,
      targetPrice: signal.levelPrice,
      requestedBaseAmount: sellPlan.requestedBaseAmount,
      requestedQuoteAmount: sellPlan.requestedQuoteAmount,
      status: OrderStatus.Created,
      reason: `${bot.bot.strategyMode}: sell level ${signal.levelIndex + 1}`,
      matchedLotIds: sellPlan.matchedLotIds
    };
  }

  private buildSellPlan(
    bot: BotAggregate,
    signalLevelIndex: number,
    executionPrice: number
  ): { requestedBaseAmount: number; requestedQuoteAmount: number; matchedLotIds: string[] } | null {
    const eligibleLot = this.findCycleMatchedSellLot(bot, signalLevelIndex) ?? this.findInferredSellLot(bot, signalLevelIndex);

    if (!eligibleLot) {
      return null;
    }

    return this.buildSellPlanFromLot(bot, eligibleLot, executionPrice);
  }

  private findCycleMatchedSellLot(bot: BotAggregate, signalLevelIndex: number): PositionLot | null {
    const gridCycles = bot.latestState?.metadata.gridCycles ?? {};
    const activeCycle = Object.values(gridCycles)
      .filter((cycle) => cycle.sellLevelIndex === signalLevelIndex)
      .sort((left, right) => new Date(left.openedAt).getTime() - new Date(right.openedAt).getTime())[0];

    if (!activeCycle) {
      return null;
    }

    return bot.openLots.find((lot) => lot.id === activeCycle.lotId && this.isOpenLotSellable(lot)) ?? null;
  }

  private findInferredSellLot(bot: BotAggregate, signalLevelIndex: number): PositionLot | null {
    const levels = this.calculateLevels(bot.config.lowPrice, bot.config.highPrice, bot.config.levelCount, bot.config.gridType);
    const trackedLotIds = new Set(Object.values(bot.latestState?.metadata.gridCycles ?? {}).map((cycle) => cycle.lotId));
    const candidates = bot.openLots
      .filter((lot) => this.isOpenLotSellable(lot))
      .filter((lot) => !trackedLotIds.has(lot.id))
      .filter((lot) => this.inferGridCycleForLot(levels, lot)?.sellLevelIndex === signalLevelIndex)
      .sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime());

    return candidates[0] ?? null;
  }

  private inferGridCycleForLot(levels: GridLevel[], lot: PositionLot): GridCycle | null {
    const costBasis = this.getLotCostBasis(lot);
    if (costBasis <= 0 || levels.length < 2) {
      return null;
    }

    const firstProfitableRail = levels.find((level) => level.price > costBasis + PRICE_EPSILON)?.index ?? null;
    const sellLevelIndex = firstProfitableRail === null ? null : Math.max(1, firstProfitableRail);
    const buyLevelIndex = sellLevelIndex === null ? Math.max(0, levels.length - 2) : Math.max(0, sellLevelIndex - 1);

    return {
      buyLevelIndex,
      sellLevelIndex,
      lotId: lot.id,
      openedAt: lot.openedAt.toISOString()
    };
  }

  private buildSellPlanFromLot(
    bot: BotAggregate,
    eligibleLot: PositionLot,
    executionPrice: number
  ): { requestedBaseAmount: number; requestedQuoteAmount: number; matchedLotIds: string[] } | null {
    if (!this.isOpenLotSellable(eligibleLot)) {
      return null;
    }

    const currentNotional = round(eligibleLot.remainingBaseAmount * executionPrice, 8);
    if (currentNotional <= eligibleLot.costQuote) {
      return null;
    }

    const targetQuoteAmount = this.getTargetQuoteAmount(bot.bot.strategyMode, eligibleLot.costQuote, currentNotional);
    const requestedBaseAmount = round(Math.min(eligibleLot.remainingBaseAmount, targetQuoteAmount / executionPrice), 8);
    const requestedQuoteAmount = round(requestedBaseAmount * executionPrice, 2);

    // Existing lots must remain sellable even after a later budget increase raises
    // the configured min order. The min-order guard is an entry-sizing rule, not
    // a reason to trap older, smaller lots forever.
    if (requestedBaseAmount <= 0 || requestedQuoteAmount <= 0) {
      return null;
    }

    return {
      requestedBaseAmount,
      requestedQuoteAmount,
      matchedLotIds: [eligibleLot.id]
    };
  }

  private isOpenLotSellable(lot: PositionLot): boolean {
    return lot.remainingBaseAmount > 0 && lot.costQuote > 0 && !lot.closedAt;
  }

  private getLotCostBasis(lot: PositionLot): number {
    if (lot.remainingBaseAmount > 0 && lot.costQuote > 0) {
      return lot.costQuote / lot.remainingBaseAmount;
    }

    const fallbackBaseAmount = lot.originalBaseAmount > 0 ? lot.originalBaseAmount : lot.remainingBaseAmount;
    return lot.entryPrice > 0 ? lot.entryPrice : fallbackBaseAmount > 0 ? lot.costQuote / fallbackBaseAmount : 0;
  }

  private isBuyLevelOccupied(gridCycles: Record<string, GridCycle>, levelIndex: number): boolean {
    return Boolean(gridCycles[String(levelIndex)]) || Object.values(gridCycles).some((cycle) => cycle.buyLevelIndex === levelIndex);
  }

  private getTargetQuoteAmount(strategy: StrategyMode, remainingCostQuote: number, currentNotional: number): number {
    switch (strategy) {
      case StrategyMode.AccumulateBase:
        return round(remainingCostQuote, 8);
      case StrategyMode.AccumulateUsdc:
        return round(currentNotional, 8);
      case StrategyMode.Balanced:
      default:
        return round(remainingCostQuote + (currentNotional - remainingCostQuote) / 2, 8);
    }
  }

  private isExecutableLevel(levelIndex: number, levelCount: number, side: TradeSide) {
    if (levelCount <= 1) {
      return false;
    }

    return side === TradeSide.Buy ? levelIndex < levelCount - 1 : levelIndex > 0;
  }
}
