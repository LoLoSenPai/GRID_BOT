import { describe, expect, it, vi } from "vitest";
import type { ShadowGridCandidateSet } from "@grid-bot/core";
import { buildJevV3Request } from "./shadow-jev-v3-questions";
import { evaluateJevV3 } from "./shadow-jev-v3-client";

const observedAt = "2026-09-28T12:00:00.000Z";
const decision = { action: "revise" as const, reason: "candidate", nextLowPrice: 95,
  nextHighPrice: 105, nextLevelCount: 4, nextSpacing: 10 / 3,
  protectedLowPrice: null, protectedHighPrice: null };
const candidateSet: ShadowGridCandidateSet = {
  version: "shadow-grid-candidates-v3", policyCandidateId: "policy", rejected: [],
  candidates: [
    { id: "keep", kind: "keep", action: "keep", lowPrice: 90, highPrice: 110, levelCount: 5,
      spacing: 5, requestedCapitalUsd: 0, validation: "validated", economicallyValid: true,
      economicValidationReasons: [], currentlyPolicyEligible: false,
      policyEligibilityReasons: ["Counterfactual KEEP"],
      decision: { ...decision, action: "wait", nextLowPrice: null, nextHighPrice: null,
        nextLevelCount: null, nextSpacing: null } },
    { id: "policy", kind: "policy", action: "revise", lowPrice: 95, highPrice: 105, levelCount: 4,
      spacing: 10 / 3, requestedCapitalUsd: 0, validation: "validated", economicallyValid: true,
      economicValidationReasons: [], currentlyPolicyEligible: true, policyEligibilityReasons: [], decision },
  ],
};

function prepared(set: ShadowGridCandidateSet = candidateSet, at = observedAt) {
  const candles = Array.from({ length: 30 }, (_, i) => {
    const closedAt = new Date(Date.parse(at) - (29 - i) * 3_600_000);
    return { openedAt: new Date(+closedAt - 3_600_000), closedAt,
      open: 100, high: 102, low: 98, close: 100 + i / 100 };
  });
  candles.push({ openedAt: new Date(Date.parse(at) + 3_600_000),
    closedAt: new Date(Date.parse(at) + 7_200_000),
    open: 1_000, high: 1_001, low: 999, close: 1_000 });
  return buildJevV3Request({ observedAt: at, stateReadAt: new Date(Date.parse(at) + 10_000),
    objective: "accumulate_base", candidateSet: set,
    policyInput: { now: at, price: 100, assetSymbol: "BTC", band: { id: "b", lowPrice: 90,
      highPrice: 110, levelCount: 5, spacing: 5, status: "active", allocatedCapitalUsd: 400,
      idleQuoteUsd: 120, openTradingLots: [{ entryPrice: 92, remainingBaseAmount: 0.01, costQuote: 100 }] },
    bandCount: 1, assetAttributedCapitalUsd: 400, availableCashUsd: 200,
    totalPortfolioCapitalUsd: 1_000, candles, candleIntervalMs: 3_600_000,
    maxCandleAgeMs: 7_200_000, parameters: { persistenceClosedBars: 3, cooldownMs: 0,
      maxDailyRevisions: 3, atrMultiplier: 6, realizedVolMultiplier: 6, amplitudeMultiplier: 3,
      minWidthPct: 6, maxWidthPct: 24, minUsefulOrderUsd: 25, maxBands: 3, maxLevels: 24,
      maxExposurePct: 70, lowerBandOffsetPct: 3, lowerBandWidthPct: 6,
      minimumSpacingPct: 0.4 } } });
}

