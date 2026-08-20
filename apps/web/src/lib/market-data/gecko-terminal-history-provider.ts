import { GECKOTERMINAL_POOLS, MINTS, getEnv } from "@grid-bot/common";
import type {
  CandleHistoryProvider,
  CandleHistoryRequest,
  CandleHistoryResult,
  NormalizedCandle,
} from "@grid-bot/core";

import type { HistoryResolution } from "@/lib/charting";

const GECKOTERMINAL_TIMEOUT_MS = 8_000;
const MAX_PAGES = 5;
const PAGE_SIZE = 1_000;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 3_000];

const POOL_BY_SYMBOL: Record<string, string> = {
  SOL: GECKOTERMINAL_POOLS.SOL_USDC,
  BTC: GECKOTERMINAL_POOLS.BTC_USDC,
  HYPE: GECKOTERMINAL_POOLS.HYPE_USDC,
};

const SOURCE_RESOLUTION: Record<
  HistoryResolution,
  { timeframe: "minute" | "hour" | "day"; aggregate: number; bucketMs: number }
> = {
  "5m": { timeframe: "minute", aggregate: 5, bucketMs: 5 * 60_000 },
  "30m": { timeframe: "minute", aggregate: 15, bucketMs: 30 * 60_000 },
  "1h": { timeframe: "hour", aggregate: 1, bucketMs: 60 * 60_000 },
  "4h": { timeframe: "hour", aggregate: 4, bucketMs: 4 * 60 * 60_000 },
  "1d": { timeframe: "day", aggregate: 1, bucketMs: 24 * 60 * 60_000 },
  "1w": { timeframe: "day", aggregate: 1, bucketMs: 7 * 24 * 60 * 60_000 },
  "1mo": { timeframe: "day", aggregate: 1, bucketMs: 31 * 24 * 60 * 60_000 },
};

type GeckoOhlcvRow = [number, number, number, number, number, number];

interface GeckoOhlcvResponse {
  data?: {
    attributes?: {
      ohlcv_list?: unknown[];
    };
  };
  meta?: {
    base?: { address?: string };
    quote?: { address?: string };
  };
  status?: {
    error_code?: number;
    error_message?: string;
  };
}

export interface GeckoTerminalHistoryProviderOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxPages?: number;
  now?: () => Date;
  retryDelaysMs?: number[];
}

export class GeckoTerminalHistoryProvider implements CandleHistoryProvider {
  readonly provider = "gecko-terminal";
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly now: () => Date;
  private readonly retryDelaysMs: number[];

  constructor(options: GeckoTerminalHistoryProviderOptions = {}) {
    const env = getEnv();
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = (options.baseUrl ?? env.GECKOTERMINAL_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? GECKOTERMINAL_TIMEOUT_MS;
    this.maxPages = options.maxPages ?? MAX_PAGES;
    this.now = options.now ?? (() => new Date());
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async getHistory(request: CandleHistoryRequest): Promise<CandleHistoryResult> {
    const symbol = request.symbol.toUpperCase();
    const quoteSymbol = request.quoteSymbol.toUpperCase();
    const resolution = request.resolution as HistoryResolution;
    const poolAddress = POOL_BY_SYMBOL[symbol];
    const sourceResolution = SOURCE_RESOLUTION[resolution];
    const tokenMint = getMint(symbol);

    if (!poolAddress || quoteSymbol !== "USDC" || !sourceResolution || !tokenMint) {
      throw new Error(`Unsupported GeckoTerminal history market: ${symbol}/${quoteSymbol} ${request.resolution}`);
    }

    const rawRows = await this.fetchRows({
      poolAddress,
      tokenMint,
      fromSeconds: Math.floor(request.from.getTime() / 1000),
      toSeconds: Math.floor(request.to.getTime() / 1000),
      timeframe: sourceResolution.timeframe,
      aggregate: sourceResolution.aggregate,
    });
    const fetchedAt = this.now();
    const candles = aggregateRows(rawRows, {
      provider: this.provider,
      symbol,
      quoteSymbol,
      resolution,
      poolAddress,
      fetchedAt,
      bucketMs: sourceResolution.bucketMs,
    }).filter(
      (candle) => candle.openTime.getTime() >= request.from.getTime() && candle.openTime.getTime() <= request.to.getTime()
    );

    if (candles.length === 0) {
      throw new Error(`No GeckoTerminal OHLCV history returned for ${symbol}/${quoteSymbol} ${resolution}`);
    }

    return {
      candles,
      meta: {
        provider: this.provider,
        symbol,
        quoteSymbol,
        resolution,
        from: candles[0]?.openTime ?? request.from,
        to: candles.at(-1)?.closeTime ?? candles.at(-1)?.openTime ?? request.to,
        sourceMarket: `solana:${poolAddress}`,
        cacheHit: false,
        fetchedAt,
      },
    };
  }

  private async fetchRows(input: {
    poolAddress: string;
    tokenMint: string;
    fromSeconds: number;
    toSeconds: number;
    timeframe: "minute" | "hour" | "day";
    aggregate: number;
  }) {
    const rowsByTimestamp = new Map<number, GeckoOhlcvRow>();
    let beforeTimestamp = input.toSeconds + 1;

    for (let page = 0; page < this.maxPages; page += 1) {
      const url = new URL(
        `${this.baseUrl}/networks/solana/pools/${input.poolAddress}/ohlcv/${input.timeframe}`
      );
      url.searchParams.set("aggregate", String(input.aggregate));
      url.searchParams.set("before_timestamp", String(beforeTimestamp));
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("currency", "usd");
      url.searchParams.set("token", input.tokenMint);
      url.searchParams.set("include_empty_intervals", "true");

      const payload = await this.fetchPage(url.toString());
      validatePoolMeta(payload, input.tokenMint);
      const rows = parseRows(payload.data?.attributes?.ohlcv_list);
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        if (row[0] <= input.toSeconds) {
          rowsByTimestamp.set(row[0], row);
        }
      }

      const oldestTimestamp = Math.min(...rows.map((row) => row[0]));
      if (oldestTimestamp <= input.fromSeconds || rows.length < PAGE_SIZE) {
        break;
      }
      if (oldestTimestamp >= beforeTimestamp) {
        throw new Error("GeckoTerminal history pagination did not advance");
      }
      if (page === this.maxPages - 1) {
        throw new Error(
          `GeckoTerminal history window exceeds the safe ${this.maxPages * PAGE_SIZE}-candle pagination limit`
        );
      }
      beforeTimestamp = oldestTimestamp - 1;
    }

    return [...rowsByTimestamp.values()]
      .filter((row) => row[0] >= input.fromSeconds && row[0] <= input.toSeconds)
      .sort((left, right) => left[0] - right[0]);
  }

  private async fetchPage(url: string): Promise<GeckoOhlcvResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryDelaysMs[attempt - 1] ?? 0);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;

