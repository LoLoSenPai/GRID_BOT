import { describe, expect, it, vi } from "vitest";
import { MINTS } from "@grid-bot/common";
import { ShadowDataCollector, verifyShadowPool } from "./shadow-data-collector";
import type { ShadowQuoteComparison } from "./shadow-execution-quote-client";
const target = { portfolioId: "p", botId: "b", symbol: "BTC" as const, baseMint: MINTS.BTC, quoteMint: MINTS.USDC, orderQuoteUsd: 133.33 };
describe("Independent shadow collector", () => {
  it("collects BTC reference once per resolution despite duplicate bands and Gecko pool failure", async () => {
    const candles = vi.fn(), observeReference = vi.fn(), onError = vi.fn(), history = { getHistory: vi.fn() };
    const btcReference = { getClosedHistory: vi.fn(async () => ({ candles: [], quality: { stale: true, missingIntervals: 80 } })) };
    await new ShadowDataCollector({ targets: async () => [target, { ...target, botId: "b2" }], candles, observeReference, quote: vi.fn() },
      { history, btcReference: btcReference as never, compare: async () => ({} as ShadowQuoteComparison),
        verifyPool: async () => { throw new Error("Gecko identity unavailable"); }, onError }).collect();
    expect(btcReference.getClosedHistory).toHaveBeenCalledTimes(2); expect(candles).toHaveBeenCalledTimes(2);
    expect(history.getHistory).not.toHaveBeenCalled();
    expect(observeReference).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "pool_BTC");
  });
  it("continues hourly reference and Gecko collection after failed 5m reference", async () => {
    const history = { getHistory: vi.fn(async () => ({ candles: [] })) };
    const btcReference = { getClosedHistory: vi.fn().mockRejectedValueOnce(new Error("reference failed"))
      .mockResolvedValueOnce({ candles: [], quality: { stale: true, missingIntervals: 80 } }) };
    const onError = vi.fn();
    await new ShadowDataCollector({ targets: async () => [target], candles: vi.fn(), quote: vi.fn() },
      { history: history as never, btcReference, compare: async () => ({} as ShadowQuoteComparison), verifyPool: async () => {}, onError }).collect();
    expect(btcReference.getClosedHistory).toHaveBeenCalledTimes(2); expect(history.getHistory).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "candles_BTC_REF_5m");
  });
  it("continues after candle or quote failures and rate-bounds comparisons", async () => {
    const at = new Date("2026-09-30T20:00:15Z"), onError = vi.fn();
    const compare = vi.fn(async () => { throw new Error("API unavailable"); });
    const history = { getHistory: vi.fn(async () => { throw new Error("market unavailable"); }) };
    const collector = new ShadowDataCollector({ targets: async () => [target], candles: vi.fn(), quote: vi.fn() },
      { history, compare, verifyPool: async () => {}, onError });
    await expect(collector.collect(at)).resolves.toBeUndefined();
    expect(history.getHistory).toHaveBeenCalledTimes(2); expect(compare).toHaveBeenCalledTimes(2);
    await collector.collect(new Date(+at + 300_000)); expect(compare).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalled();
  });
  it("does not collect an unsupported token under a familiar symbol", async () => {
    const compare = vi.fn(async () => ({} as ShadowQuoteComparison)), history = { getHistory: vi.fn() };
    await new ShadowDataCollector({ targets: async () => [{ ...target, baseMint: MINTS.SOL }], candles: vi.fn(), quote: vi.fn() },
      { compare, history, verifyPool: vi.fn(), onError: vi.fn() }).collect();
    expect(compare).not.toHaveBeenCalled(); expect(history.getHistory).not.toHaveBeenCalled();
  });
  it("checks both pool token identities before trusting candles", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ data: { relationships: {
      base_token: { data: { id: `solana_${MINTS.SOL}` } }, quote_token: { data: { id: `solana_${MINTS.USDC}` } },
    } } }))) as unknown as typeof fetch;
    await expect(verifyShadowPool(target, fetchFn)).rejects.toThrow(/identity/);
  });
});
