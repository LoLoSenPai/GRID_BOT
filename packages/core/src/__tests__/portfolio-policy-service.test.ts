import { describe, expect, it } from "vitest";
import { blocksDuplicateEntry, evaluatePortfolioPolicy, prioritizeAssetAllocation, type PortfolioPolicyInput, type PolicyCandle } from "../services/portfolio-policy-service";

const now = new Date("2026-09-21T12:00:00Z"); const interval = 3_600_000;
const params = { persistenceClosedBars: 2, cooldownMs: interval, maxDailyRevisions: 2, atrMultiplier: 1, realizedVolMultiplier: 1, amplitudeMultiplier: 1, minWidthPct: 4, maxWidthPct: 12, minUsefulOrderUsd: 25, maxBands: 3, maxLevels: 8, maxExposurePct: 90, lowerBandOffsetPct: 2, lowerBandWidthPct: 8, minimumSpacingPct: 1 };
function candles(close: number, count = 24): PolicyCandle[] { return Array.from({ length: count }, (_, i) => { const t = new Date(now.getTime() - (count - i) * interval); return { openedAt: new Date(t.getTime() - interval), closedAt: t, open: close, high: close * 1.01, low: close * .99, close }; }); }
function input(overrides: Partial<PortfolioPolicyInput> = {}): PortfolioPolicyInput { return { now, price: 100, assetSymbol: "BTC", band: { id: "btc-main", lowPrice: 90, highPrice: 110, levelCount: 5, spacing: 5, status: "active", allocatedCapitalUsd: 500, idleQuoteUsd: 100, openTradingLots: [] }, bandCount: 1, assetAttributedCapitalUsd: 500, candles: candles(100), candleIntervalMs: interval, maxCandleAgeMs: interval * 2, availableCashUsd: 200, totalPortfolioCapitalUsd: 1_000, parameters: params, ...overrides }; }

