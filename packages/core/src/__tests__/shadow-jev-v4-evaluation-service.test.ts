import { describe, expect, it } from "vitest";
import { ShadowJevV4EvaluationService } from "../services/shadow-jev-v4-evaluation-service";
import { DEFAULT_PORTFOLIO_POLICY } from "../services/portfolio-policy-service";
import type { ShadowJevV4EvaluationRequest } from "../services/shadow-jev-v4-evaluation-service";

const HOUR = 3_600_000;
const t0 = Date.parse("2026-09-28T12:00:00Z");
const old = new Date(t0 - HOUR).toISOString();
const at = new Date(t0).toISOString();
const after = new Date(t0 + 1000).toISOString();

function fixture() {
  const makeStrategy = (symbol: string) => {
    const bandId = `${symbol}-band`, strategyId = `${symbol}-strategy`, botId = `${symbol}-bot`;
    const low = symbol === "BTC" ? 90 : 18, high = symbol === "BTC" ? 110 : 22;
    return { id: strategyId, portfolioId: "portfolio", baseSymbol: symbol, baseMint: `${symbol}-mint`,
      objective: symbol === "BTC" ? "accumulate_base" : "accumulate_usdc", allocatedQuoteAmount: "500", retainedBaseAmount: "0",
      updatedAt: old, createdAt: old, bands: [{ id: bandId, assetStrategyId: strategyId, botId,
        status: "ACTIVE", allocatedQuoteAmount: "500", availableQuoteAmount: "500", reservedQuoteAmount: "0",
        deployedCostQuote: "0", realizedLossQuote: "0", updatedAt: old, createdAt: old,
        capitalReservations: [] as unknown[], exitCommitments: [] as unknown[],
        revisions: [{ id: `${symbol}-revision`, bandId, sequence: 1, gridType: "arithmetic",
          lowPrice: low, highPrice: high, levelCount: 5, observedAt: old, createdAt: old }],
        bot: { id: botId, baseMint: `${symbol}-mint`, quoteMint: "usdc-mint", baseSymbol: symbol, quoteSymbol: "USDC",
          baseDecimals: symbol === "BTC" ? 8 : 9, strategyMode: symbol === "BTC" ? "accumulate_base" : "accumulate_usdc",
          status: "running", archivedAt: null, executionAttempt: null as unknown,
          config: { updatedAt: old, createdAt: old, gridType: "arithmetic", entryMode: "normal", lowPrice: low, highPrice: high,
            levelCount: 5, reserveQuoteAmount: "0", maxDeployableUsd: "500", minOrderQuoteAmount: "25" },
          position: { updatedAt: old, baseAmount: "0" }, positionLots: [] as unknown[],
          stateSnapshots: [{ metadata: { pendingSignal: null as unknown, levelLocks: {} as Record<string, unknown>, recenterHistory: [] as string[] } }] },
      }] };
  };
  const wait = { action: "wait", reason: "Frozen policy", nextLowPrice: null, nextHighPrice: null,
    nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null };
  const keep = { id: "keep", lowPrice: 90, highPrice: 110, levelCount: 5, decision: wait };
  const markets = ["BTC", "SOL"].map(assetSymbol => {
    const price = assetSymbol === "BTC" ? 100 : 20;
    const candle = (timestamp: number) => ({ timestamp: new Date(timestamp), open: price, high: price, low: price, close: price });
    return { assetSymbol, baseMint: `${assetSymbol}-mint`, quoteMint: "usdc-mint", provider: "public-test", sourceMarket: `${assetSymbol}-pool`,
      inputId: `${assetSymbol}-frozen-input`, warmupCandles: Array.from({ length: 80 }, (_, i) => candle(t0 + (i - 80) * HOUR)),
      futureCandles: Array.from({ length: 24 }, (_, i) => candle(t0 + i * HOUR)) };
  });
  markets[0]!.futureCandles[0] = { timestamp: new Date(t0), open: 100, low: 95, high: 102, close: 100 };
  return { observation: { observedAt: at, bandId: "BTC-band", context: {
    band: { id: "BTC-band", activeRevision: { id: "BTC-revision" } },
    shadowTiming: { marketClosedAt: at, stateReadAt: after },
    shadowReplayV3: { schemaVersion: "shadow-replay-v3", capturedAt: new Date(t0 + 3000).toISOString(),
      source: { portfolioId: "portfolio", strategyId: "BTC-strategy", bandId: "BTC-band", botId: "BTC-bot", portfolioVersion: 1 },
      portfolio: { id: "portfolio", version: 1, updatedAt: old, createdAt: old, quoteMint: "usdc-mint", freeQuoteAmount: "0", nativeFeeReserveSol: "0.01" },
      strategies: [makeStrategy("BTC"), makeStrategy("SOL")], reservations: [] as unknown[] } },
    policyInput: { now: at, price: 100, assetSymbol: "BTC", parameters: { ...DEFAULT_PORTFOLIO_POLICY }, band: {
      id: "BTC-band", lowPrice: 90, highPrice: 110, levelCount: 5, allocatedCapitalUsd: 500, idleQuoteUsd: 500,
      status: "active", openTradingLots: [] as unknown[] }, bandCount: 1, availableCashUsd: 0, assetAttributedCapitalUsd: 500, totalPortfolioCapitalUsd: 1000 },
    candidateSet: { version: "shadow-grid-candidates-v3", candidates: [keep, { ...keep, id: "park", decision: { ...wait, action: "park" } }] },
    proposedDecision: wait }, selectedCandidateId: "park", markets, feeBps: 10, slippageBps: 10, nativeFeeUsd: 0.01 };
}

