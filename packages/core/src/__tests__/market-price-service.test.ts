import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "../domain/types";
import { MarketPriceService } from "../services/market-price-service";

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
});
