import "server-only";

import { getEnv } from "@grid-bot/common";

import { type CandlePoint, type HistoryResolution, getResolutionParam } from "@/lib/charting";

const SYMBOL_MAP = {
  SOL: "Crypto.SOL/USD",
  BTC: "Crypto.BTC/USD"
} as const;

const SYMBOL_HISTORY_START_SECONDS = {
  SOL: Math.floor(Date.UTC(2020, 3, 10, 0, 0, 0, 0) / 1000),
  BTC: Math.floor(Date.UTC(2010, 6, 17, 0, 0, 0, 0) / 1000)
} as const;

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

export async function fetchMarketHistory(symbol: keyof typeof SYMBOL_MAP, resolution: HistoryResolution) {
  const env = getEnv();
  const from = SYMBOL_HISTORY_START_SECONDS[symbol];
  const to = Math.floor(Date.now() / 1000);
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

  return {
    candles,
    meta: {
      symbol,
      resolution,
      cappedByResolution: false,
      from: new Date(from * 1000).toISOString(),
      to: new Date(to * 1000).toISOString(),
      source: "pyth-history"
    }
  };
}
