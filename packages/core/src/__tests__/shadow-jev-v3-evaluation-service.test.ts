import { describe, expect, it } from "vitest";
import { ShadowJevV3EvaluationService } from "../services/shadow-jev-v3-evaluation-service";
import { DEFAULT_PORTFOLIO_POLICY } from "../services/portfolio-policy-service";

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

describe("ShadowJevV3EvaluationService", () => {
  it("evaluates immutable single interventions at four horizons without mutating the input", () => {
    const input = fixture(), saved = structuredClone(input);
    const result = new ShadowJevV3EvaluationService().evaluate(input);
    expect(result.reasons).toEqual([]);
    expect(result.status).toBe("evaluated");
    expect(result.mode).toBe("hypothetical_at_candle_close");
    expect(result.horizons.map(h => h.hours)).toEqual([1, 3, 6, 24]);
    const first = result.horizons[0]!.branches!;
    expect(first.keep.closedCycles).toBeGreaterThan(0);
    expect(first.jev.closedCycles).toBe(0);
    expect(first.keep.initialEquityUsd).toBe(1000);
    expect(first.jev.initialEquityUsd).toBe(1000);
    expect(first.keep.feesUsd).toBeGreaterThan(0);
    expect(first.keep.retainedBaseByAsset.BTC).toBeGreaterThan(0);
    expect(first.keep.equityBtc).toBe(first.keep.equityUsd / 100);
    expect(input).toEqual(saved);
  });

  it("falls back to the policy for abstention", () => {
    const input = fixture(); input.selectedCandidateId = "abstain";
    const result = new ShadowJevV3EvaluationService().evaluate(input);
    expect(result.status).toBe("evaluated");
    for (const horizon of result.horizons) expect(horizon.branches!.jev).toEqual(horizon.branches!.policy);
  });

  it("maps immutable old exits and retained holdings without converting them into new free capital", () => {
    const input = fixture(), strategy = input.observation.context.shadowReplayV3.strategies[0]!, band = strategy.bands[0]!;
    const trading = { id: "trading", botId: band.botId, kind: "trading", entryPrice: "90", remainingBaseAmount: "1.2",
      costQuote: "100", closedAt: null, openedAt: old };
    const retained = { ...trading, id: "retained", kind: "retained", remainingBaseAmount: "0.1", costQuote: "0" };
    band.availableQuoteAmount = "400"; band.deployedCostQuote = "100";
    band.bot.position.baseAmount = "1.3"; band.bot.positionLots = [trading, retained];
    strategy.retainedBaseAmount = "0.1";
    band.exitCommitments.push({ lotId: "trading", bandId: band.id, originRevisionId: "BTC-revision", targetStatus: "KNOWN",
      fulfilledAt: null, createdAt: old, sellTargetPrice: "108", economicRule: "accumulate_usdc" });
    input.observation.policyInput.band.idleQuoteUsd = 400;
    input.observation.policyInput.band.openTradingLots = [trading, retained];
    input.markets[0]!.futureCandles[0] = { timestamp: new Date(t0), open: 100, low: 100, high: 112, close: 110 };
    const result = new ShadowJevV3EvaluationService().evaluate(input);
    expect(result.status).toBe("evaluated");
    const jev = result.horizons[0]!.branches!.jev;
    expect(jev.initialEquityUsd).toBe(1030);
    expect(jev.closedCycles).toBe(1);
    expect(jev.retainedBaseByAsset.BTC).toBeCloseTo(0.1);
    expect(jev.realizedUsdcByAsset.BTC).toBeGreaterThan(30);
    (band.exitCommitments[0] as { targetStatus: string }).targetStatus = "UNKNOWN";
    expect(new ShadowJevV3EvaluationService().evaluate(input).reasons).toContain("UNKNOWN_OR_POST_CLOSE_EXIT");
  });

  it("adapts two bands for BTC alongside SOL at the same total capital", () => {
    const input = fixture(), strategy = input.observation.context.shadowReplayV3.strategies[0]!;
    const lower = structuredClone(strategy.bands[0]!);
    lower.id = "BTC-lower-band"; lower.botId = "BTC-lower-bot"; lower.bot.id = lower.botId;
    lower.revisions[0] = { ...lower.revisions[0]!, id: "BTC-lower-revision", bandId: lower.id, lowPrice: 40, highPrice: 60 };
    lower.bot.config.lowPrice = 40; lower.bot.config.highPrice = 60;
    strategy.bands.push(lower); strategy.allocatedQuoteAmount = "1000";
    input.observation.policyInput.bandCount = 2;
    input.observation.policyInput.assetAttributedCapitalUsd = 1000;
    input.observation.policyInput.totalPortfolioCapitalUsd = 1500;
    const result = new ShadowJevV3EvaluationService().evaluate(input);
    expect(result.reasons).toEqual([]);
    const first = result.horizons[0]!.branches!;
    expect(first.keep.initialEquityUsd).toBe(1500);
    expect(first.policy.initialEquityUsd).toBe(1500);
    expect(first.jev.initialEquityUsd).toBe(1500);
  });

  it("censors unavailable horizons without inventing or borrowing candles", () => {
    const input = fixture(); input.markets[1]!.futureCandles = input.markets[1]!.futureCandles.slice(0, 3);
    const result = new ShadowJevV3EvaluationService().evaluate(input);
    expect(result.status).toBe("partial");
    expect(result.horizons.map(h => h.status)).toEqual(["evaluated", "evaluated", "censored", "censored"]);
    expect(result.horizons[2]!.reasons).toContain("FUTURE_COVERAGE:SOL:6h");
  });

  it.each(["portfolio", "strategy", "band", "position", "config"])("rejects post-close economic mutation: %s", component => {
    const input = fixture(), snapshot = input.observation.context.shadowReplayV3;
    const strategy = snapshot.strategies[0]!, band = strategy.bands[0]!;
    const target = { portfolio: snapshot.portfolio, strategy, band, position: band.bot.position, config: band.bot.config }[component]!;
    target.updatedAt = after;
    const result = new ShadowJevV3EvaluationService().evaluate(input);
    expect(result.status).toBe("censored");
    expect(result.reasons).toContain(`POST_CLOSE_MUTATION:${component}`);
    expect(result.horizons.every(h => !h.branches)).toBe(true);
  });

  it("rejects pending reservations, execution attempts and runtime signals", () => {
    for (const mutate of [
      (input: ReturnType<typeof fixture>) => input.observation.context.shadowReplayV3.reservations.push({ id: "pending" }),
      (input: ReturnType<typeof fixture>) => { input.observation.context.shadowReplayV3.strategies[0]!.bands[0]!.bot.executionAttempt = { uncertain: true }; },
      (input: ReturnType<typeof fixture>) => { input.observation.context.shadowReplayV3.strategies[0]!.bands[0]!.bot.stateSnapshots[0]!.metadata.pendingSignal = { side: "buy" }; },
    ]) {
      const input = fixture(); mutate(input);
      expect(new ShadowJevV3EvaluationService().evaluate(input).status).toBe("censored");
    }
  });

  it("rejects mismatching lots, revision IDs, policy time and policy mark", () => {
    for (const mutate of [
      (input: ReturnType<typeof fixture>) => { input.observation.context.band.activeRevision.id = "different-revision"; },
      (input: ReturnType<typeof fixture>) => { input.observation.policyInput.now = after; },
      (input: ReturnType<typeof fixture>) => { input.observation.policyInput.price = 999; },
      (input: ReturnType<typeof fixture>) => input.observation.policyInput.band.openTradingLots.push({ kind: "trading", entryPrice: 90, remainingBaseAmount: 1, costQuote: 90 }),
    ]) {
      const input = fixture(); mutate(input);
      expect(new ShadowJevV3EvaluationService().evaluate(input).reasons).toContain("SNAPSHOT_POLICY_STATE_MISMATCH");
    }
  });

  it("does not promote a different future suffix into the earlier horizon", () => {
    const input = fixture(), changed = structuredClone(input);
    changed.markets[0]!.futureCandles[3] = { timestamp: new Date(t0 + 3 * HOUR), open: 100, high: 200, low: 10, close: 100 };
    const service = new ShadowJevV3EvaluationService();
    expect(service.evaluate(changed).horizons.slice(0, 2)).toEqual(service.evaluate(input).horizons.slice(0, 2));
  });

  it("rejects unaccounted initial funds and unknown candidate IDs", () => {
    const input = fixture();
    input.observation.context.shadowReplayV3.strategies[1]!.bands[0]!.availableQuoteAmount = "490";
    expect(new ShadowJevV3EvaluationService().evaluate(input).status).toBe("censored");
    const unknown = fixture(); unknown.selectedCandidateId = "missing";
    expect(new ShadowJevV3EvaluationService().evaluate(unknown).reasons).toContain("UNKNOWN_JEV_CANDIDATE");
  });
});
