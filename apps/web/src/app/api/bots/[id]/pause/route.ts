import { NextResponse } from "next/server";
import { BotStatus } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

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
      config: true,
      stateSnapshots: { orderBy: { createdAt: "desc" }, take: 1 }
    }
  });

  if (!bot?.config) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  if (bot.status === BotStatus.Paused) {
    return NextResponse.json({ ok: true });
  }

  const snapshotData =
    bot.stateSnapshots[0]
      ? cloneStateSnapshot(bot.id, BotStatus.Paused, bot.stateSnapshots[0], {
          totalBudgetUsd: Number(bot.config.totalBudgetUsd),
          currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null
        })
      : createInitialStateSnapshot({
          botId: bot.id,
          status: BotStatus.Paused,
          totalBudgetUsd: Number(bot.config.totalBudgetUsd),
          currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null
        });

  await prisma.$transaction([
    prisma.bot.update({
      where: { id },
      data: { status: BotStatus.Paused as never }
    }),
    prisma.botStateSnapshot.create({ data: snapshotData }),
    prisma.systemLog.create({
      data: {
        botId: id,
        level: "info",
        category: "bot_status",
        message: `Bot paused by ${session.username}.`,
        metadata: { actor: session.username }
      }
    })
  ]);

  return NextResponse.json({ ok: true });
}