      try {
        response = await this.fetchFn(url, {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
      } catch (error) {
        lastError = error;
        continue;
      } finally {
        clearTimeout(timeoutId);
      }

      const payload = (await response.json().catch(() => ({}))) as GeckoOhlcvResponse;
      if (response.ok) {
        return payload;
      }

      const detail = payload.status?.error_message ? `: ${payload.status.error_message}` : "";
      const error = new Error(`GeckoTerminal history request failed with status ${response.status}${detail}`);
      if (response.status !== 408 && response.status !== 429 && response.status < 500) {
        throw error;
      }
      lastError = error;
    }

    throw new Error(
      `GeckoTerminal history request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      { cause: lastError }
    );
  }
}

function getMint(symbol: string) {
  return MINTS[symbol as keyof typeof MINTS] ?? null;
}

function parseRows(input: unknown[] | undefined): GeckoOhlcvRow[] {
  if (!input) {
    return [];
  }

  return input.flatMap((item) => {
    if (!Array.isArray(item) || item.length < 6) {
      return [];
    }

    const values = item.slice(0, 6).map(Number);
    if (!values.every(Number.isFinite) || values[0]! <= 0 || values.slice(1, 5).some((value) => value <= 0)) {
      return [];
    }

    return [values as GeckoOhlcvRow];
  });
}

function validatePoolMeta(payload: GeckoOhlcvResponse, tokenMint: string) {
  const baseAddress = payload.meta?.base?.address;
  const quoteAddress = payload.meta?.quote?.address;
  if (!baseAddress && !quoteAddress) {
    return;
  }

  if (baseAddress !== tokenMint && quoteAddress !== tokenMint) {
    throw new Error(`GeckoTerminal pool response does not contain requested token ${tokenMint}`);
  }

  if (baseAddress !== MINTS.USDC && quoteAddress !== MINTS.USDC) {
    throw new Error("GeckoTerminal pool response is not paired with USDC");
  }
}

function aggregateRows(
  rows: GeckoOhlcvRow[],
  input: {
    provider: string;
    symbol: string;
    quoteSymbol: string;
    resolution: HistoryResolution;
    poolAddress: string;
    fetchedAt: Date;
    bucketMs: number;
  }
) {
  const buckets = new Map<number, NormalizedCandle>();

  for (const [timestamp, open, high, low, close, volume] of rows) {
    const timestampMs = timestamp * 1000;
    const bucket = getBucketTime(timestampMs, input.resolution, input.bucketMs);
    const existing = buckets.get(bucket);

    if (!existing) {
      buckets.set(bucket, {
        provider: input.provider,
        symbol: input.symbol,
        quoteSymbol: input.quoteSymbol,
        resolution: input.resolution,
        sourceMarket: `solana:${input.poolAddress}`,
        openTime: new Date(bucket),
        closeTime: getCloseTime(bucket, input.resolution, input.bucketMs),
        open,
        high,
        low,
        close,
        volume,
        fetchedAt: input.fetchedAt,
      });
      continue;
    }

    existing.high = Math.max(existing.high, high);
    existing.low = Math.min(existing.low, low);
    existing.close = close;
    existing.volume = (existing.volume ?? 0) + volume;
  }

  return [...buckets.values()].sort((left, right) => left.openTime.getTime() - right.openTime.getTime());
}

function getBucketTime(timestampMs: number, resolution: HistoryResolution, bucketMs: number) {
  const date = new Date(timestampMs);
  if (resolution === "1mo") {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }

  if (resolution === "1w") {
    const day = date.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + mondayOffset);
  }

  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

function getCloseTime(openTimeMs: number, resolution: HistoryResolution, bucketMs: number) {
  if (resolution === "1mo") {
    const date = new Date(openTimeMs);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }

  return new Date(openTimeMs + bucketMs);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
