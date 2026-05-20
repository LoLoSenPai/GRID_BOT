import "dotenv/config";

import {
  GridStrategyService,
  reconcileOpenPositionLots,
  type BotRuntimeMetadata,
  type PositionLot,
} from "@grid-bot/core";
import type { Prisma } from "@prisma/client";

type PrismaClientShape = typeof import("../src/client")["prisma"];

type DbLot = {
  id: string;
  botId: string;
  originalBaseAmount: { toString(): string };
  remainingBaseAmount: { toString(): string };
  entryPrice: { toString(): string };
  costQuote: { toString(): string };
  openedByExecutionId: string;
  closedByExecutionId: string | null;
  openedAt: Date;
  closedAt: Date | null;
};

type DbBot = {
  id: string;
  name: string;
  mode: string;
  status: string;
  config: {
    lowPrice: { toNumber(): number };
    highPrice: { toNumber(): number };
    levelCount: number;
    gridType: string;
  } | null;
  stateSnapshots: Array<{
    id: string;
    deployedQuoteAmount: { toNumber(): number };
    availableBaseAmount: { toNumber(): number };
    metadata: Prisma.JsonValue;
    createdAt: Date;
  }>;
  positionLots: DbLot[];
};

function printHelp() {
  console.log(`
Usage:
  pnpm db:repair-open-lots
  pnpm db:repair-open-lots -- --bot-id <botId>
  pnpm db:repair-open-lots -- --bot-name "plus agressif"
  pnpm db:repair-open-lots -- --inspect --bot-name "plus agressif"
  pnpm db:repair-open-lots -- --apply

Default mode is dry-run. Use --apply to write the cleaned open lots.
Use --inspect to print the raw DB source behind chart Bxx/Sxx labels.

What it fixes:
  - Removes stale position_lots that no longer match latest deployed quote/base state.
  - Rebuilds latest state metadata.gridCycles from the surviving lots and current grid.

Operational note:
  Pause the target bot, or stop the worker briefly, before running --apply.
`);
}

function getArgValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    if ("toNumber" in value && typeof value.toNumber === "function") {
      const numeric = value.toNumber();
      return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : 0;
    }

    if ("toString" in value && typeof value.toString === "function") {
      const numeric = Number(value.toString());
      return Number.isFinite(numeric) ? numeric : 0;
    }
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function mapLot(lot: DbLot): PositionLot {
  return {
    id: lot.id,
    botId: lot.botId,
    originalBaseAmount: toNumber(lot.originalBaseAmount),
    remainingBaseAmount: toNumber(lot.remainingBaseAmount),
    entryPrice: toNumber(lot.entryPrice),
    costQuote: toNumber(lot.costQuote),
    openedByExecutionId: lot.openedByExecutionId,
    closedByExecutionId: lot.closedByExecutionId,
    openedAt: lot.openedAt,
    closedAt: lot.closedAt,
  };
}

