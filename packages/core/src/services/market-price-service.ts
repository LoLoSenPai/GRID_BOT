import { MINTS, getEnv } from "@grid-bot/common";

import type { MarketPricePort } from "../domain/contracts";
import type { Bot, MarketPrice } from "../domain/types";

export const JUPITER_PRICE_SYMBOLS = ["SOL", "BTC", "HYPE"] as const;

export interface JupiterPriceEntry {
  createdAt?: string;
  usdPrice?: number | null;
  blockId?: number | null;
  decimals?: number;
  priceChange24h?: number;
}

export type JupiterPriceResponse = Record<string, JupiterPriceEntry | null | undefined>;

export interface PriceBlockObservation {
  blockId: number;
  firstObservedAt: string;
  hasAdvanced?: boolean;
}

export interface PriceObservationStore {
  load(): Promise<Record<string, PriceBlockObservation>>;
  save(observations: Record<string, PriceBlockObservation>): Promise<void>;
}

export interface MarketPriceServiceOptions {
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  retryDelaysMs?: number[];
  apiKey?: string;
  baseUrl?: string;
  staleAfterMs?: number;
  observationStore?: PriceObservationStore;
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
  private readonly batchesInFlight = new Map<string, Promise<MarketPrice[]>>();
  private readonly blockObservations = new Map<string, PriceBlockObservation>();
  private readonly observationStore?: PriceObservationStore;
  private observationLoad: Promise<void> | null = null;
  private observationSave: Promise<void> = Promise.resolve();

  constructor(options: MarketPriceServiceOptions = {}) {
    const env = getEnv();
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.apiKey = options.apiKey ?? env.JUPITER_API_KEY ?? "";
    this.baseUrl = options.baseUrl ?? env.JUPITER_PRICE_BASE_URL;
    this.staleAfterMs = options.staleAfterMs ?? env.PRICE_STALE_AFTER_MS;
    this.observationStore = options.observationStore;
  }

  async getLatestPrice(bot: Bot): Promise<MarketPrice> {
    const cached = this.getFreshPrice(bot.baseSymbol, bot.quoteSymbol);
    if (cached) {
      return cached;
    }

    return this.fetchLatestPrice(bot.baseSymbol, bot.quoteSymbol);
  }

  getCachedPrice(symbol: string, quoteSymbol = "USDC") {
    return this.latestBySymbol.get(`${symbol}/${quoteSymbol}`.toUpperCase()) ?? null;
  }

  setLatestPrice(marketPrice: MarketPrice) {
    this.latestBySymbol.set(marketPrice.pair.toUpperCase(), marketPrice);
    return marketPrice;
  }

  async fetchLatestPrice(symbol: string, quoteSymbol = "USDC"): Promise<MarketPrice> {
    const normalizedSymbol = symbol.toUpperCase();
    const normalizedQuoteSymbol = quoteSymbol.toUpperCase();
    const prices = await this.fetchLatestPrices([...new Set([...JUPITER_PRICE_SYMBOLS, normalizedSymbol])], normalizedQuoteSymbol);
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
    const normalizedSymbols = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
    const normalizedQuoteSymbol = quoteSymbol.toUpperCase();
    const batchKey = `${[...normalizedSymbols].sort().join(",")}/${normalizedQuoteSymbol}`;
    const pending = this.batchesInFlight.get(batchKey);
    if (pending) return pending;
    const request = this.fetchJupiterBatch(normalizedSymbols, normalizedQuoteSymbol).finally(() => {
      this.batchesInFlight.delete(batchKey);
    });
    this.batchesInFlight.set(batchKey, request);
    return request;
  }

