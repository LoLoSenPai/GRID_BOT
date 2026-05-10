import "dotenv/config";

import { ExecutionStatus, TradeSide } from "@grid-bot/core/enums";
import type { Prisma } from "@prisma/client";

const LAMPORTS_PER_SOL = 1_000_000_000;
const EPSILON = 0.00000001;

type PrismaClientShape = typeof import("../src/client")["prisma"];

type RawJupiterReport = {
  order?: {
    signatureFeeLamports?: number | string | null;
    prioritizationFeeLamports?: number | string | null;
    rentFeeLamports?: number | string | null;
  } | null;
} | null;

type BotDelta = {
  botId: string;
  botName: string;
  feeReduction: number;
  availableQuoteDelta: number;
  realizedPnlDelta: number;
  unrealizedPnlDelta: number;
  openCostDelta: number;
  correctedExecutions: number;
};

type OpenLotUpdate = {
  id: string;
  costQuote: number;
  entryPrice: number;
};

type ExecutionWithRelations = Prisma.ExecutionGetPayload<{
  include: {
    order: true;
    bot: {
      select: {
        id: true;
        name: true;
        baseSymbol: true;
        quoteSymbol: true;
      };
    };
  };
}>;

function printHelp() {
  console.log(`
Usage:
  pnpm db:fix-jupiter-rent-fees
  pnpm db:fix-jupiter-rent-fees -- --apply

Default mode is dry-run. Use --apply to update DB rows.

What it fixes:
  - Recomputes Jupiter execution fees from signatureFeeLamports + prioritizationFeeLamports.
  - Excludes rentFeeLamports from consumed trade fees.
  - Adjusts current position, open lot cost basis, latest state snapshot, and latest PnL snapshot.

Operational note:
  Stop the worker before --apply if live bots are running, then restart it after the script finishes.
`);
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function getRawReport(value: unknown): RawJupiterReport {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as RawJupiterReport;
}

function getCorrectedNativeFeeSol(rawReport: unknown): number | null {
  const order = getRawReport(rawReport)?.order;
  if (!order) {
    return null;
  }

  const signatureFeeLamports = toNumber(order.signatureFeeLamports);
  const prioritizationFeeLamports = toNumber(order.prioritizationFeeLamports);

  if (signatureFeeLamports <= 0 && prioritizationFeeLamports <= 0) {
    return null;
  }

  return (signatureFeeLamports + prioritizationFeeLamports) / LAMPORTS_PER_SOL;
}

function getFeeQuotePrice(input: {
  baseSymbol: string;
  quotePrice: number;
  solReferencePrice: number | null;
}) {
  if (input.baseSymbol.toUpperCase() === "SOL") {
    return input.quotePrice > 0 ? input.quotePrice : input.solReferencePrice;
  }

  return input.solReferencePrice;
}

function getDelta(map: Map<string, BotDelta>, botId: string, botName: string) {
  const existing = map.get(botId);
  if (existing) {
    return existing;
  }

  const created: BotDelta = {
    botId,
    botName,
    feeReduction: 0,
    availableQuoteDelta: 0,
    realizedPnlDelta: 0,
    unrealizedPnlDelta: 0,
    openCostDelta: 0,
    correctedExecutions: 0,
  };
  map.set(botId, created);
  return created;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    printHelp();
    return;
  }

  const apply = args.has("--apply");
  const { prisma } = await import("../src/client") as { prisma: PrismaClientShape };

  const latestSolState = await prisma.botStateSnapshot.findFirst({
    where: {
      bot: {
        baseSymbol: "SOL",
        quoteSymbol: "USDC",
      },
      currentPrice: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: { currentPrice: true },
  });
  const solReferencePrice = latestSolState?.currentPrice ? Number(latestSolState.currentPrice) : null;

  const executions = await prisma.execution.findMany({
    where: {
      provider: "jupiter",
      status: { in: [ExecutionStatus.Submitted, ExecutionStatus.Filled, ExecutionStatus.Simulated] as never[] },
      executedFeeAmount: { not: null },
    },
    include: {
      order: true,
      bot: {
        select: {
          id: true,
          name: true,
          baseSymbol: true,
          quoteSymbol: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  }) as ExecutionWithRelations[];

  const openLots = await prisma.positionLot.findMany({
    where: {
      botId: { in: [...new Set(executions.map((execution) => execution.botId))] },
      remainingBaseAmount: { gt: 0 },
    },
  });
  const openLotByExecutionId = new Map(openLots.map((lot) => [lot.openedByExecutionId, lot]));
  const botDeltas = new Map<string, BotDelta>();
  const executionUpdates: Array<{ id: string; previousFee: number; correctedFee: number }> = [];
  const openLotUpdates = new Map<string, OpenLotUpdate>();
  const skipped: Array<{ id: string; bot: string; reason: string }> = [];

  for (const execution of executions) {
    const oldFee = toNumber(execution.executedFeeAmount);
    const correctedNativeFeeSol = getCorrectedNativeFeeSol(execution.rawReport);
    if (correctedNativeFeeSol === null) {
      skipped.push({ id: execution.id, bot: execution.bot.name, reason: "missing fee lamports in rawReport.order" });
      continue;
    }

    const quotePrice = toNumber(execution.quotePrice);
    const feeQuotePrice = getFeeQuotePrice({
      baseSymbol: execution.bot.baseSymbol,
      quotePrice,
      solReferencePrice,
    });
    if (!feeQuotePrice || feeQuotePrice <= 0) {
      skipped.push({ id: execution.id, bot: execution.bot.name, reason: "missing SOL/USDC reference price" });
      continue;
    }

    const correctedFee = round(correctedNativeFeeSol * feeQuotePrice, 8);
    if (oldFee <= correctedFee + EPSILON) {
      continue;
    }

    const feeDelta = round(oldFee - correctedFee, 8);
    const delta = getDelta(botDeltas, execution.botId, execution.bot.name);
    delta.feeReduction = round(delta.feeReduction + feeDelta, 8);
    delta.availableQuoteDelta = round(delta.availableQuoteDelta + feeDelta, 8);
    delta.correctedExecutions += 1;

    if (execution.order.side === TradeSide.Sell) {
      delta.realizedPnlDelta = round(delta.realizedPnlDelta + feeDelta, 8);
    } else {
      const openLot = openLotByExecutionId.get(execution.id);
      if (!openLot) {
        delta.realizedPnlDelta = round(delta.realizedPnlDelta + feeDelta, 8);
      } else {
        const originalBaseAmount = toNumber(openLot.originalBaseAmount);
        const remainingBaseAmount = toNumber(openLot.remainingBaseAmount);
        const remainingRatio =
          originalBaseAmount > 0
            ? Math.max(0, Math.min(1, remainingBaseAmount / originalBaseAmount))
            : 1;
        const openFeeDelta = round(feeDelta * remainingRatio, 8);
        const closedFeeDelta = round(feeDelta - openFeeDelta, 8);
        const nextCostQuote = round(Math.max(toNumber(openLot.costQuote) - openFeeDelta, 0), 8);
        const nextEntryPrice = remainingBaseAmount > 0 ? round(nextCostQuote / remainingBaseAmount, 8) : toNumber(openLot.entryPrice);

        delta.openCostDelta = round(delta.openCostDelta + openFeeDelta, 8);
        delta.unrealizedPnlDelta = round(delta.unrealizedPnlDelta + openFeeDelta, 8);
        delta.realizedPnlDelta = round(delta.realizedPnlDelta + closedFeeDelta, 8);
        openLotUpdates.set(openLot.id, {
          id: openLot.id,
          costQuote: nextCostQuote,
          entryPrice: nextEntryPrice,
        });
      }
    }

    executionUpdates.push({
      id: execution.id,
      previousFee: oldFee,
      correctedFee,
    });
  }

  const summary = [...botDeltas.values()];
  console.log(apply ? "Applying Jupiter rent fee correction..." : "Dry-run Jupiter rent fee correction...");
  console.table(
    summary.map((delta) => ({
      bot: delta.botName,
      executions: delta.correctedExecutions,
      feeReduction: delta.feeReduction.toFixed(8),
      realizedDelta: delta.realizedPnlDelta.toFixed(8),
      unrealizedDelta: delta.unrealizedPnlDelta.toFixed(8),
      openCostDelta: delta.openCostDelta.toFixed(8),
    }))
  );

  if (skipped.length) {
    console.log(`Skipped ${skipped.length} execution(s). First skipped rows:`);
    console.table(skipped.slice(0, 10));
  }

  if (!apply) {
    console.log(`Dry-run only. ${executionUpdates.length} execution(s) would be corrected. Re-run with --apply to write changes.`);
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const update of executionUpdates) {
      await tx.execution.update({
        where: { id: update.id },
        data: { executedFeeAmount: update.correctedFee },
      });
    }

    for (const update of openLotUpdates.values()) {
      await tx.positionLot.update({
        where: { id: update.id },
        data: {
          costQuote: update.costQuote,
          entryPrice: update.entryPrice,
        },
      });
    }

    for (const delta of summary) {
      const latestState = await tx.botStateSnapshot.findFirst({
        where: { botId: delta.botId },
        orderBy: { createdAt: "desc" },
      });
      const currentLots = await tx.positionLot.findMany({
        where: { botId: delta.botId, remainingBaseAmount: { gt: 0 } },
      });
      const totalBase = round(currentLots.reduce((sum, lot) => sum + toNumber(lot.remainingBaseAmount), 0), 8);
      const totalCost = round(currentLots.reduce((sum, lot) => sum + toNumber(lot.costQuote), 0), 8);
      const averageEntryPrice = totalBase > 0 && totalCost > 0 ? round(totalCost / totalBase, 8) : null;

      await tx.position.updateMany({
        where: { botId: delta.botId },
        data: {
          quoteSpent: totalCost,
          averageEntryPrice: averageEntryPrice ?? 0,
          realizedPnlUsd: { increment: delta.realizedPnlDelta },
          unrealizedPnlUsd: { increment: delta.unrealizedPnlDelta },
          totalFeesQuote: { decrement: delta.feeReduction },
        },
      });

      if (latestState) {
        await tx.botStateSnapshot.update({
          where: { id: latestState.id },
          data: {
            availableQuoteAmount: { increment: delta.availableQuoteDelta },
            deployedQuoteAmount: totalCost,
            averageEntryPrice,
            realizedPnlUsd: { increment: delta.realizedPnlDelta },
            unrealizedPnlUsd: { increment: delta.unrealizedPnlDelta },
            totalEquityUsd: { increment: delta.availableQuoteDelta },
          },
        });

        await tx.inventorySnapshot.create({
          data: {
            botId: delta.botId,
            baseAmount: latestState.availableBaseAmount,
            quoteAmount: round(toNumber(latestState.availableQuoteAmount) + delta.availableQuoteDelta, 8),
            reservedBaseAmount: 0,
            reservedQuoteAmount: 0,
            averageCost: averageEntryPrice ?? undefined,
          },
        });
        await tx.pnlSnapshot.create({
          data: {
            botId: delta.botId,
            realizedPnlUsd: round(toNumber(latestState.realizedPnlUsd) + delta.realizedPnlDelta, 8),
            unrealizedPnlUsd: round(toNumber(latestState.unrealizedPnlUsd) + delta.unrealizedPnlDelta, 8),
            totalPnlUsd: round(
              toNumber(latestState.realizedPnlUsd) +
                delta.realizedPnlDelta +
                toNumber(latestState.unrealizedPnlUsd) +
                delta.unrealizedPnlDelta,
              8
            ),
            equityUsd: round(toNumber(latestState.totalEquityUsd) + delta.availableQuoteDelta, 8),
            price: latestState.currentPrice ?? 0,
          },
        });
      }

      await tx.systemLog.create({
        data: {
          botId: delta.botId,
          level: "info",
          category: "maintenance",
          message: "Corrected historical Jupiter fees by excluding rentFeeLamports.",
          metadata: {
            correctedExecutions: delta.correctedExecutions,
            feeReduction: delta.feeReduction,
            realizedPnlDelta: delta.realizedPnlDelta,
            unrealizedPnlDelta: delta.unrealizedPnlDelta,
            openCostDelta: delta.openCostDelta,
          },
        },
      });
    }
  });

  console.log(`Applied correction to ${executionUpdates.length} execution(s).`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
