import { getEnv } from "@grid-bot/common";

import { AppShell } from "@/components/app-shell";
import { BotManagementConsole } from "@/components/bot-management-console";
import type { BotDetailViewData } from "@/components/bot-detail-view";
import { requireSession } from "@/lib/auth";
import { BOT_BEHAVIOR_PRESETS, inferBehaviorPresetId, inferPresetId, type BotFormDraft } from "@/lib/bot-management";
import { buildCandlesFromSnapshots } from "@/lib/charting";
import { fetchMarketHistory } from "@/lib/market-history";
import { getNextGridTriggers, parsePendingSignal } from "@/lib/bot-runtime";
import { getBotsOverview } from "@/lib/data";

export default async function BotsPage({
  searchParams
}: {
  searchParams?: Promise<{ botId?: string }>;
}) {
  await requireSession();
  const params = (await searchParams) ?? {};
  const bots = await getBotsOverview();
  const liveTradingEnabled = getEnv().LIVE_TRADING_ENABLED;
  const symbols = Array.from(new Set(bots.map((bot) => bot.baseSymbol as "SOL" | "BTC")));
  const historyEntries = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        return [symbol, await fetchMarketHistory(symbol, "1h")] as const;
      } catch {
        return [symbol, null] as const;
      }
    })
  );
  const historyBySymbol = new Map(historyEntries);

  const viewModel = bots.map((bot) => {
    const config = bot.config;
    const latest = bot.stateSnapshots[0];
    const latestPaperReset = bot.systemLogs.find((log) => log.category === "paper_reset") ?? null;
    const price = bot.currentPrice ? Number(bot.currentPrice) : latest?.currentPrice ? Number(latest.currentPrice) : null;
    const low = Number(config?.lowPrice ?? 0);
    const high = Number(config?.highPrice ?? 0);
    const pnl = latest ? Number(latest.realizedPnlUsd) + Number(latest.unrealizedPnlUsd) : 0;
    const deployableUsage =
      config && latest && Number(config.maxDeployableUsd) > 0 ? (Number(latest.deployedQuoteAmount) / Number(config.maxDeployableUsd)) * 100 : 0;
    const rangeProgress = price !== null && high > low ? ((price - low) / (high - low)) * 100 : 0;
    const presetId = inferPresetId(bot.baseSymbol) ?? "SOL_USDC";
    const draftConfig = {
      presetId,
      name: bot.name,
      strategyMode: bot.strategyMode as BotFormDraft["strategyMode"],
      mode: bot.mode as BotFormDraft["mode"],
      gridType: (config?.gridType ?? "arithmetic") as BotFormDraft["gridType"],
      totalBudgetUsd: Number(config?.totalBudgetUsd ?? 0),
      maxDeployableUsd: Number(config?.maxDeployableUsd ?? 0),
      reserveQuoteAmount: Number(config?.reserveQuoteAmount ?? 0),
      lowPrice: Number(config?.lowPrice ?? 0),
      highPrice: Number(config?.highPrice ?? 0),
      levelCount: config?.levelCount ?? 2,
      minOrderQuoteAmount: Number(config?.minOrderQuoteAmount ?? 0),
      maxSlippageBps: config?.maxSlippageBps ?? 50,
      cooldownMs: config?.cooldownMs ?? 0,
      maxOrdersPerHour: config?.maxOrdersPerHour ?? 1,
      maxDrawdownPct: Number(config?.maxDrawdownPct ?? 0),
      maxConsecutiveFailures: config?.maxConsecutiveFailures ?? 1,
      levelLockMs: config?.levelLockMs ?? 0,
      priceConfirmationWindowMs: config?.priceConfirmationWindowMs ?? 0,
      recenterMode: (config?.recenterMode ?? "manual_recenter") as BotFormDraft["recenterMode"],
      autoRecenterMinIntervalMs: config?.autoRecenterMinIntervalMs ?? 0,
      autoRecenterMaxPerDay: config?.autoRecenterMaxPerDay ?? 0,
      outOfRangePause: config?.outOfRangePause ?? true
    } satisfies BotFormDraft;
    const pendingSignal = parsePendingSignal(latest?.metadata, draftConfig.priceConfirmationWindowMs);
    const nextTriggers = getNextGridTriggers(draftConfig, price);
    const latestOrder = bot.orders[0] ?? null;
    const latestExecution = bot.executions[0] ?? null;
    const latestPaperSignalAt = latest?.lastProcessedAt?.toISOString() ?? null;

    return {
      id: bot.id,
      key: bot.key,
      name: bot.name,
      createdAt: bot.createdAt.toISOString(),
      pairLabel: `${bot.baseSymbol}/${bot.quoteSymbol}`,
      presetId: inferPresetId(bot.baseSymbol),
      strategyMode: bot.strategyMode as BotFormDraft["strategyMode"],
      mode: bot.mode as BotFormDraft["mode"],
      status: bot.status,
      executionProvider: bot.executionProvider,
      currentPrice: price,
      lastHeartbeatAt: bot.lastHeartbeatAt?.toISOString() ?? null,
      sparkline: bot.priceSnapshots.map((snapshot) => Number(snapshot.price)),
      config: draftConfig,
      metrics: {
        deployedQuoteAmount: Number(latest?.deployedQuoteAmount ?? 0),
        equity: Number(latest?.totalEquityUsd ?? 0),
        pnl,
        rangeProgress,
        deployableUsage
      },
      runtime: {
        availableQuoteAmount: Number(latest?.availableQuoteAmount ?? 0),
        availableBaseAmount: Number(latest?.availableBaseAmount ?? 0),
        deployedQuoteAmount: Number(latest?.deployedQuoteAmount ?? 0),
        averageEntryPrice: latest?.averageEntryPrice ? Number(latest.averageEntryPrice) : null,
        realizedPnlUsd: Number(latest?.realizedPnlUsd ?? 0),
        unrealizedPnlUsd: Number(latest?.unrealizedPnlUsd ?? 0),
        totalEquityUsd: Number(latest?.totalEquityUsd ?? 0),
        consecutiveFailures: latest?.consecutiveFailures ?? 0,
        lastProcessedAt: latest?.lastProcessedAt?.toISOString() ?? null,
        lastExecutionAt: latest?.lastExecutionAt?.toISOString() ?? null,
        nextBuyLevel: nextTriggers.nextBuyLevel,
        nextSellLevel: nextTriggers.nextSellLevel,
        pendingSignal: pendingSignal
          ? {
              side: pendingSignal.side,
              levelIndex: pendingSignal.levelIndex,
              firstObservedAt: pendingSignal.firstObservedAt,
              lastObservedPrice: pendingSignal.lastObservedPrice,
              remainingMs: pendingSignal.remainingMs,
              ready: pendingSignal.ready
            }
          : null
      },
      paperSession: {
        enabled: bot.mode === "paper",
        startedAt: (latestPaperReset?.createdAt ?? bot.createdAt).toISOString(),
        lastResetAt: latestPaperReset?.createdAt.toISOString() ?? null,
        ordersCount: bot._count.orders,
        executionsCount: bot._count.executions,
        latestExecutionAt: latestExecution?.createdAt.toISOString() ?? null,
        latestExecutionStatus: latestExecution?.status ?? null,
        latestExecutionInputAmount: latestExecution?.executedInputAmount ? Number(latestExecution.executedInputAmount) : null,
        latestExecutionOutputAmount: latestExecution?.executedOutputAmount ? Number(latestExecution.executedOutputAmount) : null,
        latestExecutionPrice: latestExecution?.quotePrice ? Number(latestExecution.quotePrice) : price,
        latestOrderSide: latestOrder?.side ?? null,
        latestOrderStatus: latestOrder?.status ?? null,
        latestOrderAt: latestOrder?.createdAt.toISOString() ?? null,
        latestSignalAt: latestPaperSignalAt
      }
    };
  });

  const botBoards = Object.fromEntries(
    bots.map((bot) => {
      const config = bot.config;
      const latestState = bot.stateSnapshots[0];
      const currentPrice = bot.currentPrice ? Number(bot.currentPrice) : Number(bot.priceSnapshots.at(-1)?.price ?? 0);
      const levels =
        config && config.levelCount > 1
          ? Array.from({ length: config.levelCount }, (_, index) => {
              if (config.gridType === "arithmetic") {
                const step = (Number(config.highPrice) - Number(config.lowPrice)) / (config.levelCount - 1);
                return Number(config.lowPrice) + step * index;
              }

              const ratio = Math.pow(Number(config.highPrice) / Number(config.lowPrice), 1 / (config.levelCount - 1));
              return Number(config.lowPrice) * ratio ** index;
            })
          : [];
      const runtimeMetadata = latestState?.metadata && typeof latestState.metadata === "object" ? (latestState.metadata as Record<string, unknown>) : null;
      const gridCycles =
        runtimeMetadata && runtimeMetadata.gridCycles && typeof runtimeMetadata.gridCycles === "object"
          ? (runtimeMetadata.gridCycles as Record<string, { buyLevelIndex: number; sellLevelIndex: number | null; lotId: string; openedAt: string }>)
          : {};
      const deployedQuoteAmount = Number(latestState?.deployedQuoteAmount ?? 0);
      const inventoryValue = bot.position ? Number(bot.position.baseAmount) * currentPrice : 0;
      const rangeProgress =
        config && Number(config.highPrice) > Number(config.lowPrice)
          ? Math.max(0, Math.min(100, ((currentPrice - Number(config.lowPrice)) / (Number(config.highPrice) - Number(config.lowPrice))) * 100))
          : 0;
      const deployableUsage = config && Number(config.maxDeployableUsd) > 0 ? (deployedQuoteAmount / Number(config.maxDeployableUsd)) * 100 : 0;
      const priceSnapshots = [...bot.priceSnapshots].map((snapshot) => ({
        time: snapshot.capturedAt.toISOString(),
        value: Number(snapshot.price)
      }));
      const draftConfig = {
        presetId: inferPresetId(bot.baseSymbol) ?? "SOL_USDC",
        strategyMode: bot.strategyMode as Parameters<typeof inferBehaviorPresetId>[0]["strategyMode"],
        cooldownMs: config?.cooldownMs ?? 0,
        priceConfirmationWindowMs: config?.priceConfirmationWindowMs ?? 0,
        lowPrice: Number(config?.lowPrice ?? 0),
        highPrice: Number(config?.highPrice ?? 0),
        levelCount: config?.levelCount ?? 2,
        gridType: config?.gridType ?? "arithmetic"
      };
      const behaviorPresetId = inferBehaviorPresetId(draftConfig);
      const behaviorPreset = BOT_BEHAVIOR_PRESETS[behaviorPresetId];
      const lotLookup = new Map(bot.positionLots.map((lot) => [lot.id, lot]));
      const initialHistory = historyBySymbol.get(bot.baseSymbol as "SOL" | "BTC") ?? null;

      const board: BotDetailViewData = {
        id: bot.id,
        name: bot.name,
        baseSymbol: bot.baseSymbol as "SOL" | "BTC",
        quoteSymbol: bot.quoteSymbol,
        strategyMode: bot.strategyMode,
        mode: bot.mode,
        status: bot.status,
        behavior: {
          id: behaviorPresetId,
          label: behaviorPreset.label,
          summary: behaviorPreset.summary,
          operatorHint: behaviorPreset.operatorHint,
          cycleRule: behaviorPreset.cycleRule,
          exitRule: behaviorPreset.exitRule,
          tags: [...behaviorPreset.tags]
        },
        currentPrice,
        lastHeartbeatAt: bot.lastHeartbeatAt?.toISOString() ?? null,
        config: {
          lowPrice: Number(config?.lowPrice ?? 0),
          highPrice: Number(config?.highPrice ?? 0),
          levelCount: config?.levelCount ?? 0,
          gridType: config?.gridType ?? "arithmetic",
          minOrderQuoteAmount: Number(config?.minOrderQuoteAmount ?? 0),
          maxDeployableUsd: Number(config?.maxDeployableUsd ?? 0),
          reserveQuoteAmount: Number(config?.reserveQuoteAmount ?? 0),
          cooldownMs: config?.cooldownMs ?? 0,
          maxOrdersPerHour: config?.maxOrdersPerHour ?? 0,
          maxDrawdownPct: Number(config?.maxDrawdownPct ?? 0),
          priceConfirmationWindowMs: config?.priceConfirmationWindowMs ?? 0,
          recenterMode: config?.recenterMode ?? "manual_recenter"
        },
        levels,
        position: bot.position
          ? {
              baseAmount: Number(bot.position.baseAmount),
              averageEntryPrice: Number(bot.position.averageEntryPrice),
              realizedPnlUsd: Number(bot.position.realizedPnlUsd),
              unrealizedPnlUsd: Number(bot.position.unrealizedPnlUsd)
            }
          : null,
        metrics: {
          deployedQuoteAmount,
          inventoryValue,
          rangeProgress,
          deployableUsage
        },
        priceSnapshots,
        initialCandles: initialHistory?.candles.length ? initialHistory.candles : buildCandlesFromSnapshots(priceSnapshots, "1h"),
        initialHistorySourceLabel: initialHistory?.meta.source ?? "local snapshots",
        orders: [...bot.orders].reverse().map((order) => ({
          id: order.id,
          time: order.createdAt.toISOString(),
          side: order.side as "buy" | "sell",
          status: order.status,
          levelIndex: order.levelIndex,
          targetPrice: Number(order.targetPrice),
          requestedBaseAmount: Number(order.requestedBaseAmount),
          requestedQuoteAmount: Number(order.requestedQuoteAmount),
          executionSummary: order.executions[0]
            ? `${order.executions[0].provider} ${order.executions[0].status}${order.executions[0].txId ? ` | ${order.executions[0].txId}` : ""}`
            : null
        })),
        positionLots: bot.positionLots.map((lot) => ({
          id: lot.id,
          remainingBaseAmount: Number(lot.remainingBaseAmount),
          entryPrice: Number(lot.entryPrice),
          costQuote: Number(lot.costQuote),
          openedAt: lot.openedAt.toISOString()
        })),
        openCycles: Object.entries(gridCycles)
          .map(([cycleId, cycle]) => {
            const lot = lotLookup.get(cycle.lotId);
            return {
              id: cycleId,
              lotId: cycle.lotId,
              buyLevelIndex: cycle.buyLevelIndex,
              buyPrice: levels[cycle.buyLevelIndex] ?? Number(config?.lowPrice ?? 0),
              sellLevelIndex: cycle.sellLevelIndex,
              sellPrice: cycle.sellLevelIndex !== null ? (levels[cycle.sellLevelIndex] ?? null) : null,
              remainingBaseAmount: lot ? Number(lot.remainingBaseAmount) : 0,
              costQuote: lot ? Number(lot.costQuote) : 0,
              openedAt: cycle.openedAt
            };
          })
          .sort((left, right) => left.buyLevelIndex - right.buyLevelIndex),
        alerts: bot.alerts.map((alert) => ({
          id: alert.id,
          title: alert.title,
          message: alert.message,
          severity: alert.severity,
          createdAt: alert.createdAt.toISOString()
        })),
        systemLogs: bot.systemLogs.map((log) => ({
          id: log.id,
          category: log.category,
          message: log.message,
          level: log.level,
          createdAt: log.createdAt.toISOString()
        }))
      };

      return [bot.id, board];
    })
  );

  const initialSelectedBotId = params.botId && viewModel.some((bot) => bot.id === params.botId) ? params.botId : viewModel[0]?.id ?? null;

  return (
    <AppShell title="Bots" subtitle="Grid terminal" pathname="/bots">
      <BotManagementConsole
        bots={viewModel}
        liveTradingEnabled={liveTradingEnabled}
        initialSelectedBotId={initialSelectedBotId}
        botBoards={botBoards}
      />
    </AppShell>
  );
}
