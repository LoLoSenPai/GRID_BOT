import { logger } from "@grid-bot/common";
import { BotMode, BotStatus } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
export const PORTFOLIO_SNAPSHOT_RETENTION_DAYS = 730;

const ACTIVE_STATUSES = new Set<string>([BotStatus.Running, BotStatus.Cooldown]);

function toNumber(value: { toNumber?: () => number } | number | null | undefined) {
  if (typeof value === "number") {
    return value;
  }

  return value?.toNumber?.() ?? 0;
}

export async function createPortfolioSnapshots(now = new Date()) {
  const results = await Promise.all([createPortfolioSnapshot(BotMode.Paper, now), createPortfolioSnapshot(BotMode.Live, now)]);
  return results.filter(Boolean).length;
}

async function createPortfolioSnapshot(mode: BotMode, now: Date) {
  const bots = await prisma.bot.findMany({
    where: { mode: mode as never },
    select: {
      id: true,
      status: true,
      config: {
        select: {
          maxDeployableUsd: true,
        },
      },
      stateSnapshots: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          deployedQuoteAmount: true,
          realizedPnlUsd: true,
          unrealizedPnlUsd: true,
          totalEquityUsd: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!bots.length) {
    return null;
  }

  const totals = bots.reduce(
    (accumulator, bot) => {
      const latest = bot.stateSnapshots[0];
      const budget = toNumber(bot.config?.maxDeployableUsd);
      const realizedPnl = toNumber(latest?.realizedPnlUsd);
      const unrealizedPnl = toNumber(latest?.unrealizedPnlUsd);

      accumulator.botCount += 1;
      accumulator.activeBotCount += ACTIVE_STATUSES.has(bot.status) ? 1 : 0;
      accumulator.totalBudgetUsd += budget;
      accumulator.capitalDeployedUsd += toNumber(latest?.deployedQuoteAmount);
      accumulator.realizedPnlUsd += realizedPnl;
      accumulator.unrealizedPnlUsd += unrealizedPnl;
      accumulator.totalPnlUsd += realizedPnl + unrealizedPnl;
      accumulator.totalEquityUsd += latest ? toNumber(latest.totalEquityUsd) : budget;
      return accumulator;
    },
    {
      botCount: 0,
      activeBotCount: 0,
      totalBudgetUsd: 0,
      capitalDeployedUsd: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      totalPnlUsd: 0,
      totalEquityUsd: 0,
    },
  );

  return prisma.portfolioSnapshot.create({
    data: {
      mode: mode as never,
      botCount: totals.botCount,
      activeBotCount: totals.activeBotCount,
      totalBudgetUsd: totals.totalBudgetUsd,
      capitalDeployedUsd: totals.capitalDeployedUsd,
      realizedPnlUsd: totals.realizedPnlUsd,
      unrealizedPnlUsd: totals.unrealizedPnlUsd,
      totalPnlUsd: totals.totalPnlUsd,
      totalEquityUsd: totals.totalEquityUsd,
      createdAt: now,
    },
  });
}

export function prunePortfolioSnapshots(now = new Date()) {
  const cutoff = new Date(now.getTime() - PORTFOLIO_SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return prisma.portfolioSnapshot.deleteMany({
    where: {
      createdAt: {
        lt: cutoff,
      },
    },
  });
}

export function getPortfolioSnapshotIntervalMs() {
  return FIVE_MINUTES_MS;
}

export async function safeCreatePortfolioSnapshots(now = new Date()) {
  try {
    const created = await createPortfolioSnapshots(now);
    logger.debug({ created }, "Portfolio snapshots captured");
    return created;
  } catch (error) {
    logger.error({ error }, "Portfolio snapshot capture failed");
    return 0;
  }
}
