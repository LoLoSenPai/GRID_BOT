import "dotenv/config";

import { findIsolatedPortfolioSpikeIndexes } from "@grid-bot/core";
import { BotMode } from "@grid-bot/core/enums";

const HOUR_MS = 60 * 60 * 1000;

function getArgValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function toNumber(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }

  return Number(value);
}

function floorToHour(value: Date) {
  return new Date(Math.floor(value.getTime() / HOUR_MS) * HOUR_MS);
}

function printHelp() {
  console.log(`
Usage:
  pnpm db:repair-portfolio-history
  pnpm db:repair-portfolio-history -- --mode live
  pnpm db:repair-portfolio-history -- --mode live --apply

The command detects isolated one-hour PnL spikes, prints them in dry-run mode,
and only deletes the affected portfolio snapshot buckets with --apply.
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const modeArg = getArgValue(args, "--mode")?.toLowerCase();
  if (modeArg && modeArg !== BotMode.Live && modeArg !== BotMode.Paper) {
    throw new Error(`Unsupported mode: ${modeArg}`);
  }

  const apply = args.includes("--apply");
  const modes = modeArg ? [modeArg as BotMode] : [BotMode.Live, BotMode.Paper];
  const { prisma } = await import("../src/client");
  let deleted = 0;

  for (const mode of modes) {
    const rows = await prisma.portfolioSnapshot.findMany({
      where: { mode: mode as never },
      orderBy: { createdAt: "asc" }
    });
    const latestByHour = new Map<number, (typeof rows)[number]>();
    for (const row of rows) {
      latestByHour.set(floorToHour(row.createdAt).getTime(), row);
    }

    const hourlyRows = [...latestByHour.values()].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const spikeIndexes = findIsolatedPortfolioSpikeIndexes(
      hourlyRows.map((row) => ({ totalPnlUsd: toNumber(row.totalPnlUsd) }))
    );

    if (spikeIndexes.size === 0) {
      console.log(`${mode}: no isolated portfolio spikes found.`);
      continue;
    }

    for (const index of spikeIndexes) {
      const row = hourlyRows[index];
      if (!row) {
        continue;
      }

      const from = floorToHour(row.createdAt);
      const to = new Date(from.getTime() + HOUR_MS);
      console.log(
        `${apply ? "remove" : "found"} ${mode} ${from.toISOString()} pnl=$${toNumber(row.totalPnlUsd).toFixed(2)} equity=$${toNumber(row.totalEquityUsd).toFixed(2)}`
      );

      if (apply) {
        const result = await prisma.portfolioSnapshot.deleteMany({
          where: {
            mode: mode as never,
            createdAt: { gte: from, lt: to }
          }
        });
        deleted += result.count;
      }
    }
  }

  console.log(apply ? `Deleted ${deleted} corrupted portfolio snapshot(s).` : "Dry-run only. Re-run with -- --apply to clean these buckets.");
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
