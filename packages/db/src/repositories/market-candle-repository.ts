import type { MarketCandleRepository } from "@grid-bot/core";

import { prisma } from "../client";
import { mapMarketCandle } from "../mappers";

export class PrismaMarketCandleRepository implements MarketCandleRepository {
  async findCandles(request: Parameters<MarketCandleRepository["findCandles"]>[0]) {
    const candles = await prisma.marketCandle.findMany({
      where: {
        provider: request.provider,
        symbol: request.symbol.toUpperCase(),
        quoteSymbol: request.quoteSymbol.toUpperCase(),
        resolution: request.resolution,
        openTime: {
          gte: request.from,
          lte: request.to
        }
      },
      orderBy: { openTime: "asc" }
    });

    return candles.map(mapMarketCandle);
  }

  async upsertCandles(candles: Parameters<MarketCandleRepository["upsertCandles"]>[0]) {
    if (candles.length === 0) {
      return;
    }

    const data = candles.map((candle) => ({
      provider: candle.provider,
      symbol: candle.symbol.toUpperCase(),
      quoteSymbol: candle.quoteSymbol.toUpperCase(),
      resolution: candle.resolution,
      sourceMarket: candle.sourceMarket ?? undefined,
      openTime: candle.openTime,
      closeTime: candle.closeTime ?? undefined,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume ?? undefined,
      fetchedAt: candle.fetchedAt
    }));
    const candlesToRefresh = candles.slice(-3);

    await prisma.$transaction(
      [
        prisma.marketCandle.createMany({
          data,
          skipDuplicates: true
        }),
        ...candlesToRefresh.map((candle) =>
          prisma.marketCandle.upsert({
            where: {
              provider_symbol_quoteSymbol_resolution_openTime: {
                provider: candle.provider,
                symbol: candle.symbol.toUpperCase(),
                quoteSymbol: candle.quoteSymbol.toUpperCase(),
                resolution: candle.resolution,
                openTime: candle.openTime
              }
            },
            update: {
              sourceMarket: candle.sourceMarket ?? undefined,
              closeTime: candle.closeTime ?? undefined,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume ?? undefined,
              fetchedAt: candle.fetchedAt
            },
            create: {
              provider: candle.provider,
              symbol: candle.symbol.toUpperCase(),
              quoteSymbol: candle.quoteSymbol.toUpperCase(),
              resolution: candle.resolution,
              sourceMarket: candle.sourceMarket ?? undefined,
              openTime: candle.openTime,
              closeTime: candle.closeTime ?? undefined,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume ?? undefined,
              fetchedAt: candle.fetchedAt
            }
          })
        )
      ]
    );
  }
}
