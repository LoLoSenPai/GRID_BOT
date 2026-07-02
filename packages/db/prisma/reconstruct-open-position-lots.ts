import "dotenv/config";

import {
  GridStrategyService,
  type BotRuntimeMetadata,
  type PositionLot,
} from "@grid-bot/core";
import { ExecutionStatus, StrategyMode, TradeSide } from "@grid-bot/core/enums";
import type { Prisma } from "@prisma/client";

type PrismaClientShape = typeof import("../src/client")["prisma"];

type DbBot = Prisma.BotGetPayload<{
  include: {
    config: true;
    position: true;
    stateSnapshots: {
      take: 1;
      orderBy: {
        createdAt: "desc";
      };
    };
    positionLots: {
      where: {
        closedAt: null;
      };
      orderBy: {
        openedAt: "asc";
      };
    };
    executions: {
      include: {
        order: true;
      };
      orderBy: {
        createdAt: "asc";
      };
    };
  };
}>;

type ReplayLot = PositionLot & {
  buyLevelIndex: number;
};

type ReplayResult = {
  openLots: ReplayLot[];
  realizedPnlUsd: number;
  totalFeesQuote: number;
  buyCount: number;
  sellCount: number;
  ignoredCount: number;
};

const MATERIAL_BASE_EPSILON = 0.000001;
const MATERIAL_QUOTE_EPSILON = 0.05;

function printHelp() {
  console.log(`
Usage:
  pnpm db:reconstruct-open-lots -- --bot-name "Farm USDC" --inspect
  pnpm db:reconstruct-open-lots -- --bot-name "Farm USDC" --apply
  pnpm db:reconstruct-open-lots -- --bot-id <botId> --inspect

Default mode is dry-run. Use --apply only after checking the reconstructed
base amount against the wallet/base inventory you want the bot to manage.

What it does:
  - Replays successful executions chronologically.
  - Rebuilds probable open position_lots.
  - Rebuilds metadata.gridCycles from those lots and the current grid.
  - Recomputes latest runtime deployed/base/unrealized values.

Operational note:
  Stop the worker before --apply, then restart it after the script finishes.
`);
}

function getArgValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
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

function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function isSuccessfulExecution(status: unknown) {
  return status === ExecutionStatus.Submitted || status === ExecutionStatus.Filled || status === ExecutionStatus.Simulated;
}

function isMaterialLot(lot: PositionLot) {
  return lot.remainingBaseAmount > MATERIAL_BASE_EPSILON && lot.costQuote > MATERIAL_QUOTE_EPSILON && !lot.closedAt;
}

function getEffectivePrice(side: TradeSide, inputAmount: number, outputAmount: number, fallbackPrice: number) {
  if (side === TradeSide.Buy) {
    return outputAmount > 0 ? inputAmount / outputAmount : fallbackPrice;
  }

  return inputAmount > 0 ? outputAmount / inputAmount : fallbackPrice;
}

