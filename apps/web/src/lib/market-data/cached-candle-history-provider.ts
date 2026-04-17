import type { CandleHistoryProvider, MarketCandleRepository } from "@grid-bot/core";
import type { CandleHistoryRequest, CandleHistoryResult, NormalizedCandle } from "@grid-bot/core";

const DEFAULT_CACHE_TTL_MS = 60_000;
const RESOLUTION_MS: Record<string, number> = {
  "5m": 5 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1mo": 31 * 24 * 60 * 60 * 1000
};

function getLatestFetchedAt(candles: NormalizedCandle[]) {
  return candles.reduce<Date | null>((latest, candle) => {
    if (!latest || candle.fetchedAt > latest) {
      return candle.fetchedAt;
    }

    return latest;
  }, null);
}

function buildCachedResult(
  request: CandleHistoryRequest,
  provider: string,
  candles: NormalizedCandle[],
  input: { stale?: boolean } = {}
): CandleHistoryResult {
  const latestFetchedAt = getLatestFetchedAt(candles) ?? new Date();
  const firstCandle = candles[0];

  return {
    candles,
    meta: {
      provider,
      symbol: request.symbol.toUpperCase(),
      quoteSymbol: request.quoteSymbol.toUpperCase(),
      resolution: request.resolution,
      from: request.from,
      to: request.to,
      sourceMarket: firstCandle?.sourceMarket ?? null,
      cacheHit: true,
      stale: input.stale,
      fetchedAt: latestFetchedAt
    }
  };
}

function hasWindowCoverage(request: CandleHistoryRequest, candles: NormalizedCandle[]) {
  if (candles.length === 0) {
    return false;
  }

  const intervalMs = RESOLUTION_MS[request.resolution];
  if (!intervalMs) {
    return false;
  }

  const firstOpenTime = candles[0]?.openTime.getTime() ?? Number.POSITIVE_INFINITY;
  const lastOpenTime = candles.at(-1)?.openTime.getTime() ?? 0;
  const startToleranceMs = intervalMs * 2;
  const endToleranceMs = intervalMs * 2;

  return firstOpenTime <= request.from.getTime() + startToleranceMs && lastOpenTime >= request.to.getTime() - endToleranceMs;
}

function mergeCandles(cachedCandles: NormalizedCandle[], freshCandles: NormalizedCandle[]) {
  const byOpenTime = new Map<number, NormalizedCandle>();
  for (const candle of cachedCandles) {
    byOpenTime.set(candle.openTime.getTime(), candle);
  }
  for (const candle of freshCandles) {
    byOpenTime.set(candle.openTime.getTime(), candle);
  }

  return [...byOpenTime.values()].sort((left, right) => left.openTime.getTime() - right.openTime.getTime());
}

export class CachedCandleHistoryProvider implements CandleHistoryProvider {
  readonly provider: string;

  constructor(
    private readonly repository: MarketCandleRepository,
    private readonly upstream: CandleHistoryProvider,
    private readonly ttlMs = DEFAULT_CACHE_TTL_MS
  ) {
    this.provider = upstream.provider;
  }

  async getHistory(request: CandleHistoryRequest): Promise<CandleHistoryResult> {
    const cachedCandles = await this.repository.findCandles({
      ...request,
      provider: this.provider
    });
    const latestFetchedAt = getLatestFetchedAt(cachedCandles);
    const windowCovered = hasWindowCoverage(request, cachedCandles);

    if (
      cachedCandles.length > 0 &&
      windowCovered &&
      latestFetchedAt &&
      Date.now() - latestFetchedAt.getTime() <= this.ttlMs
    ) {
      return buildCachedResult(request, this.provider, cachedCandles);
    }

    try {
      const intervalMs = RESOLUTION_MS[request.resolution];
      const lastOpenTime = cachedCandles.at(-1)?.openTime.getTime();
      const refreshFrom =
        windowCovered && intervalMs && lastOpenTime
          ? new Date(Math.max(request.from.getTime(), lastOpenTime - intervalMs * 3))
          : request.from;
      const fresh = await this.upstream.getHistory({ ...request, from: refreshFrom });
      await this.repository.upsertCandles(fresh.candles);
      const candles = windowCovered ? mergeCandles(cachedCandles, fresh.candles) : fresh.candles;
      return {
        candles,
        meta: {
          ...fresh.meta,
          from: request.from,
          to: request.to
        }
      };
    } catch (error) {
      if (cachedCandles.length > 0) {
        return buildCachedResult(request, this.provider, cachedCandles, { stale: true });
      }

      throw error;
    }
  }
}
