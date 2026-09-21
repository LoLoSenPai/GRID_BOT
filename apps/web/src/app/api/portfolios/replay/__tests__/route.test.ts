import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: { username: "operator" } as { username: string } | null,
  loadHistory: vi.fn(), initialEnvelope: vi.fn(), compare: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ readSession: async () => mocks.session }));
vi.mock("../../history", () => ({ loadPortfolioHistory: mocks.loadHistory }));
vi.mock("@grid-bot/core", () => ({
  DEFAULT_PORTFOLIO_POLICY: { persistenceClosedBars: 3, cooldownMs: 1 },
  initialPortfolioEnvelope: mocks.initialEnvelope,
  PortfolioPolicyReplayService: class { compare = mocks.compare; },
}));

import { POST } from "../route";

beforeEach(() => {
  mocks.session = { username: "operator" };
  mocks.loadHistory.mockReset().mockImplementation(async (symbol: string, from: Date, to: Date) => history(symbol, from, to));
  mocks.initialEnvelope.mockReset().mockReturnValue({ lowPrice: 90, highPrice: 110, levelCount: 5 });
  mocks.compare.mockReset().mockReturnValue({ fixed: result(4001), adaptive: result(4002) });
});

describe("portfolio replay route", () => {
  it("uses separate 80h warmup and frozen 14d evaluation inputs for both scenarios", async () => {
    const response = await POST(request({ totalCapitalUsd: 4000, baseAllocationUsd: 1000, days: 14 }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(mocks.initialEnvelope).toHaveBeenCalledTimes(2);
    expect(mocks.initialEnvelope.mock.calls.every((call) => call[0].length === 80)).toBe(true);
    const replayRequest = mocks.compare.mock.calls[0]![0];
    expect(replayRequest).toMatchObject({ totalStartingCapitalUsd: 4000, freeCashUsd: 2000,
      feeBps: 10, slippageBps: 50, nativeFeeUsd: 0, minOrderQuoteUsd: 25 });
    expect(replayRequest.allocations).toHaveLength(2);
    expect(replayRequest.allocations.every((allocation: { warmupCandles: unknown[] }) => allocation.warmupCandles.length === 80)).toBe(true);
    expect(replayRequest.allocations.every((allocation: { series: { candles: unknown[] } }) => allocation.series.candles.length === 336)).toBe(true);
    expect(payload.comparison.adaptive.endingEquityUsd).toBe(4002);
    expect(payload.inputs.sources.BTC.warmup).toHaveLength(80);
    expect(payload.inputs.sources.BTC.evaluation).toHaveLength(336);
    expect(payload.assumptions.join(" ")).toContain("exploratory paper comparison");
  });

  it("rejects a movable evaluation window and invalid equal-capital baseline", async () => {
    expect((await POST(request({ totalCapitalUsd: 4000, baseAllocationUsd: 1000, days: 7 }))).status).toBe(400);
    expect((await POST(request({ totalCapitalUsd: 1500, baseAllocationUsd: 1000, days: 14 }))).status).toBe(400);
    expect(mocks.loadHistory).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    mocks.session = null;
    expect((await POST(request({ totalCapitalUsd: 4000, baseAllocationUsd: 1000, days: 14 }))).status).toBe(401);
  });

  it("rejects stale cached history before running the comparison", async () => {
    mocks.loadHistory.mockImplementation(async (symbol: string, from: Date, to: Date) => ({
      ...history(symbol, from, to), meta: { ...history(symbol, from, to).meta, stale: symbol === "SOL" },
    }));
    const response = await POST(request({ totalCapitalUsd: 4000, baseAllocationUsd: 1000, days: 14 }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("stale");
    expect(mocks.compare).not.toHaveBeenCalled();
  });
});

function request(body: unknown) {
  return new Request("http://localhost/api/portfolios/replay", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function history(symbol: string, from: Date, to: Date) {
  const count = Math.round((to.getTime() - from.getTime()) / 3_600_000);
  return { candles: Array.from({ length: count }, (_, index) => {
    const openTime = new Date(from.getTime() + index * 3_600_000);
    return { provider: "public-test", symbol, quoteSymbol: "USDC", resolution: "1h", sourceMarket: `pool:${symbol}`,
      openTime, closeTime: new Date(+openTime + 3_600_000), open: 100, high: 101, low: 99, close: 100,
      volume: 1, fetchedAt: to };
  }), meta: { provider: "public-test", sourceMarket: `pool:${symbol}`, fetchedAt: to } };
}

function result(endingEquityUsd: number) {
  return { endingEquityUsd, endingCashUsd: 4000, endingTradingCostUsd: 0,
    retainedBaseByAsset: {}, closedCycles: 0, points: [], actions: [], policyParameters: {} };
}