function replayExecutions(bot: DbBot): ReplayResult {
  let openLots: ReplayLot[] = [];
  let realizedPnlUsd = 0;
  let totalFeesQuote = 0;
  let buyCount = 0;
  let sellCount = 0;
  let ignoredCount = 0;

  for (const execution of bot.executions) {
    if (!isSuccessfulExecution(execution.status)) {
      ignoredCount += 1;
      continue;
    }

    const side = execution.order.side as TradeSide;
    const inputAmount = toNumber(execution.executedInputAmount);
    const outputAmount = toNumber(execution.executedOutputAmount);
    const feeAmount = toNumber(execution.executedFeeAmount);
    const targetPrice = toNumber(execution.order.targetPrice);
    const levelIndex = execution.order.levelIndex;

    if (inputAmount <= 0 || outputAmount <= 0) {
      ignoredCount += 1;
      continue;
    }

    totalFeesQuote = round(totalFeesQuote + feeAmount, 8);

    if (side === TradeSide.Buy) {
      const costQuote = round(inputAmount + feeAmount, 8);
      const entryPrice = outputAmount > 0 ? round(costQuote / outputAmount, 8) : targetPrice;
      openLots = [
        ...openLots,
        {
          id: `lot-${execution.id}`,
          botId: bot.id,
          originalBaseAmount: outputAmount,
          remainingBaseAmount: outputAmount,
          entryPrice,
          costQuote,
          openedByExecutionId: execution.id,
          closedByExecutionId: null,
          openedAt: execution.completedAt ?? execution.createdAt,
          closedAt: null,
          buyLevelIndex: levelIndex,
        },
      ];
      buyCount += 1;
      continue;
    }

    const effectivePrice = getEffectivePrice(side, inputAmount, outputAmount, targetPrice);
    const exactLevelCandidates = openLots.filter((lot) => lot.buyLevelIndex === levelIndex - 1 && isMaterialLot(lot));
    const fallbackCandidates = openLots
      .filter(isMaterialLot)
      .filter((lot) => !exactLevelCandidates.some((candidate) => candidate.id === lot.id))
      .filter((lot) => lot.costQuote / lot.remainingBaseAmount < effectivePrice)
      .sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime());
    const candidates = [...exactLevelCandidates, ...fallbackCandidates].sort(
      (left, right) => left.openedAt.getTime() - right.openedAt.getTime(),
    );

    let remainingToSell = inputAmount;
    let remainingFee = feeAmount;
    let remainingOutput = outputAmount;

    openLots = openLots
      .map((lot) => {
        if (remainingToSell <= MATERIAL_BASE_EPSILON || !candidates.some((candidate) => candidate.id === lot.id)) {
          return lot;
        }

        const soldBase = Math.min(lot.remainingBaseAmount, remainingToSell);
        const soldRatio = inputAmount > 0 ? soldBase / inputAmount : 0;
        const soldQuote = round(outputAmount * soldRatio, 8);
        const soldFee = round(feeAmount * soldRatio, 8);
        const costPerBase = lot.remainingBaseAmount > 0 ? lot.costQuote / lot.remainingBaseAmount : 0;
        const soldCostQuote = round(costPerBase * soldBase, 8);
        const nextRemainingBase = round(lot.remainingBaseAmount - soldBase, 8);
        const nextCostQuote = round(Math.max(lot.costQuote - soldCostQuote, 0), 8);

        remainingToSell = round(remainingToSell - soldBase, 8);
        remainingOutput = round(remainingOutput - soldQuote, 8);
        remainingFee = round(remainingFee - soldFee, 8);
        realizedPnlUsd = round(realizedPnlUsd + soldQuote - soldFee - soldCostQuote, 8);

        return {
          ...lot,
          remainingBaseAmount: nextRemainingBase,
          costQuote: nextCostQuote,
          closedByExecutionId: nextRemainingBase <= MATERIAL_BASE_EPSILON ? execution.id : lot.closedByExecutionId,
          closedAt: nextRemainingBase <= MATERIAL_BASE_EPSILON ? (execution.completedAt ?? execution.createdAt) : lot.closedAt,
        };
      })
      .filter(isMaterialLot);

    // If an accumulate-base/balanced sell retained some base, it is intentionally
    // not carried as an open grid lot. The current live engine also frees the
    // matched cycle after the paired sell.
    void remainingOutput;
    void remainingFee;
    sellCount += 1;
  }

  return {
    openLots,
    realizedPnlUsd,
    totalFeesQuote,
    buyCount,
    sellCount,
    ignoredCount,
  };
}

