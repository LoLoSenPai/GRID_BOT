import { NextResponse } from "next/server";
import { getEnv } from "@grid-bot/common";
import { prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import {
  BotManagementValidationError,
  createInitialStateSnapshot,
  parseCreateBotPayload,
} from "@/lib/bot-management";
import { validateBudgetAllocation } from "@/lib/wallet-budget";

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await request.json();
    const parsed = parseCreateBotPayload(
      payload,
      getEnv().LIVE_TRADING_ENABLED,
    );

    const budgetCheck = await validateBudgetAllocation(
      parsed.totalBudgetUsd,
      parsed.mode,
    );
    if (!budgetCheck.ok) {
      return NextResponse.json({ error: budgetCheck.error }, { status: 422 });
    }

    const baseKey =
      parsed.key ||
      `${parsed.baseSymbol.toLowerCase()}-${parsed.quoteSymbol.toLowerCase()}-grid`;
    const key = await createUniqueBotKey(baseKey);

    const bot = await prisma.$transaction(async (tx) => {
      const createdBot = await tx.bot.create({
        data: {
          key,
          name: parsed.name,
          baseMint: parsed.baseMint,
          quoteMint: parsed.quoteMint,
          baseSymbol: parsed.baseSymbol,
          quoteSymbol: parsed.quoteSymbol,
          baseDecimals: parsed.baseDecimals,
          quoteDecimals: parsed.quoteDecimals,
          strategyMode: parsed.strategyMode as never,
          mode: parsed.mode as never,
          status: parsed.status as never,
          executionProvider: parsed.executionProvider as never,
        },
      });

      await tx.botConfig.create({
        data: {
          botId: createdBot.id,
          totalBudgetUsd: parsed.totalBudgetUsd,
          maxDeployableUsd: parsed.maxDeployableUsd,
          reserveQuoteAmount: parsed.reserveQuoteAmount,
          lowPrice: parsed.lowPrice,
          highPrice: parsed.highPrice,
          levelCount: parsed.levelCount,
          gridType: parsed.gridType as never,
          minOrderQuoteAmount: parsed.minOrderQuoteAmount,
          maxSlippageBps: parsed.maxSlippageBps,
          cooldownMs: parsed.cooldownMs,
          maxOrdersPerHour: parsed.maxOrdersPerHour,
          maxDrawdownPct: parsed.maxDrawdownPct,
          maxConsecutiveFailures: parsed.maxConsecutiveFailures,
          levelLockMs: parsed.levelLockMs,
          priceConfirmationWindowMs: parsed.priceConfirmationWindowMs,
          recenterMode: parsed.recenterMode as never,
          autoRecenterMinIntervalMs: parsed.autoRecenterMinIntervalMs,
          autoRecenterMaxPerDay: parsed.autoRecenterMaxPerDay,
          outOfRangePause: parsed.outOfRangePause,
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
          status: parsed.status,
          totalBudgetUsd: parsed.totalBudgetUsd,
        }),
      });

      await tx.systemLog.create({
        data: {
          botId: createdBot.id,
          level: "info",
          category: "bot_admin",
          message: `Bot created in ${parsed.mode} mode from ${parsed.label} preset.`,
          metadata: {
            actor: session.username,
            presetId: parsed.presetId,
          },
        },
      });

      return createdBot;
    });

    return NextResponse.json({ ok: true, id: bot.id });
  } catch (error) {
    if (error instanceof BotManagementValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    console.error(error);
    return NextResponse.json(
      {
        error: "Failed to create bot.",
        detail:
          process.env.NODE_ENV !== "production" && error instanceof Error
            ? error.message
            : undefined,
      },
      { status: 500 },
    );
  }
}

async function createUniqueBotKey(baseKey: string) {
  const cleanBaseKey = baseKey.trim() || "grid-bot";
  let attempt = cleanBaseKey;
  let counter = 2;

  while (
    await prisma.bot.findUnique({
      where: { key: attempt },
      select: { id: true },
    })
  ) {
    attempt = `${cleanBaseKey}-${counter}`;
    counter += 1;
  }

  return attempt;
}