  private async fetchJupiterBatch(symbols: string[], quoteSymbol: string): Promise<MarketPrice[]> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new MarketDataUnavailableError("JUPITER_API_KEY is required for Jupiter Price V3", {
        provider: "jupiter-price-v3",
      });
    }

    await this.loadObservations();
    const quoteMint = getMintForSymbol(quoteSymbol);
    const baseMints = symbols.map((symbol) => getMintForSymbol(symbol));
    const ids = [...new Set([...baseMints, quoteMint])].join(",");
    const url = `${this.baseUrl}?ids=${encodeURIComponent(ids)}`;
    const payload = await this.fetchJupiterPayload(url, apiKey);
    const receivedAt = this.now();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new MarketDataUnavailableError("Malformed Jupiter Price V3 response", { provider: "jupiter-price-v3" });
    }
    const quoteObservation = this.observeBlock(quoteMint, payload[quoteMint]?.blockId, receivedAt);
    const quoteUsdPrice = quoteObservation ? getJupiterUsdPrice(payload, quoteMint) : null;
    // Observe all requested mints even while the quote mint is warming up.
    const baseObservations = baseMints.map((mint) => this.observeBlock(mint, payload[mint]?.blockId, receivedAt));

    if (!quoteUsdPrice) {
      for (const symbol of symbols) this.latestBySymbol.delete(`${symbol}/${quoteSymbol}`);
      throw new MarketDataUnavailableError(`Jupiter Price V3 returned no fresh quote price for ${quoteSymbol}; missing data, stale block or source warming up`, {
        provider: "jupiter-price-v3",
        symbol: quoteSymbol,
      });
    }

    const prices = symbols.flatMap((symbol, index) => {
      const baseMint = baseMints[index];
      if (!baseMint) {
        return [];
      }

      const baseObservation = baseObservations[index];
      const baseUsdPrice = baseObservation ? getJupiterUsdPrice(payload, baseMint) : null;
      if (!baseUsdPrice || !baseObservation || !quoteObservation) {
        this.latestBySymbol.delete(`${symbol}/${quoteSymbol}`);
        return [];
      }

      return [
        {
          symbol,
          pair: `${symbol}/${quoteSymbol}`,
          price: baseUsdPrice / quoteUsdPrice,
          confidence: 0,
          source: "jupiter-price-v3",
          // Price V3 has a block ID, not an observation timestamp. This is the
          // first local sighting of that block, never a claimed on-chain time.
          timestamp: new Date(Math.min(Date.parse(baseObservation.firstObservedAt), Date.parse(quoteObservation.firstObservedAt))),
          receivedAt,
          sourceObservedAt: new Date(baseObservation.firstObservedAt),
          sourceBlockId: baseObservation.blockId,
          quoteSourceBlockId: quoteObservation.blockId,
          freshnessBasis: "block-observed" as const,
          feedId: baseMint,
        },
      ];
    });

    if (prices.length === 0) {
      throw new MarketDataUnavailableError("Jupiter Price V3 returned no reliable requested prices", {
        provider: "jupiter-price-v3",
      });
    }

    // Persist source evidence before publishing a usable price, so a worker restart
    // cannot make a repeatedly served source block fresh again.
    if (this.observationStore) {
      const snapshot = Object.fromEntries(this.blockObservations);
      this.observationSave = this.observationSave.catch(() => {}).then(() => this.observationStore!.save(snapshot));
      try { await this.observationSave; } catch (cause) {
        throw new MarketDataUnavailableError("Could not persist price source observations", { provider: "jupiter-price-v3", cause });
      }
    }
    return prices.map((price) => this.setLatestPrice(price));
  }

  private async loadObservations() {
    if (!this.observationStore) return;
    this.observationLoad ??= this.observationStore.load().then((observations) => {
      for (const [mint, observation] of Object.entries(observations)) {
        if (!Number.isSafeInteger(observation.blockId) || observation.blockId <= 0 ||
          !Number.isFinite(Date.parse(observation.firstObservedAt))) throw new Error("Invalid persisted price source observation.");
        this.blockObservations.set(mint, observation);
      }
    });
    try { await this.observationLoad; } catch (cause) {
      throw new MarketDataUnavailableError("Could not load price source observations", { provider: "jupiter-price-v3", cause });
    }
  }

  private observeBlock(mint: string, blockId: number | null | undefined, receivedAt: Date): PriceBlockObservation | null {
    if (!Number.isSafeInteger(blockId) || !blockId || blockId <= 0) return null;
    const previous = this.blockObservations.get(mint);
    if (previous && blockId < previous.blockId) return null;
    const observation = previous?.blockId === blockId ? previous : {
      blockId, firstObservedAt: receivedAt.toISOString(), hasAdvanced: previous !== undefined,
    };
    this.blockObservations.set(mint, observation);
    const age = receivedAt.getTime() - Date.parse(observation.firstObservedAt);
    // The first sighting cannot prove recency. Require advancement before use;
    // after that, unchanged blocks age from their first sighting, including USDC.
    return observation.hasAdvanced && age >= 0 && age <= this.staleAfterMs ? observation : null;
  }

  private async fetchJupiterPayload(url: string, apiKey: string): Promise<JupiterPriceResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.retryDelaysMs[attempt - 1] ?? 0);
      }

      try {
        const { response, payload } = await this.fetchWithTimeout(url, apiKey);
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

        return payload as JupiterPriceResponse;
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
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => { controller.abort(); reject(new Error("Jupiter Price V3 request timed out")); }, this.timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await this.fetchFn(url, {
          headers: { accept: "application/json", "x-api-key": apiKey },
          cache: "no-store", signal: controller.signal,
        });
        const payload: unknown = response.ok ? await response.json() : null;
        return { response, payload };
      })()]);
    } finally { clearTimeout(timeoutId); }
  }

  private getFreshPrice(symbol: string, quoteSymbol: string) {
    const cached = this.getCachedPrice(symbol, quoteSymbol);
    if (!cached) {
      return null;
    }

    if (this.now().getTime() < cached.timestamp.getTime() || this.now().getTime() - cached.timestamp.getTime() > this.staleAfterMs) {
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
