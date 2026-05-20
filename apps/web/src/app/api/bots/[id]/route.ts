import { NextResponse } from "next/server";
import { getEnv } from "@grid-bot/common";
import {
  BotMode,
  GridStrategyService,
  reconcileOpenPositionLots,
  type BotRuntimeMetadata,
  type BotStatus,
  type PositionLot,
} from "@grid-bot/core";
import { findLatestBotStateSnapshot, prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import {
  BotManagementValidationError,
  cloneStateSnapshot,
  createInitialStateSnapshot,
  parseUpdateBotPayload,
} from "@/lib/bot-management";
import { validateAdditionalBudgetAllocation } from "@/lib/wallet-budget";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const bot = await prisma.bot.findFirst({
      where: { id, archivedAt: null },
      include: {
        config: true,
      },
    });

    if (!bot?.config) {
      return NextResponse.json({ error: "Bot not found." }, { status: 404 });
    }

    if (bot.status === "running" || bot.status === "cooldown") {
      return NextResponse.json(
        { error: "Pause or stop the bot before editing config." },
        { status: 409 },
      );
    }

    const payload = await request.json();
    const parsed = parseUpdateBotPayload(
      payload,
      getEnv().LIVE_TRADING_ENABLED,
    );

    if (parsed.mode !== bot.mode) {
      return NextResponse.json(
        { error: "Bot mode is immutable. Create or clone a new bot instead." },
        { status: 409 },
      );
    }

    const previousBudgetUsd = bot.config.totalBudgetUsd.toNumber();
    const budgetDeltaUsd = roundUsd(parsed.totalBudgetUsd - previousBudgetUsd);
    const gridChanged = hasGridChanged(
      {
        lowPrice: bot.config.lowPrice.toNumber(),
        highPrice: bot.config.highPrice.toNumber(),
        levelCount: bot.config.levelCount,
        gridType: String(bot.config.gridType),
      },
      {
        lowPrice: parsed.lowPrice,
        highPrice: parsed.highPrice,
        levelCount: parsed.levelCount,
        gridType: parsed.gridType,
      },
    );

    if (bot.mode === BotMode.Live && budgetDeltaUsd < 0) {
      return NextResponse.json(
        {
          error:
            "Reducing a live bot budget is not supported. Stop and recreate the bot if you want a smaller allocation.",
        },
        { status: 409 },
      );
    }

    if (budgetDeltaUsd > 0) {
      const budgetCheck = await validateAdditionalBudgetAllocation(
        budgetDeltaUsd,
        parsed.mode,
      );
      if (!budgetCheck.ok) {
        return NextResponse.json({ error: budgetCheck.error }, { status: 422 });
      }
    }

    const latestState =
      budgetDeltaUsd > 0 || gridChanged
        ? await findLatestBotStateSnapshot(bot.id)
        : null;

    if (gridChanged && !latestState) {
      return NextResponse.json(
        {
          error:
            "Missing runtime state for grid migration. Let the bot create a state snapshot before editing the grid.",
        },
        { status: 409 },
      );
    }

    const migratedGridCycles = gridChanged
      ? await buildMigratedGridCycles(id, parsed, latestState)
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.bot.update({
        where: { id },
        data: {
          name: parsed.name,
          strategyMode: parsed.strategyMode as never,
          mode: parsed.mode as never,
          executionProvider: parsed.executionProvider as never,
        },
      });

      await tx.botConfig.update({
        where: { botId: id },
        data: {
          totalBudgetUsd: parsed.totalBudgetUsd,
          maxDeployableUsd: parsed.maxDeployableUsd,
          reserveQuoteAmount: parsed.reserveQuoteAmount,
          lowPrice: parsed.lowPrice,
          highPrice: parsed.highPrice,
          levelCount: parsed.levelCount,
          gridType: parsed.gridType as never,
          minOrderQuoteAmount: parsed.minOrderQuoteAmount,
          maxSlippageBps: parsed.maxSlippageBps,
          cooldownMs: parsed.cooldownMs,
          maxOrdersPerHour: parsed.maxOrdersPerHour,
          maxDrawdownPct: parsed.maxDrawdownPct,
          maxConsecutiveFailures: parsed.maxConsecutiveFailures,
          levelLockMs: parsed.levelLockMs,
          priceConfirmationWindowMs: parsed.priceConfirmationWindowMs,
          recenterMode: parsed.recenterMode as never,
          autoRecenterMinIntervalMs: parsed.autoRecenterMinIntervalMs,
          autoRecenterMaxPerDay: parsed.autoRecenterMaxPerDay,
          outOfRangePause: parsed.outOfRangePause,
        },
      });

      if (budgetDeltaUsd > 0 || gridChanged) {
        const snapshotData = latestState
          ? cloneStateSnapshot(
              id,
              bot.status as BotStatus,
              latestState,
              {
                totalBudgetUsd: parsed.totalBudgetUsd,
                currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null,
              },
            )
          : createInitialStateSnapshot({
              botId: id,
              status: bot.status as BotStatus,
              totalBudgetUsd: parsed.totalBudgetUsd,
              currentPrice: bot.currentPrice ? Number(bot.currentPrice) : null,
            });

        if (latestState && budgetDeltaUsd > 0) {
          snapshotData.availableQuoteAmount = roundUsd(
            Number(snapshotData.availableQuoteAmount) + budgetDeltaUsd,
          );
          snapshotData.totalEquityUsd = roundUsd(
            Number(snapshotData.totalEquityUsd) + budgetDeltaUsd,
          );
          snapshotData.lastProcessedAt = new Date();
        }

        if (gridChanged && migratedGridCycles) {
          snapshotData.metadata = buildMigratedRuntimeMetadata(
            snapshotData.metadata,
            migratedGridCycles,
          ) as never;
          snapshotData.lastProcessedAt = new Date();
        }

        await tx.botStateSnapshot.create({ data: snapshotData });
      }

      await tx.systemLog.create({
        data: {
          botId: id,
          level: "info",
          category: "bot_admin",
          message: `Bot configuration updated by ${session.username}.`,
          metadata: {
            actor: session.username,
            mode: parsed.mode,
            strategyMode: parsed.strategyMode,
            previousBudgetUsd,
            nextBudgetUsd: parsed.totalBudgetUsd,
            budgetDeltaUsd,
            gridChanged,
            migratedOpenCycles: migratedGridCycles
              ? Object.keys(migratedGridCycles).length
              : undefined,
          },
        },
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof BotManagementValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    console.error(error);
    return NextResponse.json(
      { error: "Failed to update bot." },
      { status: 500 },
    );
  }
}

function roundUsd(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(value * 100) / 100;
}

function hasGridChanged(
  previous: {
    lowPrice: number;
    highPrice: number;
    levelCount: number;
    gridType: string;
  },
  next: {
    lowPrice: number;
    highPrice: number;
    levelCount: number;
    gridType: string;
  },
) {
  return (
    !sameNumber(previous.lowPrice, next.lowPrice) ||
    !sameNumber(previous.highPrice, next.highPrice) ||
    previous.levelCount !== next.levelCount ||
    previous.gridType !== next.gridType
  );
}

function sameNumber(left: number, right: number) {
  return Math.abs(left - right) < 0.00000001;
}

async function buildMigratedGridCycles(
  botId: string,
  config: {
    lowPrice: number;
    highPrice: number;
    levelCount: number;
    gridType: Parameters<GridStrategyService["calculateLevels"]>[3];
  },
  latestState: {
    deployedQuoteAmount: unknown;
    availableBaseAmount: unknown;
  } | null,
) {
  const strategyService = new GridStrategyService();
  const levels = strategyService.calculateLevels(
    config.lowPrice,
    config.highPrice,
    config.levelCount,
    config.gridType,
  );
  const openLots = await prisma.positionLot.findMany({
    where: { botId, closedAt: null },
    orderBy: { openedAt: "asc" },
  });

  const reconciledOpenLots = reconcileOpenPositionLots(
    openLots.map(mapPositionLot),
    latestState
      ? {
          deployedQuoteAmount: decimalLikeToNumber(latestState.deployedQuoteAmount),
          availableBaseAmount: decimalLikeToNumber(latestState.availableBaseAmount),
        }
      : null,
  );

  return strategyService.remapOpenLotsToGridCycles(levels, reconciledOpenLots);
}

function mapPositionLot(lot: {
  id: string;
  botId: string;
  originalBaseAmount: unknown;
  remainingBaseAmount: unknown;
  entryPrice: unknown;
  costQuote: unknown;
  openedByExecutionId: string;
  closedByExecutionId: string | null;
  openedAt: Date;
  closedAt: Date | null;
}): PositionLot {
  return {
    id: lot.id,
    botId: lot.botId,
    originalBaseAmount: decimalLikeToNumber(lot.originalBaseAmount),
    remainingBaseAmount: decimalLikeToNumber(lot.remainingBaseAmount),
    entryPrice: decimalLikeToNumber(lot.entryPrice),
    costQuote: decimalLikeToNumber(lot.costQuote),
    openedByExecutionId: lot.openedByExecutionId,
    closedByExecutionId: lot.closedByExecutionId,
    openedAt: lot.openedAt,
    closedAt: lot.closedAt,
  };
}

function buildMigratedRuntimeMetadata(
  metadata: unknown,
  gridCycles: NonNullable<BotRuntimeMetadata["gridCycles"]>,
): BotRuntimeMetadata {
  const current = normalizeRuntimeMetadata(metadata);

  return {
    ...current,
    levelLocks: {},
    pendingSignal: null,
    gridCycles,
  };
}

function normalizeRuntimeMetadata(metadata: unknown): BotRuntimeMetadata {
  const record =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Partial<BotRuntimeMetadata>)
      : {};

  return {
    levelLocks: isStringRecord(record.levelLocks) ? record.levelLocks : {},
    pendingSignal: record.pendingSignal ?? null,
    gridCycles: isObjectRecord(record.gridCycles) ? record.gridCycles : {},
    recenterHistory: Array.isArray(record.recenterHistory)
      ? record.recenterHistory.filter((value): value is string => typeof value === "string")
      : [],
    recentExecutions: Array.isArray(record.recentExecutions)
      ? record.recentExecutions.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === "string",
    )
  );
}

