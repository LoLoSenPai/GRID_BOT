import { describe, expect, it, vi } from "vitest";

import { GECKOTERMINAL_POOLS, MINTS } from "@grid-bot/common";

import { GeckoTerminalHistoryProvider } from "./gecko-terminal-history-provider";

const baseRequest = {
  symbol: "SOL",
  quoteSymbol: "USDC",
  resolution: "5m",
  from: new Date("2026-08-20T10:00:00.000Z"),
  to: new Date("2026-08-20T10:30:00.000Z"),
};

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function response(rows: unknown[], status = 200) {
  return new Response(
    JSON.stringify({
      data: { attributes: { ohlcv_list: rows } },
      meta: {
        base: { address: MINTS.SOL },
        quote: { address: MINTS.USDC },
      },
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

describe("GeckoTerminalHistoryProvider", () => {
  it("normalizes GeckoTerminal OHLCV rows and verified pool metadata", async () => {
    const rows = [
      [at("2026-08-20T10:05:00.000Z"), 82.2, 82.5, 82.1, 82.4, 120],
      [at("2026-08-20T10:00:00.000Z"), 82, 82.3, 81.9, 82.2, 100],
    ];
    const fetchFn = vi.fn<typeof fetch>(async () => response(rows));
    const provider = new GeckoTerminalHistoryProvider({ fetchFn, maxPages: 1, retryDelaysMs: [] });

    const result = await provider.getHistory(baseRequest);

    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]).toMatchObject({
      provider: "gecko-terminal",
      symbol: "SOL",
      quoteSymbol: "USDC",
      resolution: "5m",
      open: 82,
      close: 82.2,
      volume: 100,
      sourceMarket: `solana:${GECKOTERMINAL_POOLS.SOL_USDC}`,
    });
    expect(result.meta.provider).toBe("gecko-terminal");
    expect(decodeURIComponent(String(fetchFn.mock.calls[0]?.[0]))).toContain(
      `/pools/${GECKOTERMINAL_POOLS.SOL_USDC}/ohlcv/minute`
    );
  });

  it("builds 30-minute candles from two 15-minute rows", async () => {
    const rows = [
      [at("2026-08-20T10:15:00.000Z"), 82.2, 82.8, 82.1, 82.6, 120],
      [at("2026-08-20T10:00:00.000Z"), 82, 82.4, 81.9, 82.2, 100],
    ];
    const fetchFn = vi.fn<typeof fetch>(async () => response(rows));
    const provider = new GeckoTerminalHistoryProvider({ fetchFn, maxPages: 1, retryDelaysMs: [] });

    const result = await provider.getHistory({ ...baseRequest, resolution: "30m" });

    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]).toMatchObject({ open: 82, high: 82.8, low: 81.9, close: 82.6, volume: 220 });
    const url = decodeURIComponent(String(fetchFn.mock.calls[0]?.[0]));
    expect(url).toContain("/ohlcv/minute");
    expect(url).toContain("aggregate=15");
  });

  it("rejects a pool response that does not contain USDC", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          data: { attributes: { ohlcv_list: [[at("2026-08-20T10:00:00.000Z"), 82, 83, 81, 82, 100]] } },
          meta: { base: { address: MINTS.SOL }, quote: { address: "not-usdc" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const provider = new GeckoTerminalHistoryProvider({ fetchFn, maxPages: 1, retryDelaysMs: [] });

    await expect(provider.getHistory(baseRequest)).rejects.toThrow("not paired with USDC");
  });

  it("fails cleanly when GeckoTerminal has no history", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response([]));
    const provider = new GeckoTerminalHistoryProvider({ fetchFn, maxPages: 1, retryDelaysMs: [] });

    await expect(provider.getHistory(baseRequest)).rejects.toThrow("No GeckoTerminal OHLCV history");
  });

  it("surfaces provider rate limits without retrying aggressively", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ status: { error_code: 429, error_message: "rate limited" } }),
        { status: 429, headers: { "content-type": "application/json" } }
      )
    );
    const provider = new GeckoTerminalHistoryProvider({ fetchFn, maxPages: 1, retryDelaysMs: [] });

    await expect(provider.getHistory(baseRequest)).rejects.toThrow("status 429: rate limited");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("retries a temporary GeckoTerminal 429 with bounded backoff", async () => {
    const rows = [[at("2026-08-20T10:00:00.000Z"), 82, 83, 81, 82, 100]];
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(response(rows));
    const provider = new GeckoTerminalHistoryProvider({ fetchFn, maxPages: 1, retryDelaysMs: [0] });

    await expect(provider.getHistory(baseRequest)).resolves.toMatchObject({
      candles: [expect.objectContaining({ open: 82, close: 82 })],
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent provider error", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ status: { error_code: 400, error_message: "invalid pool" } }),
        { status: 400, headers: { "content-type": "application/json" } }
      )
    );
    const provider = new GeckoTerminalHistoryProvider({ fetchFn, maxPages: 1, retryDelaysMs: [0, 0] });

    await expect(provider.getHistory(baseRequest)).rejects.toThrow("status 400: invalid pool");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
