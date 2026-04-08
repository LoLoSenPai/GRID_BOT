import { NextResponse } from "next/server";
import { getEnv } from "@grid-bot/common";
import { prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import {
  BotManagementValidationError,
  parseUpdateBotPayload,
} from "@/lib/bot-management";
import { validateBudgetAllocation } from "@/lib/wallet-budget";

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
      include: { config: true },
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

    const budgetCheck = await validateBudgetAllocation(
      parsed.totalBudgetUsd,
      parsed.mode,
      id,
    );
    if (!budgetCheck.ok) {
      return NextResponse.json({ error: budgetCheck.error }, { status: 422 });
    }

    if (parsed.mode !== bot.mode) {
      return NextResponse.json(
        { error: "Bot mode is immutable. Create or clone a new bot instead." },
        { status: 409 },
      );
    }

    await prisma.$transaction([
      prisma.bot.update({
        where: { id },
        data: {
          name: parsed.name,
          strategyMode: parsed.strategyMode as never,
          mode: parsed.mode as never,
          executionProvider: parsed.executionProvider as never,
        },
      }),
      prisma.botConfig.update({
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
      }),
      prisma.systemLog.create({
        data: {
          botId: id,
          level: "info",
          category: "bot_admin",
          message: `Bot configuration updated by ${session.username}.`,
          metadata: {
            actor: session.username,
            mode: parsed.mode,
            strategyMode: parsed.strategyMode,
          },
        },
      }),
    ]);

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
