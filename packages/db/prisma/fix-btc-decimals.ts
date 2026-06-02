import "dotenv/config";

import { MINTS } from "@grid-bot/common/constants";
import { TradeSide } from "@grid-bot/core/enums";
import type { Prisma } from "@prisma/client";

type PrismaClientShape = typeof import("../src/client")["prisma"];

const WRONG_DECIMALS = 6;
const CORRECT_DECIMALS = 8;
const BASE_SCALE = 10 ** (CORRECT_DECIMALS - WRONG_DECIMALS);

type BtcBot = Prisma.BotGetPayload<{
  include: {
    config: true;
    position: true;
    positionLots: true;
    stateSnapshots: true;
    inventorySnapshots: true;
    pnlSnapshots: true;
    orders: true;
    executions: {
      include: {
        order: true;
      };
    };
  };
}>;

function printHelp() {
  console.log(`
Usage:
  pnpm db:fix-btc-decimals
  pnpm db:fix-btc-decimals -- --apply
  pnpm db:fix-btc-decimals -- --bot-id <botId> --apply

Default mode is dry-run. Use --apply to update DB rows.

What it fixes:
  - BTC/WBTC bots created with baseDecimals=6 instead of 8.
  - Divides BTC-denominated amounts by 100.
  - Multiplies BTC/USDC effective prices and average entries by 100.
  - Recomputes affected runtime equity/unrealized values.

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

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = toNumber(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value: number, decimals = 10) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function scaleBase(value: unknown) {
  return round(toNumber(value) / BASE_SCALE);
}

function scaleNullableBase(value: unknown) {
  const numeric = toNullableNumber(value);
  return numeric === null ? null : round(numeric / BASE_SCALE);
}

function scalePrice(value: unknown) {
  return round(toNumber(value) * BASE_SCALE);
}

function scaleNullablePrice(value: unknown) {
  const numeric = toNullableNumber(value);
  return numeric === null ? null : round(numeric * BASE_SCALE);
}

function recomputeState(input: {
  availableQuoteAmount: unknown;
  availableBaseAmount: unknown;
  deployedQuoteAmount: unknown;
  realizedPnlUsd: unknown;
  currentPrice: unknown;
}) {
  const availableQuoteAmount = toNumber(input.availableQuoteAmount);
  const availableBaseAmount = scaleBase(input.availableBaseAmount);
  const deployedQuoteAmount = toNumber(input.deployedQuoteAmount);
  const realizedPnlUsd = toNumber(input.realizedPnlUsd);
  const currentPrice = toNullableNumber(input.currentPrice);
  const averageEntryPrice =
    availableBaseAmount > 0 && deployedQuoteAmount > 0
      ? round(deployedQuoteAmount / availableBaseAmount, 8)
      : null;
  const unrealizedPnlUsd =
    currentPrice !== null && availableBaseAmount > 0
      ? round(availableBaseAmount * currentPrice - deployedQuoteAmount, 8)
      : 0;
  const totalEquityUsd =
    currentPrice !== null
      ? round(availableQuoteAmount + availableBaseAmount * currentPrice, 8)
      : round(availableQuoteAmount, 8);

  return {
    availableBaseAmount,
    averageEntryPrice,
    unrealizedPnlUsd,
    totalEquityUsd,
    totalPnlUsd: round(realizedPnlUsd + unrealizedPnlUsd, 8)
  };
}

function getExecutionUpdates(execution: BtcBot["executions"][number]) {
  const side = execution.order.side as TradeSide;
  const data: Prisma.ExecutionUpdateInput = {
    quotePrice: execution.quotePrice !== null ? scalePrice(execution.quotePrice) : undefined
  };

  if (side === TradeSide.Buy) {
    data.expectedOutputAmount =
      execution.expectedOutputAmount !== null ? scaleBase(execution.expectedOutputAmount) : undefined;
    data.executedOutputAmount =
      execution.executedOutputAmount !== null ? scaleBase(execution.executedOutputAmount) : undefined;
    return data;
  }

  data.executedInputAmount =
    execution.executedInputAmount !== null ? scaleBase(execution.executedInputAmount) : undefined;
  return data;
}

function getBotSummary(bot: BtcBot) {
  const latest = bot.stateSnapshots[0] ?? null;
  return {
    id: bot.id,
    name: bot.name,
    baseDecimals: bot.baseDecimals,
    latestBase: latest ? toNumber(latest.availableBaseAmount) : null,
    latestEquity: latest ? toNumber(latest.totalEquityUsd) : null,
    positionBase: bot.position ? toNumber(bot.position.baseAmount) : null,
    executions: bot.executions.length
  };
}

async function repairBot(prisma: PrismaClientShape, bot: BtcBot, apply: boolean) {
  const operations: Prisma.PrismaPromise<unknown>[] = [];

  operations.push(
    prisma.bot.update({
      where: { id: bot.id },
      data: { baseDecimals: CORRECT_DECIMALS }
    })
  );

  if (bot.position) {
    const baseAmount = scaleBase(bot.position.baseAmount);
    const quoteSpent = toNumber(bot.position.quoteSpent);
    const averageEntryPrice = baseAmount > 0 && quoteSpent > 0 ? round(quoteSpent / baseAmount, 8) : 0;
    const currentPrice = bot.currentPrice ? toNumber(bot.currentPrice) : null;
    const unrealizedPnlUsd =
      currentPrice !== null && baseAmount > 0 ? round(baseAmount * currentPrice - quoteSpent, 8) : toNumber(bot.position.unrealizedPnlUsd);

    operations.push(
      prisma.position.update({
        where: { botId: bot.id },
        data: {
          baseAmount,
          averageEntryPrice,
          unrealizedPnlUsd
        }
      })
    );
  }

  for (const lot of bot.positionLots) {
    operations.push(
      prisma.positionLot.update({
        where: { id: lot.id },
        data: {
          originalBaseAmount: scaleBase(lot.originalBaseAmount),
          remainingBaseAmount: scaleBase(lot.remainingBaseAmount),
          entryPrice: scalePrice(lot.entryPrice)
        }
      })
    );
  }

  for (const snapshot of bot.stateSnapshots) {
    const computed = recomputeState(snapshot);
    operations.push(
      prisma.botStateSnapshot.update({
        where: { id: snapshot.id },
        data: {
          availableBaseAmount: computed.availableBaseAmount,
          averageEntryPrice: computed.averageEntryPrice,
          unrealizedPnlUsd: computed.unrealizedPnlUsd,
          totalEquityUsd: computed.totalEquityUsd
        }
      })
    );
  }

  for (const snapshot of bot.inventorySnapshots) {
    operations.push(
      prisma.inventorySnapshot.update({
        where: { id: snapshot.id },
        data: {
          baseAmount: scaleBase(snapshot.baseAmount),
          reservedBaseAmount: scaleBase(snapshot.reservedBaseAmount),
          averageCost: scaleNullablePrice(snapshot.averageCost)
        }
      })
    );
  }

  for (const snapshot of bot.pnlSnapshots) {
    const matchingState = bot.stateSnapshots.find(
      (state) => Math.abs(state.createdAt.getTime() - snapshot.createdAt.getTime()) < 5_000
    );

    if (!matchingState) {
      continue;
    }

    const computed = recomputeState(matchingState);
    operations.push(
      prisma.pnlSnapshot.update({
        where: { id: snapshot.id },
        data: {
          unrealizedPnlUsd: computed.unrealizedPnlUsd,
          totalPnlUsd: computed.totalPnlUsd,
          equityUsd: computed.totalEquityUsd
        }
      })
    );
  }

  for (const order of bot.orders) {
    if ((order.side as TradeSide) !== TradeSide.Sell) {
      continue;
    }

    operations.push(
      prisma.order.update({
        where: { id: order.id },
        data: {
          requestedBaseAmount: scaleBase(order.requestedBaseAmount)
        }
      })
    );
  }

  for (const execution of bot.executions) {
    operations.push(
      prisma.execution.update({
        where: { id: execution.id },
        data: getExecutionUpdates(execution)
      })
    );
  }

  const before = getBotSummary(bot);
  console.log(
    `${apply ? "repair" : "dry-run"} ${bot.name} (${bot.id}) baseDecimals ${before.baseDecimals} -> ${CORRECT_DECIMALS}, ` +
      `latestBase ${before.latestBase ?? "--"} -> ${before.latestBase === null ? "--" : round(before.latestBase / BASE_SCALE)}, ` +
      `positionBase ${before.positionBase ?? "--"} -> ${before.positionBase === null ? "--" : round(before.positionBase / BASE_SCALE)}, ` +
      `${operations.length} row update(s)`
  );

  if (apply && operations.length > 0) {
    await prisma.$transaction(operations);
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
  const { prisma } = await import("../src/client");

  const bots = await prisma.bot.findMany({
    where: {
      ...(botId ? { id: botId } : {}),
      baseDecimals: WRONG_DECIMALS,
      OR: [{ baseMint: MINTS.BTC }, { baseSymbol: "BTC" }]
    },
    include: {
      config: true,
      position: true,
      positionLots: true,
      stateSnapshots: { orderBy: { createdAt: "desc" } },
      inventorySnapshots: true,
      pnlSnapshots: true,
      orders: true,
      executions: {
        include: { order: true }
      }
    }
  });

  if (bots.length === 0) {
    console.log("No BTC bots with baseDecimals=6 found.");
    await prisma.$disconnect();
    return;
  }

  for (const bot of bots) {
    await repairBot(prisma, bot, apply);
  }

  if (!apply) {
    console.log("\nDry-run only. Re-run with -- --apply after stopping the worker.");
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
