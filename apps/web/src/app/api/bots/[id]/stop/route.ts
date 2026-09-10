import { NextResponse } from "next/server";
import { BotStatus } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import {
  cloneStateSnapshot,
  createStateSnapshotFromOpenLots,
} from "@/lib/bot-management";

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
        config: true,
        position: true,
        positionLots: {
          where: { closedAt: null },
          orderBy: { openedAt: "asc" }
        }
      }
    });

    if (!bot?.config) {
      return NextResponse.json({ error: "Bot not found." }, { status: 404 });
    }

    if (bot.status === BotStatus.Stopped) {
      return NextResponse.json({ ok: true });
    }

    const latestState = await tx.botStateSnapshot.findFirst({ where: { botId: bot.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const snapshotData =
      latestState
        ? cloneStateSnapshot(bot.id, BotStatus.Stopped, latestState, {
            totalBudgetUsd: Number(bot.config.totalBudgetUsd),
            currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null
          })
        : createStateSnapshotFromOpenLots({
            botId: bot.id,
            status: BotStatus.Stopped,
            totalBudgetUsd: Number(bot.config.totalBudgetUsd),
            currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null,
            config: {
              lowPrice: bot.config.lowPrice,
              highPrice: bot.config.highPrice,
              levelCount: bot.config.levelCount,
              gridType: bot.config.gridType as never
            },
            position: bot.position,
            openLots: bot.positionLots
          });

    await tx.bot.update({
        where: { id },
        data: { status: BotStatus.Stopped as never }
    });
    await tx.botStateSnapshot.create({ data: snapshotData });
    await tx.systemLog.create({
        data: {
          botId: id,
          level: "warn",
          category: "bot_status",
          message: `Bot stopped by ${session.username}.`,
          metadata: { actor: session.username }
        }
    });

    return NextResponse.json({ ok: true });
  });
}
