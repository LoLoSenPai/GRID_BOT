import { NextResponse } from "next/server";
import { BotMode, type BotStatus } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import { createInitialStateSnapshot } from "@/lib/bot-management";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const bot = await prisma.bot.findUnique({
    where: { id },
    include: { config: true }
  });

  if (!bot?.config) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  if (bot.mode !== BotMode.Paper) {
    return NextResponse.json({ error: "Paper reset is only available for paper bots." }, { status: 409 });
  }

  if (bot.status === "running" || bot.status === "cooldown") {
    return NextResponse.json({ error: "Pause or stop the bot before resetting paper state." }, { status: 409 });
  }

  await prisma.$transaction([
    prisma.order.deleteMany({ where: { botId: id } }),
    prisma.positionLot.deleteMany({ where: { botId: id } }),
    prisma.inventorySnapshot.deleteMany({ where: { botId: id } }),
    prisma.pnlSnapshot.deleteMany({ where: { botId: id } }),
    prisma.botStateSnapshot.deleteMany({ where: { botId: id } }),
    prisma.position.upsert({
      where: { botId: id },
      update: {
        baseAmount: 0,
        quoteSpent: 0,
        averageEntryPrice: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        totalFeesQuote: 0
      },
      create: {
        botId: id,
        baseAmount: 0,
        quoteSpent: 0,
        averageEntryPrice: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        totalFeesQuote: 0
      }
    }),
    prisma.botStateSnapshot.create({
      data: createInitialStateSnapshot({
        botId: id,
        status: bot.status as BotStatus,
        totalBudgetUsd: Number(bot.config.totalBudgetUsd),
        currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null
      })
    }),
    prisma.systemLog.create({
      data: {
        botId: id,
        level: "warn",
        category: "paper_reset",
        message: `Paper state reset by ${session.username}.`,
        metadata: { actor: session.username }
      }
    })
  ]);

  return NextResponse.json({ ok: true });
}