function isObjectRecord<T extends object = object>(
  value: unknown,
): value is Record<string, T> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decimalLikeToNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : 0;
  }

  if (value && typeof value === "object") {
    if ("toNumber" in value && typeof value.toNumber === "function") {
      const numericValue = value.toNumber();
      return typeof numericValue === "number" && Number.isFinite(numericValue)
        ? numericValue
        : 0;
    }

    if ("toString" in value && typeof value.toString === "function") {
      const numericValue = Number(value.toString());
      return Number.isFinite(numericValue) ? numericValue : 0;
    }
  }

  return 0;
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const bot = await prisma.bot.findFirst({
    where: { id, archivedAt: null },
    select: { id: true, status: true, name: true },
  });

  if (!bot) {
    return NextResponse.json({ error: "Bot not found." }, { status: 404 });
  }

  if (bot.status !== "stopped") {
    return NextResponse.json(
      { error: "Stop the bot before deleting it." },
      { status: 409 },
    );
  }

  try {
    await prisma.$transaction([
      prisma.bot.update({
        where: { id },
        data: { archivedAt: new Date() },
      }),
      prisma.systemLog.create({
        data: {
          botId: id,
          level: "info",
          category: "bot_admin",
          message: `Bot archived by ${session.username}.`,
          metadata: {
            actor: session.username,
          },
        },
      }),
    ]);
    return NextResponse.json({ ok: true, deletedBotName: bot.name, archivedBotName: bot.name });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Failed to archive bot." },
      { status: 500 },
    );
  }
}
