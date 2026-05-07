import type {
  Alert,
  Bot,
  BotConfig,
  BotStateSnapshot,
  Execution,
  MarketCandle,
  Position,
  PositionLot
} from "@prisma/client";
import type {
  AlertRecord,
  Bot as DomainBot,
  BotAggregate,
  BotConfig as DomainBotConfig,
  BotStateSnapshot as DomainBotStateSnapshot,
  ExecutionRecord,
  NormalizedCandle,
  Position as DomainPosition,
  PositionLot as DomainPositionLot
} from "@grid-bot/core";

export function decimalToNumber(value: { toNumber(): number } | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }

  return typeof value === "number" ? value : value.toNumber();
}

export function mapBot(bot: Bot): DomainBot {
  return {
    id: bot.id,
    key: bot.key,
    name: bot.name,
    baseMint: bot.baseMint,
    quoteMint: bot.quoteMint,
    baseSymbol: bot.baseSymbol,
    quoteSymbol: bot.quoteSymbol,
    baseDecimals: bot.baseDecimals,
    quoteDecimals: bot.quoteDecimals,
    strategyMode: bot.strategyMode as DomainBot["strategyMode"],
    mode: bot.mode as DomainBot["mode"],
    status: bot.status as DomainBot["status"],
    executionProvider: bot.executionProvider as DomainBot["executionProvider"],
    currentPrice: bot.currentPrice ? bot.currentPrice.toNumber() : null
  };
}

export function mapConfig(config: BotConfig): DomainBotConfig {
  return {
    id: config.id,
    botId: config.botId,
    totalBudgetUsd: config.totalBudgetUsd.toNumber(),
    maxDeployableUsd: config.maxDeployableUsd.toNumber(),
    reserveQuoteAmount: config.reserveQuoteAmount.toNumber(),
    lowPrice: config.lowPrice.toNumber(),
    highPrice: config.highPrice.toNumber(),
    levelCount: config.levelCount,
    gridType: config.gridType as DomainBotConfig["gridType"],
    minOrderQuoteAmount: config.minOrderQuoteAmount.toNumber(),
    maxSlippageBps: config.maxSlippageBps,
    cooldownMs: config.cooldownMs,
    maxOrdersPerHour: config.maxOrdersPerHour,
    maxDrawdownPct: config.maxDrawdownPct.toNumber(),
    maxConsecutiveFailures: config.maxConsecutiveFailures,
    levelLockMs: config.levelLockMs,
    priceConfirmationWindowMs: config.priceConfirmationWindowMs,
    recenterMode: config.recenterMode as DomainBotConfig["recenterMode"],
    entryMode: config.entryMode as DomainBotConfig["entryMode"],
    autoRecenterMinIntervalMs: config.autoRecenterMinIntervalMs,
    autoRecenterMaxPerDay: config.autoRecenterMaxPerDay,
    outOfRangePause: config.outOfRangePause
  };
}

export function mapState(snapshot: BotStateSnapshot): DomainBotStateSnapshot {
  return {
    id: snapshot.id,
    botId: snapshot.botId,
    status: snapshot.status as DomainBotStateSnapshot["status"],
    currentPrice: snapshot.currentPrice?.toNumber() ?? null,
    availableQuoteAmount: snapshot.availableQuoteAmount.toNumber(),
    availableBaseAmount: snapshot.availableBaseAmount.toNumber(),
    deployedQuoteAmount: snapshot.deployedQuoteAmount.toNumber(),
    averageEntryPrice: snapshot.averageEntryPrice?.toNumber() ?? null,
    realizedPnlUsd: snapshot.realizedPnlUsd.toNumber(),
    unrealizedPnlUsd: snapshot.unrealizedPnlUsd.toNumber(),
    totalEquityUsd: snapshot.totalEquityUsd.toNumber(),
    consecutiveFailures: snapshot.consecutiveFailures,
    lastExecutionAt: snapshot.lastExecutionAt,
    lastProcessedAt: snapshot.lastProcessedAt,
    lastRecenterAt: snapshot.lastRecenterAt,
    metadata: snapshot.metadata as unknown as DomainBotStateSnapshot["metadata"]
  };
}

