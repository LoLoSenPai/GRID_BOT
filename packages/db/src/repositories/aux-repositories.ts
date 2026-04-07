import type { AlertRepository, PriceSnapshotRepository, SystemLogRepository } from "@grid-bot/core";
import { mapAlert } from "../mappers";

import { prisma } from "../client";

export class PrismaPriceSnapshotRepository implements PriceSnapshotRepository {
  async createPriceSnapshot(input: Parameters<PriceSnapshotRepository["createPriceSnapshot"]>[0]) {
    await prisma.priceSnapshot.create({
      data: {
        botId: input.botId ?? undefined,
        symbol: input.symbol,
        source: input.source,
        price: input.price,
        confidence: input.confidence,
        feedId: input.feedId,
        status: input.status,
        capturedAt: input.capturedAt
      }
    });
  }
}

export class PrismaAlertRepository implements AlertRepository {
  async createAlert(alert: Parameters<AlertRepository["createAlert"]>[0]) {
    const created = await prisma.alert.create({
      data: {
        botId: alert.botId ?? undefined,
        type: alert.type as never,
        severity: alert.severity,
        title: alert.title,
        message: alert.message,
        metadata: alert.metadata as never
      }
    });

    return mapAlert(created);
  }
}

export class PrismaSystemLogRepository implements SystemLogRepository {
  async writeLog(entry: Parameters<SystemLogRepository["writeLog"]>[0]) {
    await prisma.systemLog.create({
      data: {
        botId: entry.botId ?? undefined,
        level: entry.level as never,
        category: entry.category,
        message: entry.message,
        metadata: entry.metadata as never
      }
    });
  }
}
