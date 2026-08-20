import { MINTS, getEnv } from "@grid-bot/common";

import type { MarketPricePort } from "../domain/contracts";
import type { Bot, MarketPrice } from "../domain/types";

export const JUPITER_PRICE_SYMBOLS = ["SOL", "BTC", "HYPE"] as const;

export interface JupiterPriceEntry {
  createdAt?: string;
  usdPrice?: number | null;
  blockId?: number;
  decimals?: number;
  priceChange24h?: number;
}

export type JupiterPriceResponse = Record<string, JupiterPriceEntry | null | undefined>;

export interface MarketPriceServiceOptions {
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  apiKey?: string;
  baseUrl?: string;
  staleAfterMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAYS_MS = [250];

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

export class MarketPriceService implements MarketPricePort {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly staleAfterMs: number;
  private readonly latestBySymbol = new Map<string, MarketPrice>();
  private batchInFlight: Promise<MarketPrice[]> | null = null;

  constructor(options: MarketPriceServiceOptions = {}) {
    const env = getEnv();
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.apiKey = options.apiKey ?? env.JUPITER_API_KEY ?? "";
    this.baseUrl = options.baseUrl ?? env.JUPITER_PRICE_BASE_URL;
    this.staleAfterMs = options.staleAfterMs ?? env.PRICE_STALE_AFTER_MS;
  }

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
    const normalizedSymbol = symbol.toUpperCase();
    const normalizedQuoteSymbol = quoteSymbol.toUpperCase();
    const prices = await this.fetchLatestPrices(JUPITER_PRICE_SYMBOLS, normalizedQuoteSymbol);
    const marketPrice = prices.find((price) => price.symbol === normalizedSymbol);

    if (!marketPrice) {
      throw new MarketDataUnavailableError(
        `Jupiter Price V3 returned no reliable price for ${normalizedSymbol}/${normalizedQuoteSymbol}`,
        {
          provider: "jupiter-price-v3",
          symbol: normalizedSymbol,
        }
      );
    }

    return marketPrice;
  }

  fetchLatestPrices(
    symbols: readonly string[] = JUPITER_PRICE_SYMBOLS,
    quoteSymbol = "USDC"
  ): Promise<MarketPrice[]> {
    if (this.batchInFlight) {
      return this.batchInFlight;
    }

    const normalizedSymbols = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
    const normalizedQuoteSymbol = quoteSymbol.toUpperCase();
    const request = this.fetchJupiterBatch(normalizedSymbols, normalizedQuoteSymbol).finally(() => {
      this.batchInFlight = null;
    });
    this.batchInFlight = request;
    return request;
  }

  private async fetchJupiterBatch(symbols: string[], quoteSymbol: string): Promise<MarketPrice[]> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new MarketDataUnavailableError("JUPITER_API_KEY is required for Jupiter Price V3", {
        provider: "jupiter-price-v3",
      });
    }

    const quoteMint = getMintForSymbol(quoteSymbol);
    const baseMints = symbols.map((symbol) => getMintForSymbol(symbol));
    const ids = [...new Set([...baseMints, quoteMint])].join(",");
    const url = `${this.baseUrl}?ids=${encodeURIComponent(ids)}`;
    const payload = await this.fetchJupiterPayload(url, apiKey);
    const receivedAt = this.now();
    const quoteUsdPrice = getJupiterUsdPrice(payload, quoteMint) ?? (quoteSymbol === "USDC" ? 1 : null);

    if (!quoteUsdPrice) {
      throw new MarketDataUnavailableError(`Jupiter Price V3 returned no reliable quote price for ${quoteSymbol}`, {
        provider: "jupiter-price-v3",
        symbol: quoteSymbol,
      });
    }

    const prices = symbols.flatMap((symbol, index) => {
      const baseMint = baseMints[index];
      if (!baseMint) {
        return [];
      }

      const baseUsdPrice = getJupiterUsdPrice(payload, baseMint);
      if (!baseUsdPrice) {
        return [];
      }

      return [
        this.setLatestPrice({
          symbol,
          pair: `${symbol}/${quoteSymbol}`,
          price: baseUsdPrice / quoteUsdPrice,
          confidence: 0,
          source: "jupiter-price-v3",
          timestamp: receivedAt,
          feedId: baseMint,
        }),
      ];
    });

    if (prices.length === 0) {
      throw new MarketDataUnavailableError("Jupiter Price V3 returned no reliable requested prices", {
        provider: "jupiter-price-v3",
      });
    }

    return prices;
  }

  private async fetchJupiterPayload(url: string, apiKey: string): Promise<JupiterPriceResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryDelaysMs[attempt - 1] ?? 0);
      }

      try {
        const response = await this.fetchWithTimeout(url, apiKey);
        if (!response.ok) {
          const error = new MarketDataUnavailableError(
            `Jupiter Price V3 request failed with status ${response.status}`,
            {
              provider: "jupiter-price-v3",
              status: response.status,
            }
          );

          if (!isRetryableMarketDataStatus(response.status)) {
            throw error;
          }

          lastError = error;
          continue;
        }

        return (await response.json()) as JupiterPriceResponse;
      } catch (error) {
        if (error instanceof MarketDataUnavailableError && error.status && !isRetryableMarketDataStatus(error.status)) {
          throw error;
        }

        lastError = error;
      }
    }

    if (lastError instanceof MarketDataUnavailableError) {
      throw lastError;
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown error");
    throw new MarketDataUnavailableError(`Jupiter Price V3 request failed: ${message}`, {
      provider: "jupiter-price-v3",
      cause: lastError,
    });
  }

  private async fetchWithTimeout(url: string, apiKey: string) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetchFn(url, {
        headers: {
          accept: "application/json",
          "x-api-key": apiKey,
        },
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private getFreshPrice(symbol: string) {
    const cached = this.getCachedPrice(symbol);
    if (!cached) {
      return null;
    }

    if (this.now().getTime() - cached.timestamp.getTime() > this.staleAfterMs) {
      return null;
    }

    return cached;
  }
}

function getMintForSymbol(symbol: string) {
  const mint = MINTS[symbol.toUpperCase() as keyof typeof MINTS];
  if (!mint) {
    throw new Error(`Unsupported Jupiter price symbol: ${symbol}`);
  }

  return mint;
}

function getJupiterUsdPrice(payload: JupiterPriceResponse, mint: string) {
  const entry = payload[mint];
  const price = entry?.usdPrice;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    return null;
  }

  return price;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
