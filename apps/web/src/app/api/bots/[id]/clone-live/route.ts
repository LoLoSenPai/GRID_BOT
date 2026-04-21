import { NextResponse } from "next/server";
import { getEnv } from "@grid-bot/common";
import { BotMode, BotStatus, ExecutionProvider } from "@grid-bot/core/enums";
import { prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import {
  buildBotKeyForMode,
  createInitialStateSnapshot,
  slugifyBotKey,
} from "@/lib/bot-management";
import { validateBudgetAllocation } from "@/lib/wallet-budget";

export async function POST(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!getEnv().LIVE_TRADING_ENABLED) {
    return NextResponse.json(
      { error: "Live trading is globally disabled." },
      { status: 422 },
    );
  }

  const { id } = await params;
  const sourceBot = await prisma.bot.findFirst({
    where: { id, archivedAt: null },
    include: { config: true },
  });

  if (!sourceBot?.config) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }
  const sourceConfig = sourceBot.config;

  if (sourceBot.mode !== BotMode.Paper) {
    return NextResponse.json(
      { error: "Only paper bots can be cloned to live." },
      { status: 409 },
    );
  }

  const budgetCheck = await validateBudgetAllocation(
    Number(sourceConfig.totalBudgetUsd),
    BotMode.Live,
  );
  if (!budgetCheck.ok) {
    return NextResponse.json({ error: budgetCheck.error }, { status: 422 });
  }

  const baseKey = slugifyBotKey(sourceBot.name || sourceBot.key || "grid-bot");
  const key = await createUniqueBotKey(buildBotKeyForMode(baseKey, BotMode.Live));

  const clonedBot = await prisma.$transaction(async (tx) => {
    const createdBot = await tx.bot.create({
      data: {
        key,
        clonedFromBotId: sourceBot.id,
        name: sourceBot.name,
        baseMint: sourceBot.baseMint,
        quoteMint: sourceBot.quoteMint,
        baseSymbol: sourceBot.baseSymbol,
        quoteSymbol: sourceBot.quoteSymbol,
        baseDecimals: sourceBot.baseDecimals,
        quoteDecimals: sourceBot.quoteDecimals,
        strategyMode: sourceBot.strategyMode as never,
        mode: BotMode.Live as never,
        status: BotStatus.Paused as never,
        executionProvider: ExecutionProvider.Jupiter as never,
        currentPrice: sourceBot.currentPrice,
      },
    });

    await tx.botConfig.create({
      data: {
        botId: createdBot.id,
        totalBudgetUsd: sourceConfig.totalBudgetUsd,
        maxDeployableUsd: sourceConfig.maxDeployableUsd,
        reserveQuoteAmount: sourceConfig.reserveQuoteAmount,
        lowPrice: sourceConfig.lowPrice,
        highPrice: sourceConfig.highPrice,
        levelCount: sourceConfig.levelCount,
        gridType: sourceConfig.gridType as never,
        minOrderQuoteAmount: sourceConfig.minOrderQuoteAmount,
        maxSlippageBps: sourceConfig.maxSlippageBps,
        cooldownMs: sourceConfig.cooldownMs,
        maxOrdersPerHour: sourceConfig.maxOrdersPerHour,
        maxDrawdownPct: sourceConfig.maxDrawdownPct,
        maxConsecutiveFailures: sourceConfig.maxConsecutiveFailures,
        levelLockMs: sourceConfig.levelLockMs,
        priceConfirmationWindowMs: sourceConfig.priceConfirmationWindowMs,
        recenterMode: sourceConfig.recenterMode as never,
        autoRecenterMinIntervalMs: sourceConfig.autoRecenterMinIntervalMs,
        autoRecenterMaxPerDay: sourceConfig.autoRecenterMaxPerDay,
        outOfRangePause: sourceConfig.outOfRangePause,
      },
    });

    await tx.position.create({
      data: {
        botId: createdBot.id,
        baseAmount: 0,
        quoteSpent: 0,
        averageEntryPrice: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        totalFeesQuote: 0,
      },
    });

    await tx.botStateSnapshot.create({
      data: createInitialStateSnapshot({
        botId: createdBot.id,
        status: BotStatus.Paused,
        totalBudgetUsd: Number(sourceConfig.totalBudgetUsd),
        currentPrice: sourceBot.currentPrice
          ? Number(sourceBot.currentPrice)
          : null,
      }),
    });

    await tx.systemLog.createMany({
      data: [
        {
          botId: sourceBot.id,
          level: "info",
          category: "bot_admin",
          message: `Live clone created by ${session.username}.`,
          metadata: {
            actor: session.username,
            liveBotId: createdBot.id,
          },
        },
        {
          botId: createdBot.id,
          level: "info",
          category: "bot_admin",
          message: `Live bot cloned from ${sourceBot.name} by ${session.username}.`,
          metadata: {
            actor: session.username,
            clonedFromBotId: sourceBot.id,
          },
        },
      ],
    });

    return createdBot;
  });

  return NextResponse.json({ ok: true, id: clonedBot.id });
}

async function createUniqueBotKey(baseKey: string) {
  let attempt = baseKey.trim() || "grid-bot-live";
  let counter = 2;

  while (
    await prisma.bot.findUnique({
      where: { key: attempt },
      select: { id: true },
    })
  ) {
    attempt = `${baseKey}-${counter}`;
    counter += 1;
  }

  return attempt;
}
