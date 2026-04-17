import "server-only";

import type { CandleHistoryProvider } from "@grid-bot/core";

import { type CandlePoint, type HistoryResolution } from "@/lib/charting";
import { CachedCandleHistoryProvider } from "@/lib/market-data/cached-candle-history-provider";
import { PythHistoryProvider } from "@/lib/market-data/pyth-history-provider";
import { getHistoryWindow } from "@/lib/market-history-window";

type SupportedSymbol = "SOL" | "BTC";

const HISTORY_CACHE_TTL_MS = 60_000;

type MarketHistoryResult = {
  candles: CandlePoint[];
  meta: {
    symbol: SupportedSymbol;
    resolution: HistoryResolution;
    cappedByResolution: boolean;
    from: string;
    to: string;
    source: string;
    provider: string;
    sourceMarket: string | null;
    cacheHit: boolean;
    stale?: boolean;
  };
};

type HistoryCacheEntry = {
  data: MarketHistoryResult;
  fetchedAt: number;
};

const historyCache = new Map<string, HistoryCacheEntry>();
const inFlightHistoryRequests = new Map<string, Promise<MarketHistoryResult>>();

const directCandleHistoryProvider = new PythHistoryProvider();
let dbCachedCandleHistoryProviderPromise: Promise<CandleHistoryProvider> | null = null;

function isDbCandleCacheEnabled() {
  return process.env.MARKET_CANDLE_DB_CACHE_ENABLED === "true";
}

function getCandleHistoryProvider(): Promise<CandleHistoryProvider> {
  if (!isDbCandleCacheEnabled()) {
    return Promise.resolve(directCandleHistoryProvider);
  }

  dbCachedCandleHistoryProviderPromise ??= import("@grid-bot/db").then(
    ({ PrismaMarketCandleRepository }) =>
      new CachedCandleHistoryProvider(
        new PrismaMarketCandleRepository(),
        directCandleHistoryProvider,
        HISTORY_CACHE_TTL_MS
      )
  );

  return dbCachedCandleHistoryProviderPromise;
}

function getHistoryCacheKey(symbol: SupportedSymbol, resolution: HistoryResolution) {
  return `${symbol}:${resolution}`;
}

function getLookbackHistoryCacheKey(symbol: SupportedSymbol, resolution: HistoryResolution, lookbackDays: number) {
  return `${symbol}:${resolution}:lookback:${lookbackDays}`;
}

function markCacheHit(result: MarketHistoryResult): MarketHistoryResult {
  return {
    ...result,
    meta: {
      ...result.meta,
      cacheHit: true
    }
  };
}

function getFreshHistory(symbol: SupportedSymbol, resolution: HistoryResolution) {
  const cacheKey = getHistoryCacheKey(symbol, resolution);
  const cached = historyCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.fetchedAt > HISTORY_CACHE_TTL_MS) {
    historyCache.delete(cacheKey);
    return null;
  }

  return markCacheHit(cached.data);
}

export async function fetchMarketHistory(symbol: SupportedSymbol, resolution: HistoryResolution): Promise<MarketHistoryResult> {
  const fresh = getFreshHistory(symbol, resolution);
  if (fresh) {
    return fresh;
  }

  const cacheKey = getHistoryCacheKey(symbol, resolution);
  const inFlight = inFlightHistoryRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const request = fetchMarketHistoryUncached(symbol, resolution).finally(() => {
    inFlightHistoryRequests.delete(cacheKey);
  });
  inFlightHistoryRequests.set(cacheKey, request);
  return request;
}

async function fetchMarketHistoryUncached(symbol: SupportedSymbol, resolution: HistoryResolution): Promise<MarketHistoryResult> {
  const { from, to, cappedByResolution } = getHistoryWindow(symbol, resolution);
  return fetchHistoryWindow(symbol, resolution, { from, to, cappedByResolution, cacheKey: getHistoryCacheKey(symbol, resolution) });
}

export async function fetchMarketHistoryLookback(
  symbol: SupportedSymbol,
  resolution: HistoryResolution,
  lookbackDays: number
): Promise<MarketHistoryResult> {
  const normalizedLookbackDays = Math.max(1, Math.floor(lookbackDays));
  const cacheKey = getLookbackHistoryCacheKey(symbol, resolution, normalizedLookbackDays);
  const cached = historyCache.get(cacheKey);

  if (cached && Date.now() - cached.fetchedAt <= HISTORY_CACHE_TTL_MS) {
    return markCacheHit(cached.data);
  }

  const inFlight = inFlightHistoryRequests.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const to = Math.floor(Date.now() / 1000);
  const from = to - normalizedLookbackDays * 24 * 60 * 60;
  const request = fetchHistoryWindow(symbol, resolution, {
    from,
    to,
    cappedByResolution: false,
    cacheKey
  }).finally(() => {
    inFlightHistoryRequests.delete(cacheKey);
  });

  inFlightHistoryRequests.set(cacheKey, request);
  return request;
}

async function fetchHistoryWindow(
  symbol: SupportedSymbol,
  resolution: HistoryResolution,
  input: {
    from: number;
    to: number;
    cappedByResolution: boolean;
    cacheKey: string;
  }
): Promise<MarketHistoryResult> {
  const candleHistoryProvider = await getCandleHistoryProvider();
  const history = await candleHistoryProvider.getHistory({
    symbol,
    quoteSymbol: "USDC",
    resolution,
    from: new Date(input.from * 1000),
    to: new Date(input.to * 1000)
  });

  const candles: CandlePoint[] = history.candles.map((candle) => ({
    time: candle.openTime.toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? undefined
  }));

  const result: MarketHistoryResult = {
    candles,
    meta: {
      symbol,
      resolution,
      cappedByResolution: input.cappedByResolution,
      from: history.meta.from.toISOString(),
      to: history.meta.to.toISOString(),
      source: history.meta.provider,
      provider: history.meta.provider,
      sourceMarket: history.meta.sourceMarket,
      cacheHit: history.meta.cacheHit,
      stale: history.meta.stale
    }
  };

  historyCache.set(input.cacheKey, {
    data: result,
    fetchedAt: Date.now()
  });

  return result;
}
