import { NextResponse } from "next/server";
import { BotStatus } from "@grid-bot/core";
import { findLatestBotStateSnapshot, prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import { cloneStateSnapshot, createInitialStateSnapshot } from "@/lib/bot-management";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const bot = await prisma.bot.findFirst({
    where: { id, archivedAt: null },
    include: {
      config: true
    }
  });

  if (!bot?.config) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  if (bot.status === BotStatus.Stopped) {
    return NextResponse.json({ ok: true });
  }

  const latestState = await findLatestBotStateSnapshot(bot.id);
  const snapshotData =
    latestState
      ? cloneStateSnapshot(bot.id, BotStatus.Stopped, latestState, {
          totalBudgetUsd: Number(bot.config.totalBudgetUsd),
          currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null
        })
      : createInitialStateSnapshot({
          botId: bot.id,
          status: BotStatus.Stopped,
          totalBudgetUsd: Number(bot.config.totalBudgetUsd),
          currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null
        });

  await prisma.$transaction([
    prisma.bot.update({
      where: { id },
      data: { status: BotStatus.Stopped as never }
    }),
    prisma.botStateSnapshot.create({ data: snapshotData }),
    prisma.systemLog.create({
      data: {
        botId: id,
        level: "warn",
        category: "bot_status",
        message: `Bot stopped by ${session.username}.`,
        metadata: { actor: session.username }
      }
    })
  ]);

  return NextResponse.json({ ok: true });
}
