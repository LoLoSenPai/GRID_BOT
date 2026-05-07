import { NextResponse } from "next/server";
import { EntryMode } from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const bot = await prisma.bot.findFirst({
    where: { id, archivedAt: null },
    include: { config: true }
  });

  if (!bot?.config) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  if (bot.config.entryMode === EntryMode.SellOnly) {
    return NextResponse.json({ ok: true });
  }

  await prisma.$transaction([
    prisma.botConfig.update({
      where: { botId: id },
      data: { entryMode: EntryMode.SellOnly as never }
    }),
    prisma.systemLog.create({
      data: {
        botId: id,
        level: "warn",
        category: "bot_strategy",
        message: `Sell only enabled by ${session.username}.`,
        metadata: {
          actor: session.username,
          entryMode: EntryMode.SellOnly
        }
      }
    })
  ]);

  return NextResponse.json({ ok: true });
}