function normalizeMetadata(metadata: Prisma.JsonValue): BotRuntimeMetadata {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Partial<BotRuntimeMetadata>)
      : {};

  return {
    levelLocks:
      record.levelLocks && typeof record.levelLocks === "object" && !Array.isArray(record.levelLocks)
        ? (record.levelLocks as Record<string, string>)
        : {},
    pendingSignal: record.pendingSignal ?? null,
    gridCycles:
      record.gridCycles && typeof record.gridCycles === "object" && !Array.isArray(record.gridCycles)
        ? record.gridCycles
        : {},
    recenterHistory: Array.isArray(record.recenterHistory)
      ? record.recenterHistory.filter((value): value is string => typeof value === "string")
      : [],
    recentExecutions: Array.isArray(record.recentExecutions)
      ? record.recentExecutions.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function sameLotSet(left: PositionLot[], right: PositionLot[]) {
  if (left.length !== right.length) {
    return false;
  }

  const leftIds = left.map((lot) => lot.id).sort();
  const rightIds = right.map((lot) => lot.id).sort();
  return leftIds.every((id, index) => id === rightIds[index]);
}

function sameLotState(left: PositionLot[], right: PositionLot[]) {
  if (!sameLotSet(left, right)) {
    return false;
  }

  const rightById = new Map(right.map((lot) => [lot.id, lot]));
  return left.every((leftLot) => {
    const rightLot = rightById.get(leftLot.id);
    if (!rightLot) {
      return false;
    }

    return (
      Math.abs(leftLot.remainingBaseAmount - rightLot.remainingBaseAmount) < 0.000001 &&
      Math.abs(leftLot.originalBaseAmount - rightLot.originalBaseAmount) < 0.000001 &&
      Math.abs(leftLot.entryPrice - rightLot.entryPrice) < 0.000001 &&
      Math.abs(leftLot.costQuote - rightLot.costQuote) < 0.000001
    );
  });
}

function sameGridCycles(
  left: BotRuntimeMetadata["gridCycles"],
  right: BotRuntimeMetadata["gridCycles"],
) {
  const normalize = (cycles: BotRuntimeMetadata["gridCycles"]) =>
    Object.values(cycles ?? {})
      .map((cycle) => ({
        buyLevelIndex: cycle.buyLevelIndex,
        sellLevelIndex: cycle.sellLevelIndex,
        lotId: cycle.lotId,
      }))
      .sort((leftCycle, rightCycle) => {
        if (leftCycle.lotId !== rightCycle.lotId) {
          return leftCycle.lotId.localeCompare(rightCycle.lotId);
        }
        return leftCycle.buyLevelIndex - rightCycle.buyLevelIndex;
      });

  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function describeLot(lot: PositionLot) {
  const costBasis = lot.remainingBaseAmount > 0 ? lot.costQuote / lot.remainingBaseAmount : lot.entryPrice;
  return `${lot.id} entry=${costBasis.toFixed(4)} cost=$${lot.costQuote.toFixed(2)} base=${lot.remainingBaseAmount.toFixed(6)}`;
}

function formatLevelCode(levelIndex: number | null | undefined) {
  if (typeof levelIndex !== "number" || !Number.isFinite(levelIndex)) {
    return "--";
  }

  return String(levelIndex + 1).padStart(2, "0");
}

function formatCycleLabel(cycle: NonNullable<BotRuntimeMetadata["gridCycles"]>[string]) {
  const buyLabel = `B${formatLevelCode(cycle.buyLevelIndex)}`;
  const sellLabel = cycle.sellLevelIndex === null ? "--" : `S${formatLevelCode(cycle.sellLevelIndex)}`;
  return `${buyLabel}/${sellLabel}`;
}

function getLotMateriality(lot: PositionLot) {
  return lot.remainingBaseAmount > 0.000001 && lot.costQuote > 0.05;
}

function printInspectBlock({
  bot,
  latestState,
  rawOpenLots,
  reconciledOpenLots,
  currentMetadata,
  gridCycles,
  lotsNeedRepair,
  metadataNeedsRepair,
}: {
  bot: DbBot;
  latestState: DbBot["stateSnapshots"][number];
  rawOpenLots: PositionLot[];
  reconciledOpenLots: PositionLot[];
  currentMetadata: BotRuntimeMetadata;
  gridCycles: NonNullable<BotRuntimeMetadata["gridCycles"]>;
  lotsNeedRepair: boolean;
  metadataNeedsRepair: boolean;
}) {
  const rawLotIds = new Set(rawOpenLots.map((lot) => lot.id));
  const reconciledLotIds = new Set(reconciledOpenLots.map((lot) => lot.id));

  console.log(`\n[inspect] ${bot.name} (${bot.id})`);
  console.log(`  mode=${bot.mode} status=${bot.status}`);
  console.log(
    `  config range=${bot.config?.lowPrice.toNumber()}-${bot.config?.highPrice.toNumber()} rails=${bot.config?.levelCount} grid=${bot.config?.gridType}`,
  );
  console.log(
    `  latestState=${latestState.id} at=${latestState.createdAt.toISOString()} deployed=${latestState.deployedQuoteAmount.toNumber().toFixed(10)} base=${latestState.availableBaseAmount.toNumber().toFixed(10)}`,
  );

  console.log(`  raw open lots (${rawOpenLots.length})`);
  for (const lot of rawOpenLots) {
    console.log(`    ${describeLot(lot)} material=${getLotMateriality(lot) ? "yes" : "no"}`);
  }

  console.log(`  reconciled lots (${reconciledOpenLots.length})`);
  for (const lot of reconciledOpenLots) {
    console.log(`    ${describeLot(lot)}`);
  }

  console.log(`  current metadata.gridCycles (${Object.keys(currentMetadata.gridCycles ?? {}).length})`);
  for (const [key, cycle] of Object.entries(currentMetadata.gridCycles ?? {}).sort((left, right) => left[0].localeCompare(right[0]))) {
    console.log(
      `    key=${key} ${formatCycleLabel(cycle)} lot=${cycle.lotId} rawLot=${rawLotIds.has(cycle.lotId) ? "yes" : "no"} reconciledLot=${reconciledLotIds.has(cycle.lotId) ? "yes" : "no"}`,
    );
  }

  console.log(`  rebuilt gridCycles (${Object.keys(gridCycles).length})`);
  for (const [key, cycle] of Object.entries(gridCycles).sort((left, right) => left[0].localeCompare(right[0]))) {
    console.log(`    key=${key} ${formatCycleLabel(cycle)} lot=${cycle.lotId}`);
  }

  console.log(`  repair needed: lots=${lotsNeedRepair ? "yes" : "no"} metadata=${metadataNeedsRepair ? "yes" : "no"}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const apply = args.includes("--apply");
  const inspect = args.includes("--inspect");
  const botId = getArgValue(args, "--bot-id");
  const botName = getArgValue(args, "--bot-name");
  const { prisma } = (await import("../src/client")) as { prisma: PrismaClientShape };
  const strategyService = new GridStrategyService();

  const bots = (await prisma.bot.findMany({
    where: {
      archivedAt: null,
      ...(botId ? { id: botId } : {}),
      ...(botName ? { name: { contains: botName, mode: "insensitive" } } : {}),
    },
    include: {
      config: true,
      stateSnapshots: {
        take: 1,
        orderBy: { createdAt: "desc" },
      },
      positionLots: {
        where: { closedAt: null },
        orderBy: { openedAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  })) as unknown as DbBot[];

  if (bots.length === 0) {
    console.log("No matching active bots found.");
    await prisma.$disconnect();
    return;
  }

  let changedBotCount = 0;

  for (const bot of bots) {
    const latestState = bot.stateSnapshots[0] ?? null;
    if (!bot.config || !latestState) {
      continue;
    }

    const rawOpenLots = bot.positionLots.map(mapLot).filter((lot) => lot.remainingBaseAmount > 0 && lot.costQuote > 0);
    const reconciledOpenLots = reconcileOpenPositionLots(rawOpenLots, {
      deployedQuoteAmount: latestState.deployedQuoteAmount.toNumber(),
      availableBaseAmount: latestState.availableBaseAmount.toNumber(),
    });
    const levels = strategyService.calculateLevels(
      bot.config.lowPrice.toNumber(),
      bot.config.highPrice.toNumber(),
      bot.config.levelCount,
      bot.config.gridType as never,
    );
    const currentMetadata = normalizeMetadata(latestState.metadata);
    const gridCycles = strategyService.remapOpenLotsToGridCycles(levels, reconciledOpenLots);
    const lotsNeedRepair = !sameLotState(rawOpenLots, reconciledOpenLots);
    const metadataNeedsRepair = !sameGridCycles(currentMetadata.gridCycles, gridCycles);

    if (inspect) {
      printInspectBlock({
        bot,
        latestState,
        rawOpenLots,
        reconciledOpenLots,
        currentMetadata,
        gridCycles,
        lotsNeedRepair,
        metadataNeedsRepair,
      });
    }

    if (!lotsNeedRepair && !metadataNeedsRepair) {
      continue;
    }

    changedBotCount += 1;
    const removedLots = rawOpenLots.filter((lot) => !reconciledOpenLots.some((kept) => kept.id === lot.id));
    const nextMetadata: BotRuntimeMetadata = {
      ...currentMetadata,
      levelLocks: {},
      pendingSignal: null,
      gridCycles,
    };

    console.log(`\n${bot.name} (${bot.id})`);
    console.log(`  deployed=$${latestState.deployedQuoteAmount.toNumber().toFixed(2)} base=${latestState.availableBaseAmount.toNumber().toFixed(6)}`);
    console.log(`  open lots: ${rawOpenLots.length} -> ${reconciledOpenLots.length}`);
    if (lotsNeedRepair && removedLots.length === 0) {
      console.log("  normalize open lot amounts to latest runtime deployed/base balance");
    }
    if (metadataNeedsRepair) {
      console.log(`  rebuild gridCycles: ${Object.keys(currentMetadata.gridCycles ?? {}).length} -> ${Object.keys(gridCycles).length}`);
    }
    for (const lot of removedLots) {
      console.log(`  remove ${describeLot(lot)}`);
    }

    if (!apply) {
      continue;
    }

    await prisma.$transaction(async (tx) => {
      if (lotsNeedRepair) {
        await tx.positionLot.deleteMany({ where: { botId: bot.id } });

        if (reconciledOpenLots.length > 0) {
          await tx.positionLot.createMany({
            data: reconciledOpenLots.map((lot) => ({
              id: lot.id,
              botId: bot.id,
              originalBaseAmount: lot.originalBaseAmount,
              remainingBaseAmount: lot.remainingBaseAmount,
              entryPrice: lot.entryPrice,
              costQuote: lot.costQuote,
              openedByExecutionId: lot.openedByExecutionId,
              closedByExecutionId: lot.closedByExecutionId ?? undefined,
              openedAt: lot.openedAt,
              closedAt: lot.closedAt ?? undefined,
            })),
          });
        }
      }

      await tx.botStateSnapshot.update({
        where: { id: latestState.id },
        data: {
          metadata: nextMetadata as never,
        },
      });

      await tx.systemLog.create({
        data: {
          botId: bot.id,
          level: "info",
          category: "maintenance",
          message: "Repaired inconsistent open position lots.",
          metadata: {
            removedLotCount: removedLots.length,
            keptLotCount: reconciledOpenLots.length,
            rebuiltGridCycles: metadataNeedsRepair,
            removedLotIds: removedLots.map((lot) => lot.id),
          },
        },
      });
    });
  }

  if (changedBotCount === 0) {
    console.log("No stale open lots or grid-cycle mismatches found.");
  } else if (!apply) {
    console.log(`\nDry-run only. Re-run with --apply to write ${changedBotCount} bot repair(s).`);
  } else {
    console.log(`\nApplied ${changedBotCount} bot repair(s).`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
