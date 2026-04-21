import { BotStatus, type BotStateRepository } from "@grid-bot/core";
import { Prisma } from "@prisma/client";

import { prisma } from "../client";
import { mapAggregate } from "../mappers";
import { findLatestBotStateSnapshot, findLatestBotStateSnapshots } from "./latest-state-snapshots";

export class PrismaBotStateRepository implements BotStateRepository {
  async listRunnableBots() {
    const bots = await prisma.bot.findMany({
      where: {
        archivedAt: null,
        status: {
          in: [BotStatus.Running, BotStatus.Cooldown, BotStatus.Error, BotStatus.OutOfRange]
        }
      },
      include: {
        config: true,
        position: true,
        positionLots: {
          orderBy: { openedAt: "asc" }
        }
      },
      orderBy: { createdAt: "asc" }
    });
    const latestStateByBotId = await findLatestBotStateSnapshots(bots.map((bot) => bot.id));

    return bots
      .map((bot) =>
        mapAggregate({
          bot,
          config: bot.config,
          stateSnapshots: latestStateByBotId.get(bot.id) ? [latestStateByBotId.get(bot.id)!] : [],
          position: bot.position,
          positionLots: bot.positionLots
        })
      )
      .filter((value): value is NonNullable<typeof value> => Boolean(value));
  }

  async getBotAggregate(botId: string) {
    const bot = await prisma.bot.findFirst({
      where: { id: botId, archivedAt: null },
      include: {
        config: true,
        position: true,
        positionLots: {
          orderBy: { openedAt: "asc" }
        }
      }
    });
    const latestState = bot ? await findLatestBotStateSnapshot(bot.id) : null;
    return bot
      ? mapAggregate({
          bot,
          config: bot.config,
          stateSnapshots: latestState ? [latestState] : [],
          position: bot.position,
          positionLots: bot.positionLots
        })
      : null;
  }

  async updateBotStatus(botId: string, status: BotStatus) {
    await prisma.bot.update({
      where: { id: botId },
      data: { status: status as never }
    });
  }

  async setBotHeartbeat(botId: string, currentPrice: number | null) {
    await prisma.bot.update({
      where: { id: botId },
      data: {
        currentPrice: currentPrice ?? undefined,
        lastHeartbeatAt: new Date()
      }
    });
  }

  async createStateSnapshot(snapshot: Parameters<BotStateRepository["createStateSnapshot"]>[0]) {
    await prisma.$transaction([
      prisma.botStateSnapshot.create({
        data: {
          botId: snapshot.botId,
          status: snapshot.status as never,
          currentPrice: snapshot.currentPrice ?? undefined,
          availableQuoteAmount: snapshot.availableQuoteAmount,
          availableBaseAmount: snapshot.availableBaseAmount,
          deployedQuoteAmount: snapshot.deployedQuoteAmount,
          averageEntryPrice: snapshot.averageEntryPrice ?? undefined,
          realizedPnlUsd: snapshot.realizedPnlUsd,
          unrealizedPnlUsd: snapshot.unrealizedPnlUsd,
          totalEquityUsd: snapshot.totalEquityUsd,
          consecutiveFailures: snapshot.consecutiveFailures,
          lastExecutionAt: snapshot.lastExecutionAt ?? undefined,
          lastProcessedAt: snapshot.lastProcessedAt,
          lastRecenterAt: snapshot.lastRecenterAt ?? undefined,
          metadata: snapshot.metadata as unknown as Prisma.InputJsonValue
        }
      }),
      prisma.bot.update({
        where: { id: snapshot.botId },
        data: {
          status: snapshot.status as never,
          currentPrice: snapshot.currentPrice ?? undefined
        }
      })
    ]);
  }

  async withBotLock<T>(botId: string, callback: () => Promise<T>): Promise<T | null> {
    return prisma.$transaction(
      async (tx) => {
        const result = await tx.$queryRaw<Array<{ locked: boolean }>>(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext(${botId})) AS locked`
        );

        if (!result[0]?.locked) {
          return null;
        }

        return callback();
      },
      {
        maxWait: 5_000,
        timeout: 20_000
      }
    );
  }
}
