import "server-only";

import { getEnv } from "@grid-bot/common";
import type { CandleHistoryProvider, CandleHistoryRequest, CandleHistoryResult } from "@grid-bot/core";

import { type HistoryResolution, getResolutionParam } from "@/lib/charting";

const SYMBOL_MAP: Record<string, string> = {
  SOL: "Crypto.SOL/USD",
  BTC: "Crypto.BTC/USD"
};

interface PythHistoryResponse {
  s: "ok" | "error";
  errmsg?: string;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v?: number[];
}

function toNullableNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PythHistoryProvider implements CandleHistoryProvider {
  readonly provider = "pyth-history";

  async getHistory(request: CandleHistoryRequest): Promise<CandleHistoryResult> {
    const symbol = request.symbol.toUpperCase();
    const quoteSymbol = request.quoteSymbol.toUpperCase();
    const marketSymbol = SYMBOL_MAP[symbol];

    if (!marketSymbol || quoteSymbol !== "USDC") {
      throw new Error(`Unsupported Pyth history market: ${symbol}/${quoteSymbol}`);
    }

    const env = getEnv();
    const fromSeconds = Math.floor(request.from.getTime() / 1000);
    const toSeconds = Math.floor(request.to.getTime() / 1000);
    const resolutionParam = getResolutionParam(request.resolution as HistoryResolution);
    const url = `${env.PYTH_HISTORY_BASE_URL}/fixed_rate@200ms/history?symbol=${encodeURIComponent(
      marketSymbol
    )}&from=${fromSeconds}&to=${toSeconds}&resolution=${resolutionParam}`;

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

    const fetchedAt = new Date();
    const candles = payload.t.map((timestamp, index) => ({
      provider: this.provider,
      symbol,
      quoteSymbol,
      resolution: request.resolution,
      sourceMarket: marketSymbol,
      openTime: new Date(timestamp * 1000),
      closeTime: null,
      open: Number(payload.o[index]),
      high: Number(payload.h[index]),
      low: Number(payload.l[index]),
      close: Number(payload.c[index]),
      volume: toNullableNumber(payload.v?.[index]),
      fetchedAt
    }));

    return {
      candles,
      meta: {
        provider: this.provider,
        symbol,
        quoteSymbol,
        resolution: request.resolution,
        from: request.from,
        to: request.to,
        sourceMarket: marketSymbol,
        cacheHit: false,
        fetchedAt
      }
    };
  }
}
