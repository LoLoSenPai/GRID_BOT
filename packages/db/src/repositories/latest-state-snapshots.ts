import { Prisma, type BotStateSnapshot } from "@prisma/client";

import { prisma } from "../client";

export async function findLatestBotStateSnapshots(botIds: string[]) {
  if (!botIds.length) {
    return new Map<string, BotStateSnapshot>();
  }

  const rows = await prisma.$queryRaw<BotStateSnapshot[]>(Prisma.sql`
    SELECT DISTINCT ON ("botId")
      "id",
      "botId",
      "status",
      "currentPrice",
      "availableQuoteAmount",
      "availableBaseAmount",
      "deployedQuoteAmount",
      "averageEntryPrice",
      "realizedPnlUsd",
      "unrealizedPnlUsd",
      "totalEquityUsd",
      "consecutiveFailures",
      "lastExecutionAt",
      "lastProcessedAt",
      "lastRecenterAt",
      "metadata",
      "createdAt"
    FROM "bot_state_snapshots"
    WHERE "botId" IN (${Prisma.join(botIds)})
    ORDER BY "botId", "createdAt" DESC
  `);

  return new Map(rows.map((row) => [row.botId, row]));
}

export async function findLatestBotStateSnapshot(botId: string) {
  return (await findLatestBotStateSnapshots([botId])).get(botId) ?? null;
}
