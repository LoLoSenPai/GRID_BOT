import { DEFAULTS, MINTS } from "@grid-bot/common";
import { BotMode, BotStatus, ExecutionProvider, GridType, RecenterMode, StrategyMode } from "@grid-bot/core";

import { prisma } from "../src/client";

async function upsertBot(input: {
  key: string;
  name: string;
  baseMint: string;
  quoteMint: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  strategyMode: StrategyMode;
  mode: BotMode;
  gridType: GridType;
  totalBudgetUsd: number;
  maxDeployableUsd: number;
  reserveQuoteAmount: number;
  lowPrice: number;
  highPrice: number;
  levelCount: number;
  minOrderQuoteAmount: number;
}) {
  const bot = await prisma.bot.upsert({
    where: { key: input.key },
    update: {
      name: input.name,
      baseMint: input.baseMint,
      quoteMint: input.quoteMint,
      baseSymbol: input.baseSymbol,
      quoteSymbol: input.quoteSymbol,
      baseDecimals: input.baseDecimals,
      quoteDecimals: input.quoteDecimals,
      strategyMode: input.strategyMode as never,
      mode: input.mode as never,
      status: BotStatus.Paused as never,
      executionProvider: (input.mode === BotMode.Paper ? ExecutionProvider.Paper : ExecutionProvider.Jupiter) as never
    },
    create: {
      key: input.key,
      name: input.name,
      baseMint: input.baseMint,
      quoteMint: input.quoteMint,
      baseSymbol: input.baseSymbol,
      quoteSymbol: input.quoteSymbol,
      baseDecimals: input.baseDecimals,
      quoteDecimals: input.quoteDecimals,
      strategyMode: input.strategyMode as never,
      mode: input.mode as never,
      status: BotStatus.Paused as never,
      executionProvider: (input.mode === BotMode.Paper ? ExecutionProvider.Paper : ExecutionProvider.Jupiter) as never
    }
  });

  await prisma.botConfig.upsert({
    where: { botId: bot.id },
    update: {
      totalBudgetUsd: input.totalBudgetUsd,
      maxDeployableUsd: input.maxDeployableUsd,
      reserveQuoteAmount: input.reserveQuoteAmount,
      lowPrice: input.lowPrice,
      highPrice: input.highPrice,
      levelCount: input.levelCount,
      gridType: input.gridType as never,
      minOrderQuoteAmount: input.minOrderQuoteAmount,
      maxSlippageBps: 50,
      cooldownMs: DEFAULTS.cooldownMs,
      maxOrdersPerHour: DEFAULTS.maxOrdersPerHour,
      maxDrawdownPct: 18,
      maxConsecutiveFailures: DEFAULTS.maxConsecutiveFailures,
      levelLockMs: DEFAULTS.levelLockMs,
      priceConfirmationWindowMs: DEFAULTS.priceConfirmationWindowMs,
      recenterMode: RecenterMode.Manual as never,
      autoRecenterMinIntervalMs: DEFAULTS.autoRecenterMinIntervalMs,
      autoRecenterMaxPerDay: DEFAULTS.autoRecenterMaxPerDay,
      outOfRangePause: true
    },
    create: {
      botId: bot.id,
      totalBudgetUsd: input.totalBudgetUsd,
      maxDeployableUsd: input.maxDeployableUsd,
      reserveQuoteAmount: input.reserveQuoteAmount,
      lowPrice: input.lowPrice,
      highPrice: input.highPrice,
      levelCount: input.levelCount,
      gridType: input.gridType as never,
      minOrderQuoteAmount: input.minOrderQuoteAmount,
      maxSlippageBps: 50,
      cooldownMs: DEFAULTS.cooldownMs,
      maxOrdersPerHour: DEFAULTS.maxOrdersPerHour,
      maxDrawdownPct: 18,
      maxConsecutiveFailures: DEFAULTS.maxConsecutiveFailures,
      levelLockMs: DEFAULTS.levelLockMs,
      priceConfirmationWindowMs: DEFAULTS.priceConfirmationWindowMs,
      recenterMode: RecenterMode.Manual as never,
      autoRecenterMinIntervalMs: DEFAULTS.autoRecenterMinIntervalMs,
      autoRecenterMaxPerDay: DEFAULTS.autoRecenterMaxPerDay,
      outOfRangePause: true
    }
  });

  await prisma.position.upsert({
    where: { botId: bot.id },
    update: {
      baseAmount: 0,
      quoteSpent: 0,
      averageEntryPrice: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      totalFeesQuote: 0
    },
    create: {
      botId: bot.id,
      baseAmount: 0,
      quoteSpent: 0,
      averageEntryPrice: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      totalFeesQuote: 0
    }
  });

  const existingSnapshot = await prisma.botStateSnapshot.findFirst({
    where: { botId: bot.id },
    orderBy: { createdAt: "desc" }
  });

  if (!existingSnapshot) {
    await prisma.botStateSnapshot.create({
      data: {
        botId: bot.id,
        status: BotStatus.Paused as never,
        availableQuoteAmount: input.totalBudgetUsd,
        availableBaseAmount: 0,
        deployedQuoteAmount: 0,
        averageEntryPrice: null,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        totalEquityUsd: input.totalBudgetUsd,
        consecutiveFailures: 0,
        lastProcessedAt: new Date(),
        metadata: {
          levelLocks: {},
          pendingSignal: null,
          recenterHistory: [],
          recentExecutions: []
        }
      }
    });
  }

  return bot;
}

async function main() {
  await upsertBot({
    key: "sol-usdc-paper",
    name: "SOL / USDC Grid",
    baseMint: MINTS.SOL,
    quoteMint: MINTS.USDC,
    baseSymbol: "SOL",
    quoteSymbol: "USDC",
    baseDecimals: 9,
    quoteDecimals: 6,
    strategyMode: StrategyMode.Balanced,
    mode: BotMode.Paper,
    gridType: GridType.Arithmetic,
    totalBudgetUsd: 2000,
    maxDeployableUsd: 1500,
    reserveQuoteAmount: 500,
    lowPrice: 105,
    highPrice: 165,
    levelCount: 14,
    minOrderQuoteAmount: 50
  });

  await upsertBot({
    key: "btc-usdc-paper",
    name: "BTC / USDC Grid",
    baseMint: MINTS.BTC,
    quoteMint: MINTS.USDC,
    baseSymbol: "BTC",
    quoteSymbol: "USDC",
    baseDecimals: 6,
    quoteDecimals: 6,
    strategyMode: StrategyMode.AccumulateUsdc,
    mode: BotMode.Paper,
    gridType: GridType.Geometric,
    totalBudgetUsd: 2000,
    maxDeployableUsd: 1500,
    reserveQuoteAmount: 500,
    lowPrice: 56000,
    highPrice: 76000,
    levelCount: 12,
    minOrderQuoteAmount: 50
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
