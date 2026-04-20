import { BotMode } from "@grid-bot/core/enums";

import type { BotDetailViewData } from "@/components/bot-detail-view";
import { BOT_BEHAVIOR_PRESETS, BOT_PAIR_PRESETS, inferBehaviorPresetId, inferPresetId, type BotFormDraft, type BotPairPresetId } from "@/lib/bot-management";
import { calculateGridLevels, getNextGridTriggers, parsePendingSignal } from "@/lib/bot-runtime";
import { buildCandlesFromSnapshots } from "@/lib/charting";
import type { getBotDetail, getBotsOverview } from "@/lib/data";

const PREVIEW_SYMBOLS = ["SOL", "BTC"] as const;
export type PreviewSymbol = (typeof PREVIEW_SYMBOLS)[number];

export type MarketPreviewHistory = {
  candles: BotDetailViewData["initialCandles"];
  meta: {
    source: string;
  };
} | null;

type OverviewBot = Awaited<ReturnType<typeof getBotsOverview>>[number];
type DetailBot = NonNullable<Awaited<ReturnType<typeof getBotDetail>>>;

function deriveExecutionAmounts(
  side: "buy" | "sell",
  execution: {
    executedInputAmount: { toString(): string } | null;
    executedOutputAmount: { toString(): string } | null;
    quotePrice: { toString(): string } | null;
  },
  order: {
    requestedQuoteAmount: { toString(): string };
    requestedBaseAmount: { toString(): string };
  }
) {
  const requestedQuoteAmount = Number(order.requestedQuoteAmount);
  const requestedBaseAmount = Number(order.requestedBaseAmount);
  const executedInputAmount = execution.executedInputAmount ? Number(execution.executedInputAmount) : null;
  const executedOutputAmount = execution.executedOutputAmount ? Number(execution.executedOutputAmount) : null;
  const quoteAmount = side === "buy" ? executedInputAmount ?? requestedQuoteAmount : executedOutputAmount ?? requestedQuoteAmount;
  const baseAmount = side === "buy" ? executedOutputAmount ?? requestedBaseAmount : executedInputAmount ?? requestedBaseAmount;
  const effectivePrice = quoteAmount > 0 && baseAmount > 0 ? quoteAmount / baseAmount : execution.quotePrice ? Number(execution.quotePrice) : null;

  return {
    quoteAmount,
    baseAmount,
    effectivePrice
  };
}

function isVisibleSystemLog(log: { category: string; level: string; message: string }) {
  return !(log.category === "engine" && log.level === "info" && log.message.includes("skipped: empty intent"));
}

function getPairPresetIdFromSymbol(symbol: PreviewSymbol): BotPairPresetId {
  return symbol === "SOL" ? "SOL_USDC" : "BTC_USDC";
}

function toDraftConfig(bot: Pick<OverviewBot, "baseSymbol" | "name" | "strategyMode" | "mode" | "config">): BotFormDraft {
  const config = bot.config;
  return {
    presetId: inferPresetId(bot.baseSymbol) ?? "SOL_USDC",
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
  };
}

function serializePriceSnapshots(snapshots: Array<{ capturedAt: Date; price: { toString(): string } }>) {
  return [...snapshots]
    .sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime())
    .map((snapshot) => ({
      time: snapshot.capturedAt.toISOString(),
      value: Number(snapshot.price)
    }));
}

