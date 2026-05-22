import { PYTH_FEED_IDS, getEnv } from "@grid-bot/common";

import type { MarketPricePort } from "../domain/contracts";
import type { Bot, MarketPrice } from "../domain/types";

export interface HermesParsedPriceUpdate {
  id: string;
  price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
}

interface HermesLatestResponse {
  parsed: HermesParsedPriceUpdate[];
}

const FEED_ID_BY_SYMBOL = {
  BTC: PYTH_FEED_IDS.BTC_USD,
  HYPE: PYTH_FEED_IDS.HYPE_USD,
  SOL: PYTH_FEED_IDS.SOL_USD,
} as const;

export class MarketDataUnavailableError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly symbol?: string;

  constructor(
    message: string,
    options: {
      provider: string;
      status?: number;
      symbol?: string;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "MarketDataUnavailableError";
    this.provider = options.provider;
    this.status = options.status;
    this.symbol = options.symbol;
  }
}

export function isMarketDataUnavailableError(error: unknown): error is MarketDataUnavailableError {
  return error instanceof MarketDataUnavailableError;
}

function isRetryableMarketDataStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function normalizePythFeedId(feedId: string) {
  return feedId.replace(/^0x/i, "").toLowerCase();
}

export function getPythFeedId(symbol: string) {
  const normalizedSymbol = symbol.toUpperCase() as keyof typeof FEED_ID_BY_SYMBOL;
  const feedId = FEED_ID_BY_SYMBOL[normalizedSymbol];
  if (!feedId) {
    throw new Error(`Unsupported Pyth symbol: ${symbol}`);
  }

  return feedId;
}

export function parseHermesPriceUpdate(
  symbol: string,
  quoteSymbol: string,
  item: HermesParsedPriceUpdate
): MarketPrice {
  const price = Number(item.price.price) * 10 ** item.price.expo;
  const confidence = Number(item.price.conf) * 10 ** item.price.expo;

  return {
    symbol,
    pair: `${symbol}/${quoteSymbol}`,
    price,
    confidence,
    source: "pyth",
    timestamp: new Date(item.price.publish_time * 1000),
    feedId: normalizePythFeedId(item.id),
  };
}

export class MarketPriceService implements MarketPricePort {
  private readonly env = getEnv();
  private readonly latestBySymbol = new Map<string, MarketPrice>();

  async getLatestPrice(bot: Bot): Promise<MarketPrice> {
    const cached = this.getFreshPrice(bot.baseSymbol);
    if (cached) {
      return cached;
    }

    return this.fetchLatestPrice(bot.baseSymbol, bot.quoteSymbol);
  }

  getCachedPrice(symbol: string) {
    return this.latestBySymbol.get(symbol.toUpperCase()) ?? null;
  }

  setLatestPrice(marketPrice: MarketPrice) {
    this.latestBySymbol.set(marketPrice.symbol.toUpperCase(), marketPrice);
    return marketPrice;
  }

  async fetchLatestPrice(symbol: string, quoteSymbol = "USDC"): Promise<MarketPrice> {
    const feedId = getPythFeedId(symbol);
    const url = `${this.env.PYTH_HERMES_BASE_URL}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
    let response: Response;

    try {
      response = await fetch(url);
    } catch (error) {
      throw new MarketDataUnavailableError(
        `Pyth request failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          provider: "pyth",
          symbol: symbol.toUpperCase(),
          cause: error,
        }
      );
    }

    if (!response.ok) {
      const message = `Pyth request failed with status ${response.status}`;
      if (isRetryableMarketDataStatus(response.status)) {
        throw new MarketDataUnavailableError(message, {
          provider: "pyth",
          status: response.status,
          symbol: symbol.toUpperCase(),
        });
      }

      throw new Error(message);
    }

    const payload = (await response.json()) as HermesLatestResponse;
    const item = payload.parsed[0];
    if (!item) {
      throw new Error(`No Pyth price feed returned for ${symbol}`);
    }

    return this.setLatestPrice(parseHermesPriceUpdate(symbol.toUpperCase(), quoteSymbol, item));
  }

  private getFreshPrice(symbol: string) {
    const cached = this.getCachedPrice(symbol);
    if (!cached) {
      return null;
    }

    if (Date.now() - cached.timestamp.getTime() > this.env.PRICE_STALE_AFTER_MS) {
      return null;
    }

    return cached;
  }
}
