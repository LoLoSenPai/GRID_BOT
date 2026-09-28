import { describe, expect, it } from "vitest";

import { buildShadowGridCandidates, SHADOW_GRID_CANDIDATE_VERSION } from "../services/shadow-grid-candidate-service";
import { evaluatePortfolioPolicy, type PortfolioPolicyInput, type PolicyCandle } from "../services/portfolio-policy-service";

const now = new Date("2026-09-21T12:00:00Z");
const interval = 3_600_000;
const parameters = {
  persistenceClosedBars: 2, cooldownMs: interval, maxDailyRevisions: 2,
  atrMultiplier: 1, realizedVolMultiplier: 1, amplitudeMultiplier: 1,
  minWidthPct: 4, maxWidthPct: 24, minUsefulOrderUsd: 25,
  maxBands: 3, maxLevels: 12, maxExposurePct: 90,
  lowerBandOffsetPct: 2, lowerBandWidthPct: 8, minimumSpacingPct: 1,
  estimatedExecutionFeeBps: 10, estimatedSlippageBps: 50
};

function candles(close: number, count = 24): PolicyCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const closedAt = new Date(now.getTime() - (count - i) * interval);
    return { openedAt: new Date(closedAt.getTime() - interval), closedAt,
      open: close, high: close * 1.01, low: close * 0.99, close };
  });
}

function input(overrides: Partial<PortfolioPolicyInput> = {}): PortfolioPolicyInput {
  return {
    now, price: 104, assetSymbol: "SOL",
    band: { id: "sol-main", lowPrice: 90, highPrice: 110, levelCount: 5, spacing: 5,
      status: "active", allocatedCapitalUsd: 500, idleQuoteUsd: 100, openTradingLots: [] },
    bandCount: 1, assetAttributedCapitalUsd: 500, candles: candles(104),
    candleIntervalMs: interval, maxCandleAgeMs: interval * 2, availableCashUsd: 200,
    totalPortfolioCapitalUsd: 1_000, parameters, ...overrides
  };
}

