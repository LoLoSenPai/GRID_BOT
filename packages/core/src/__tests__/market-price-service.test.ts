import { describe, expect, it, vi } from "vitest";
import { MINTS } from "@grid-bot/common";
import type { Bot } from "../domain/types";
import { MarketPriceService, type PriceObservationStore } from "../services/market-price-service";

const bot = { baseSymbol: "SOL", quoteSymbol: "USDC" } as Bot;
const options = { apiKey: "test-key", baseUrl: "https://api.jup.ag/price/v3", retryDelaysMs: [] };
const start = new Date("2026-09-10T12:00:00Z");
function response(block = 100, overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    [MINTS.SOL]: { usdPrice: 82.44, blockId: block, decimals: 9 },
    [MINTS.BTC]: { usdPrice: 67500, blockId: block, decimals: 8 },
    [MINTS.HYPE]: { usdPrice: 35.2, blockId: block, decimals: 6 },
    [MINTS.USDC]: { usdPrice: 1.0001, blockId: block, decimals: 6 },
    ...overrides,
  }), { status: 200 });
}
async function warmed(extra: ConstructorParameters<typeof MarketPriceService>[0] = {}) {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(100));
  const service = new MarketPriceService({ ...options, now: () => start, ...extra, fetchFn });
  await expect(service.fetchLatestPrices()).rejects.toThrow("warming up");
  fetchFn.mockClear();
  fetchFn.mockImplementation(async () => response(101));
  return { service, fetchFn };
}

