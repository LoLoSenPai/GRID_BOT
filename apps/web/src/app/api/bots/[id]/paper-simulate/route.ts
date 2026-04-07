import { NextResponse } from "next/server";
import {
  BotMode,
  BotStatus,
  ExecutionProvider,
  GridStrategyService,
  GridType,
  RecenterMode,
  StrategyMode,
  TradeSide,
  type BotAggregate,
  type BotRuntimeMetadata,
  type MarketPricePort
} from "@grid-bot/core";
import { prisma } from "@grid-bot/db";

import { readSession } from "@/lib/auth";
import { cloneStateSnapshot, createInitialStateSnapshot } from "@/lib/bot-management";
import { createBotEngine } from "@/server/create-bot-engine";

function readSimulationSide(value: unknown) {
  if (value !== "buy" && value !== "sell") {
    throw new Error("Simulation side must be buy or sell.");
  }

  return value as "buy" | "sell";
}

class SimulatedMarketPriceService implements MarketPricePort {
  constructor(
    private readonly pair: string,
    private readonly feedId: string,
    private readonly price: number
  ) {}

  async getLatestPrice(bot: { baseSymbol: string; quoteSymbol: string }) {
    return {
      symbol: `${bot.baseSymbol}/${bot.quoteSymbol}`,
      pair: this.pair,
      price: this.price,
      confidence: 0,
      source: "paper-simulated",
      timestamp: new Date(),
      feedId: this.feedId
    };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const payload = await request.json();
    const side = readSimulationSide((payload as { side?: unknown })?.side);
    const bot = await prisma.bot.findUnique({
      where: { id },
      include: {
        config: true,
        stateSnapshots: { orderBy: { createdAt: "desc" }, take: 1 },
        position: true,
        positionLots: { orderBy: { openedAt: "asc" } }
      }
    });

    if (!bot?.config) {
      return NextResponse.json({ error: "Bot not found." }, { status: 404 });
    }

    if (bot.mode !== BotMode.Paper) {
      return NextResponse.json({ error: "Paper simulation is only available for paper bots." }, { status: 409 });
    }

    const latestState = bot.stateSnapshots[0];
    const currentPrice = bot.currentPrice ? Number(bot.currentPrice) : latestState?.currentPrice ? Number(latestState.currentPrice) : null;
    if (!currentPrice || !Number.isFinite(currentPrice)) {
      return NextResponse.json({ error: "Current price is unavailable for this bot." }, { status: 409 });
    }

    const gridStrategyService = new GridStrategyService();
    const levels = gridStrategyService.calculateLevels(
      Number(bot.config.lowPrice),
      Number(bot.config.highPrice),
      bot.config.levelCount,
      bot.config.gridType as GridType
    );

    const targetLevel =
      side === "buy"
        ? [...levels].reverse().find((level) => level.price < currentPrice)
        : levels.find((level) => level.price > currentPrice);

    if (!targetLevel) {
      return NextResponse.json(
        { error: `No ${side} level is currently armed. Adjust the range or wait for the spot to move.` },
        { status: 409 }
      );
    }

    const aggregate = {
      bot: {
        id: bot.id,
        key: bot.key,
        name: bot.name,
        baseMint: bot.baseMint,
        quoteMint: bot.quoteMint,
        baseSymbol: bot.baseSymbol,
        quoteSymbol: bot.quoteSymbol,
        baseDecimals: bot.baseDecimals,
        quoteDecimals: bot.quoteDecimals,
        strategyMode: bot.strategyMode as StrategyMode,
        mode: bot.mode as BotMode,
        status: bot.status as BotStatus,
        executionProvider: bot.executionProvider as ExecutionProvider,
        currentPrice
      },
      config: {
        id: bot.config.id,
        botId: bot.id,
        totalBudgetUsd: Number(bot.config.totalBudgetUsd),
        maxDeployableUsd: Number(bot.config.maxDeployableUsd),
        reserveQuoteAmount: Number(bot.config.reserveQuoteAmount),
        lowPrice: Number(bot.config.lowPrice),
        highPrice: Number(bot.config.highPrice),
        levelCount: bot.config.levelCount,
        gridType: bot.config.gridType as GridType,
        minOrderQuoteAmount: Number(bot.config.minOrderQuoteAmount),
        maxSlippageBps: bot.config.maxSlippageBps,
        cooldownMs: bot.config.cooldownMs,
        maxOrdersPerHour: bot.config.maxOrdersPerHour,
        maxDrawdownPct: Number(bot.config.maxDrawdownPct),
        maxConsecutiveFailures: bot.config.maxConsecutiveFailures,
        levelLockMs: bot.config.levelLockMs,
        priceConfirmationWindowMs: bot.config.priceConfirmationWindowMs,
        recenterMode: bot.config.recenterMode as RecenterMode,
        autoRecenterMinIntervalMs: bot.config.autoRecenterMinIntervalMs,
        autoRecenterMaxPerDay: bot.config.autoRecenterMaxPerDay,
        outOfRangePause: bot.config.outOfRangePause
      },
      latestState: latestState
        ? {
            id: latestState.id,
            botId: bot.id,
            status: latestState.status as BotStatus,
            currentPrice: latestState.currentPrice ? Number(latestState.currentPrice) : null,
            availableQuoteAmount: Number(latestState.availableQuoteAmount),
            availableBaseAmount: Number(latestState.availableBaseAmount),
            deployedQuoteAmount: Number(latestState.deployedQuoteAmount),
            averageEntryPrice: latestState.averageEntryPrice ? Number(latestState.averageEntryPrice) : null,
            realizedPnlUsd: Number(latestState.realizedPnlUsd),
            unrealizedPnlUsd: Number(latestState.unrealizedPnlUsd),
            totalEquityUsd: Number(latestState.totalEquityUsd),
            consecutiveFailures: latestState.consecutiveFailures,
            lastExecutionAt: latestState.lastExecutionAt,
            lastProcessedAt: latestState.lastProcessedAt,
            lastRecenterAt: latestState.lastRecenterAt,
            metadata: (latestState.metadata ?? {
              levelLocks: {},
              pendingSignal: null,
              recenterHistory: [],
              recentExecutions: []
            }) as BotRuntimeMetadata
          }
        : null,
      position: bot.position
        ? {
            id: bot.position.id,
            botId: bot.id,
            baseAmount: Number(bot.position.baseAmount),
            quoteSpent: Number(bot.position.quoteSpent),
            averageEntryPrice: Number(bot.position.averageEntryPrice),
            realizedPnlUsd: Number(bot.position.realizedPnlUsd),
            unrealizedPnlUsd: Number(bot.position.unrealizedPnlUsd),
            totalFeesQuote: Number(bot.position.totalFeesQuote)
          }
        : null,
      openLots: bot.positionLots.map((lot) => ({
        id: lot.id,
        botId: bot.id,
        originalBaseAmount: Number(lot.originalBaseAmount),
        remainingBaseAmount: Number(lot.remainingBaseAmount),
        entryPrice: Number(lot.entryPrice),
        costQuote: Number(lot.costQuote),
        openedByExecutionId: lot.openedByExecutionId,
        closedByExecutionId: lot.closedByExecutionId,
        openedAt: lot.openedAt,
        closedAt: lot.closedAt
      }))
    } satisfies BotAggregate;

    const signalSide = side === "buy" ? TradeSide.Buy : TradeSide.Sell;
    const orderIntent = gridStrategyService.buildOrderIntent(aggregate, {
      levelIndex: targetLevel.index,
      side: signalSide,
      levelPrice: targetLevel.price,
      observedPrice: currentPrice,
      idempotencyKey: `${bot.id}:paper-sim:${side}:${Date.now()}`,
      triggeredAt: new Date()
    });

    if (!orderIntent) {
      return NextResponse.json(
        {
          error:
            side === "sell"
              ? "No profitable lot is available to simulate a sell yet. Simulate a buy first or wait for price appreciation."
              : "This buy cannot arm with the current reserve and deployable capital."
        },
        { status: 409 }
      );
    }

    const simulatedPrice =
      side === "buy"
        ? Number((targetLevel.price * 0.998).toFixed(8))
        : Number((targetLevel.price * 1.002).toFixed(8));
    const confirmationOrigin = new Date(Date.now() - bot.config.priceConfirmationWindowMs - 1000).toISOString();
    const snapshotData =
      latestState
        ? cloneStateSnapshot(bot.id, BotStatus.Running, latestState, {
            totalBudgetUsd: Number(bot.config.totalBudgetUsd),
            currentPrice
          })
        : createInitialStateSnapshot({
            botId: bot.id,
            status: BotStatus.Running,
            totalBudgetUsd: Number(bot.config.totalBudgetUsd),
            currentPrice
          });

    const mutableSnapshot = snapshotData as {
      status: BotStatus;
      currentPrice: number | null | undefined;
      lastExecutionAt?: Date;
      lastProcessedAt: Date;
      metadata: BotRuntimeMetadata;
    };
    const levelLocks =
      mutableSnapshot.metadata.levelLocks && typeof mutableSnapshot.metadata.levelLocks === "object"
        ? { ...mutableSnapshot.metadata.levelLocks }
        : {};

    delete levelLocks[String(targetLevel.index)];

    mutableSnapshot.status = BotStatus.Running;
    mutableSnapshot.currentPrice = currentPrice;
    mutableSnapshot.lastExecutionAt = undefined;
    mutableSnapshot.lastProcessedAt = new Date();
    mutableSnapshot.metadata = {
      ...mutableSnapshot.metadata,
      levelLocks,
      pendingSignal: {
        levelIndex: targetLevel.index,
        side: signalSide,
        firstObservedAt: confirmationOrigin,
        lastObservedPrice: simulatedPrice
      }
    };

    const executionCountBefore = await prisma.execution.count({ where: { botId: id } });
    const { engine, botRepository } = createBotEngine({
      marketPriceService: new SimulatedMarketPriceService(
        `${bot.baseSymbol}/USD`,
        `paper-simulated-${bot.baseSymbol.toLowerCase()}`,
        simulatedPrice
      )
    });

    let executionCreated = false;
    let lockAcquired = false;

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await botRepository.withBotLock(id, async () => {
        await prisma.$transaction([
          prisma.bot.update({
            where: { id },
            data: {
              status: BotStatus.Running as never,
              currentPrice
            }
          }),
          prisma.botStateSnapshot.create({ data: snapshotData }),
          prisma.systemLog.create({
            data: {
              botId: id,
              level: "info",
              category: "paper_simulation",
              message: `Paper ${side} cross simulated by ${session.username} at level ${targetLevel.index}.`,
              metadata: {
                actor: session.username,
                side,
                levelIndex: targetLevel.index,
                levelPrice: targetLevel.price,
                simulatedPrice
              }
            }
          })
        ]);

        await engine.runBot(id, { skipLock: true });
        const executionCountAfter = await prisma.execution.count({ where: { botId: id } });
        return executionCountAfter > executionCountBefore;
      });

      if (result === null) {
        await sleep(250);
        continue;
      }

      lockAcquired = true;
      executionCreated = result;
      break;
    }

    if (!lockAcquired) {
      return NextResponse.json(
        {
          error: "Paper simulation could not acquire the bot lock. Retry in a second."
        },
        { status: 409 }
      );
    }

    if (!executionCreated) {
      return NextResponse.json(
        {
          error: "Paper simulation reached the engine but no execution was created. The signal was skipped by runtime rules."
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      ok: true,
      side,
      levelIndex: targetLevel.index,
      levelPrice: targetLevel.price,
      simulatedPrice
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to simulate paper cross.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