export function buildMarketPreviewBoard(symbol: PreviewSymbol, history: MarketPreviewHistory, mode: BotMode): BotDetailViewData {
  const presetId = getPairPresetIdFromSymbol(symbol);
  const pairPreset = BOT_PAIR_PRESETS[presetId];
  const draft = {
    presetId,
    name: pairPreset.defaultName,
    ...pairPreset.defaults,
    mode
  } satisfies BotFormDraft;
  const behaviorPreset = BOT_BEHAVIOR_PRESETS[inferBehaviorPresetId(draft)];
  const candles = history?.candles ?? [];
  const currentPrice = candles.at(-1)?.close ?? Number(pairPreset.defaults.lowPrice);
  const levels = calculateGridLevels(draft);

  return {
    id: `preview-${symbol.toLowerCase()}-${mode}`,
    name: pairPreset.defaultName,
    baseSymbol: pairPreset.baseSymbol,
    quoteSymbol: pairPreset.quoteSymbol,
    strategyMode: draft.strategyMode,
    mode,
    status: "paused",
    behavior: {
      id: behaviorPreset.id,
      label: behaviorPreset.label,
      summary: behaviorPreset.summary,
      operatorHint: behaviorPreset.operatorHint,
      cycleRule: behaviorPreset.cycleRule,
      exitRule: behaviorPreset.exitRule,
      tags: [...behaviorPreset.tags]
    },
    currentPrice,
    lastHeartbeatAt: null,
    config: {
      lowPrice: Number(draft.lowPrice),
      highPrice: Number(draft.highPrice),
      levelCount: draft.levelCount,
      gridType: draft.gridType,
      minOrderQuoteAmount: Number(draft.minOrderQuoteAmount),
      maxDeployableUsd: Number(draft.maxDeployableUsd),
      reserveQuoteAmount: Number(draft.reserveQuoteAmount),
      cooldownMs: draft.cooldownMs,
      maxOrdersPerHour: draft.maxOrdersPerHour,
      maxDrawdownPct: Number(draft.maxDrawdownPct),
      priceConfirmationWindowMs: draft.priceConfirmationWindowMs,
      recenterMode: draft.recenterMode
    },
    levels,
    position: null,
    metrics: {
      deployedQuoteAmount: 0,
      inventoryValue: 0,
      rangeProgress:
        Number(draft.highPrice) > Number(draft.lowPrice)
          ? Math.max(0, Math.min(100, ((currentPrice - Number(draft.lowPrice)) / (Number(draft.highPrice) - Number(draft.lowPrice))) * 100))
          : 0,
      deployableUsage: 0
    },
    priceSnapshots: candles.slice(-120).map((candle) => ({
      time: candle.time,
      value: candle.close
    })),
    initialCandles: candles,
    initialHistorySourceLabel: history?.meta.source ?? "pyth-history",
    orders: [],
    executions: [],
    positionLots: [],
    openCycles: [],
    alerts: [],
    systemLogs: []
  };
}

export function serializeBotOverview(bot: OverviewBot) {
  const config = bot.config;
  const latest = bot.stateSnapshots[0];
  const latestPaperReset = bot.systemLogs.find((log) => log.category === "paper_reset") ?? null;
  const price = bot.currentPrice ? Number(bot.currentPrice) : latest?.currentPrice ? Number(latest.currentPrice) : null;
  const low = Number(config?.lowPrice ?? 0);
  const high = Number(config?.highPrice ?? 0);
  const pnl = latest ? Number(latest.realizedPnlUsd) + Number(latest.unrealizedPnlUsd) : 0;
  const deployableUsage = config && latest && Number(config.maxDeployableUsd) > 0 ? (Number(latest.deployedQuoteAmount) / Number(config.maxDeployableUsd)) * 100 : 0;
  const rangeProgress = price !== null && high > low ? ((price - low) / (high - low)) * 100 : 0;
  const draftConfig = toDraftConfig(bot);
  const pendingSignal = parsePendingSignal(latest?.metadata, draftConfig.priceConfirmationWindowMs);
  const nextTriggers = getNextGridTriggers(draftConfig, price);
  const latestOrder = bot.orders[0] ?? null;
  const latestExecution = bot.executions[0] ?? null;
  const latestExecutionAmounts = latestExecution ? deriveExecutionAmounts(latestExecution.order.side as "buy" | "sell", latestExecution, latestExecution.order) : null;
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
    sparkline: [],
    latestExecution: latestExecution
      ? {
          id: latestExecution.id,
          orderId: latestExecution.orderId,
          time: (latestExecution.completedAt ?? latestExecution.createdAt).toISOString(),
          status: latestExecution.status,
          side: latestExecution.order.side as "buy" | "sell",
          levelIndex: latestExecution.order.levelIndex,
          targetPrice: Number(latestExecution.order.targetPrice),
          quoteAmount: latestExecutionAmounts?.quoteAmount ?? null,
          baseAmount: latestExecutionAmounts?.baseAmount ?? null,
          effectivePrice: latestExecutionAmounts?.effectivePrice ?? null,
          provider: latestExecution.provider,
          executionRef: latestExecution.executionRef,
          txId: latestExecution.txId,
          errorMessage: latestExecution.errorMessage,
          reason: latestExecution.order.reason
        }
      : null,
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
      latestExecutionId: latestExecution?.id ?? null,
      latestExecutionSide: latestExecution?.order.side ?? null,
      latestExecutionAt: latestExecution?.createdAt.toISOString() ?? null,
      latestExecutionStatus: latestExecution?.status ?? null,
      latestExecutionInputAmount: latestExecution?.executedInputAmount ? Number(latestExecution.executedInputAmount) : null,
      latestExecutionOutputAmount: latestExecution?.executedOutputAmount ? Number(latestExecution.executedOutputAmount) : null,
        latestExecutionPrice: latestExecutionAmounts?.effectivePrice ?? price,
      latestExecutionTxId: latestExecution?.txId ?? null,
      latestOrderSide: latestOrder?.side ?? null,
      latestOrderStatus: latestOrder?.status ?? null,
      latestOrderAt: latestOrder?.createdAt.toISOString() ?? null,
      latestSignalAt: latestPaperSignalAt
    }
  };
}