describe("MarketPriceService source freshness", () => {
  it("warms up from advancing source blocks for all mints, then batches and caches prices", async () => {
    const { service, fetchFn } = await warmed();
    const prices = await service.fetchLatestPrices();
    expect(prices.map((price) => price.symbol)).toEqual(["SOL", "BTC", "HYPE"]);
    expect(prices[0]?.price).toBeCloseTo(82.44 / 1.0001);
    expect(prices[0]).toMatchObject({ timestamp: start, receivedAt: start, sourceObservedAt: start,
      sourceBlockId: 101, quoteSourceBlockId: 101, freshnessBasis: "block-observed" });
    expect(await service.getLatestPrice(bot)).toEqual(prices[0]);
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    for (const mint of Object.values(MINTS)) expect(decodeURIComponent(String(url))).toContain(mint);
    expect(init?.headers).toMatchObject({ "x-api-key": "test-key" });
  });

  it("deduplicates concurrent requests for the same batch", async () => {
    const { service, fetchFn } = await warmed();
    const [sol, btc] = await Promise.all([service.getLatestPrice(bot), service.getLatestPrice({ ...bot, baseSymbol: "BTC" })]);
    expect(sol.symbol).toBe("SOL");
    expect(btc.symbol).toBe("BTC");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not conflate different quote symbols in cache or concurrent batches", async () => {
    const { service, fetchFn } = await warmed();
    await service.fetchLatestPrices();
    const [usdc, sol] = await Promise.all([service.fetchLatestPrices(["BTC"], "USDC"), service.fetchLatestPrices(["BTC"], "SOL")]);
    expect(usdc[0]?.price).toBeCloseTo(67500 / 1.0001);
    expect(sol[0]?.price).toBeCloseTo(67500 / 82.44);
    expect(service.getCachedPrice("BTC")?.pair).toBe("BTC/USDC");
    expect(service.getCachedPrice("BTC", "SOL")?.pair).toBe("BTC/SOL");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("does not renew source freshness on repeated HTTP responses, even if price changes", async () => {
    let now = start;
    const { service, fetchFn } = await warmed({ now: () => now, staleAfterMs: 10_000 });
    const first = await service.fetchLatestPrice("SOL");
    now = new Date(start.getTime() + 5000);
    fetchFn.mockImplementation(async () => response(101, { [MINTS.SOL]: { usdPrice: 90, blockId: 101 } }));
    const repeated = await service.fetchLatestPrice("SOL");
    expect(repeated.receivedAt).toEqual(now);
    expect(repeated.timestamp).toEqual(first.timestamp);
    now = new Date(start.getTime() + 10_001);
    await expect(service.getLatestPrice(bot)).rejects.toThrow("no fresh quote price");
  });

  it("can recover after stale data only with advancement of both base and quote blocks", async () => {
    let now = start;
    const { service, fetchFn } = await warmed({ now: () => now, staleAfterMs: 10_000 });
    await service.fetchLatestPrice("SOL");
    now = new Date(start.getTime() + 20_000);
    fetchFn.mockImplementation(async () => response(101, { [MINTS.SOL]: { usdPrice: 90, blockId: 102 } }));
    await expect(service.fetchLatestPrice("SOL")).rejects.toThrow("no fresh quote price");
    fetchFn.mockImplementation(async () => response(102));
    expect((await service.fetchLatestPrice("SOL")).timestamp).toEqual(now);
  });

  it("fails closed after restart until source blocks advance again", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response(1));
    const first = new MarketPriceService({ ...options, fetchFn });
    await expect(first.fetchLatestPrices()).rejects.toThrow("warming up");
    const restarted = new MarketPriceService({ ...options, fetchFn });
    await expect(restarted.fetchLatestPrices()).rejects.toThrow("warming up");
    await expect(restarted.fetchLatestPrices()).rejects.toThrow("warming up");
    fetchFn.mockImplementation(async () => response(2));
    expect(await restarted.fetchLatestPrices()).toHaveLength(3);
  });

  it.each([null, {}, { usdPrice: 1 }, { usdPrice: 1, blockId: 0 }, { usdPrice: 1, blockId: -1 },
    { usdPrice: 1, blockId: 10.5 }])("does not silently peg missing or unverifiable USDC to $1: %j", async (quote) => {
    const { service, fetchFn } = await warmed();
    fetchFn.mockImplementation(async () => response(101, { [MINTS.USDC]: quote }));
    await expect(service.fetchLatestPrices()).rejects.toThrow("no fresh quote price");
  });

  it("omits unavailable or regressing base blocks without discarding valid symbols", async () => {
    const { service, fetchFn } = await warmed();
    await service.fetchLatestPrices();
    fetchFn.mockImplementation(async () => response(102, { [MINTS.SOL]: { usdPrice: 82.44, blockId: 99 }, [MINTS.HYPE]: null }));
    expect((await service.fetchLatestPrices()).map((p) => p.symbol)).toEqual(["BTC"]);
    await expect(service.fetchLatestPrice("SOL")).rejects.toMatchObject({ symbol: "SOL" });
  });

  it("ignores token creation timestamps and exposes local block observations honestly", async () => {
    const { service, fetchFn } = await warmed();
    fetchFn.mockImplementation(async () => response(101, { [MINTS.SOL]: {
      usdPrice: 82.44, blockId: 101, createdAt: "2020-01-01T00:00:00Z" } }));
    const price = await service.fetchLatestPrice("SOL");
    expect(price.timestamp).toEqual(start);
    expect(price.freshnessBasis).toBe("block-observed");
  });

  it("persists first sightings and restores unchanged-block aging when a durable store is supplied", async () => {
    let saved = {};
    const store: PriceObservationStore = { load: vi.fn(async () => saved), save: vi.fn(async (state) => { saved = state; }) };
    const { service } = await warmed({ observationStore: store });
    await service.fetchLatestPrices();
    expect(store.save).toHaveBeenCalledOnce();
    const restarted = new MarketPriceService({ ...options, observationStore: store, now: () => new Date(start.getTime() + 20_000),
      staleAfterMs: 10_000, fetchFn: vi.fn<typeof fetch>().mockImplementation(async () => response(101)) });
    await expect(restarted.fetchLatestPrices()).rejects.toThrow("no fresh quote price");
  });

  it("fails closed if durable observations cannot be saved", async () => {
    const { service } = await warmed({ observationStore: { load: async () => ({}), save: async () => { throw new Error("disk full"); } } });
    await expect(service.fetchLatestPrices()).rejects.toThrow("persist");
    expect(service.getCachedPrice("SOL")).toBeNull();
  });

  it("retries 429 once without treating it as a fresh source observation", async () => {
    const { service, fetchFn } = await warmed({ retryDelaysMs: [0] });
    fetchFn.mockReset().mockResolvedValueOnce(new Response("rate limited", { status: 429 })).mockResolvedValueOnce(response(101));
    expect(await service.fetchLatestPrices()).toHaveLength(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled response body, even if fetch has already returned headers", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as Response);
    const service = new MarketPriceService({ ...options, fetchFn, timeoutMs: 5 });
    await expect(service.fetchLatestPrices()).rejects.toMatchObject({ name: "MarketDataUnavailableError", provider: "jupiter-price-v3" });
  });

  it("bounds stalled requests even when the fetch implementation ignores abort", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const service = new MarketPriceService({ ...options, fetchFn, timeoutMs: 5 });
    await expect(service.fetchLatestPrices()).rejects.toMatchObject({ name: "MarketDataUnavailableError", provider: "jupiter-price-v3" });
  });
});
