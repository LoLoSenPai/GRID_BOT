import { describe, expect, it } from "vitest";
import type { HistoricalCandle } from "../domain/types";
import { PortfolioPolicyReplayService, type PortfolioPolicyReplayRequest } from "../services/portfolio-policy-replay-service";
import type { PortfolioPolicyDecision } from "../services/portfolio-policy-service";
import { SHADOW_GRID_CANDIDATE_VERSION } from "../services/shadow-grid-candidate-service";

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
      expect(candidateSet.version).toBe(SHADOW_GRID_CANDIDATE_VERSION);
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

  it("shares one candle stream across funded bands and keeps ownership of each fill", () => {
    const market = series("BTC", [110, 110]);
    market.candles = market.candles.map(c => ({ ...c, open: 110, high: 120, low: 45, close: 110 }));
    const first = { ...request().allocations[0]!, bandId: "upper", strategy: "accumulate_usdc" as const,
      series: market, initialBudgetUsd: 200, lowPrice: 90, highPrice: 110, levelCount: 3 };
    const second = { ...first, bandId: "lower", lowPrice: 50, highPrice: 70 };
    const result = new PortfolioPolicyReplayService().replay(request({ allocations: [first, second],
      totalStartingCapitalUsd: 400, adaptive: false, feeBps: 0 }));
    expect(result.points).toHaveLength(2);
    expect(result.closedCycles).toBe(8);
    expect(result.trades.filter(t => t.side === "buy")).toHaveLength(8);
    expect(result.trades.filter(t => t.bandId === "upper" && t.side === "sell")).toHaveLength(4);
    expect(result.trades.filter(t => t.bandId === "lower" && t.side === "sell")).toHaveLength(4);
    expect(result.endingBands.map(b => b.idleQuoteUsd)).toEqual([200, 200]);
    expect(result.endingCashUsd).toBeCloseTo(400 + result.realizedProfitUsd, 8);
  });

  it("adds each closed candle once to the policy prefix despite multiple bands", () => {
    const allocation = { ...request().allocations[0]!, series: series("BTC", [100, 100, 100]) };
    const seen: number[] = [];
    new PortfolioPolicyReplayService().replay(request({ allocations: [allocation, { ...allocation }],
      totalStartingCapitalUsd: 1000, candidateSelector: ({ candles }) => { seen.push(candles.length); return "keep"; } }));
    expect(seen).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it("applies a recorded intervention at t0 before any fill and preserves seeded exits", () => {
    const allocation = { ...request().allocations[0]!, bandId: "live-btc", lowPrice: 95, highPrice: 105,
      initialIdleQuoteUsd: 400, initialLots: [{ kind: "trading" as const, entryPrice: 90, remainingBaseAmount: 1.2,
        costQuote: 100, exitPrice: 108, entrySpacing: 5, economicRule: "accumulate_usdc" as const }],
      series: series("BTC", [100, 110]) };
    const park: PortfolioPolicyDecision = { action: "park", reason: "Recorded choice", nextLowPrice: null,
      nextHighPrice: null, nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null };
    const result = new PortfolioPolicyReplayService().replay(request({ allocations: [allocation],
      totalStartingCapitalUsd: 500, feeBps: 0, adaptive: false, initialIntervention: {
        bandId: "live-btc", observedAt: allocation.series.candles[0]!.timestamp, decision: park, candidateId: "park_0" } }));
    expect(result.initialPoint.cashUsd).toBe(400);
    expect(result.initialPoint.equityUsd).toBe(520);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ candidateId: "park_0", timestamp: allocation.series.candles[0]!.timestamp });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ side: "sell", baseAmount: 1.2 });
    expect(result.closedCycles).toBe(1);
    expect(result.endingLots[0]).toMatchObject({ exitPrice: 108, entrySpacing: 5, economicRule: "accumulate_usdc" });
    expect(result.endingBands[0]!.status).toBe("parked");
  });

  it("charges a t0 new band to free cash and rejects an unfunded intervention", () => {
    const allocation = { ...request().allocations[0]!, bandId: "old", series: series("BTC", [100, 100]) };
    const create: PortfolioPolicyDecision = { action: "create_band", reason: "Recorded lower range", nextLowPrice: null,
      nextHighPrice: null, nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null,
      candidate: { lowPrice: 50, highPrice: 60, levelCount: 3, spacing: 5, requestedCapitalUsd: 100 } };
    const input = request({ allocations: [allocation], totalStartingCapitalUsd: 600, freeCashUsd: 100,
      adaptive: false, feeBps: 0, initialIntervention: { bandId: "old", observedAt: allocation.series.candles[0]!.timestamp, decision: create } });
    const result = new PortfolioPolicyReplayService().replay(input);
    expect(result.endingBands).toHaveLength(2);
    expect(result.endingBands.map(b => b.allocatedCapitalUsd)).toEqual([500, 100]);
    expect(result.endingCashUsd).toBe(600);
    expect(result.endingEquityUsd).toBe(600);
    expect(() => new PortfolioPolicyReplayService().replay({ ...input, freeCashUsd: 0, totalStartingCapitalUsd: 500 }))
      .toThrow(/cannot fund/);
  });

  it("continues with the deterministic policy after t0 and never leaks a changed future suffix", () => {
    const allocation = { ...request().allocations[0]!, bandId: "current", series: series("BTC", [100, 100, 100, 100]),
      warmupCandles: series("BTC", Array(20).fill(100)).candles.map(c => ({ ...c, timestamp: new Date(+c.timestamp - 20 * 3_600_000) })) };
    const park: PortfolioPolicyDecision = { action: "park", reason: "Initial recorded decision", nextLowPrice: null,
      nextHighPrice: null, nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null };
    const input = request({ allocations: [allocation], totalStartingCapitalUsd: 500, initialIntervention: {
      bandId: "current", observedAt: allocation.series.candles[0]!.timestamp, decision: park } });
    const first = new PortfolioPolicyReplayService().replay(input);
    const changed = new PortfolioPolicyReplayService().replay({ ...input,
      allocations: [{ ...allocation, series: series("BTC", [100, 100, 50, 150]) }] });
    expect(first.actions[0]!.action).toBe("park");
    expect(first.actions[1]).toMatchObject({ action: "reactivate", timestamp: new Date(+allocation.series.candles[0]!.timestamp + 3_600_000) });
    expect(first.points.slice(0, 2)).toEqual(changed.points.slice(0, 2));
    expect(first.actions.filter(a => +a.timestamp <= +first.points[1]!.timestamp))
      .toEqual(changed.actions.filter(a => +a.timestamp <= +first.points[1]!.timestamp));
    expect(() => new PortfolioPolicyReplayService().replay({ ...input,
      initialIntervention: { ...input.initialIntervention!, observedAt: new Date(+allocation.series.candles[0]!.timestamp + 1) } }))
      .toThrow(/at replay t0/);
  });

  it("exposes fees separately from open lot cost and reconciles constant-price equity", () => {
    const allocation = { ...request().allocations[0]!, initialPreviousPrice: 110,
      lowPrice: 100, highPrice: 120, levelCount: 2, baseDecimals: 6, series: series("BTC", [100, 100]) };
    allocation.series.candles = allocation.series.candles.map(c => ({ ...c, open: 100, high: 100, low: 100, close: 100 }));
    const result = new PortfolioPolicyReplayService().replay(request({ allocations: [allocation], totalStartingCapitalUsd: 500,
      adaptive: false, feeBps: 100, slippageBps: 100, nativeFeeUsd: 1 }));
    expect(result.trades).toHaveLength(1);
    expect(result.feesUsd).toBeCloseTo(5.99);
    expect(result.endingTradingCostUsd).toBe(500);
    expect(result.endingEquityUsd).toBeCloseTo(result.initialPoint.equityUsd - result.feesUsd - result.slippageCostUsd - result.roundingCostUsd, 8);
  });

  it("rejects mismatching same-asset data, mints, duplicate IDs and candle gaps", () => {
    const allocation = { ...request().allocations[0]!, bandId: "a", baseMint: "btc-mint", series: series("BTC", [100, 100, 100]) };
    const peer = { ...allocation, bandId: "b" };
    const run = (other: typeof peer) => new PortfolioPolicyReplayService().replay(request({ allocations: [allocation, other], totalStartingCapitalUsd: 1000 }));
    expect(() => run({ ...peer, baseMint: "other-mint" })).toThrow(/mint/);
    expect(() => run({ ...peer, series: series("BTC", [100, 101, 100]) })).toThrow(/identical market/);
    expect(() => run({ ...peer, bandId: "a" })).toThrow(/unique/);
    const gapped = structuredClone(peer);
    gapped.series.candles[1]!.timestamp = new Date(+gapped.series.candles[1]!.timestamp + 1000);
    expect(() => run(gapped)).toThrow(/contiguous/);
  });

  it("rejects unaccounted initial capital and future warmup instead of silently dropping them", () => {
    const allocation = { ...request().allocations[0]!, initialIdleQuoteUsd: 490, series: series("BTC", [100, 100]) };
    const input = request({ allocations: [allocation], totalStartingCapitalUsd: 500, adaptive: false });
    expect(() => new PortfolioPolicyReplayService().replay(input)).toThrow(/must equal assigned capital/);
    const declared = { ...allocation, initialRealizedLossUsd: 10 };
    expect(new PortfolioPolicyReplayService().replay({ ...input, allocations: [declared] }).initialPoint.cashUsd).toBe(490);
    expect(() => new PortfolioPolicyReplayService().replay({ ...input, allocations: [{ ...declared,
      warmupCandles: declared.series.candles }] })).toThrow(/closed prefix/);
  });
});
