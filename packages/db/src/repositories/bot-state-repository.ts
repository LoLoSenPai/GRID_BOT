import { BotStatus, type BotStateRepository } from "@grid-bot/core";
import { Prisma } from "@prisma/client";

import { prisma, botLockPool } from "../client";
import { stateSnapshotData } from "./execution-persistence-data";
import { mapAggregate } from "../mappers";
import { findLatestBotStateSnapshot, findLatestBotStateSnapshots } from "./latest-state-snapshots";

export class PrismaBotStateRepository implements BotStateRepository {
  async listRunnableBots() {
    const bots = await prisma.bot.findMany({
      where: {
        OR: [
          { archivedAt: null, status: { in: [BotStatus.Running, BotStatus.Cooldown, BotStatus.Error, BotStatus.OutOfRange] } },
          { executionAttempt: { isNot: null } },
        ]
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
      where: { id: botId, OR: [{ archivedAt: null }, { executionAttempt: { isNot: null } }] },
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
    await prisma.bot.updateMany({
      where: { id: botId, ...([BotStatus.Paused, BotStatus.Stopped].includes(status) ? {} : { status: { notIn: [BotStatus.Paused, BotStatus.Stopped] } }) },
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
    await prisma.$transaction(async (tx) => {
      const current = await tx.$queryRaw<Array<{ status: BotStatus }>>(
        Prisma.sql`SELECT status FROM bots WHERE id = ${snapshot.botId} FOR UPDATE`
      );
      if (!current[0]) throw new Error("Bot no longer exists.");
      const status = preserveOperatorStatus(current[0].status, snapshot.status);
      await tx.botStateSnapshot.create({ data: stateSnapshotData({ ...snapshot, status }) });
      await tx.bot.update({ where: { id: snapshot.botId }, data: { status: status as never, currentPrice: snapshot.currentPrice } });
    });
  }

  async updateRange(botId: string, range: { lowPrice: number; highPrice: number }, snapshot: Parameters<BotStateRepository["createStateSnapshot"]>[0]) {
    if (snapshot.botId !== botId || !Number.isFinite(range.lowPrice) || !Number.isFinite(range.highPrice) ||
      range.lowPrice <= 0 || range.highPrice <= range.lowPrice) throw new Error("Invalid recenter range.");
    await prisma.$transaction(async (tx) => {
      const current = await tx.$queryRaw<Array<{ status: BotStatus }>>(
        Prisma.sql`SELECT status FROM bots WHERE id = ${botId} FOR UPDATE`
      );
      if (!current[0]) throw new Error("Bot no longer exists.");
      const lots = await tx.positionLot.count({ where: { botId, kind: "trading", closedAt: null, remainingBaseAmount: { gt: 0 } } });
      const attempt = await tx.executionAttempt.findUnique({ where: { botId } });
      if (lots || attempt) throw new Error("Cannot recenter while trading lots or an unresolved execution exist.");
      if ([BotStatus.Paused, BotStatus.Stopped].includes(current[0].status)) throw new Error("Cannot recenter a paused or stopped bot.");
      await tx.botConfig.update({ where: { botId }, data: range });
      await tx.botStateSnapshot.create({ data: stateSnapshotData(snapshot) });
      await tx.bot.update({ where: { id: botId }, data: { status: snapshot.status as never, currentPrice: snapshot.currentPrice } });
    });
  }

  async withBotLock<T>(botId: string, callback: () => Promise<T>): Promise<T | null> {
    const client = await botLockPool.connect();
    let locked = false;
    let connectionError: Error | undefined;
    const onError = (error: Error) => { connectionError = error; };
    client.on("error", onError);
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [botId]
      );
      locked = result.rows[0]?.locked ?? false;
      if (!locked) return null;
      const resultValue = await callback();
      if (connectionError) throw new Error("Bot lock connection was lost; durable execution reconciliation required.", { cause: connectionError });
      return resultValue;
    } finally {
      try {
        if (locked && !connectionError) {
          const result = await client.query<{ unlocked: boolean }>(
            "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked", [botId]
          );
          if (!result.rows[0]?.unlocked) connectionError = new Error("Bot advisory lock was no longer held.");
        }
      } catch (error) { connectionError = error instanceof Error ? error : new Error(String(error)); }
      finally {
        client.removeListener("error", onError);
        // Destroy the session if unlock failed; never pool a possibly locked session.
        client.release(connectionError);
      }
    }
  }
}

export function preserveOperatorStatus(current: BotStatus, proposed: BotStatus): BotStatus {
  return current === BotStatus.Paused || current === BotStatus.Stopped ? current : proposed;
}
