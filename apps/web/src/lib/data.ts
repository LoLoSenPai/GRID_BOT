import { BotMode } from "@grid-bot/core/enums";
import { prisma } from "@grid-bot/db";

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
  if (!mode) {
    return undefined;
  }

  return {
    is: {
      mode: mode as never,
    },
  };
}

function buildScopedOptionalBotRelation(mode?: BotMode) {
  if (!mode) {
    return undefined;
  }

  return {
    OR: [
      { bot: { is: null } },
      { bot: buildScopedBotRelation(mode) },
    ],
  };
}

export async function getDashboardData(mode?: BotMode) {
  const [bots, rawAlerts, orders, executions, rawLogs] = await Promise.all([
    prisma.bot.findMany({
      where: mode ? { mode: mode as never } : undefined,
      include: {
        config: true,
        stateSnapshots: { orderBy: { createdAt: "desc" }, take: 1 },
        position: true,
        priceSnapshots: { orderBy: { capturedAt: "asc" }, take: 24 }
      },
      orderBy: { createdAt: "asc" }
    }),
    prisma.alert.findMany({
      where: buildScopedOptionalBotRelation(mode),
      include: { bot: true },
      orderBy: { createdAt: "desc" },
      take: 24,
    }),
    prisma.order.findMany({
      where: mode ? { bot: { mode: mode as never } } : undefined,
      include: { bot: true },
      orderBy: { createdAt: "desc" },
      take: 8
    }),
    prisma.execution.findMany({
      where: mode ? { bot: { mode: mode as never } } : undefined,
      include: { bot: true, order: true },
      orderBy: { createdAt: "desc" },
      take: 8
    }),
    prisma.systemLog.findMany({
      where: buildScopedOptionalBotRelation(mode),
      include: { bot: true },
      orderBy: { createdAt: "desc" },
      take: 24
    })
  ]);

  const alerts = rawAlerts.filter((alert) => isVisibleIncidentAlert(alert)).slice(0, 8);
  const logs = rawLogs.filter((log) => isVisibleSystemLog(log)).slice(0, 8);

  const botCards = bots.map((bot) => {
    const latest = bot.stateSnapshots[0];
    const low = bot.config ? Number(bot.config.lowPrice) : 0;
    const high = bot.config ? Number(bot.config.highPrice) : 0;
    const price = bot.currentPrice ? Number(bot.currentPrice) : latest?.currentPrice ? Number(latest.currentPrice) : null;
    const equity = latest ? Number(latest.totalEquityUsd) : 0;
    const pnl = latest ? Number(latest.realizedPnlUsd) + Number(latest.unrealizedPnlUsd) : 0;
    const budgetUsed = latest ? Number(latest.deployedQuoteAmount) : 0;
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
      equity,
      sparkline: bot.priceSnapshots.map((snapshot) => Number(snapshot.price)),
      rangeProgress: price === null ? 0 : ((price - low) / rangeSpan) * 100,
      deployableUsage: bot.config ? (budgetUsed / Number(bot.config.maxDeployableUsd || 1)) * 100 : 0,
      baseInventoryValue: bot.position && price ? Number(bot.position.baseAmount) * price : 0,
      latestTickAt: latest?.createdAt ?? null
    };
  });

  const totalEquity = botCards.reduce((sum, bot) => sum + bot.equity, 0);
  const totalPnl = botCards.reduce((sum, bot) => sum + bot.pnl, 0);
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

  return {
    totalEquity,
    totalPnl,
    capitalDeployed,
    activeBots: botCards.filter((bot) => bot.status === "running" || bot.status === "cooldown").length,
    statusCounts,
    topPerformer,
    botCards,
    alerts,
    orders,
    executions,
    logs,
    activityStream
  };
}

export async function getBotsOverview(mode?: BotMode) {
  return prisma.bot.findMany({
    where: mode ? { mode: mode as never } : undefined,
    include: {
      config: true,
      stateSnapshots: { orderBy: { createdAt: "desc" }, take: 1 },
      position: true,
      positionLots: { orderBy: { openedAt: "asc" } },
      orders: {
        orderBy: { createdAt: "desc" },
        take: 80,
        include: {
          executions: {
            orderBy: { createdAt: "desc" },
            take: 1
          }
        }
      },
      priceSnapshots: { orderBy: { capturedAt: "asc" }, take: 240 },
      alerts: { orderBy: { createdAt: "desc" }, take: 24 },
      executions: { orderBy: { createdAt: "desc" }, take: 24, include: { order: true } },
      systemLogs: { orderBy: { createdAt: "desc" }, take: 24 },
      _count: {
        select: {
          orders: true,
          executions: true
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });
}

export async function getBotDetail(botId: string) {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: {
      config: true,
      stateSnapshots: { orderBy: { createdAt: "desc" }, take: 120 },
      position: true,
      positionLots: { orderBy: { openedAt: "asc" } },
      orders: {
        orderBy: { createdAt: "desc" },
        take: 80,
        include: {
          executions: {
            orderBy: { createdAt: "desc" },
            take: 1
          }
        }
      },
      alerts: { orderBy: { createdAt: "desc" }, take: 80 },
      systemLogs: { orderBy: { createdAt: "desc" }, take: 80 },
      priceSnapshots: { orderBy: { capturedAt: "desc" }, take: 240 },
      pnlSnapshots: { orderBy: { createdAt: "desc" }, take: 120 },
      executions: { orderBy: { createdAt: "desc" }, take: 40, include: { order: true } }
    }
  });

  if (!bot) {
    return null;
  }

  return {
    ...bot,
    alerts: bot.alerts.filter((alert) => isVisibleIncidentAlert({ ...alert, bot })).slice(0, 24),
    systemLogs: bot.systemLogs.filter((log) => isVisibleSystemLog(log)).slice(0, 40)
  };
}

export async function getActivityFeed(mode?: BotMode) {
  const [rawAlerts, rawLogs, executions] = await Promise.all([
    prisma.alert.findMany({
      where: buildScopedOptionalBotRelation(mode),
      include: { bot: true },
      orderBy: { createdAt: "desc" },
      take: 120,
    }),
    prisma.systemLog.findMany({
      where: buildScopedOptionalBotRelation(mode),
      include: { bot: true },
      orderBy: { createdAt: "desc" },
      take: 120,
    }),
    prisma.execution.findMany({
      where: mode ? { bot: { mode: mode as never } } : undefined,
      include: { bot: true, order: true },
      orderBy: { createdAt: "desc" },
      take: 40,
    })
  ]);

  const alerts = rawAlerts.filter((alert) => isVisibleIncidentAlert(alert)).slice(0, 40);
  const logs = rawLogs.filter((log) => isVisibleSystemLog(log)).slice(0, 40);

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