describe("portfolio policy", () => {
  it("adapts with an old lot outside the new envelope and no additional free capital", () => {
    const result = evaluatePortfolioPolicy(input({ price: 80, candles: candles(80), availableCashUsd: 0,
      assetAttributedCapitalUsd: 1000, band: { ...input().band, openTradingLots: [{ entryPrice: 100, costQuote: 100, remainingBaseAmount: 1 }] } }));
    expect(result.action).toBe("revise");
    expect(result.nextHighPrice).toBeLessThan(100);
  });
  it("allows unoccupied future rails even with a lot in the candidate range", () => {
    const result = evaluatePortfolioPolicy(input({ band: { ...input().band, spacing: 1,
      openTradingLots: [{ entryPrice: 100, costQuote: 100, remainingBaseAmount: 1 }] } }));
    expect(result.action).toBe("revise");
  });
  it("ignores future candles and cannot use them to satisfy the history minimum", () => {
    const prefix = candles(100).slice(-19);
    const future = { ...prefix.at(-1)!, openedAt: now, closedAt: new Date(+now + interval) };
    expect(evaluatePortfolioPolicy(input({ candles: [...prefix, future, { ...future, closedAt: new Date(+now + 2 * interval) }] })).reason).toContain("Incomplete");
    expect(evaluatePortfolioPolicy(input({ candles: [...candles(100), future] }))).toEqual(evaluatePortfolioPolicy(input()));
  });
  it("rejects invalid, future, stale and incomplete data", () => {
    expect(evaluatePortfolioPolicy(input({ price: Number.NaN })).action).toBe("wait");
    expect(evaluatePortfolioPolicy(input({ candles: candles(100).slice(0, 19) })).reason).toContain("Incomplete");
    const broken = candles(100); broken[10] = { ...broken[10]!, closedAt: new Date(broken[10]!.closedAt.getTime() + interval * 2), openedAt: new Date(broken[10]!.openedAt.getTime() + interval * 2) };
    expect(evaluatePortfolioPolicy(input({ candles: broken })).reason).toContain("contiguous");
    expect(evaluatePortfolioPolicy(input({ candles: candles(100).map((c) => ({ ...c, closedAt: new Date(c.closedAt.getTime() - interval * 5), openedAt: new Date(c.openedAt.getTime() - interval * 5) })) })).reason).toContain("stale");
  });
  it("requires contiguous same-side bars outside, then revises", () => {
    const outside = candles(120).map((c) => ({ ...c, close: 120, open: 120, high: 121, low: 119 }));
    expect(evaluatePortfolioPolicy(input({ price: 120, candles: outside.slice(0, -1).concat({ ...outside.at(-1)!, close: 100 }) })).action).toBe("wait");
    expect(evaluatePortfolioPolicy(input({ price: 120, candles: outside }))).toMatchObject({ action: "revise", nextLowPrice: expect.any(Number) });
  });
  it("adapts inside the range when volatility or center changes", () => {
    const history = candles(100).map((c, i) => i < 12 ? c : { ...c, open: 104, high: 110, low: 98, close: 104 });
    expect(evaluatePortfolioPolicy(input({ price: 104, candles: history }))).toMatchObject({ action: "revise" });
  });
  it("keeps old commitments external and creates a lower envelope containing current price", () => {
    const result = evaluatePortfolioPolicy(input({ price: 80, band: { ...input().band, idleQuoteUsd: 0, commitments: [{ lowPrice: 98, highPrice: 102 }], openTradingLots: [{ entryPrice: 100, remainingBaseAmount: 1, costQuote: 100 }] }, candles: candles(80) }));
    expect(result.action).toBe("create_band"); expect(result.protectedLowPrice).toBe(98); expect(result.candidate!.lowPrice).toBeLessThan(80); expect(result.candidate!.highPrice).toBeGreaterThan(80);
  });
  it("waits rather than creating or parking on cooldown, daily limit, or insufficient funds", () => {
    const base = { price: 80, candles: candles(80), band: { ...input().band, idleQuoteUsd: 0, commitments: [{ lowPrice: 98, highPrice: 102 }], openTradingLots: [{ entryPrice: 100, remainingBaseAmount: 1, costQuote: 100 }] } };
    expect(evaluatePortfolioPolicy(input({ ...base, band: { ...base.band, lastRevisionAt: now } })).action).toBe("wait");
    expect(evaluatePortfolioPolicy(input({ ...base, band: { ...base.band, revisionsToday: 2 } })).action).toBe("wait");
    expect(evaluatePortfolioPolicy(input({ ...base, availableCashUsd: 1 })).action).toBe("park");
  });
  it("enforces resulting asset exposure and band count", () => {
    const base = { price: 80, candles: candles(80), band: { ...input().band, idleQuoteUsd: 0, commitments: [{ lowPrice: 98, highPrice: 102 }], openTradingLots: [{ entryPrice: 100, remainingBaseAmount: 1, costQuote: 100 }] } };
    expect(evaluatePortfolioPolicy(input({ ...base, bandCount: 3 })).action).toBe("park");
    expect(evaluatePortfolioPolicy(input({ ...base, assetAttributedCapitalUsd: 990 })).action).toBe("park");
  });
  it("blocks duplicate entry near an open lot and prioritizes the least funded asset", () => {
    expect(blocksDuplicateEntry({ oldEntryPrice: 100, currentPrice: 102, widerSpacing: 6, openTradingLot: true })).toBe(true);
    expect(blocksDuplicateEntry({ oldEntryPrice: 100, currentPrice: 102, widerSpacing: 6, openTradingLot: false })).toBe(false);
    expect(prioritizeAssetAllocation([{ assetSymbol: "SOL", historicalAllocatedCapitalUsd: 300, idleAssignedCapitalUsd: 100, initialTargetUsd: 500 }, { assetSymbol: "BTC", historicalAllocatedCapitalUsd: 100, idleAssignedCapitalUsd: 50, initialTargetUsd: 500 }]).map((a) => a.assetSymbol)).toEqual(["BTC", "SOL"]);
  });
});

