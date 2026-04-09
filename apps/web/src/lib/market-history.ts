import "server-only";

import { getEnv } from "@grid-bot/common";

import { type CandlePoint, type HistoryResolution, getResolutionParam } from "@/lib/charting";
import { getHistoryWindow } from "@/lib/market-history-window";

const SYMBOL_MAP = {
  SOL: "Crypto.SOL/USD",
  BTC: "Crypto.BTC/USD"
} as const;

const HISTORY_CACHE_TTL_MS = 60_000;

type MarketHistoryResult = {
  candles: CandlePoint[];
  meta: {
    symbol: keyof typeof SYMBOL_MAP;
    resolution: HistoryResolution;
    cappedByResolution: boolean;
    from: string;
    to: string;
    source: string;
  };
};

type HistoryCacheEntry = {
  data: MarketHistoryResult;
  fetchedAt: number;
};

const historyCache = new Map<string, HistoryCacheEntry>();
const inFlightHistoryRequests = new Map<string, Promise<MarketHistoryResult>>();

interface PythHistoryResponse {
  s: "ok" | "error";
  errmsg?: string;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

function getHistoryCacheKey(symbol: keyof typeof SYMBOL_MAP, resolution: HistoryResolution) {
  return `${symbol}:${resolution}`;
}

function getFreshHistory(symbol: keyof typeof SYMBOL_MAP, resolution: HistoryResolution) {
  const cacheKey = getHistoryCacheKey(symbol, resolution);
  const cached = historyCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.fetchedAt > HISTORY_CACHE_TTL_MS) {
    historyCache.delete(cacheKey);
    return null;
  }

  return cached.data;
}

export async function fetchMarketHistory(symbol: keyof typeof SYMBOL_MAP, resolution: HistoryResolution): Promise<MarketHistoryResult> {
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

async function fetchMarketHistoryUncached(symbol: keyof typeof SYMBOL_MAP, resolution: HistoryResolution): Promise<MarketHistoryResult> {
  const env = getEnv();
  const { from, to, cappedByResolution } = getHistoryWindow(symbol, resolution);
  const resolutionParam = getResolutionParam(resolution);
  const marketSymbol = SYMBOL_MAP[symbol];
  const url = `${env.PYTH_HISTORY_BASE_URL}/fixed_rate@200ms/history?symbol=${encodeURIComponent(marketSymbol)}&from=${from}&to=${to}&resolution=${resolutionParam}`;

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Pyth history request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as PythHistoryResponse;
  if (payload.s !== "ok") {
    throw new Error(payload.errmsg ?? "Pyth history response returned an error");
  }

  const candles: CandlePoint[] = payload.t.map((timestamp, index) => ({
    time: new Date(timestamp * 1000).toISOString(),
    open: Number(payload.o[index]),
    high: Number(payload.h[index]),
    low: Number(payload.l[index]),
    close: Number(payload.c[index]),
    volume: Number(payload.v[index] ?? 0)
  }));

  const result: MarketHistoryResult = {
    candles,
    meta: {
      symbol,
      resolution,
      cappedByResolution,
      from: new Date(from * 1000).toISOString(),
      to: new Date(to * 1000).toISOString(),
      source: "pyth-history"
    }
  };

  historyCache.set(getHistoryCacheKey(symbol, resolution), {
    data: result,
    fetchedAt: Date.now()
  });

  return result;
}
