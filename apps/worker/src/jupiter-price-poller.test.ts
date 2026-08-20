import { afterEach, describe, expect, it, vi } from "vitest";

import type { MarketPrice } from "@grid-bot/core";

import { JupiterPricePoller } from "./jupiter-price-poller";

const prices: MarketPrice[] = [
  {
    symbol: "SOL",
    pair: "SOL/USDC",
    price: 82,
    confidence: 0,
    source: "jupiter-price-v3",
    timestamp: new Date("2026-08-20T10:00:00.000Z"),
    feedId: "sol-mint",
  },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("JupiterPricePoller", () => {
  it("fetches one global batch and forwards the fresh prices", async () => {
    const fetchLatestPrices = vi.fn().mockResolvedValue(prices);
    const onPrices = vi.fn();
    const poller = new JupiterPricePoller({ fetchLatestPrices }, onPrices, 60_000);

    poller.start();

    await vi.waitFor(() => expect(onPrices).toHaveBeenCalledWith(prices));
    expect(fetchLatestPrices).toHaveBeenCalledOnce();
    expect(fetchLatestPrices).toHaveBeenCalledWith(["SOL", "BTC", "HYPE"], "USDC");
    poller.stop();
  });

  it("backs off after a temporary failure and resumes on the next successful batch", async () => {
    vi.useFakeTimers();
    const fetchLatestPrices = vi.fn().mockRejectedValueOnce(new Error("temporary outage")).mockResolvedValue(prices);
    const onPrices = vi.fn();
    const poller = new JupiterPricePoller({ fetchLatestPrices }, onPrices, 1_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLatestPrices).toHaveBeenCalledOnce();
    expect(onPrices).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchLatestPrices).toHaveBeenCalledTimes(2);
    expect(onPrices).toHaveBeenCalledWith(prices);
    poller.stop();
  });
});
