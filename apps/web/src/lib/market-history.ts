import "server-only";

import type { CandleHistoryProvider } from "@grid-bot/core";

import { type CandlePoint, type HistoryResolution } from "@/lib/charting";
import { CachedCandleHistoryProvider } from "@/lib/market-data/cached-candle-history-provider";
import { GeckoTerminalHistoryProvider } from "@/lib/market-data/gecko-terminal-history-provider";
import { getHistoryWindow } from "@/lib/market-history-window";

type SupportedSymbol = "SOL" | "BTC" | "HYPE";

const HISTORY_CACHE_TTL_MS = 60_000;
const RESOLUTION_MS: Partial<Record<HistoryResolution, number>> = {
  "5m": 5 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000
};

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
    coverage: {
      requestedFrom: string;
      requestedTo: string;
      actualFrom: string;
      actualTo: string;
      closedCandleCount: number;
      expectedCandleCount: number | null;
      coveragePct: number | null;
      internalGapCount: number;
      complete: boolean;
    };
    pricing: {
      requestedPair: string;
      providerDenomination: "USD";
      quoteTreatment: "USD proxy for USDC; no FX conversion applied";
    };
  };
};

type HistoryCacheEntry = {
  data: MarketHistoryResult;
  fetchedAt: number;
};

const historyCache = new Map<string, HistoryCacheEntry>();
const inFlightHistoryRequests = new Map<string, Promise<MarketHistoryResult>>();

const directCandleHistoryProvider = new GeckoTerminalHistoryProvider();
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
  const intervalMs = RESOLUTION_MS[resolution] ?? null;
  const closedThroughMs = Math.min(input.to * 1000, Date.now());
  const closedCandles = history.candles.filter((candle) => {
    const closeTimeMs = candle.closeTime?.getTime() ?? (intervalMs ? candle.openTime.getTime() + intervalMs : Number.POSITIVE_INFINITY);
    return closeTimeMs <= closedThroughMs;
  });
  const internalGapCount = intervalMs ? countInternalGaps(closedCandles, intervalMs) : 0;
  if (internalGapCount > 0) {
    throw new Error(`Historical series contains ${internalGapCount} internal candle gap(s).`);
  }

  if (!closedCandles.length) {
    throw new Error(`Historical series contains no closed ${resolution} candles.`);
  }

  const candles: CandlePoint[] = closedCandles.map((candle) => ({
    time: candle.openTime.toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? undefined
  }));
  const actualFrom = closedCandles[0]!.openTime;
  const actualTo = closedCandles.at(-1)!.closeTime ?? new Date(closedCandles.at(-1)!.openTime.getTime() + (intervalMs ?? 0));
  const expectedCandleCount = intervalMs
    ? Math.max(0, Math.floor((closedThroughMs - input.from * 1000) / intervalMs))
    : null;
  const coveragePct = expectedCandleCount && expectedCandleCount > 0
    ? Math.min(100, (closedCandles.length / expectedCandleCount) * 100)
    : null;
  const complete = intervalMs
    ? actualFrom.getTime() <= input.from * 1000 + intervalMs && actualTo.getTime() >= closedThroughMs - intervalMs
    : true;

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
      stale: history.meta.stale,
      coverage: {
        requestedFrom: new Date(input.from * 1000).toISOString(),
        requestedTo: new Date(input.to * 1000).toISOString(),
        actualFrom: actualFrom.toISOString(),
        actualTo: actualTo.toISOString(),
        closedCandleCount: closedCandles.length,
        expectedCandleCount,
        coveragePct,
        internalGapCount,
        complete
      },
      pricing: {
        requestedPair: `${symbol}/USDC`,
        providerDenomination: "USD",
        quoteTreatment: "USD proxy for USDC; no FX conversion applied"
      }
    }
  };

  historyCache.set(input.cacheKey, {
    data: result,
    fetchedAt: Date.now()
  });

  return result;
}

function countInternalGaps(candles: Array<{ openTime: Date }>, intervalMs: number) {
  let gapCount = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]!.openTime.getTime();
    const current = candles[index]!.openTime.getTime();
    if (current - previous > intervalMs * 1.5) {
      gapCount += Math.max(1, Math.round((current - previous) / intervalMs) - 1);
    }
  }
  return gapCount;
}
