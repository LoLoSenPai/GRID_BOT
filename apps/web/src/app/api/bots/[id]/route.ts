import { NextResponse } from "next/server";
import { getEnv } from "@grid-bot/common";
import { BotMode, type BotStatus } from "@grid-bot/core/enums";
import { prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import {
  BotManagementValidationError,
  cloneStateSnapshot,
  createInitialStateSnapshot,
  parseUpdateBotPayload,
} from "@/lib/bot-management";
import { validateAdditionalBudgetAllocation } from "@/lib/wallet-budget";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const bot = await prisma.bot.findUnique({
      where: { id },
      include: {
        config: true,
        stateSnapshots: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    if (!bot?.config) {
      return NextResponse.json({ error: "Bot not found." }, { status: 404 });
    }

    if (bot.status === "running" || bot.status === "cooldown") {
      return NextResponse.json(
        { error: "Pause or stop the bot before editing config." },
        { status: 409 },
      );
    }

    const payload = await request.json();
    const parsed = parseUpdateBotPayload(
      payload,
      getEnv().LIVE_TRADING_ENABLED,
    );

    if (parsed.mode !== bot.mode) {
      return NextResponse.json(
        { error: "Bot mode is immutable. Create or clone a new bot instead." },
        { status: 409 },
      );
    }

    const previousBudgetUsd = bot.config.totalBudgetUsd.toNumber();
    const budgetDeltaUsd = roundUsd(parsed.totalBudgetUsd - previousBudgetUsd);

    if (bot.mode === BotMode.Live && budgetDeltaUsd < 0) {
      return NextResponse.json(
        {
          error:
            "Reducing a live bot budget is not supported. Stop and recreate the bot if you want a smaller allocation.",
        },
        { status: 409 },
      );
    }

    if (budgetDeltaUsd > 0) {
      const budgetCheck = await validateAdditionalBudgetAllocation(
        budgetDeltaUsd,
        parsed.mode,
      );
      if (!budgetCheck.ok) {
        return NextResponse.json({ error: budgetCheck.error }, { status: 422 });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.bot.update({
        where: { id },
        data: {
          name: parsed.name,
          strategyMode: parsed.strategyMode as never,
          mode: parsed.mode as never,
          executionProvider: parsed.executionProvider as never,
        },
      });

      await tx.botConfig.update({
        where: { botId: id },
        data: {
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

      if (budgetDeltaUsd > 0) {
        const snapshotData = bot.stateSnapshots[0]
          ? cloneStateSnapshot(
              id,
              bot.status as BotStatus,
              bot.stateSnapshots[0],
              {
                totalBudgetUsd: parsed.totalBudgetUsd,
                currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null,
              },
            )
          : createInitialStateSnapshot({
              botId: id,
              status: bot.status as BotStatus,
              totalBudgetUsd: parsed.totalBudgetUsd,
              currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null,
            });

        if (bot.stateSnapshots[0]) {
          snapshotData.availableQuoteAmount = roundUsd(
            Number(snapshotData.availableQuoteAmount) + budgetDeltaUsd,
          );
          snapshotData.totalEquityUsd = roundUsd(
            Number(snapshotData.totalEquityUsd) + budgetDeltaUsd,
          );
          snapshotData.lastProcessedAt = new Date();
        }

        await tx.botStateSnapshot.create({ data: snapshotData });
      }

      await tx.systemLog.create({
        data: {
          botId: id,
          level: "info",
          category: "bot_admin",
          message: `Bot configuration updated by ${session.username}.`,
          metadata: {
            actor: session.username,
            mode: parsed.mode,
            strategyMode: parsed.strategyMode,
            previousBudgetUsd,
            nextBudgetUsd: parsed.totalBudgetUsd,
            budgetDeltaUsd,
          },
        },
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof BotManagementValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    console.error(error);
    return NextResponse.json(
      { error: "Failed to update bot." },
      { status: 500 },
    );
  }
}

function roundUsd(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(value * 100) / 100;
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const bot = await prisma.bot.findUnique({
    where: { id },
    select: { id: true, status: true, name: true },
  });

  if (!bot) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  if (bot.status !== "stopped") {
    return NextResponse.json(
      { error: "Stop the bot before deleting it." },
      { status: 409 },
    );
  }

  try {
    await prisma.bot.delete({ where: { id } });
    return NextResponse.json({ ok: true, deletedBotName: bot.name });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to delete bot." },
      { status: 500 },
    );
  }
}
