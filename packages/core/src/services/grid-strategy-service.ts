import { OrderStatus, StrategyMode, TradeSide, type GridType } from "../domain/enums";
import type { BotAggregate, GridLevel, OrderIntent, TriggerSignal } from "../domain/types";
import { round } from "../utils/math";

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

    const lower = Math.min(previousPrice, currentPrice);
    const upper = Math.max(previousPrice, currentPrice);
    const side = currentPrice < previousPrice ? TradeSide.Buy : TradeSide.Sell;

    return levels
      .filter((level) => level.price >= lower && level.price <= upper)
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

  buildOrderIntent(bot: BotAggregate, signal: TriggerSignal): OrderIntent | null {
    const snapshot = bot.latestState;
    const gridCycles = snapshot?.metadata.gridCycles ?? {};
    const availableQuote = snapshot?.availableQuoteAmount ?? bot.config.totalBudgetUsd;
    const targetNotional = round(bot.config.maxDeployableUsd / bot.config.levelCount, 2);
    const requestedQuoteAmount = Math.max(targetNotional, bot.config.minOrderQuoteAmount);

    if (!this.isExecutableLevel(signal.levelIndex, bot.config.levelCount, signal.side)) {
      return null;
    }

    if (signal.side === TradeSide.Buy) {
      if (gridCycles[String(signal.levelIndex)]) {
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
        reason: `${bot.bot.strategyMode}: buy level ${signal.levelIndex}`
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
      reason: `${bot.bot.strategyMode}: sell level ${signal.levelIndex}`,
      matchedLotIds: sellPlan.matchedLotIds
    };
  }

  private buildSellPlan(
    bot: BotAggregate,
    signalLevelIndex: number,
    executionPrice: number
  ): { requestedBaseAmount: number; requestedQuoteAmount: number; matchedLotIds: string[] } | null {
    const gridCycles = bot.latestState?.metadata.gridCycles ?? {};
    const activeCycle = Object.values(gridCycles)
      .filter((cycle) => cycle.sellLevelIndex === signalLevelIndex)
      .sort((left, right) => new Date(left.openedAt).getTime() - new Date(right.openedAt).getTime())[0];

    if (!activeCycle) {
      return null;
    }

    const eligibleLot = bot.openLots.find((lot) => lot.id === activeCycle.lotId && lot.remainingBaseAmount > 0 && lot.costQuote > 0);

    if (!eligibleLot) {
      return null;
    }

    const currentNotional = round(eligibleLot.remainingBaseAmount * executionPrice, 8);
    if (currentNotional <= eligibleLot.costQuote) {
      return null;
    }

    const targetQuoteAmount = this.getTargetQuoteAmount(bot.bot.strategyMode, eligibleLot.costQuote, currentNotional);
    const requestedBaseAmount = round(Math.min(eligibleLot.remainingBaseAmount, targetQuoteAmount / executionPrice), 8);
    const requestedQuoteAmount = round(requestedBaseAmount * executionPrice, 2);

    if (requestedBaseAmount <= 0 || requestedQuoteAmount < bot.config.minOrderQuoteAmount) {
      return null;
    }

    return {
      requestedBaseAmount,
      requestedQuoteAmount,
      matchedLotIds: [eligibleLot.id]
    };
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
