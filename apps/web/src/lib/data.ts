import { BotMode } from "@grid-bot/core/enums";
import { findLatestBotStateSnapshot, findLatestBotStateSnapshots, prisma } from "@grid-bot/db";

const BOT_DETAIL_EXECUTION_HISTORY_LIMIT = 500;
const PORTFOLIO_HISTORY_LOOKBACK_DAYS = 180;
const PORTFOLIO_HISTORY_MAX_POINTS = 360;

type PortfolioHistoryRow = {
  bucket: Date;
  bot_count: number;
  active_bot_count: number;
  total_budget_usd: unknown;
  capital_deployed_usd: unknown;
  realized_pnl_usd: unknown;
  unrealized_pnl_usd: unknown;
  total_pnl_usd: unknown;
  total_equity_usd: unknown;
};

function numberFromDatabase(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }

  return Number(value ?? 0);
}

function downsamplePoints<T>(points: T[], maxPoints: number) {
  if (points.length <= maxPoints) {
    return points;
  }

  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
}

async function getPortfolioHistory(mode: BotMode) {
  const cutoff = new Date(Date.now() - PORTFOLIO_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<PortfolioHistoryRow[]>`
    SELECT DISTINCT ON (bucket)
      bucket,
      "created_at",
      "bot_count",
      "active_bot_count",
      "total_budget_usd",
      "capital_deployed_usd",
      "realized_pnl_usd",
      "unrealized_pnl_usd",
      "total_pnl_usd",
      "total_equity_usd"
    FROM (
      SELECT
        date_trunc('hour', "created_at") AS bucket,
        "created_at",
        "bot_count",
        "active_bot_count",
        "total_budget_usd",
        "capital_deployed_usd",
        "realized_pnl_usd",
        "unrealized_pnl_usd",
        "total_pnl_usd",
        "total_equity_usd"
      FROM "portfolio_snapshots"
      WHERE "mode" = CAST(${mode} AS "BotMode")
        AND "created_at" >= ${cutoff}
    ) hourly
    ORDER BY bucket ASC, "created_at" DESC
  `;

  return downsamplePoints(
    rows.map((row) => ({
      time: row.bucket.toISOString(),
      botCount: row.bot_count,
      activeBotCount: row.active_bot_count,
      totalBudgetUsd: numberFromDatabase(row.total_budget_usd),
      capitalDeployedUsd: numberFromDatabase(row.capital_deployed_usd),
      realizedPnlUsd: numberFromDatabase(row.realized_pnl_usd),
      unrealizedPnlUsd: numberFromDatabase(row.unrealized_pnl_usd),
      totalPnlUsd: numberFromDatabase(row.total_pnl_usd),
      totalEquityUsd: numberFromDatabase(row.total_equity_usd),
    })),
    PORTFOLIO_HISTORY_MAX_POINTS,
  );
}

function isVisibleIncidentAlert(alert: { type: string; bot?: { status: string } | null }) {
  if (alert.type === "bot_out_of_range") {
    return false;
  }

  if (alert.type === "infrastructure_degraded" && alert.bot && alert.bot.status !== "error") {
    return false;
  }

  return true;
}

function isVisibleSystemLog(log: { category: string; level: string; message: string }) {
  if (log.level === "debug") {
    return false;
  }

  if (log.category === "engine" && log.level === "info" && log.message.includes("skipped: empty intent")) {
    return false;
  }

  return true;
}

function buildScopedBotRelation(mode?: BotMode) {
  return {
    is: {
      archivedAt: null,
      ...(mode ? { mode: mode as never } : {}),
    },
  };
}

function buildScopedOptionalBotRelation(mode?: BotMode) {
  return {
    OR: [
      { bot: { is: null } },
      { bot: buildScopedBotRelation(mode) },
    ],
  };
}

function buildVisibleBotWhere(mode?: BotMode) {
  return {
    archivedAt: null,
    ...(mode ? { mode: mode as never } : {}),
  };
}

function buildVisibleBotExecutionWhere(mode?: BotMode) {
  return {
    bot: {
      archivedAt: null,
      ...(mode ? { mode: mode as never } : {}),
    },
  };
}

async function getArchivedClosedPnl(mode: BotMode) {
  const bots = await prisma.bot.findMany({
    where: {
      mode: mode as never,
      archivedAt: { not: null },
    },
    select: {
      id: true,
      position: {
        select: {
          realizedPnlUsd: true,
          unrealizedPnlUsd: true,
        },
      },
    },
  });
  const latestStateByBotId = await findLatestBotStateSnapshots(bots.map((bot) => bot.id));

  return bots.reduce((sum, bot) => {
    if (bot.position) {
      return sum + numberFromDatabase(bot.position.realizedPnlUsd) + numberFromDatabase(bot.position.unrealizedPnlUsd);
    }

    const latest = latestStateByBotId.get(bot.id);
    return sum + numberFromDatabase(latest?.realizedPnlUsd) + numberFromDatabase(latest?.unrealizedPnlUsd);
  }, 0);
}

export async function getDashboardData(mode?: BotMode) {
  const scopedMode = mode ?? BotMode.Paper;
  const [bots, rawAlerts, executions, rawLogs, archivedClosedPnl] = await Promise.all([
    prisma.bot.findMany({
      where: buildVisibleBotWhere(mode),
      include: {
        config: true,
      },
      orderBy: { createdAt: "asc" }
    }),
    prisma.alert.findMany({
      where: buildScopedOptionalBotRelation(mode),
      include: { bot: true },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    prisma.execution.findMany({
      where: buildVisibleBotExecutionWhere(mode),
      include: { bot: true, order: true },
      orderBy: { createdAt: "desc" },
      take: 6
    }),
    prisma.systemLog.findMany({
      where: buildScopedOptionalBotRelation(mode),
      include: { bot: true },
      orderBy: { createdAt: "desc" },
      take: 12
    }),
    getArchivedClosedPnl(scopedMode),
  ]);

  const alerts = rawAlerts.filter((alert) => isVisibleIncidentAlert(alert)).slice(0, 8);
  const logs = rawLogs.filter((log) => isVisibleSystemLog(log)).slice(0, 8);
  const latestStateByBotId = await findLatestBotStateSnapshots(bots.map((bot) => bot.id));

  const botCards = bots.map((bot) => {
    const latest = latestStateByBotId.get(bot.id);
    const low = bot.config ? Number(bot.config.lowPrice) : 0;
    const high = bot.config ? Number(bot.config.highPrice) : 0;
    const price = bot.currentPrice ? Number(bot.currentPrice) : latest?.currentPrice ? Number(latest.currentPrice) : null;
    const equity = latest ? Number(latest.totalEquityUsd) : 0;
    const realizedPnl = latest ? Number(latest.realizedPnlUsd) : 0;
    const unrealizedPnl = latest ? Number(latest.unrealizedPnlUsd) : 0;
    const pnl = realizedPnl + unrealizedPnl;
    const budgetUsed = latest ? Number(latest.deployedQuoteAmount) : 0;
    const budgetUsd = bot.config ? Number(bot.config.maxDeployableUsd) : 0;
    const rangeSpan = high - low || 1;

    return {
      id: bot.id,
      name: bot.name,
      pair: `${bot.baseSymbol}/${bot.quoteSymbol}`,
      strategy: bot.strategyMode,
      mode: bot.mode,
      status: bot.status,
      gridType: bot.config?.gridType ?? null,
      levelCount: bot.config?.levelCount ?? 0,
      recenterMode: bot.config?.recenterMode ?? null,
      range: [low, high] as [number, number],
      price,
      budgetUsed,
      pnl,
      realizedPnl,
      unrealizedPnl,
      equity,
      budgetUsd,
      sparkline: [],
      rangeProgress: price === null ? 0 : ((price - low) / rangeSpan) * 100,
      deployableUsage: bot.config ? (budgetUsed / Number(bot.config.maxDeployableUsd || 1)) * 100 : 0,
      baseInventoryValue: 0,
      latestTickAt: latest?.createdAt ?? null
    };
  });

  const totalEquity = botCards.reduce((sum, bot) => sum + bot.equity, 0);
  const activeBotPnl = botCards.reduce((sum, bot) => sum + bot.pnl, 0);
  const totalPnl = activeBotPnl + archivedClosedPnl;
  const capitalDeployed = botCards.reduce((sum, bot) => sum + bot.budgetUsed, 0);
  const topPerformer = [...botCards].sort((left, right) => right.pnl - left.pnl)[0] ?? null;
  const statusCounts = {
    running: botCards.filter((bot) => bot.status === "running").length,
    cooldown: botCards.filter((bot) => bot.status === "cooldown").length,
    paused: botCards.filter((bot) => bot.status === "paused").length,
    outOfRange: botCards.filter((bot) => bot.status === "out_of_range").length,
    error: botCards.filter((bot) => bot.status === "error").length
  };

  const activityStream = [
    ...alerts.map((alert) => ({
      id: alert.id,
      kind: "alert" as const,
      timestamp: alert.createdAt,
      botName: alert.bot?.name ?? "System",
      title: alert.title,
      detail: alert.message,
      tone: alert.severity === "critical" ? "red" : alert.severity === "warning" ? "amber" : "blue"
    })),
    ...executions.map((execution) => ({
      id: execution.id,
      kind: "execution" as const,
      timestamp: execution.createdAt,
      botName: execution.bot.name,
      title: `${execution.provider} ${execution.status}`,
      detail: execution.txId ?? execution.executionRef,
      tone: execution.status === "failed" ? "red" : execution.status === "simulated" ? "blue" : "green"
    })),
    ...logs.map((log) => ({
      id: log.id,
      kind: "log" as const,
      timestamp: log.createdAt,
      botName: log.bot?.name ?? "System",
      title: log.category,
      detail: log.message,
      tone: log.level === "error" ? "red" : log.level === "warn" ? "amber" : "blue"
    }))
  ]
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())
    .slice(0, 10);
  const portfolioHistory = await getPortfolioHistory(scopedMode);
  const currentPortfolioPoint = {
    time: new Date().toISOString(),
    botCount: botCards.length,
    activeBotCount: botCards.filter((bot) => bot.status === "running" || bot.status === "cooldown").length,
    totalBudgetUsd: botCards.reduce((sum, bot) => sum + bot.budgetUsd, 0),
    capitalDeployedUsd: capitalDeployed,
    realizedPnlUsd: botCards.reduce((sum, bot) => sum + bot.realizedPnl, 0) + archivedClosedPnl,
    unrealizedPnlUsd: botCards.reduce((sum, bot) => sum + bot.unrealizedPnl, 0),
    totalPnlUsd: totalPnl,
    totalEquityUsd: totalEquity,
  };

  return {
    totalEquity,
    totalPnl,
    capitalDeployed,
    activeBots: botCards.filter((bot) => bot.status === "running" || bot.status === "cooldown").length,
    statusCounts,
    topPerformer,
    botCards,
    alerts,
    executions,
    logs,
    activityStream,
    portfolioHistory: [...portfolioHistory, currentPortfolioPoint],
  };
}

export async function getBotsOverview(mode?: BotMode) {
  const bots = await prisma.bot.findMany({
    where: buildVisibleBotWhere(mode),
    include: {
      config: true,
      orders: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          executions: {
            orderBy: { createdAt: "desc" },
            take: 1
          }
        }
      },
      executions: { orderBy: { createdAt: "desc" }, take: 1, include: { order: true } },
      systemLogs: { where: { category: "paper_reset" }, orderBy: { createdAt: "desc" }, take: 1 },
      _count: {
        select: {
          orders: true,
          executions: true
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });
  const latestStateByBotId = await findLatestBotStateSnapshots(bots.map((bot) => bot.id));

  return bots.map((bot) => ({
    ...bot,
    stateSnapshots: latestStateByBotId.get(bot.id) ? [latestStateByBotId.get(bot.id)!] : [],
  }));
}

export async function getBotDetail(botId: string, mode?: BotMode) {
  const bot = await prisma.bot.findFirst({
    where: {
      id: botId,
      archivedAt: null,
      ...(mode ? { mode: mode as never } : {})
    },
    include: {
      config: true,
      position: true,
      positionLots: {
        where: { remainingBaseAmount: { gt: 0 } },
        orderBy: { openedAt: "asc" },
        take: 32
      },
      orders: {
        orderBy: { createdAt: "desc" },
        take: 12,
        include: {
          executions: {
            orderBy: { createdAt: "desc" },
            take: 1
          }
        }
      },
      alerts: { orderBy: { createdAt: "desc" }, take: 8 },
      systemLogs: { orderBy: { createdAt: "desc" }, take: 8 },
      priceSnapshots: { orderBy: { capturedAt: "desc" }, take: 32 },
      executions: {
        orderBy: { createdAt: "desc" },
        take: BOT_DETAIL_EXECUTION_HISTORY_LIMIT,
        include: { order: true }
      }
    }
  });

  if (!bot) {
    return null;
  }
  const latestState = await findLatestBotStateSnapshot(bot.id);

  return {
    ...bot,
    stateSnapshots: latestState ? [latestState] : [],
    alerts: bot.alerts.filter((alert) => isVisibleIncidentAlert({ ...alert, bot })).slice(0, 8),
    systemLogs: bot.systemLogs.filter((log) => isVisibleSystemLog(log)).slice(0, 8)
  };
}

export async function getActivityFeed(mode?: BotMode) {
  const [rawAlerts, rawLogs, executions] = await Promise.all([
    prisma.alert.findMany({
      where: buildScopedOptionalBotRelation(mode),
      include: { bot: true },
      orderBy: { createdAt: "desc" },
      take: 48,
    }),
    prisma.systemLog.findMany({
      where: buildScopedOptionalBotRelation(mode),
      include: { bot: true },
      orderBy: { createdAt: "desc" },
      take: 48,
    }),
    prisma.execution.findMany({
      where: buildVisibleBotExecutionWhere(mode),
      include: { bot: true, order: true },
      orderBy: { createdAt: "desc" },
      take: 24,
    })
  ]);

  const alerts = rawAlerts.filter((alert) => isVisibleIncidentAlert(alert)).slice(0, 24);
  const logs = rawLogs.filter((log) => isVisibleSystemLog(log)).slice(0, 24);

  const timeline = [
    ...alerts.map((alert) => ({
      id: `alert-${alert.id}`,
      kind: "alert" as const,
      timestamp: alert.createdAt,
      botName: alert.bot?.name ?? "System",
      heading: alert.title,
      detail: alert.message,
      tone: alert.severity === "critical" ? "red" : alert.severity === "warning" ? "amber" : "blue"
    })),
    ...logs.map((log) => ({
      id: `log-${log.id}`,
      kind: "log" as const,
      timestamp: log.createdAt,
      botName: log.bot?.name ?? "System",
      heading: log.category,
      detail: log.message,
      tone: log.level === "error" ? "red" : log.level === "warn" ? "amber" : "blue"
    })),
    ...executions.map((execution) => ({
      id: `execution-${execution.id}`,
      kind: "execution" as const,
      timestamp: execution.createdAt,
      botName: execution.bot.name,
      heading: `${execution.provider} ${execution.status}`,
      detail: execution.txId ?? execution.executionRef,
      tone: execution.status === "failed" ? "red" : execution.status === "simulated" ? "blue" : "green"
    }))
  ].sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime());

  return {
    alerts,
    logs,
    executions,
    timeline,
    summary: {
      alertCount: alerts.length,
      criticalAlerts: alerts.filter((alert) => alert.severity === "critical").length,
      executionFailures: executions.filter((execution) => execution.status === "failed").length,
      errorLogs: logs.filter((log) => log.level === "error").length
    }
  };
}
