import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "../domain/types";
import { MarketDataUnavailableError, MarketPriceService } from "../services/market-price-service";

const ORIGINAL_FETCH = globalThis.fetch;

function createBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    key: "sol-grid",
    name: "SOL Grid",
    baseMint: "SOL",
    quoteMint: "USDC",
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

describe("MarketPriceService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("returns a fresh streamed price without polling Hermes again", async () => {
    const service = new MarketPriceService();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    const streamedPrice = service.setLatestPrice({
      symbol: "SOL",
      pair: "SOL/USDC",
      price: 82.12,
      confidence: 0.01,
      source: "pyth",
      timestamp: new Date(),
      feedId: "feed-sol",
    });

    const marketPrice = await service.getLatestPrice(createBot());

    expect(marketPrice).toEqual(streamedPrice);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to Hermes polling when the cached streamed price is stale", async () => {
    const service = new MarketPriceService();
    service.setLatestPrice({
      symbol: "SOL",
      pair: "SOL/USDC",
      price: 82.12,
      confidence: 0.01,
      source: "pyth",
      timestamp: new Date(Date.now() - 60_000),
      feedId: "feed-sol",
    });

    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          parsed: [
            {
              id: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
              price: {
                price: "8215",
                conf: "4",
                expo: -2,
                publish_time: 1_775_736_800,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }
      )
    ) as typeof fetch;

    const marketPrice = await service.getLatestPrice(createBot());

    expect(marketPrice.price).toBe(82.15);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("falls back to Jupiter price when Hermes is temporarily unavailable", async () => {
    const service = new MarketPriceService();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            So11111111111111111111111111111111111111112: {
              usdPrice: 82.44,
              blockId: 398169359,
              decimals: 9,
            },
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
              usdPrice: 1.0001,
              blockId: 398169360,
              decimals: 6,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      ) as typeof fetch;

    const marketPrice = await service.getLatestPrice(createBot());

    expect(marketPrice).toMatchObject({
      symbol: "SOL",
      pair: "SOL/USDC",
      source: "jupiter-price",
      confidence: 0,
      feedId: "So11111111111111111111111111111111111111112",
    });
    expect(marketPrice.price).toBeCloseTo(82.44 / 1.0001);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringContaining("https://api.jup.ag/price/v3?ids="),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": expect.any(String),
        }),
      })
    );
  });

  it("deduplicates concurrent Jupiter fallback requests for the same pair", async () => {
    const service = new MarketPriceService();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            So11111111111111111111111111111111111111112: {
              usdPrice: 82.44,
              blockId: 398169359,
              decimals: 9,
            },
            EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
              usdPrice: 1,
              blockId: 398169360,
              decimals: 6,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          }
        )
      ) as typeof fetch;

    const [first, second] = await Promise.all([
      service.getLatestPrice(createBot()),
      service.getLatestPrice(createBot()),
    ]);

    expect(first).toEqual(second);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).includes("/price/v3")).length).toBe(1);
  });

  it("classifies retryable Hermes and Jupiter failures as temporary market data outages", async () => {
    const service = new MarketPriceService();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 })) as typeof fetch;

    await expect(service.getLatestPrice(createBot())).rejects.toMatchObject({
      name: "MarketDataUnavailableError",
      message: "Jupiter price fallback failed with status 429",
      provider: "jupiter-price",
      status: 429,
      symbol: "SOL",
    } satisfies Partial<MarketDataUnavailableError>);
  });
});
