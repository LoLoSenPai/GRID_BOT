import { NextResponse } from "next/server";
import { BotMode, BotStatus } from "@grid-bot/core";
import { PrismaBotStateRepository, prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import { createInitialStateSnapshot } from "@/lib/bot-management";

const botRepository = new PrismaBotStateRepository();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetPaperBot(input: {
  botId: string;
  totalBudgetUsd: number;
  currentPrice: number | null;
  actor: string;
}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await botRepository.withBotLock(input.botId, async () => {
      await prisma.$transaction([
        prisma.execution.deleteMany({ where: { botId: input.botId } }),
        prisma.order.deleteMany({ where: { botId: input.botId } }),
        prisma.positionLot.deleteMany({ where: { botId: input.botId } }),
        prisma.inventorySnapshot.deleteMany({ where: { botId: input.botId } }),
        prisma.pnlSnapshot.deleteMany({ where: { botId: input.botId } }),
        prisma.botStateSnapshot.deleteMany({ where: { botId: input.botId } }),
        prisma.position.upsert({
          where: { botId: input.botId },
          update: {
            baseAmount: 0,
            quoteSpent: 0,
            averageEntryPrice: 0,
            realizedPnlUsd: 0,
            unrealizedPnlUsd: 0,
            totalFeesQuote: 0
          },
          create: {
            botId: input.botId,
            baseAmount: 0,
            quoteSpent: 0,
            averageEntryPrice: 0,
            realizedPnlUsd: 0,
            unrealizedPnlUsd: 0,
            totalFeesQuote: 0
          }
        }),
        prisma.bot.update({
          where: { id: input.botId },
          data: {
            status: BotStatus.Paused as never
          }
        }),
        prisma.botStateSnapshot.create({
          data: createInitialStateSnapshot({
            botId: input.botId,
            status: BotStatus.Paused,
            totalBudgetUsd: input.totalBudgetUsd,
            currentPrice: input.currentPrice
          })
        }),
        prisma.systemLog.create({
          data: {
            botId: input.botId,
            level: "warn",
            category: "paper_reset",
            message: `Paper state reset by ${input.actor}.`,
            metadata: {
              actor: input.actor,
              scope: "all-paper-bots"
            }
          }
        })
      ]);

      return true;
    });

    if (result !== null) {
      return true;
    }

    await sleep(250);
  }

  return false;
}

export async function POST() {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const bots = await prisma.bot.findMany({
    where: { mode: BotMode.Paper as never, archivedAt: null },
    include: { config: true },
    orderBy: { createdAt: "asc" }
  });

  const paperBots = bots.filter((bot) => bot.config);
  if (!paperBots.length) {
    return NextResponse.json({ ok: true, count: 0 });
  }

  for (const bot of paperBots) {
    const didReset = await resetPaperBot({
      botId: bot.id,
      totalBudgetUsd: Number(bot.config!.totalBudgetUsd),
      currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null,
      actor: session.username
    });

    if (!didReset) {
      return NextResponse.json(
        {
          error: `Could not reset ${bot.name}. The worker kept the bot lock for too long. Pause the worker for a second and retry.`
        },
        { status: 409 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    count: paperBots.length
  });
}
