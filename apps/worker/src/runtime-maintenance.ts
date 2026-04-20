import { logger } from "@grid-bot/common";
import { prisma } from "@grid-bot/db";

import { prunePortfolioSnapshots } from "./portfolio-snapshots";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
let lastMaintenanceStartedAt = 0;

export async function runRuntimeMaintenance(now = new Date()) {
  if (now.getTime() - lastMaintenanceStartedAt < SIX_HOURS_MS) {
    return false;
  }

  lastMaintenanceStartedAt = now.getTime();

  const priceSnapshotCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const stateSnapshotCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const infoLogCutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  try {
    const [
      priceSnapshots,
      stateSnapshots,
      inventorySnapshots,
      pnlSnapshots,
      portfolioSnapshots,
      infoLogs,
    ] = await prisma.$transaction([
      prisma.priceSnapshot.deleteMany({
        where: {
          createdAt: {
            lt: priceSnapshotCutoff,
          },
        },
      }),
      prisma.botStateSnapshot.deleteMany({
        where: {
          createdAt: {
            lt: stateSnapshotCutoff,
          },
        },
      }),
      prisma.inventorySnapshot.deleteMany({
        where: {
          createdAt: {
            lt: stateSnapshotCutoff,
          },
        },
      }),
      prisma.pnlSnapshot.deleteMany({
        where: {
          createdAt: {
            lt: stateSnapshotCutoff,
          },
        },
      }),
      prunePortfolioSnapshots(now),
      prisma.systemLog.deleteMany({
        where: {
          level: "info",
          createdAt: {
            lt: infoLogCutoff,
          },
        },
      }),
    ]);

    logger.info(
      {
        deleted: {
          priceSnapshots: priceSnapshots.count,
          stateSnapshots: stateSnapshots.count,
          inventorySnapshots: inventorySnapshots.count,
          pnlSnapshots: pnlSnapshots.count,
          portfolioSnapshots: portfolioSnapshots.count,
          infoLogs: infoLogs.count,
        },
      },
      "Runtime maintenance completed",
    );
    return true;
  } catch (error) {
    logger.error({ error }, "Runtime maintenance failed");
    return false;
  }
}

export function getRuntimeMaintenanceIntervalMs() {
  return SIX_HOURS_MS;
}
