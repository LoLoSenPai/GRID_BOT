import { describe, expect, it, vi } from "vitest";
import { buildShadowDecisionCandidates, buildShadowGridCandidates, DEFAULT_PORTFOLIO_POLICY, type PortfolioPolicyInput, type ShadowDecisionCandidateSet } from "@grid-bot/core";
import { buildJevV4Request } from "./shadow-jev-v4-questions";
import { evaluateJevV4 } from "./shadow-jev-v4-client";
import { ShadowJevConsumer } from "./shadow-jev-consumer";

const at = new Date("2026-09-30T20:00:00Z");
function fixture(versions: { decisions: "shadow-decisions-v4" | "shadow-decisions-v4.1";
  grid: "shadow-grid-candidates-v3.1" | "shadow-grid-candidates-v3.2" } = {
  decisions: "shadow-decisions-v4.1", grid: "shadow-grid-candidates-v3.2"
}) {
  const policyInput: PortfolioPolicyInput = { now: at, price: 100, assetSymbol: "SOL", candleIntervalMs: 3_600_000,
    maxCandleAgeMs: 7_200_000, bandCount: 1, availableCashUsd: 200, assetAttributedCapitalUsd: 400,
    totalPortfolioCapitalUsd: 1_000, parameters: DEFAULT_PORTFOLIO_POLICY,
    band: { id: "band", lowPrice: 90, highPrice: 110, levelCount: 5, spacing: 5, status: "active",
      allocatedCapitalUsd: 400, idleQuoteUsd: 300, openTradingLots: [] },
    candles: Array.from({ length: 80 }, (_, i) => ({ openedAt: new Date(+at - (80 - i) * 3_600_000),
      closedAt: new Date(+at - (79 - i) * 3_600_000), open: 100, high: 101, low: 99, close: 100 })) };
  const decision = { action: "wait" as const, reason: "wait", nextLowPrice: null, nextHighPrice: null,
    nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null };
  const candidateSet: ShadowDecisionCandidateSet = { version: versions.decisions,
    grid: { ...buildShadowGridCandidates(policyInput, decision), version: versions.grid }, costProfile: null,
    exit: { version: "shadow-exits-v1", rejected: [], candidates: [{ id: "keep", kind: "keep", updates: [], strategyParameters: {} },
      { id: "closer", kind: "closer", strategyParameters: {}, updates: [{ sourceLotId: "lot", bandId: "band", oldTargetPrice: 110,
        newTargetPrice: 105, costQuote: 100, remainingBaseAmount: 1, economicRule: "accumulate_usdc",
        minimumNetGainUsd: 0.25, minimumRetainedBaseAmount: 0 }] }] } };
  return { observedAt: at, stateReadAt: new Date(+at + 5_000), objective: "accumulate_usdc" as const, policyInput, candidateSet };
}
function response(request: ReturnType<typeof buildJevV4Request>["request"]) {
  return { model: "jev-1.13.0", usage: { input_tokens: 200, output_tokens: 20 },
    answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const keys = Object.keys(question.criteria);
      return [id, { type: "choice", choice: keys[0], confidence: 0.8,
        probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 1 : 0])) }];
    })) };
}
describe("V4 shadow questions and consumer", () => {
  it("defaults to V4.1 candidates and preserves the V4 legacy exit shuffle", () => {
    const input = fixture();
    const defaultSet = buildShadowDecisionCandidates({ policyInput: input.policyInput,
      proposedDecision: { action: "wait", reason: "wait", nextLowPrice: null, nextHighPrice: null,
        nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null },
      replaySnapshot: {}, costProfile: null });
    expect(defaultSet.version).toBe("shadow-decisions-v4.1");
    expect(defaultSet.grid.version).toBe("shadow-grid-candidates-v3.2");

    const legacy = buildJevV4Request(fixture({ decisions: "shadow-decisions-v4", grid: "shadow-grid-candidates-v3.1" }));
    expect(legacy.request.questions.grid_candidate.criteria).toBeDefined();
    expect(legacy.request.state.experiment_version).toBe("shadow-decisions-v4");
    // Frozen V4 seed: sha256("shadow-jev-v4|observedAt|band|exits")[1] % 2 = 1, so no swap occurs.
    expect(legacy.request.state.exit_candidates.map(candidate => candidate.family))
      .toEqual(["keep", "closer"]);
  });

  it("describes a V4.1 grid baseline with its economic rejection reasons", () => {
    const input = fixture();
    input.candidateSet.grid.candidates[0] = { ...input.candidateSet.grid.candidates[0]!,
      validation: "baseline", economicallyValid: false,
      economicValidationReasons: ["Spacing below current policy/cost floor"] };
    const { request, gridOptionToCandidateId } = buildJevV4Request(input);
    const option = Object.entries(gridOptionToCandidateId).find(([, id]) => id === "keep")?.[0];
    expect(option).toBeDefined();
    expect(request.questions.grid_candidate.criteria[option!]).toContain("Baseline retained for comparison");
    expect(request.questions.grid_candidate.criteria[option!]).toContain("Spacing below current policy/cost floor");
  });

  it("freezes two neutral, bounded choices without exposing the policy winner", () => {
    const input = fixture(), original = structuredClone(input), prepared = buildJevV4Request(input);
    expect(input).toEqual(original);
    expect(Object.keys(prepared.request.questions)).toEqual(["grid_candidate", "exit_candidate"]);
    expect(prepared.request.state.market.recent_closed_candles).toHaveLength(24);
    expect(prepared.request.state.exit_candidates.flatMap(c => c.updates)[0]?.sourceLotId).toBe("lot");
    expect(JSON.stringify(prepared.request)).not.toContain("policyCandidateId");
    expect(prepared.request.state.fine_market_status).toBe("missing_at_capture");
  });
  it("refuses future and discontinuous 5m observations", () => {
    const input = fixture();
    const fine = { provenance: { symbol: "SOL", quoteSymbol: "USDC", resolution: "5m" }, candleCount: 1,
      candles: [{ openedAt: at.toISOString(), closedAt: new Date(+at + 300_000).toISOString(), open: 100, high: 101, low: 99, close: 100 }] };
    expect(() => buildJevV4Request({ ...input, fineMarketSnapshot: fine })).toThrow(/future/);
    fine.candles[0] = { ...fine.candles[0]!, openedAt: new Date(+at - 300_000).toISOString(), closedAt: at.toISOString() };
    expect(buildJevV4Request({ ...input, fineMarketSnapshot: fine }).request.state.recent_5m_candles).toHaveLength(1);
  });
  it("requires complete probability distributions for both questions", async () => {
    const { request } = buildJevV4Request(fixture());
    const valid = response(request);
    await expect(evaluateJevV4(request, { evaluate: async () => valid })).resolves.toMatchObject({ modelResolved: "jev-1.13.0" });
    const broken = structuredClone(valid) as typeof valid & { answers: Record<string, any> };
    broken.answers.exit_candidate.probabilities.abstain = 0.7;
    await expect(evaluateJevV4(request, { evaluate: async () => broken })).rejects.toThrow(/distribution/);
  });
  it("persists both mapped distributions in the existing leased outbox", async () => {
    const input = fixture();
    const store = { claim: vi.fn(async () => [{ jobId: "job", attemptCount: 1, leaseExpiresAt: new Date(+at + 60_000),
      questionSetVersion: "shadow-jev-v4.1", modelRequested: "jev-1.13.0", observation: {
        id: "obs", portfolioId: "p", strategyId: "s", bandId: "band", botId: "bot", observedAt: at,
        policyInput: input.policyInput, candidateSet: input.candidateSet, context: { strategy: { objective: "accumulate_usdc" },
          shadowTiming: { stateReadAt: input.stateReadAt.toISOString() } }, botState: {}, marketMeta: {}, proposedDecision: {},
        marketSnapshot: { id: "market", contentHash: "hash", candles: input.policyInput.candles,
          candleCount: input.policyInput.candles.length, provenance: {}, observedAt: at } } }]), complete: vi.fn(), fail: vi.fn() };
    await new ShadowJevConsumer(store, { evaluate: async request => response(request as never) }, "worker").processOne();
    expect(store.fail).not.toHaveBeenCalled();
    const result = store.complete.mock.calls[0]![0];
    expect(Object.keys(result.probabilities)).toEqual(["grid_candidate", "exit_candidate"]);
    expect(Object.keys(result.probabilities.exit_candidate.probabilities).sort()).toEqual(["abstain", "closer", "keep"]);
    expect(result.rawRequest.model).toBe("jev-1.13.0");
  });
});
