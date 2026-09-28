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
  it("seeds an existing lot with its original exit target and reserved book capital", () => {
    const allocation = { ...request().allocations[0]!, lowPrice: 50, highPrice: 150, levelCount: 2,
      series: series("BTC", Array(22).fill(100).concat([105, 110])),
      initialIdleQuoteUsd: 400, initialLots: [{ kind: "trading" as const, entryPrice: 90,
        remainingBaseAmount: 1.2, costQuote: 100, exitPrice: 108, entrySpacing: 5 }] };
    const result = new PortfolioPolicyReplayService().replay(request({ allocations: [allocation],
      totalStartingCapitalUsd: 500, adaptive: false }));
    expect(result.closedCycles).toBe(1);
    expect(result.retainedBaseByAsset.BTC).toBeGreaterThan(0);
    expect(result.endingCashUsd).toBeGreaterThanOrEqual(500);
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

  it("selects a validated shadow candidate causally and records its identity", () => {
    const prefixes: number[] = [];
    const result = new PortfolioPolicyReplayService().replay(request({ allocations: [{ ...request().allocations[0]!, lowPrice: 95, highPrice: 105, series: series("BTC", Array(24).fill(100)) }], totalStartingCapitalUsd: 500, candidateSelector: ({ policyInput, objective, candidateSet, candles, candidates }) => {
      prefixes.push(candles.length);
      expect(policyInput.candles).toEqual(candles);
      expect(objective).toBe("accumulate_base");
      expect(candidateSet.version).toBe("shadow-grid-candidates-v2");
      return candidates[0]!.id;
    } }));

    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.every((length, index) => index === 0 || length >= prefixes[index - 1]!)).toBe(true);
    expect(result.actions.some((action) => action.candidateId !== undefined)).toBe(true);
  });

  it("rejects an unknown candidate selected by the hook", () => {
    expect(() => new PortfolioPolicyReplayService().replay(request({ candidateSelector: () => "missing" })))
      .toThrow(/unknown candidate ID/);
  });

  it("isolates replay accounting from mutations inside the selector", () => {
    const baseline = new PortfolioPolicyReplayService().replay(request({ candidateSelector: ({ candidates }) => candidates[0]!.id }));
    const mutated = new PortfolioPolicyReplayService().replay(request({ candidateSelector: ({ policyInput, candidates }) => {
      policyInput.band.idleQuoteUsd = 0;
      policyInput.candles.at(-1)!.close = 1;
      candidates[0]!.lowPrice = 1;
      return candidates[0]!.id;
    } }));
    expect(mutated.endingEquityUsd).toBe(baseline.endingEquityUsd);
    expect(mutated.endingCashUsd).toBe(baseline.endingCashUsd);
  });

  it("can choose KEEP or a revise candidate from the same initial capital", () => {
    const allocation = { ...request().allocations[0]!, lowPrice: 95, highPrice: 105,
      series: series("BTC", Array(20).fill(100).concat([101, 102, 103, 104])) };
    let policySeen = false;
    const choose = (mode: "keep" | "policy") => ({ candidates }: { candidates: readonly { id: string; decision: import("../services/portfolio-policy-service").PortfolioPolicyDecision }[] }) => {
      if (candidates.some((candidate) => candidate.id === "policy")) policySeen = true;
      return mode === "policy" && candidates.some((candidate) => candidate.id === "policy") ? "policy" : candidates[0]!.id;
    };
    const keep = new PortfolioPolicyReplayService().replay({ ...request({ allocations: [allocation], totalStartingCapitalUsd: 500 }), candidateSelector: choose("keep") });
    const revised = new PortfolioPolicyReplayService().replay({ ...request({ allocations: [allocation], totalStartingCapitalUsd: 500 }), candidateSelector: choose("policy") });
    expect(policySeen).toBe(true);
    expect(revised.points.at(-1)!.equityUsd).not.toBe(keep.points.at(-1)!.equityUsd);
  });
});