describe("shadow grid candidate generator", () => {
  it("returns a stable, bounded set with complete replay decisions", () => {
    const policyInput = input({ candles: candles(104) });
    const decision = evaluatePortfolioPolicy(policyInput);
    const first = buildShadowGridCandidates(policyInput, decision);
    const second = buildShadowGridCandidates(policyInput, decision);

    expect(first).toEqual(second);
    expect(first.version).toBe(SHADOW_GRID_CANDIDATE_VERSION);
    expect(first.candidates.length).toBeLessThanOrEqual(6);
    expect(first.candidates[0]).toMatchObject({ id: "keep", kind: "keep", validation: "validated" });
    expect(new Set(first.candidates.map(candidate => candidate.id)).size).toBe(first.candidates.length);
    expect(first.candidates.every(candidate => candidate.decision && candidate.decision.action)).toBe(true);
  });

  it("retains a policy proposal at the maximum center-based envelope width", () => {
    const policyInput = input({ price: 100, parameters: { ...parameters, maxWidthPct: 24 } });
    const decision = { action: "revise" as const, reason: "policy envelope", nextLowPrice: 88,
      nextHighPrice: 112, nextLevelCount: 4, nextSpacing: 8,
      protectedLowPrice: null, protectedHighPrice: null };
    const set = buildShadowGridCandidates(policyInput, decision);
    expect(set.policyCandidateId).toBe("policy");
    expect(set.candidates.find(candidate => candidate.id === "policy")?.highPrice).toBe(112);
  });

  it("rejects a lower band when another asset has funding priority or exits are unknown", () => {
    const policyInput = input();
    const proposal = { action: "create_band" as const, reason: "fallback", nextLowPrice: null,
      nextHighPrice: null, nextLevelCount: null, nextSpacing: null,
      protectedLowPrice: null, protectedHighPrice: null,
      candidate: { lowPrice: 90, highPrice: 110, levelCount: 5, spacing: 5, requestedCapitalUsd: 100 } };
    const moreFunded = buildShadowGridCandidates(policyInput, proposal, { assetAllocations: [
      { assetSymbol: "SOL", allocatedCapitalUsd: 500 }, { assetSymbol: "BTC", allocatedCapitalUsd: 400 }] });
    expect(moreFunded.policyCandidateId).toBeNull();
    expect(moreFunded.rejected.find(candidate => candidate.id === "policy")?.reasons.join(" "))
      .toContain("funding priority");
    const unknownExit = buildShadowGridCandidates(policyInput, proposal, { assetAllocations: [
      { assetSymbol: "SOL", allocatedCapitalUsd: 500 }, { assetSymbol: "BTC", allocatedCapitalUsd: 600 }],
      hasUnknownExitCommitment: true });
    expect(unknownExit.rejected.find(candidate => candidate.id === "policy")?.reasons.join(" "))
      .toContain("unknown exit");
  });

  it("creates distinct causal channel and volatility-density alternatives", () => {
    const policyInput = input({ price: 100, candles: candles(100) });
    const decision = { action: "revise" as const, reason: "policy envelope", nextLowPrice: 96,
      nextHighPrice: 104, nextLevelCount: 5, nextSpacing: 2,
      protectedLowPrice: null, protectedHighPrice: null };
    const result = buildShadowGridCandidates(policyInput, decision);

    expect(result.policyCandidateId).toBe("policy");
    expect(result.candidates.map(candidate => candidate.kind)).toEqual(expect.arrayContaining([
      "keep", "policy", "donchian_variant", "density_variant"
    ]));
    expect(result.candidates.find(candidate => candidate.id === "keep")?.currentlyPolicyEligible).toBe(false);
    expect(result.candidates.filter(candidate => candidate.kind !== "keep").every(candidate => candidate.lowPrice < policyInput.price && candidate.highPrice > policyInput.price)).toBe(true);
    expect(result.candidates.every(candidate => candidate.spacing >= 0)).toBe(true);
  });

  it("keeps WAIT as the policy choice and records unavailable drift inputs", () => {
    const policyInput = input();
    const decision = { action: "wait" as const, reason: "wait", nextLowPrice: null, nextHighPrice: null,
      nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null };
    const result = buildShadowGridCandidates(policyInput, decision);

    expect(result.policyCandidateId).toBe("keep");
    expect(result.policyCandidateId).toBe("keep");
    expect(result.candidates[0]?.id).toBe("keep");
    expect(result.candidates.length).toBeLessThanOrEqual(6);
    expect(result.rejected.find(candidate => candidate.id === "ema_drift")?.reasons.join(" ")).toContain("50 valid closed candles");
    expect(result.candidates.filter(candidate => !candidate.currentlyPolicyEligible).length).toBeGreaterThan(0);
  });

  it("does not offer a revision that leaves range and rails unchanged", () => {
    const policyInput = input({ parameters: { ...parameters, minimumSpacingPct: 4 } });
    const decision = { action: "wait" as const, reason: "wait", nextLowPrice: null, nextHighPrice: null,
      nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null };
    const result = buildShadowGridCandidates(policyInput, decision);
    expect(result.candidates.find(candidate => candidate.id === "vol_cost_density")).toBeUndefined();
    expect(result.rejected.find(candidate => candidate.id === "vol_cost_density")?.reasons.join(" "))
      .toContain("geometry unchanged");
  });

  it("adds the EMA drift candidate only with 50 causal closed candles and records its inputs", () => {
    const history = candles(104, 60).map((candle, index) => ({ ...candle, close: 90 + index * 0.25,
      open: 90 + index * 0.25, high: 91 + index * 0.25, low: 89 + index * 0.25 }));
    const latest = history.at(-1)!;
    const policyInput = input({ now: latest.closedAt, price: latest.close, candles: history });
    const result = buildShadowGridCandidates(policyInput, { action: "wait", reason: "wait", nextLowPrice: null,
      nextHighPrice: null, nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null });
    const drift = result.candidates.find(candidate => candidate.id === "ema_drift");
    expect(drift?.strategyParameters).toMatchObject({ ema_fast: 20, ema_slow: 50 });
    expect(drift?.lowPrice).toBeLessThan(policyInput.price);
    expect(drift?.highPrice).toBeGreaterThan(policyInput.price);
  });

  it("rejects a KEEP band that violates the policy cost floor and explains why", () => {
    const policyInput = input({
      band: { ...input().band, lowPrice: 99, highPrice: 101, levelCount: 12, spacing: 2 / 11 },
      parameters: { ...parameters, minimumSpacingPct: 2 }
    });
    const result = buildShadowGridCandidates(policyInput, { action: "wait", reason: "wait", nextLowPrice: null,
      nextHighPrice: null, nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null });

    expect(result.candidates[0]).toMatchObject({ id: "keep", validation: "baseline", economicallyValid: false });
    expect(result.candidates[0]?.economicValidationReasons.join(" ")).toMatch(/floor|Width|price/i);
  });

  it("retains a policy PARK action on an inherited narrow band", () => {
    const policyInput = input({ band: { ...input().band, lowPrice: 99, highPrice: 101,
      levelCount: 12, spacing: 2 / 11 } });
    const decision = { action: "park" as const, reason: "hold inventory", nextLowPrice: null,
      nextHighPrice: null, nextLevelCount: null, nextSpacing: null,
      protectedLowPrice: null, protectedHighPrice: null };
    const set = buildShadowGridCandidates(policyInput, decision);
    expect(set.policyCandidateId).toBe("policy");
    expect(set.candidates.find(candidate => candidate.id === "policy")?.validation).toBe("baseline");
  });

  it("keeps status-changing reactivation distinct from KEEP", () => {
    const policyInput = input({ band: { ...input().band, status: "parked" } });
    const decision = { action: "reactivate" as const, reason: "back in range", nextLowPrice: null,
      nextHighPrice: null, nextLevelCount: null, nextSpacing: null,
      protectedLowPrice: null, protectedHighPrice: null };
    const set = buildShadowGridCandidates(policyInput, decision);
    expect(set.policyCandidateId).toBe("policy");
    expect(set.candidates.find(candidate => candidate.id === "keep")?.currentlyPolicyEligible).toBe(false);
    expect(set.candidates.find(candidate => candidate.id === "policy")?.currentlyPolicyEligible).toBe(true);
  });
});
