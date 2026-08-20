import { describe, expect, it, vi } from "vitest";

import { MINTS } from "@grid-bot/common";

import type { Bot } from "../domain/types";
import { MarketDataUnavailableError, MarketPriceService } from "../services/market-price-service";

function createBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    key: "sol-grid",
    name: "SOL Grid",
    baseMint: MINTS.SOL,
    quoteMint: MINTS.USDC,
    baseSymbol: "SOL",
    quoteSymbol: "USDC",
    baseDecimals: 9,
    quoteDecimals: 6,
    strategyMode: "balanced" as Bot["strategyMode"],
    mode: "paper" as Bot["mode"],
    status: "running" as Bot["status"],
    executionProvider: "paper" as Bot["executionProvider"],
    currentPrice: null,
    ...overrides,
  };
}

function priceResponse(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      [MINTS.SOL]: { usdPrice: 82.44, blockId: 398169359, decimals: 9 },
      [MINTS.BTC]: { usdPrice: 67_500, blockId: 398169359, decimals: 8 },
      [MINTS.HYPE]: { usdPrice: 35.2, blockId: 398169359, decimals: 6 },
      [MINTS.USDC]: { usdPrice: 1.0001, blockId: 398169360, decimals: 6 },
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("MarketPriceService", () => {
  const options = {
    apiKey: "test-jupiter-key",
    baseUrl: "https://api.jup.ag/price/v3",
  };

  it("returns a fresh cached price without another network request", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const service = new MarketPriceService({ fetchFn, ...options });
    const cachedPrice = service.setLatestPrice({
      symbol: "SOL",
      pair: "SOL/USDC",
      price: 82.12,
      confidence: 0,
      source: "jupiter-price-v3",
      timestamp: new Date(),
      feedId: MINTS.SOL,
    });

    await expect(service.getLatestPrice(createBot())).resolves.toEqual(cachedPrice);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches SOL, BTC, HYPE and USDC in one Jupiter Price V3 batch", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => priceResponse());
    const service = new MarketPriceService({ fetchFn, retryDelaysMs: [], ...options });

    const prices = await service.fetchLatestPrices();

    expect(prices.map((price) => price.symbol)).toEqual(["SOL", "BTC", "HYPE"]);
    expect(prices[0]?.price).toBeCloseTo(82.44 / 1.0001);
    expect(prices.every((price) => price.source === "jupiter-price-v3")).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    const decodedUrl = decodeURIComponent(String(url));
    expect(decodedUrl).toContain(MINTS.SOL);
    expect(decodedUrl).toContain(MINTS.BTC);
    expect(decodedUrl).toContain(MINTS.HYPE);
    expect(decodedUrl).toContain(MINTS.USDC);
    expect(init).toEqual(
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": expect.any(String) }) })
    );
  });

  it("keeps valid symbols when Jupiter omits an unreliable token", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          [MINTS.SOL]: { usdPrice: 82.44 },
          [MINTS.BTC]: { usdPrice: 67_500 },
          [MINTS.USDC]: { usdPrice: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const service = new MarketPriceService({ fetchFn, retryDelaysMs: [], ...options });

    const prices = await service.fetchLatestPrices();

    expect(prices.map((price) => price.symbol)).toEqual(["SOL", "BTC"]);
    expect(service.getCachedPrice("HYPE")).toBeNull();
  });

  it("deduplicates concurrent stale-cache requests into one global batch", async () => {
    const fetchFn = vi.fn(async () => priceResponse());
    const service = new MarketPriceService({ fetchFn, retryDelaysMs: [], ...options });

    const [sol, btc] = await Promise.all([
      service.getLatestPrice(createBot()),
      service.getLatestPrice(createBot({ baseSymbol: "BTC", baseMint: MINTS.BTC, baseDecimals: 8 })),
    ]);

    expect(sol.symbol).toBe("SOL");
    expect(btc.symbol).toBe("BTC");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("refreshes a stale cached value instead of trading on it", async () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    const fetchFn = vi.fn(async () => priceResponse());
    const service = new MarketPriceService({ fetchFn, now: () => now, retryDelaysMs: [], ...options });
    service.setLatestPrice({
      symbol: "SOL",
      pair: "SOL/USDC",
      price: 70,
      confidence: 0,
      source: "jupiter-price-v3",
      timestamp: new Date(now.getTime() - 60_000),
      feedId: MINTS.SOL,
    });

    const price = await service.getLatestPrice(createBot());

    expect(price.price).toBeCloseTo(82.44 / 1.0001);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("uses local receipt time because Jupiter createdAt is token metadata, not quote freshness", async () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    const fetchFn = vi.fn(async () =>
      priceResponse({
        [MINTS.SOL]: {
          usdPrice: 82.44,
          createdAt: "2024-06-05T08:55:25.000Z",
        },
      })
    );
    const service = new MarketPriceService({
      fetchFn,
      now: () => now,
      staleAfterMs: 10_000,
      retryDelaysMs: [],
      ...options,
    });

    const price = await service.fetchLatestPrice("SOL");

    expect(price.price).toBeCloseTo(82.44 / 1.0001);
    expect(price.timestamp).toEqual(now);
  });

  it("retries a temporary 429 once and then succeeds", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }))
      .mockResolvedValueOnce(priceResponse());
    const service = new MarketPriceService({ fetchFn, retryDelaysMs: [0], ...options });

    await expect(service.fetchLatestPrices()).resolves.toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("classifies a request timeout as a temporary market-data outage", async () => {
    const fetchFn = vi.fn<typeof fetch>((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
    );
    const service = new MarketPriceService({ fetchFn, timeoutMs: 5, retryDelaysMs: [], ...options });

    await expect(service.fetchLatestPrices()).rejects.toMatchObject({
      name: "MarketDataUnavailableError",
      provider: "jupiter-price-v3",
    } satisfies Partial<MarketDataUnavailableError>);
  });

  it("fails cleanly when the requested symbol is absent", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          [MINTS.SOL]: { usdPrice: 82.44 },
          [MINTS.USDC]: { usdPrice: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const service = new MarketPriceService({ fetchFn, retryDelaysMs: [], ...options });

    await expect(
      service.getLatestPrice(createBot({ baseSymbol: "BTC", baseMint: MINTS.BTC, baseDecimals: 8 }))
    ).rejects.toMatchObject({
      name: "MarketDataUnavailableError",
      provider: "jupiter-price-v3",
      symbol: "BTC",
    } satisfies Partial<MarketDataUnavailableError>);
  });
});
