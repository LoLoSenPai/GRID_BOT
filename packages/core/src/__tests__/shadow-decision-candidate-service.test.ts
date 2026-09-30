import { describe, expect, it } from "vitest";
import { buildShadowDecisionCandidates } from "../services/shadow-decision-candidate-service";
import { DEFAULT_PORTFOLIO_POLICY, type PortfolioPolicyInput, type PortfolioPolicyDecision } from "../services/portfolio-policy-service";
import { buildShadowGridCandidates } from "../services/shadow-grid-candidate-service";
import type { ShadowObservedCostProfile } from "../services/shadow-observed-cost-service";

const now = new Date("2026-09-28T12:00:00Z"), HOUR = 3_600_000;
const wait: PortfolioPolicyDecision = { action: "wait", reason: "Wait", nextLowPrice: null, nextHighPrice: null,
  nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null };
function fixture(symbol = "SOL") {
  const price = symbol === "BTC" ? 60_000 : 100, amount = 100 / price;
  const policyInput: PortfolioPolicyInput = { now, price, assetSymbol: symbol,
    band: { id: "band", lowPrice: price * 0.9, highPrice: price * 1.1, levelCount: 5, spacing: price * 0.05,
      status: "active", allocatedCapitalUsd: 500, idleQuoteUsd: 400, openTradingLots: [{ entryPrice: price * 0.8,
        remainingBaseAmount: amount, costQuote: 100, kind: "trading" }] }, bandCount: 1, assetAttributedCapitalUsd: 500,
    availableCashUsd: 200, totalPortfolioCapitalUsd: 1000, candleIntervalMs: HOUR, maxCandleAgeMs: HOUR * 2,
    indicators: { atrPct: 1 }, parameters: { ...DEFAULT_PORTFOLIO_POLICY, minWidthPct: 6, minUsefulOrderUsd: 25 },
    candles: Array.from({ length: 80 }, (_, i) => ({ openedAt: new Date(+now + (i - 80) * HOUR),
      closedAt: new Date(+now + (i - 79) * HOUR), open: price, high: price * 1.015, low: price * 0.985, close: price })) };
  const replaySnapshot = { schemaVersion: "shadow-replay-v3", strategies: [{ bands: [{ id: "band",
    bot: { id: "bot", baseMint: "base", quoteMint: "quote", baseDecimals: symbol === "BTC" ? 8 : 9,
      positionLots: [{ id: "lot", kind: "trading", closedAt: null, remainingBaseAmount: String(amount), costQuote: "100" }] },
    exitCommitments: [{ lotId: "lot", targetStatus: "KNOWN", fulfilledAt: null, sellTargetPrice: price * 1.1,
      economicRule: symbol === "BTC" ? "accumulate_base" : "accumulate_usdc" }] }] }] };
  const costProfile = { version: "shadow-observed-cost-v1", asOf: now.toISOString(), windowStart: new Date(+now - HOUR).toISOString(),
    portfolioId: "portfolio", botId: "bot", assetSymbol: symbol, baseMint: "base", quoteMint: "quote",
    notionalBucket: { minUsd: 25, maxUsd: 500 }, count: 8, usable: true, feeBps: 2,
    adverseSlippageBps: 2, p90NativeFeeUsd: 0.005, safetyMarginBps: 2, coverageWarnings: [] } as unknown as ShadowObservedCostProfile;
  return { policyInput, proposedDecision: wait, replaySnapshot, costProfile };
}
describe("V4 shadow decisions", () => {
  it("is reproducible and immutable, with exact fixed baselines and experimental finer grids", () => {
    const input = fixture(), saved = structuredClone(input), result = buildShadowDecisionCandidates(input);
    expect(input).toEqual(saved); expect(result).toEqual(buildShadowDecisionCandidates(input));
    expect(result.grid.candidates.length).toBeLessThanOrEqual(6);
    expect(result.grid.candidates[0]).toEqual(buildShadowGridCandidates(input.policyInput, wait).candidates[0]);
    const narrower = result.grid.candidates.find(c => c.id === "v4_donchian_robust")!;
    expect(narrower, JSON.stringify(result.grid)).toBeDefined();
    expect(narrower.highPrice - narrower.lowPrice).toBeLessThan(input.policyInput.price * 0.06);
    expect(narrower.currentlyPolicyEligible).toBe(false);
    expect(narrower.strategyParameters?.live_validity).toBe("unvalidated");
    expect(result.exit.candidates.map(c => c.id)).toEqual(["keep", "closer", "farther"]);
  });
  it("falls back exactly to legacy candidates if observed cost coverage is missing", () => {
    const input = { ...fixture(), costProfile: null };
    const result = buildShadowDecisionCandidates(input);
    expect(result.grid).toEqual(buildShadowGridCandidates(input.policyInput, wait));
    expect(result.exit.candidates.map(c => c.id)).toEqual(["keep"]);
  });
  it("prices minimum economic gains after fees and meaningful BTC retention at precision", () => {
    for (const symbol of ["SOL", "BTC"]) {
      const input = fixture(symbol), result = buildShadowDecisionCandidates(input);
      for (const candidate of result.exit.candidates) for (const update of candidate.updates) {
        const p = input.costProfile, scale = 10 ** (symbol === "BTC" ? 8 : 9);
        const unit = update.newTargetPrice * (1 - (p.adverseSlippageBps! + p.safetyMarginBps) / 10_000) * (1 - p.feeBps! / 10_000);
        const sold = symbol === "BTC" ? Math.ceil((update.costQuote + p.p90NativeFeeUsd!) / unit * scale) / scale : update.remainingBaseAmount;
        expect(sold * unit - p.p90NativeFeeUsd!).toBeGreaterThanOrEqual(update.costQuote + update.minimumNetGainUsd - 1e-8);
        if (symbol === "BTC") {
          expect(update.minimumRetainedBaseAmount).toBeGreaterThan(1 / scale);
          expect(update.remainingBaseAmount - sold + 1e-12).toBeGreaterThanOrEqual(update.minimumRetainedBaseAmount);
        }
      }
    }
  });
  it("abstains for unknown exits, future profiles and notionals outside their observed bucket", () => {
    const input = fixture(); input.replaySnapshot.strategies[0]!.bands[0]!.exitCommitments[0]!.targetStatus = "UNKNOWN";
    expect(buildShadowDecisionCandidates(input).exit.candidates.map(c => c.id)).toEqual(["keep"]);
    const future = fixture(); future.costProfile.asOf = new Date(+now + 1).toISOString();
    expect(buildShadowDecisionCandidates(future).exit.candidates.map(c => c.id)).toEqual(["keep"]);
    const outside = fixture(); outside.replaySnapshot.strategies[0]!.bands[0]!.bot.positionLots[0]!.costQuote = "1000";
    outside.replaySnapshot.strategies[0]!.bands[0]!.bot.positionLots[0]!.remainingBaseAmount = "10";
    expect(buildShadowDecisionCandidates(outside).exit.candidates.map(c => c.id)).toEqual(["keep"]);
  });
  it("allows an explicitly ineligible reserve-funded shadow band at equal capital", () => {
    const input = fixture(); input.policyInput.band.idleQuoteUsd = 0;
    const result = buildShadowDecisionCandidates({ ...input, options: { assetAllocations: [
      { assetSymbol: "SOL", allocatedCapitalUsd: 500 }, { assetSymbol: "BTC", allocatedCapitalUsd: 500 }] } });
    const candidate = result.grid.candidates.find(c => c.id === "v4_reserve_band")!;
    expect(candidate.requestedCapitalUsd).toBeLessThanOrEqual(input.policyInput.availableCashUsd);
    expect(candidate.currentlyPolicyEligible).toBe(false);
    const denied = buildShadowDecisionCandidates({ ...input, options: { assetAllocations: [
      { assetSymbol: "SOL", allocatedCapitalUsd: 500 }, { assetSymbol: "BTC", allocatedCapitalUsd: 400 }] } });
    expect(denied.grid.candidates.some(c => c.id === "v4_reserve_band")).toBe(false);
  });
});