export function mapPosition(position: Position): DomainPosition {
  return {
    id: position.id,
    botId: position.botId,
    baseAmount: position.baseAmount.toNumber(),
    quoteSpent: position.quoteSpent.toNumber(),
    averageEntryPrice: position.averageEntryPrice.toNumber(),
    realizedPnlUsd: position.realizedPnlUsd.toNumber(),
    unrealizedPnlUsd: position.unrealizedPnlUsd.toNumber(),
    totalFeesQuote: position.totalFeesQuote.toNumber()
  };
}

export function mapLot(lot: PositionLot): DomainPositionLot {
  return {
    id: lot.id,
    botId: lot.botId,
    originalBaseAmount: lot.originalBaseAmount.toNumber(),
    remainingBaseAmount: lot.remainingBaseAmount.toNumber(),
    entryPrice: lot.entryPrice.toNumber(),
    costQuote: lot.costQuote.toNumber(),
    openedByExecutionId: lot.openedByExecutionId,
    closedByExecutionId: lot.closedByExecutionId,
    openedAt: lot.openedAt,
    closedAt: lot.closedAt
  };
}

export function mapExecution(record: Execution): ExecutionRecord {
  return {
    id: record.id,
    orderId: record.orderId,
    botId: record.botId,
    provider: record.provider as ExecutionRecord["provider"],
    mode: record.mode as ExecutionRecord["mode"],
    status: record.status as ExecutionRecord["status"],
    executionRef: record.executionRef,
    txId: record.txId,
    quotePrice: record.quotePrice?.toNumber() ?? null,
    expectedOutputAmount: record.expectedOutputAmount?.toNumber() ?? null,
    expectedFeeAmount: record.expectedFeeAmount?.toNumber() ?? null,
    executedInputAmount: record.executedInputAmount?.toNumber() ?? null,
    executedOutputAmount: record.executedOutputAmount?.toNumber() ?? null,
    executedFeeAmount: record.executedFeeAmount?.toNumber() ?? null,
    errorCode: record.errorCode,
    errorMessage: record.errorMessage,
    rawReport: record.rawReport,
    createdAt: record.createdAt,
    completedAt: record.completedAt
  };
}

export function mapAlert(alert: Alert): AlertRecord {
  return {
    id: alert.id,
    botId: alert.botId,
    type: alert.type as AlertRecord["type"],
    severity: alert.severity as AlertRecord["severity"],
    title: alert.title,
    message: alert.message,
    metadata: (alert.metadata as Record<string, unknown> | undefined) ?? undefined,
    createdAt: alert.createdAt
  };
}

export function mapMarketCandle(candle: MarketCandle): NormalizedCandle {
  return {
    provider: candle.provider,
    symbol: candle.symbol,
    quoteSymbol: candle.quoteSymbol,
    resolution: candle.resolution,
    sourceMarket: candle.sourceMarket,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open.toNumber(),
    high: candle.high.toNumber(),
    low: candle.low.toNumber(),
    close: candle.close.toNumber(),
    volume: candle.volume?.toNumber() ?? null,
    fetchedAt: candle.fetchedAt
  };
}

export function mapAggregate(input: {
  bot: Bot;
  config: BotConfig | null;
  stateSnapshots: BotStateSnapshot[];
  position: Position | null;
  positionLots: PositionLot[];
}): BotAggregate | null {
  if (!input.config) {
    return null;
  }

  return {
    bot: mapBot(input.bot),
    config: mapConfig(input.config),
    latestState: input.stateSnapshots[0] ? mapState(input.stateSnapshots[0]) : null,
    position: input.position ? mapPosition(input.position) : null,
    openLots: input.positionLots.map(mapLot)
  };
}
