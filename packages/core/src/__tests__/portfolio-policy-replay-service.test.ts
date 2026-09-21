import { describe, expect, it } from "vitest";
import type { HistoricalCandle } from "../domain/types";
import { PortfolioPolicyReplayService, type PortfolioPolicyReplayRequest } from "../services/portfolio-policy-replay-service";

const params = { persistenceClosedBars: 2, cooldownMs: 0, maxDailyRevisions: 5, atrMultiplier: 1, realizedVolMultiplier: 1, amplitudeMultiplier: 1, minWidthPct: 4, maxWidthPct: 12, minUsefulOrderUsd: 10, maxBands: 3, maxLevels: 6, maxExposurePct: 100, lowerBandOffsetPct: 2, lowerBandWidthPct: 8, minimumSpacingPct: 1 };
function series(symbol: string, values: number[]): { symbol: string; pair: string; candles: HistoricalCandle[] } { return { symbol, pair: `${symbol}/USDC`, candles: values.map((close, i) => ({ timestamp: new Date(Date.UTC(2026, 0, 1, i)), open: close, high: close * 1.01, low: close * .99, close })) }; }
function request(overrides: Partial<PortfolioPolicyReplayRequest> = {}): PortfolioPolicyReplayRequest { return { allocations: [{ assetSymbol: "BTC", series: series("BTC", Array(20).fill(100).concat([90, 120, 120, 120])), initialBudgetUsd: 500, lowPrice: 90, highPrice: 110, levelCount: 5, strategy: "accumulate_base" }, { assetSymbol: "SOL", series: series("SOL", Array(24).fill(20)), initialBudgetUsd: 500, lowPrice: 18, highPrice: 22, levelCount: 5, strategy: "accumulate_usdc" }], totalStartingCapitalUsd: 1000, freeCashUsd: 0, policyParameters: params, feeBps: 10, minOrderQuoteUsd: 25, ...overrides }; }

describe("PortfolioPolicyReplayService", () => {
  it("replays multiple assets with shared nonnegative cash and equal starting capital", () => {
    const result = new PortfolioPolicyReplayService().replay(request());
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points.every((point) => point.cashUsd >= -1e-8)).toBe(true);
    expect(result.policyParameters).toEqual(params);
  });
  it("keeps old lot exits active after the current band moves outside them", () => {
    const result = new PortfolioPolicyReplayService().replay(request({ allocations: [request().allocations[0]!] , totalStartingCapitalUsd: 500 }));
    expect(result.closedCycles).toBeGreaterThan(0);
  });
  it("does not use future candles when deciding the prefix", () => {
    const base = Array(24).fill(100);
    const first = new PortfolioPolicyReplayService().replay(request({ allocations: [{ ...request().allocations[0]!, series: series("BTC", base) }], totalStartingCapitalUsd: 500 }));
    const future = new PortfolioPolicyReplayService().replay(request({ allocations: [{ ...request().allocations[0]!, series: series("BTC", base.slice(0, 20).concat([50, 150, 150, 150])) }], totalStartingCapitalUsd: 500 }));
    expect(first.points.slice(0, 20).map((point) => point.cashUsd)).toEqual(future.points.slice(0, 20).map((point) => point.cashUsd));
  });
  it("runs fixed and adaptive configurations from the same total cash", () => {
    const { fixed, adaptive } = new PortfolioPolicyReplayService().compare(request());
    expect(fixed.actions).toEqual([]);
    expect(adaptive.actions.some(a => a.action === "revise")).toBe(true);
    expect(fixed.policyParameters).toEqual(adaptive.policyParameters);
    expect(fixed.points[0]!.cashUsd).toBe(adaptive.points[0]!.cashUsd);
    expect(fixed.points.at(-1)!.equityUsd).toBeGreaterThan(0);
    expect(adaptive.points.at(-1)!.equityUsd).toBeGreaterThan(0);
  });
  it("charges fees with constant marks and rejects spending unassigned imaginary funds", () => {
    const allocation = { ...request().allocations[0]!, series: series("BTC", Array(24).fill(100)) };
    const result = new PortfolioPolicyReplayService().replay(request({ allocations: [allocation], totalStartingCapitalUsd: 500,
      adaptive: false, feeBps: 100, slippageBps: 100 }));
    expect(result.endingCashUsd).toBeGreaterThanOrEqual(0);
    expect(result.endingEquityUsd).toBeLessThan(500);
    expect(() => new PortfolioPolicyReplayService().replay(request({ totalStartingCapitalUsd: 800 }))).toThrow(/equal total/);
  });
});
