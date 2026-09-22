import { NextResponse } from "next/server";
import { getEnv } from "@grid-bot/common";
import { BotMode, BotStatus } from "@grid-bot/core";
import { assertLegacyLiveAdmission, findLatestBotStateSnapshot, prisma, resumePortfolioBand } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import {
  cloneStateSnapshot,
  createStateSnapshotFromOpenLots,
  shouldRebuildRuntimeStateFromOpenLots,
} from "@/lib/bot-management";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const bot = await prisma.bot.findFirst({
    where: { id, archivedAt: null },
    include: {
      gridBand: true,
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

  if (bot.mode === BotMode.Live && !getEnv().LIVE_TRADING_ENABLED) {
    return NextResponse.json({ error: "Live trading is globally disabled." }, { status: 409 });
  }

  if (bot.status === BotStatus.Running) {
    return NextResponse.json({ ok: true });
  }
  if (bot.gridBand) {
    try { await resumePortfolioBand(id); return NextResponse.json({ ok: true }); }
    catch { return NextResponse.json({ error: "Reconcile pending executions before resuming this band." }, { status: 409 }); }
  }

  const latestState = await findLatestBotStateSnapshot(bot.id);
  const rebuildFromOpenLots = shouldRebuildRuntimeStateFromOpenLots(latestState, bot.positionLots);
  const snapshotData =
    latestState && !rebuildFromOpenLots
      ? cloneStateSnapshot(bot.id, BotStatus.Running, latestState, {
          totalBudgetUsd: Number(bot.config.totalBudgetUsd),
          currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null
        })
      : createStateSnapshotFromOpenLots({
          botId: bot.id,
          status: BotStatus.Running,
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

  if (bot.mode === BotMode.Live) {
    await prisma.$transaction(async tx => {
      await assertLegacyLiveAdmission(tx);
      await tx.bot.update({ where: { id }, data: { status: BotStatus.Running as never } });
      await tx.botStateSnapshot.create({ data: snapshotData });
      await tx.systemLog.create({ data: {
        botId: id,
        level: "info",
        category: "bot_status",
        message: `Bot resumed by ${session.username}.`,
        metadata: { actor: session.username }
      } });
    }, { timeout: 15000 });
  } else {
    await prisma.$transaction([
      prisma.bot.update({
        where: { id },
        data: { status: BotStatus.Running as never }
      }),
      prisma.botStateSnapshot.create({ data: snapshotData }),
      prisma.systemLog.create({
        data: {
          botId: id,
          level: "info",
          category: "bot_status",
          message: `Bot resumed by ${session.username}.`,
          metadata: { actor: session.username }
        }
      })
    ]);
  }

  return NextResponse.json({ ok: true });
}
