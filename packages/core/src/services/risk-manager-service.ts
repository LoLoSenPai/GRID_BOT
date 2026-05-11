import { AlertType, BotStatus, TradeSide } from "../domain/enums";
import type { BotAggregate, MarketPrice, OrderIntent, TriggerSignal } from "../domain/types";

export interface RiskCheckResult {
  allowed: boolean;
  reasons: string[];
  nextStatus?: BotStatus;
  alertType?: AlertType;
}

export class RiskManagerService {
  evaluate(bot: BotAggregate, signal: TriggerSignal, order: OrderIntent, marketPrice: MarketPrice, now = new Date()): RiskCheckResult {
    const reasons: string[] = [];
    const snapshot = bot.latestState;
    const metadata = snapshot?.metadata;
    const levelLockUntil = metadata?.levelLocks[String(signal.levelIndex)];
    const isSell = signal.side === TradeSide.Sell;

    if (bot.bot.status === BotStatus.Stopped || bot.bot.status === BotStatus.Paused) {
      reasons.push(`bot is ${bot.bot.status}`);
    }

    const isLowerBoundaryBuy =
      signal.side === TradeSide.Buy &&
      signal.levelIndex === 0 &&
      marketPrice.price <= order.targetPrice;

    if (
      bot.bot.status === BotStatus.OutOfRange &&
      bot.config.recenterMode === "manual_recenter" &&
      signal.side === TradeSide.Buy &&
      !isLowerBoundaryBuy
    ) {
      reasons.push("bot is out of range");
    }

    if (!isSell && levelLockUntil && new Date(levelLockUntil) > now) {
      reasons.push("level is locked");
    }

    if (!isSell && snapshot?.lastExecutionAt && now.getTime() - snapshot.lastExecutionAt.getTime() < bot.config.cooldownMs) {
      reasons.push("bot is cooling down");
    }

    if (!isSell && snapshot && this.countExecutionsInLastHour(snapshot.metadata.recentExecutions, now) >= bot.config.maxOrdersPerHour) {
      return {
        allowed: false,
        reasons: ["max orders per hour reached"],
        nextStatus: BotStatus.Paused,
        alertType: AlertType.BudgetMaxReached
      };
    }

    if (snapshot && snapshot.consecutiveFailures >= bot.config.maxConsecutiveFailures) {
      return {
        allowed: false,
        reasons: ["max consecutive failures reached"],
        nextStatus: BotStatus.Error,
        alertType: AlertType.ConsecutiveFailures
      };
    }

    if (signal.side === TradeSide.Buy && order.requestedQuoteAmount > bot.config.maxDeployableUsd) {
      reasons.push("order exceeds max deployable budget");
    }

    if (!isSell && snapshot && snapshot.totalEquityUsd > 0) {
      const drawdown = ((bot.config.totalBudgetUsd - snapshot.totalEquityUsd) / bot.config.totalBudgetUsd) * 100;
      if (drawdown >= bot.config.maxDrawdownPct) {
        return {
          allowed: false,
          reasons: ["max drawdown reached"],
          nextStatus: BotStatus.Paused,
          alertType: AlertType.DrawdownThreshold
        };
      }
    }

    if (!Number.isFinite(marketPrice.price) || marketPrice.price <= 0) {
      return {
        allowed: false,
        reasons: ["invalid market price"],
        nextStatus: BotStatus.Error,
        alertType: AlertType.InfrastructureDegraded
      };
    }

    return {
      allowed: reasons.length === 0,
      reasons
    };
  }

  private countExecutionsInLastHour(executions: string[], now: Date): number {
    const threshold = now.getTime() - 3_600_000;
    return executions.filter((entry) => new Date(entry).getTime() >= threshold).length;
  }
}