function v4Fixture(): ShadowJevV4EvaluationRequest {
  const old = fixture();
  const markets = old.markets.map(m => ({ ...m, futureExecutionCandles: m.futureCandles.flatMap(c =>
    Array.from({ length: 12 }, (_, i) => ({ timestamp: new Date(+c.timestamp + i * 300_000),
      open: c.open, high: c.high, low: c.low, close: c.close }))) }));
  return { ...old, observation: { ...old.observation, candidateSet: { version: "shadow-decisions-v4",
    grid: old.observation.candidateSet, exit: { version: "shadow-exits-v1",
      candidates: [{ id: "keep", kind: "keep", updates: [], strategyParameters: {} }], rejected: [] }, costProfile: null } },
    markets, selectedGridCandidateId: "park", selectedExitCandidateId: "keep",
    decisionAvailableAt: new Date(t0 + 4 * 60_000) };
}

describe("ShadowJevV4EvaluationService", () => {
  it("keeps fixed geometry distinct from policy adaptation, with abstention exactly following policy", () => {
    const input = v4Fixture(); input.selectedGridCandidateId = "abstain";
    const p = input.observation.policyInput as any;
    p.parameters.cooldownMs = 0; p.parameters.persistenceClosedBars = 1;
    p.parameters.maxDailyRevisions = 20;
    input.markets[0]!.futureCandles.forEach(c => { c.open = 130; c.high = 130; c.low = 130; c.close = 130; });
    input.markets[0]!.futureExecutionCandles!.forEach(c => { c.open = 130; c.high = 130; c.low = 130; c.close = 130; });
    const result = new ShadowJevV4EvaluationService().evaluate(input);
    expect(result.status).toBe("evaluated");
    const last = result.horizons.at(-1)!.branches!;
    expect(last.keep.gridRevisions).toBe(0);
    expect(last.currentPolicy.gridRevisions).toBeGreaterThan(0);
    expect(last.gridOnly).toEqual(last.currentPolicy); expect(last.exitOnly).toEqual(last.currentPolicy);
  });
  it("uses the recorded rejection at t0 rather than delaying the unapplied proposal", () => {
    const input = v4Fixture(); input.selectedGridCandidateId = "abstain";
    input.observation.proposedDecision = { ...(input.observation.proposedDecision as any), action: "park" };
    input.observation.initialEngineDecision = { ...(input.observation.proposedDecision as any), action: "wait", reason: "Engine rejected" };
    const result = new ShadowJevV4EvaluationService().evaluate(input);
    expect(result.status).toBe("evaluated"); expect(result.policyBaselineSource).toBe("recorded_engine_outcome");
    expect(result.horizons[0]!.branches!.currentPolicy.closedCycles).toBeGreaterThan(0);
    expect(result.horizons[0]!.branches!.gridOnly).toEqual(result.horizons[0]!.branches!.currentPolicy);
  });
  it("explicitly uses hourly fills for empty fine inputs while censoring partial fine inputs", () => {
    const input = v4Fixture(); input.markets.forEach(m => { m.futureExecutionCandles = []; });
    const result = new ShadowJevV4EvaluationService().evaluate(input);
    expect(result.horizons[0]!.reasons).toContain("DECISION_DEFERRED_BEYOND_HORIZON");
    expect(result.horizons[1]!.executionResolution).toBe("1h");
  });
  it("compares five branches with delayed five-minute execution and unchanged hourly policy cadence", () => {
    const input = v4Fixture(), before = structuredClone(input);
    const result = new ShadowJevV4EvaluationService().evaluate(input);
    expect(result.reasons).toEqual([]); expect(result.status).toBe("evaluated");
    expect(result.mode).toBe("single_delayed_shadow_intervention");
    expect(Object.keys(result.horizons[0]!.branches!)).toEqual(["keep", "currentPolicy", "gridOnly", "exitOnly", "combined"]);
    expect(result.horizons[0]!.branches!.gridOnly.initialEquityUsd).toBe(1000);
    expect(result.horizons[0]!.branches!.combined).toEqual(result.horizons[0]!.branches!.gridOnly);
    expect(input).toEqual(before);
  });
  it("censors incomplete five-minute coverage rather than backfilling hourly highs", () => {
    const input = v4Fixture(); input.markets[1]!.futureExecutionCandles!.splice(3, 1);
    const result = new ShadowJevV4EvaluationService().evaluate(input);
    expect(result.status).toBe("censored"); expect(result.reasons).toContain("EXECUTION_FUTURE_COVERAGE:SOL:1h");
  });
  it("retains conservative provenance checks and rejects responses predating the captured state", () => {
    const input = v4Fixture(); input.decisionAvailableAt = new Date(t0 + 2000);
    expect(new ShadowJevV4EvaluationService().evaluate(input).reasons).toContain("DECISION_AVAILABILITY_PRECEDES_CAPTURE");
    input.decisionAvailableAt = new Date(t0 + 4 * 60_000);
    (input.observation.context as any).shadowReplayV3.portfolio.updatedAt = new Date(t0 + 1000).toISOString();
    expect(new ShadowJevV4EvaluationService().evaluate(input).reasons).toContain("POST_CLOSE_MUTATION:portfolio");
  });
  it("identifies hourly availability limitations explicitly when five-minute coverage was not collected", () => {
    const input = v4Fixture(); input.markets.forEach(m => delete m.futureExecutionCandles);
    const result = new ShadowJevV4EvaluationService().evaluate(input);
    expect(result.status).toBe("partial");
    expect(result.horizons[0]!.reasons).toContain("DECISION_DEFERRED_BEYOND_HORIZON");
    expect(result.horizons[1]!.status).toBe("evaluated");
  });
  it("assigns identical dated deposits to every branch and removes their contribution from equity change", () => {
    const input = v4Fixture(); input.selectedGridCandidateId = "keep";
    const base = new ShadowJevV4EvaluationService().evaluate(input);
    input.cashflows = [{ id: "external", at: new Date(t0 + 30 * 60_000), amountUsd: 100 }];
    const funded = new ShadowJevV4EvaluationService().evaluate(input);
    expect(funded.status).toBe("evaluated");
    for (const branch of Object.values(funded.horizons[0]!.branches!)) expect(branch.externalCashflowUsd).toBe(100);
    expect(funded.horizons[0]!.branches!.keep.equityChangeExcludingCashflowsUsd)
      .toBeCloseTo(base.horizons[0]!.branches!.keep.equityChangeExcludingCashflowsUsd);
    expect(funded.horizons[0]!.branches!.keep.realizedUsdcByAsset).toEqual(base.horizons[0]!.branches!.keep.realizedUsdcByAsset);
  });
  it("replays a meaningful BTC exit change after availability and censors fabricated identity or economic bounds", () => {
    const input = v4Fixture(), snapshot = (input.observation.context as any).shadowReplayV3;
    const band = snapshot.strategies[0].bands[0];
    const lot = { id: "source", botId: band.botId, kind: "trading", entryPrice: "90", remainingBaseAmount: "1.2",
      costQuote: "100", closedAt: null, openedAt: old };
    band.availableQuoteAmount = "400"; band.deployedCostQuote = "100"; band.bot.position.baseAmount = "1.2";
    band.bot.positionLots = [lot]; band.exitCommitments = [{ lotId: "source", bandId: band.id,
      originRevisionId: "BTC-revision", targetStatus: "KNOWN", fulfilledAt: null, createdAt: old,
      sellTargetPrice: "108", economicRule: "accumulate_base" }];
    (input.observation.policyInput as any).band.idleQuoteUsd = 400;
    (input.observation.policyInput as any).band.openTradingLots = [lot];
    input.markets[0]!.warmupCandles.forEach(c => { c.high = 102; c.low = 98; });
    input.markets[0]!.futureCandles.forEach(c => { c.open = 100; c.high = 107; c.low = 100; c.close = 100; });
    input.markets[0]!.futureExecutionCandles!.forEach(c => { c.open = 100; c.high = 107; c.low = 100; c.close = 100; });
    const set = input.observation.candidateSet as any;
    set.costProfile = { version: "shadow-observed-cost-v1", asOf: at, windowStart: old, portfolioId: "portfolio", botId: band.botId,
      assetSymbol: "BTC", baseMint: "BTC-mint", quoteMint: "usdc-mint", usable: true, count: 8,
      notionalBucket: { minUsd: 25, maxUsd: 250 }, feeBps: 2, adverseSlippageBps: 2, p90NativeFeeUsd: 0.005, safetyMarginBps: 2 };
    const update = { sourceLotId: "source", bandId: "BTC-band", oldTargetPrice: 108, newTargetPrice: 106,
      costQuote: 100, remainingBaseAmount: 1.2, economicRule: "accumulate_base", minimumNetGainUsd: 0,
      minimumRetainedBaseAmount: 0.0012 };
    set.exit.candidates.push({ id: "closer", kind: "closer", updates: [update], strategyParameters: {} });
    input.selectedExitCandidateId = "closer";
    const result = new ShadowJevV4EvaluationService().evaluate(input);
    expect(result.reasons).toEqual([]); expect(result.status).toBe("evaluated");
    expect(result.horizons[0]!.branches!.combined.exitRevisionAppliedAt).toBe(new Date(t0 + 300_000).toISOString());
    expect(result.horizons[0]!.branches!.combined.retainedBaseByAsset.BTC).toBeGreaterThan(0.0012);
    expect(result.horizons[0]!.branches!.combined.closedCycles).toBeGreaterThan(result.horizons[0]!.branches!.gridOnly.closedCycles);
    update.sourceLotId = "invented";
    expect(new ShadowJevV4EvaluationService().evaluate(input).reasons).toContain("EXIT_CANDIDATE_CAPTURE_STATE_MISMATCH");
    update.sourceLotId = "source"; update.minimumRetainedBaseAmount = 0.00000001;
    expect(new ShadowJevV4EvaluationService().evaluate(input).reasons).toContain("EXIT_CANDIDATE_ECONOMIC_FLOOR_MISMATCH");
    update.minimumRetainedBaseAmount = 0.0012; update.newTargetPrice = 95;
    expect(new ShadowJevV4EvaluationService().evaluate(input).reasons).toContain("EXIT_CANDIDATE_VOLATILITY_BOUND_MISMATCH");
  });
});
