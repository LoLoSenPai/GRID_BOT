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

function floorToSnapshotBucket(date: Date) {
  return new Date(Math.floor(date.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS);
}

export async function backfillPortfolioSnapshotsFromRuntime(now = new Date()) {
  const results = await Promise.all([backfillPortfolioSnapshotsForMode(BotMode.Paper, now), backfillPortfolioSnapshotsForMode(BotMode.Live, now)]);
  return results.reduce((sum, count) => sum + count, 0);
}

async function backfillPortfolioSnapshotsForMode(mode: BotMode, now: Date) {
  const earliestRuntimeSnapshot = await prisma.botStateSnapshot.findFirst({
    where: {
      bot: {
        mode: mode as never,
      },
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  if (!earliestRuntimeSnapshot) {
    return 0;
  }

  const firstBackfillBucket = floorToSnapshotBucket(earliestRuntimeSnapshot.createdAt);
  const oldestPortfolioSnapshot = await prisma.portfolioSnapshot.findFirst({
    where: { mode: mode as never },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  if (oldestPortfolioSnapshot && oldestPortfolioSnapshot.createdAt.getTime() <= firstBackfillBucket.getTime() + 1000) {
    return 0;
  }

  const inserted = await prisma.$executeRaw`
    WITH bounds AS (
      SELECT
        to_timestamp(floor(extract(epoch from MIN(s."createdAt")) / 300) * 300) AS start_bucket,
        to_timestamp(floor(extract(epoch from ${now}::timestamp) / 300) * 300) AS end_bucket
      FROM "bot_state_snapshots" s
      INNER JOIN "bots" b ON b."id" = s."botId"
      WHERE b."mode" = CAST(${mode} AS "BotMode")
    ),
    series AS (
      SELECT generate_series(start_bucket, end_bucket, interval '5 minutes') AS bucket
      FROM bounds
      WHERE start_bucket IS NOT NULL
    ),
    rollup AS (
      SELECT
        series.bucket,
        COUNT(latest."id")::int AS bot_count,
        COUNT(latest."id") FILTER (WHERE latest."status" IN ('running'::"BotStatus", 'cooldown'::"BotStatus"))::int AS active_bot_count,
        COALESCE(SUM(CASE WHEN latest."id" IS NOT NULL THEN config."maxDeployableUsd" ELSE 0 END), 0) AS total_budget_usd,
        COALESCE(SUM(latest."deployedQuoteAmount"), 0) AS capital_deployed_usd,
        COALESCE(SUM(latest."realizedPnlUsd"), 0) AS realized_pnl_usd,
        COALESCE(SUM(latest."unrealizedPnlUsd"), 0) AS unrealized_pnl_usd,
        COALESCE(SUM(latest."realizedPnlUsd" + latest."unrealizedPnlUsd"), 0) AS total_pnl_usd,
        COALESCE(SUM(latest."totalEquityUsd"), 0) AS total_equity_usd
      FROM series
      INNER JOIN "bots" bot ON bot."mode" = CAST(${mode} AS "BotMode")
        AND bot."createdAt" <= series.bucket
      LEFT JOIN "bot_configs" config ON config."botId" = bot."id"
      LEFT JOIN LATERAL (
        SELECT
          state."id",
          state."status",
          state."deployedQuoteAmount",
          state."realizedPnlUsd",
          state."unrealizedPnlUsd",
          state."totalEquityUsd"
        FROM "bot_state_snapshots" state
        WHERE state."botId" = bot."id"
          AND state."createdAt" <= series.bucket
        ORDER BY state."createdAt" DESC
        LIMIT 1
      ) latest ON TRUE
      GROUP BY series.bucket
      HAVING COUNT(latest."id") > 0
    )
    INSERT INTO "portfolio_snapshots" (
      "id",
      "mode",
      "bot_count",
      "active_bot_count",
      "total_budget_usd",
      "capital_deployed_usd",
      "realized_pnl_usd",
      "unrealized_pnl_usd",
      "total_pnl_usd",
      "total_equity_usd",
      "created_at"
    )
    SELECT
      'portfolio_backfill_' || ${mode} || '_' || extract(epoch from bucket)::bigint::text,
      CAST(${mode} AS "BotMode"),
      bot_count,
      active_bot_count,
      total_budget_usd,
      capital_deployed_usd,
      realized_pnl_usd,
      unrealized_pnl_usd,
      total_pnl_usd,
      total_equity_usd,
      bucket
    FROM rollup
    ON CONFLICT ("id") DO NOTHING
  `;

  return Number(inserted);
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

export async function safeBackfillPortfolioSnapshots(now = new Date()) {
  try {
    const inserted = await backfillPortfolioSnapshotsFromRuntime(now);
    if (inserted > 0) {
      logger.info({ inserted }, "Portfolio snapshots backfilled from runtime history");
    }
    return inserted;
  } catch (error) {
    logger.error({ error }, "Portfolio snapshot backfill failed");
    return 0;
  }
}
