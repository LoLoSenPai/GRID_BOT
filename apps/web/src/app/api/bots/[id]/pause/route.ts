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
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${id} FOR UPDATE`;
    const bot = await tx.bot.findFirst({
      where: { id, archivedAt: null },
      include: {
        config: true
      }
    });

    if (!bot?.config) {
      return NextResponse.json({ error: "Bot not found." }, { status: 404 });
    }

    if (bot.status === BotStatus.Paused) {
      return NextResponse.json({ ok: true });
    }

    const latestState = await tx.botStateSnapshot.findFirst({ where: { botId: bot.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const snapshotData =
      latestState
        ? cloneStateSnapshot(bot.id, BotStatus.Paused, latestState, {
            totalBudgetUsd: Number(bot.config.totalBudgetUsd),
            currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null
          })
        : createInitialStateSnapshot({
            botId: bot.id,
            status: BotStatus.Paused,
            totalBudgetUsd: Number(bot.config.totalBudgetUsd),
            currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null
          });

    await tx.bot.update({
        where: { id },
        data: { status: BotStatus.Paused as never }
    });
    await tx.botStateSnapshot.create({ data: snapshotData });
    await tx.systemLog.create({
        data: {
          botId: id,
          level: "info",
          category: "bot_status",
          message: `Bot paused by ${session.username}.`,
          metadata: { actor: session.username }
        }
    });

    return NextResponse.json({ ok: true });
  });
}