function mapDbLot(lot: DbBot["positionLots"][number]): PositionLot {
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

function summarizeLots(lots: PositionLot[]) {
  const base = round(lots.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0), 10);
  const cost = round(lots.reduce((sum, lot) => sum + lot.costQuote, 0), 8);
  const averageEntry = base > 0 ? round(cost / base, 8) : 0;
  return { base, cost, averageEntry };
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
    pendingSignal: null,
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

function formatLot(lot: PositionLot) {
  const averageEntry = lot.remainingBaseAmount > 0 ? lot.costQuote / lot.remainingBaseAmount : lot.entryPrice;
  return `${lot.id} opened=${lot.openedAt.toISOString()} cost=$${lot.costQuote.toFixed(2)} base=${lot.remainingBaseAmount.toFixed(8)} entry=${averageEntry.toFixed(4)}`;
}

function printBotReplay(bot: DbBot, replay: ReplayResult) {
  const currentLots = bot.positionLots.map(mapDbLot).filter(isMaterialLot);
  const current = summarizeLots(currentLots);
  const reconstructed = summarizeLots(replay.openLots);
  const currentIds = new Set(currentLots.map((lot) => lot.id));
  const replayIds = new Set(replay.openLots.map((lot) => lot.id));
  const missing = replay.openLots.filter((lot) => !currentIds.has(lot.id));
  const extra = currentLots.filter((lot) => !replayIds.has(lot.id));

  console.log(`\n[replay] ${bot.name} (${bot.id})`);
  console.log(`  mode=${bot.mode} status=${bot.status} strategy=${bot.strategyMode}`);
  console.log(`  executions: buys=${replay.buyCount} sells=${replay.sellCount} ignored=${replay.ignoredCount}`);
  console.log(`  current open:       lots=${currentLots.length} cost=$${current.cost.toFixed(2)} base=${current.base.toFixed(8)} avg=${current.averageEntry.toFixed(4)}`);
  console.log(`  reconstructed open: lots=${replay.openLots.length} cost=$${reconstructed.cost.toFixed(2)} base=${reconstructed.base.toFixed(8)} avg=${reconstructed.averageEntry.toFixed(4)}`);
  console.log(`  replay realized=$${replay.realizedPnlUsd.toFixed(2)} fees=$${replay.totalFeesQuote.toFixed(2)}`);

  if (missing.length > 0) {
    console.log("  missing in DB:");
    for (const lot of missing) {
      console.log(`    + ${formatLot(lot)}`);
    }
  }

  if (extra.length > 0) {
    console.log("  extra in DB:");
    for (const lot of extra) {
      console.log(`    - ${formatLot(lot)}`);
    }
  }

  if (missing.length === 0 && extra.length === 0) {
    console.log("  DB open lots already match execution replay.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const apply = args.includes("--apply");
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
      position: true,
      stateSnapshots: {
        take: 1,
        orderBy: { createdAt: "desc" },
      },
      positionLots: {
        where: { closedAt: null },
        orderBy: { openedAt: "asc" },
      },
      executions: {
        include: { order: true },
        orderBy: { createdAt: "asc" },
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
    if (!bot.config) {
      continue;
    }

    const latestState = bot.stateSnapshots[0] ?? null;
    const replay = replayExecutions(bot);
    printBotReplay(bot, replay);

    const currentLots = bot.positionLots.map(mapDbLot).filter(isMaterialLot);
    const currentIds = new Set(currentLots.map((lot) => lot.id));
    const replayIds = new Set(replay.openLots.map((lot) => lot.id));
    const lotsDiffer =
      currentLots.length !== replay.openLots.length ||
      replay.openLots.some((lot) => !currentIds.has(lot.id)) ||
      currentLots.some((lot) => !replayIds.has(lot.id));

    if (!lotsDiffer && latestState) {
      continue;
    }

    changedBotCount += 1;
    if (!apply) {
      continue;
    }

    const openSummary = summarizeLots(replay.openLots);
    const currentPrice = toNumber(latestState?.currentPrice) || toNumber(bot.currentPrice) || openSummary.averageEntry;
    const unrealizedPnlUsd = round(openSummary.base * currentPrice - openSummary.cost, 8);
    const availableQuoteAmount = Math.max(
      round(toNumber(bot.config.totalBudgetUsd) + replay.realizedPnlUsd - openSummary.cost, 8),
      0,
    );
    const totalEquityUsd = round(availableQuoteAmount + openSummary.base * currentPrice, 8);
    const levels = strategyService.calculateLevels(
      toNumber(bot.config.lowPrice),
      toNumber(bot.config.highPrice),
      bot.config.levelCount,
      bot.config.gridType as never,
    );
    const gridCycles = strategyService.remapOpenLotsToGridCycles(levels, replay.openLots);
    const metadata: BotRuntimeMetadata = {
      ...(latestState ? normalizeMetadata(latestState.metadata) : normalizeMetadata(null)),
      levelLocks: {},
      pendingSignal: null,
      gridCycles,
    };

    await prisma.$transaction(async (tx) => {
      await tx.positionLot.deleteMany({ where: { botId: bot.id, closedAt: null } });

      if (replay.openLots.length > 0) {
        await tx.positionLot.createMany({
          data: replay.openLots.map((lot) => ({
            id: lot.id,
            botId: lot.botId,
            originalBaseAmount: lot.originalBaseAmount,
            remainingBaseAmount: lot.remainingBaseAmount,
            entryPrice: lot.entryPrice,
            costQuote: lot.costQuote,
            openedByExecutionId: lot.openedByExecutionId,
            openedAt: lot.openedAt,
          })),
          skipDuplicates: true,
        });
      }

      if (latestState) {
        await tx.botStateSnapshot.update({
          where: { id: latestState.id },
          data: {
            availableQuoteAmount,
            availableBaseAmount: openSummary.base,
            deployedQuoteAmount: openSummary.cost,
            averageEntryPrice: openSummary.averageEntry || null,
            realizedPnlUsd: replay.realizedPnlUsd,
            unrealizedPnlUsd,
            totalEquityUsd,
            metadata: metadata as never,
          },
        });
      } else {
        await tx.botStateSnapshot.create({
          data: {
            botId: bot.id,
            status: bot.status,
            currentPrice: currentPrice || null,
            availableQuoteAmount,
            availableBaseAmount: openSummary.base,
            deployedQuoteAmount: openSummary.cost,
            averageEntryPrice: openSummary.averageEntry || null,
            realizedPnlUsd: replay.realizedPnlUsd,
            unrealizedPnlUsd,
            totalEquityUsd,
            lastProcessedAt: new Date(),
            metadata: metadata as never,
          },
        });
      }

      await tx.position.upsert({
        where: { botId: bot.id },
        update: {
          baseAmount: openSummary.base,
          quoteSpent: openSummary.cost,
          averageEntryPrice: openSummary.averageEntry || 0,
          realizedPnlUsd: replay.realizedPnlUsd,
          unrealizedPnlUsd,
          totalFeesQuote: replay.totalFeesQuote,
        },
        create: {
          botId: bot.id,
          baseAmount: openSummary.base,
          quoteSpent: openSummary.cost,
          averageEntryPrice: openSummary.averageEntry || 0,
          realizedPnlUsd: replay.realizedPnlUsd,
          unrealizedPnlUsd,
          totalFeesQuote: replay.totalFeesQuote,
        },
      });

      await tx.systemLog.create({
        data: {
          botId: bot.id,
          level: "warn",
          category: "maintenance",
          message: "Reconstructed open position lots from execution history.",
          metadata: {
            reconstructedLotCount: replay.openLots.length,
            reconstructedCostQuote: openSummary.cost,
            reconstructedBaseAmount: openSummary.base,
            replayRealizedPnlUsd: replay.realizedPnlUsd,
          },
        },
      });
    });
  }

  if (changedBotCount === 0) {
    console.log("\nNo reconstruction changes needed.");
  } else if (!apply) {
    console.log(`\nDry-run only. Re-run with --apply to write ${changedBotCount} reconstruction(s).`);
  } else {
    console.log(`\nApplied ${changedBotCount} reconstruction(s).`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