describe("Jev V3 candidate question", () => {
  it("sends a short causal projection and neutral option IDs", () => {
    const { request, optionToCandidateId } = prepared();
    expect(request.state.market.recent_closed_candles).toHaveLength(24);
    expect(request.state.market.closed_candle_count).toBe(24);
    expect(request.state.market.window_high_low_pct).toBeGreaterThan(0);
    expect(request.state.market.recent_closed_candles.at(-1)?.closed_at).toBe(observedAt);
    expect(request.state.state_read_at).toBe("2026-09-28T12:00:10.000Z");
    expect(request.state.market.recent_closed_candles.some(c => c.close === 1_000)).toBe(false);
    expect(Object.keys(request.questions.grid_candidate.criteria)).toEqual(["option_0", "option_1", "abstain"]);
    expect(Object.values(optionToCandidateId).sort()).toEqual(["keep", "policy"]);
    expect(JSON.stringify(request)).not.toContain("policyCandidateId");
    expect(JSON.stringify(request)).not.toContain('"decision"');
  });

  it("describes the offered construction without exposing candidate IDs or full replay state", () => {
    const variant: ShadowGridCandidateSet = { ...candidateSet, candidates: [candidateSet.candidates[0]!, {
      ...candidateSet.candidates[1]!, id: "donchian_20", kind: "donchian_variant",
      strategyParameters: { lookback: 20, low_quantile: 0.1, high_quantile: 0.9 },
      decision: { ...decision, reason: "Closed-candle channel with robust quantiles." },
    }], policyCandidateId: null };
    const { request } = prepared(variant);
    const projected = request.state.candidates.find(candidate => candidate.family === "donchian_variant");
    expect(projected?.strategy_parameters).toEqual({ lookback: 20, low_quantile: 0.1, high_quantile: 0.9 });
    expect(projected?.rationale).toContain("Closed-candle channel");
    expect(JSON.stringify(request)).not.toContain("donchian_20");
    expect(JSON.stringify(request)).not.toContain('"decision"');
  });

  it("balances option positions reproducibly across observation hours", () => {
    expect(prepared().optionToCandidateId).toEqual(prepared().optionToCandidateId);
    const positions = new Set(Array.from({ length: 12 }, (_, hour) => {
      const at = new Date(Date.parse(observedAt) + hour * 3_600_000).toISOString();
      return Object.entries(prepared(candidateSet, at).optionToCandidateId).find(([, id]) => id === "keep")?.[0];
    }));
    expect(positions).toEqual(new Set(["option_0", "option_1"]));
  });

  it("validates the complete distribution and model response", async () => {
    const { request } = prepared();
    const raw = { model: "jev-1.13.0", answers: { grid_candidate: { type: "choice", choice: "option_1",
      confidence: 0.7, probabilities: { option_0: 0.2, option_1: 0.7, abstain: 0.1 } } },
    usage: { input_tokens: 500, output_tokens: 20 } };
    const client = { evaluate: vi.fn(async () => raw) };
    const result = await evaluateJevV3(request, client);
    expect(result.choice).toBe("option_1");
    expect(result.probabilities).toEqual(raw.answers.grid_candidate.probabilities);
    expect(client.evaluate).toHaveBeenCalledTimes(1);
  });

  it("keeps an economically weak existing band as an explicit baseline", () => {
    const baseline: ShadowGridCandidateSet = { ...candidateSet,
      candidates: [{ ...candidateSet.candidates[0]!, validation: "baseline", economicallyValid: false,
        economicValidationReasons: ["Spacing below current cost floor"] }, candidateSet.candidates[1]!] };
    const { request, optionToCandidateId } = prepared(baseline);
    expect(request.state.candidates.find(candidate => candidate.action === "keep")).toMatchObject({ economic_validation: "baseline",
      economic_validation_reasons: ["Spacing below current cost floor"] });
    const keepOption = Object.entries(optionToCandidateId).find(([, id]) => id === "keep")?.[0];
    expect(keepOption).toBeDefined();
    expect(request.questions.grid_candidate.criteria[keepOption!]).toContain("Existing baseline");
  });

  it("rejects missing probability options", async () => {
    const { request } = prepared();
    const raw = { model: "jev-1.13.0", answers: { grid_candidate: { type: "choice", choice: "option_1",
      confidence: 0.7, probabilities: { option_0: 0.3, option_1: 0.7 } } },
    usage: { input_tokens: 500, output_tokens: 20 } };
    await expect(evaluateJevV3(request, { evaluate: vi.fn(async () => raw) }))
      .rejects.toThrow("probability options do not match");
  });
});