export function serializeBotBoard(bot: DetailBot): BotDetailViewData {
  const config = bot.config;
  const latestState = bot.stateSnapshots[0];
  const priceSnapshots = serializePriceSnapshots(bot.priceSnapshots);
  const currentPrice = bot.currentPrice ? Number(bot.currentPrice) : Number(priceSnapshots.at(-1)?.value ?? 0);
  const draftConfig = toDraftConfig(bot);
  const levels = calculateGridLevels(draftConfig);
  const runtimeMetadata = latestState?.metadata && typeof latestState.metadata === "object" ? (latestState.metadata as Record<string, unknown>) : null;
  const gridCycles =
    runtimeMetadata && runtimeMetadata.gridCycles && typeof runtimeMetadata.gridCycles === "object"
      ? (runtimeMetadata.gridCycles as Record<string, { buyLevelIndex: number; sellLevelIndex: number | null; lotId: string; openedAt: string }>)
      : {};
  const behaviorPresetId = inferBehaviorPresetId(draftConfig);
  const behaviorPreset = BOT_BEHAVIOR_PRESETS[behaviorPresetId];
  const lotLookup = new Map(bot.positionLots.map((lot) => [lot.id, lot]));
  const deployedQuoteAmount = Number(latestState?.deployedQuoteAmount ?? 0);
  const inventoryValue = bot.position ? Number(bot.position.baseAmount) * currentPrice : 0;
  const rangeProgress =
    config && Number(config.highPrice) > Number(config.lowPrice)
      ? Math.max(0, Math.min(100, ((currentPrice - Number(config.lowPrice)) / (Number(config.highPrice) - Number(config.lowPrice))) * 100))
      : 0;
  const deployableUsage = config && Number(config.maxDeployableUsd) > 0 ? (deployedQuoteAmount / Number(config.maxDeployableUsd)) * 100 : 0;

  return {
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
    initialCandles: buildCandlesFromSnapshots(priceSnapshots, "1h"),
    initialHistorySourceLabel: "local snapshots",
    orders: bot.orders.map((order) => {
      const latestExecution = order.executions[0] ?? null;
      const executionAmounts = latestExecution ? deriveExecutionAmounts(order.side as "buy" | "sell", latestExecution, order) : null;

      return {
        id: order.id,
        time: order.createdAt.toISOString(),
        side: order.side as "buy" | "sell",
        status: order.status,
        levelIndex: order.levelIndex,
        targetPrice: Number(order.targetPrice),
        requestedBaseAmount: Number(order.requestedBaseAmount),
        requestedQuoteAmount: Number(order.requestedQuoteAmount),
        reason: order.reason,
        execution: latestExecution
          ? {
              id: latestExecution.id,
              time: (latestExecution.completedAt ?? latestExecution.createdAt).toISOString(),
              status: latestExecution.status,
              provider: latestExecution.provider,
              executionRef: latestExecution.executionRef,
              txId: latestExecution.txId,
              quoteAmount: executionAmounts?.quoteAmount ?? null,
              baseAmount: executionAmounts?.baseAmount ?? null,
              effectivePrice: executionAmounts?.effectivePrice ?? null,
              errorMessage: latestExecution.errorMessage
            }
          : null,
        executionSummary: latestExecution ? `${latestExecution.provider} ${latestExecution.status}${latestExecution.txId ? ` | ${latestExecution.txId}` : ""}` : null
      };
    }),
    executions: bot.executions.map((execution) => {
      const executionAmounts = deriveExecutionAmounts(execution.order.side as "buy" | "sell", execution, execution.order);
      return {
        id: execution.id,
        orderId: execution.orderId,
        time: (execution.completedAt ?? execution.createdAt).toISOString(),
        status: execution.status,
        side: execution.order.side as "buy" | "sell",
        levelIndex: execution.order.levelIndex,
        targetPrice: Number(execution.order.targetPrice),
        quoteAmount: executionAmounts.quoteAmount,
        baseAmount: executionAmounts.baseAmount,
        effectivePrice: executionAmounts.effectivePrice,
        provider: execution.provider,
        executionRef: execution.executionRef,
        txId: execution.txId,
        errorMessage: execution.errorMessage,
        reason: execution.order.reason
      };
    }),
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
    systemLogs: bot.systemLogs.filter((log) => isVisibleSystemLog(log)).map((log) => ({
      id: log.id,
      category: log.category,
      message: log.message,
      level: log.level,
      createdAt: log.createdAt.toISOString()
    }))
  };
}
