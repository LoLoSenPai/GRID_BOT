import { randomUUID } from "node:crypto";
import { initialPortfolioEnvelope, type NormalizedCandle } from "@grid-bot/core";
import { createPaperPortfolio, prisma, PrismaPortfolioRepository } from "@grid-bot/db";
import { NextResponse } from "next/server";

import { readSession } from "@/lib/auth";
import { loadPortfolioHistory } from "./history";

const HOUR_MS = 3_600_000;
const WARMUP_CANDLES = 80;

export async function GET() {
  if (!await readSession()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const repository = new PrismaPortfolioRepository();
  const [portfolios, contexts] = await Promise.all([repository.listPortfolios(), repository.listBandContexts()]);
  const retainedByBot = await retainedBaseByBot(contexts.map((context) => context.band.botId));
  return NextResponse.json({ portfolios: portfolios.filter((portfolio) => portfolio.mode === "paper").map((portfolio) => ({
    id: portfolio.id, mode: portfolio.mode, autoLive: portfolio.autoLive, freeQuoteAmount: portfolio.freeQuoteAmount,
    version: portfolio.version,
    bands: contexts.filter((context) => context.portfolio.id === portfolio.id).map((context) => ({
      id: context.band.id, botId: context.band.botId, baseSymbol: context.strategy.baseSymbol,
      status: context.band.status, allocatedQuoteAmount: context.band.allocatedQuoteAmount,
      availableQuoteAmount: context.band.availableQuoteAmount, reservedQuoteAmount: context.band.reservedQuoteAmount,
      retainedBaseAmount: retainedByBot.get(context.band.botId) ?? 0, lowPrice: context.band.activeRevision.lowPrice,
      highPrice: context.band.activeRevision.highPrice, levelCount: context.band.activeRevision.levelCount,
      revisionId: context.band.activeRevision.id, blockedReason: context.capitalBlockedReason,
    })),
  })) });
}

export async function POST(request: Request) {
  if (!await readSession()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const totalCapitalUsd = finiteNumber(body.totalCapitalUsd, "totalCapitalUsd");
    const baseAllocationUsd = finiteNumber(body.baseAllocationUsd, "baseAllocationUsd");
    if (baseAllocationUsd < 100 || totalCapitalUsd < baseAllocationUsd * 2 || totalCapitalUsd > 100_000) {
      throw new Error("Paper capital must fund equal BTC and SOL base allocations of at least 100 USDC.");
    }
    const requestId = typeof body.requestId === "string" ? body.requestId : randomUUID();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestId)) throw new Error("Invalid requestId.");
    const observedAt = lastClosedHour();
    const from = new Date(observedAt.getTime() - (WARMUP_CANDLES + 2) * HOUR_MS);
    const [btc, sol] = await Promise.all([
      loadPortfolioHistory("BTC", from, observedAt), loadPortfolioHistory("SOL", from, observedAt),
    ]);
    if (btc.meta.stale || sol.meta.stale) throw new Error("Closed hourly history is stale; paper creation was deferred.");
    const histories = { BTC: closedWarmup(btc.candles, observedAt), SOL: closedWarmup(sol.candles, observedAt) };
    assertSameTimeline(histories.BTC, histories.SOL);
    const envelopes = {
      BTC: initialPortfolioEnvelope(histories.BTC.map(toPolicyCandle), observedAt),
      SOL: initialPortfolioEnvelope(histories.SOL.map(toPolicyCandle), observedAt),
    };
    const portfolioId = await createPaperPortfolio({ totalCapitalUsd, baseAllocationUsd, envelopes, observedAt, requestId });
    const repository = new PrismaPortfolioRepository();
    const [portfolio, contexts] = await Promise.all([repository.getPortfolio(portfolioId), repository.listBandContexts(portfolioId)]);
    if (!portfolio || portfolio.mode !== "paper") throw new Error("Created paper portfolio could not be loaded.");
    const retainedByBot = await retainedBaseByBot(contexts.map((context) => context.band.botId));
    return NextResponse.json({ ok: true, requestId, portfolio: {
      id: portfolio.id, mode: portfolio.mode, autoLive: portfolio.autoLive, freeQuoteAmount: portfolio.freeQuoteAmount,
      version: portfolio.version, bands: contexts.map((context) => ({ id: context.band.id, botId: context.band.botId,
        baseSymbol: context.strategy.baseSymbol, status: context.band.status,
        allocatedQuoteAmount: context.band.allocatedQuoteAmount, availableQuoteAmount: context.band.availableQuoteAmount,
        reservedQuoteAmount: context.band.reservedQuoteAmount, retainedBaseAmount: retainedByBot.get(context.band.botId) ?? 0,
        lowPrice: context.band.activeRevision.lowPrice, highPrice: context.band.activeRevision.highPrice,
        levelCount: context.band.activeRevision.levelCount, revisionId: context.band.activeRevision.id,
        blockedReason: context.capitalBlockedReason })),
    }, inputs: {
      observedAt: observedAt.toISOString(), resolution: "1h", warmupCandleCount: WARMUP_CANDLES,
      sources: { BTC: sourceMetadata(btc.meta, histories.BTC), SOL: sourceMetadata(sol.meta, histories.SOL) },
    } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create paper portfolio." }, { status: 400 });
  }
}

function closedWarmup(candles: NormalizedCandle[], observedAt: Date) {
  const closed = candles.filter((candle) => candle.closeTime && candle.closeTime <= observedAt)
    .sort((left, right) => +left.openTime - +right.openTime).slice(-WARMUP_CANDLES);
  if (closed.length !== WARMUP_CANDLES) throw new Error(`Exactly ${WARMUP_CANDLES} closed hourly candles are required per asset.`);
  assertHourly(closed);
  return closed;
}

function assertHourly(candles: NormalizedCandle[]) {
  if (candles.some((candle, index) => !candle.closeTime || +candle.closeTime - +candle.openTime !== HOUR_MS ||
    (index > 0 && +candle.openTime - +candles[index - 1]!.openTime !== HOUR_MS))) {
    throw new Error("Closed hourly history is incomplete or non-contiguous.");
  }
}

function assertSameTimeline(left: NormalizedCandle[], right: NormalizedCandle[]) {
  if (left.length !== right.length || left.some((candle, index) => +candle.openTime !== +right[index]!.openTime)) {
    throw new Error("BTC and SOL closed observations do not share the same timeline.");
  }
}

function toPolicyCandle(candle: NormalizedCandle) {
  return { openedAt: candle.openTime, closedAt: candle.closeTime!, open: candle.open, high: candle.high,
    low: candle.low, close: candle.close };
}

function sourceMetadata(meta: { provider: string; sourceMarket?: string | null; fetchedAt: Date }, candles: NormalizedCandle[]) {
  return { provider: meta.provider, sourceMarket: meta.sourceMarket ?? null, fetchedAt: meta.fetchedAt.toISOString(),
    from: candles[0]!.openTime.toISOString(), to: candles.at(-1)!.closeTime!.toISOString(),
    candles: candles.map((candle) => ({ timestamp: candle.openTime.toISOString(), open: candle.open,
      high: candle.high, low: candle.low, close: candle.close })) };
}

function finiteNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
  return value;
}

function lastClosedHour() { return new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS); }

async function retainedBaseByBot(botIds: string[]) {
  if (!botIds.length) return new Map<string, number>();
  const rows = await prisma.positionLot.groupBy({ by: ["botId"], where: { botId: { in: botIds }, kind: "retained",
    closedAt: null, remainingBaseAmount: { gt: 0 } }, _sum: { remainingBaseAmount: true } });
  return new Map(rows.map((row) => [row.botId, Number(row._sum.remainingBaseAmount ?? 0)]));
}
