import { describe, expect, it, vi } from "vitest";
import type { CandleHistoryProvider, MarketCandleRepository, NormalizedCandle } from "@grid-bot/core";

import { CachedCandleHistoryProvider } from "./cached-candle-history-provider";

const request = {
  symbol: "SOL",
  quoteSymbol: "USDC",
  resolution: "5m",
  from: new Date("2026-04-17T00:00:00.000Z"),
  to: new Date("2026-04-17T01:00:00.000Z")
};

function candle(overrides: Partial<NormalizedCandle> = {}): NormalizedCandle {
  return {
    provider: "pyth-history",
    symbol: "SOL",
    quoteSymbol: "USDC",
    resolution: "5m",
    sourceMarket: "Crypto.SOL/USD",
    openTime: new Date("2026-04-17T00:00:00.000Z"),
    closeTime: null,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 123,
    fetchedAt: new Date(),
    ...overrides
  };
}

function candleAt(openTime: string, overrides: Partial<NormalizedCandle> = {}) {
  return candle({
    openTime: new Date(openTime),
    ...overrides
  });
}

function repository(candles: NormalizedCandle[] = []): MarketCandleRepository {
  return {
    findCandles: vi.fn(async () => candles),
    upsertCandles: vi.fn(async () => undefined)
  };
}

function upstream(candles: NormalizedCandle[] = []): CandleHistoryProvider {
  return {
    provider: "pyth-history",
    getHistory: vi.fn(async () => ({
      candles,
      meta: {
        provider: "pyth-history",
        symbol: "SOL",
        quoteSymbol: "USDC",
        resolution: "5m",
        from: request.from,
        to: request.to,
        sourceMarket: "Crypto.SOL/USD",
        cacheHit: false,
        fetchedAt: new Date()
      }
    }))
  };
}

describe("CachedCandleHistoryProvider", () => {
  it("returns fresh candles from the repository without hitting upstream", async () => {
    const repo = repository([candle(), candle({ openTime: new Date("2026-04-17T00:55:00.000Z") })]);
    const source = upstream([candle({ close: 102 })]);
    const provider = new CachedCandleHistoryProvider(repo, source, 60_000);

    const result = await provider.getHistory(request);

    expect(result.meta.cacheHit).toBe(true);
    expect(result.candles[0]?.close).toBe(100.5);
    expect(source.getHistory).not.toHaveBeenCalled();
  });

  it("does not treat a fresh partial window as a cache hit", async () => {
    const repo = repository([candle({ openTime: new Date("2026-04-17T00:30:00.000Z") })]);
    const fresh = candle({ close: 104 });
    const source = upstream([fresh]);
    const provider = new CachedCandleHistoryProvider(repo, source, 60_000);

    const result = await provider.getHistory(request);

    expect(result.meta.cacheHit).toBe(false);
    expect(result.candles).toEqual([fresh]);
    expect(source.getHistory).toHaveBeenCalledWith(request);
  });

  it("fetches upstream and stores candles when cache is stale", async () => {
    const repo = repository([candle({ fetchedAt: new Date("2026-04-16T00:00:00.000Z") })]);
    const fresh = candle({ close: 103 });
    const source = upstream([fresh]);
    const provider = new CachedCandleHistoryProvider(repo, source, 60_000);

    const result = await provider.getHistory(request);

    expect(result.meta.cacheHit).toBe(false);
    expect(result.candles[0]?.close).toBe(103);
    expect(repo.upsertCandles).toHaveBeenCalledWith([fresh]);
  });

  it("refreshes only the tail when a covered cache is stale", async () => {
    const staleFetchedAt = new Date("2026-04-16T00:00:00.000Z");
    const cached = Array.from({ length: 12 }, (_, index) =>
      candleAt(`2026-04-17T00:${String(index * 5).padStart(2, "0")}:00.000Z`, {
        close: 100 + index,
        fetchedAt: staleFetchedAt
      })
    );
    const fresh = [
      candleAt("2026-04-17T00:50:00.000Z", { close: 250 }),
      candleAt("2026-04-17T00:55:00.000Z", { close: 251 })
    ];
    const repo = repository(cached);
    const source = upstream(fresh);
    const provider = new CachedCandleHistoryProvider(repo, source, 60_000);

    const result = await provider.getHistory(request);

    expect(source.getHistory).toHaveBeenCalledWith({
      ...request,
      from: new Date("2026-04-17T00:40:00.000Z")
    });
    expect(repo.upsertCandles).toHaveBeenCalledWith(fresh);
    expect(result.meta.cacheHit).toBe(false);
    expect(result.meta.from).toEqual(request.from);
    expect(result.candles).toHaveLength(12);
    expect(result.candles.find((item) => item.openTime.getTime() === new Date("2026-04-17T00:50:00.000Z").getTime())?.close).toBe(250);
  });

  it("falls back to stale cached candles when upstream fails", async () => {
    const stale = candle({ fetchedAt: new Date("2026-04-16T00:00:00.000Z") });
    const repo = repository([stale]);
    const source: CandleHistoryProvider = {
      provider: "pyth-history",
      getHistory: vi.fn(async () => {
        throw new Error("provider unavailable");
      })
    };
    const provider = new CachedCandleHistoryProvider(repo, source, 60_000);

    const result = await provider.getHistory(request);

    expect(result.meta.cacheHit).toBe(true);
    expect(result.meta.stale).toBe(true);
    expect(result.candles).toEqual([stale]);
  });
});
