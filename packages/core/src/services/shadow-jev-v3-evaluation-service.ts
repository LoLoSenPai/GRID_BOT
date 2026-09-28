import type { HistoricalCandle } from "../domain/types";
import type { PortfolioPolicyDecision, PortfolioPolicyParameters } from "./portfolio-policy-service";
import { PortfolioPolicyReplayService, type PortfolioReplayAllocation, type PortfolioReplayInitialLot,
  type PortfolioPolicyReplayResult } from "./portfolio-policy-replay-service";

const HOUR = 3_600_000;
const HORIZONS = [1, 3, 6, 24] as const;
type Horizon = typeof HORIZONS[number];
type JsonRecord = Record<string, unknown>;

export interface ShadowJevV3EvaluationRequest {
  observation: { observedAt: Date | string; bandId: string; context: unknown; candidateSet: unknown;
    proposedDecision: unknown; policyInput: unknown };
  selectedCandidateId: string;
  markets: Array<{ assetSymbol: string; baseMint: string; quoteMint: string; provider: string;
    sourceMarket: string; inputId: string; warmupCandles: HistoricalCandle[]; futureCandles: HistoricalCandle[] }>;
  feeBps: number; slippageBps: number; nativeFeeUsd: number;
}

export interface ShadowJevV3Metrics {
  initialEquityUsd: number; equityUsd: number; equityBtc: number | null; cashUsd: number; inventoryValueUsd: number;
  baseAmountByAsset: Record<string, number>; retainedBaseByAsset: Record<string, number>;
  realizedUsdcByAsset: Record<string, number>; feesUsd: number; slippageCostUsd: number; roundingCostUsd: number;
  closedCycles: number; lockedLotCostUsd: number; openTradingLots: number;
}
export interface ShadowJevV3EvaluationResult {
  version: "shadow-jev-v3-evaluation-v1"; mode: "hypothetical_at_candle_close";
  status: "evaluated" | "partial" | "censored"; reasons: string[]; assumptions: string[];
  horizons: Array<{ hours: Horizon; status: "evaluated" | "censored"; reasons: string[];
    branches?: { keep: ShadowJevV3Metrics; policy: ShadowJevV3Metrics; jev: ShadowJevV3Metrics } }>;
  provenance: Array<{ assetSymbol: string; baseMint: string; quoteMint: string; provider: string; sourceMarket: string; inputId: string }>;
}

class Censored extends Error {}
function requireState(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Censored(reason);
}

/** Pure, conservative intervention comparison. It never changes the live portfolio. */
export class ShadowJevV3EvaluationService {
  constructor(private readonly replay = new PortfolioPolicyReplayService()) {}

  evaluate(input: ShadowJevV3EvaluationRequest): ShadowJevV3EvaluationResult {
    const output: ShadowJevV3EvaluationResult = {
      version: "shadow-jev-v3-evaluation-v1", mode: "hypothetical_at_candle_close", status: "censored", reasons: [],
      assumptions: ["Synthetic hourly OHLC fills; Jupiter execution, order throttles and Jev response latency are not modeled.",
        "One recorded intervention at the candle close, followed by the deterministic policy on each branch.",
        "USDC is valued at one USD. Native SOL reserve is excluded from modeled strategy equity and is not spendable quote cash.",
        "Public candle prices are a market proxy; matching the declared mint does not prove the pool traded that mint.",
        "Post-close capture is accepted only when captured economic mutation timestamps establish unchanged holdings at t0.",
        "The saved pre-decision context is not used to reverse post-close mutations; those observations remain censored."],
      horizons: [], provenance: input.markets.map(({ assetSymbol, baseMint, quoteMint, provider, sourceMarket, inputId }) =>
        ({ assetSymbol, baseMint, quoteMint, provider, sourceMarket, inputId })),
    };
    try {
      const { allocations, freeCashUsd, totalStartingCapitalUsd, minOrderQuoteUsd, parameters, decisions, t0 } = prepare(input);
      for (const hours of HORIZONS) {
        try {
          const ready = allocations.map(allocation => {
            const market = input.markets.find(m => m.assetSymbol === allocation.assetSymbol)!;
            const future = market.futureCandles.filter(c => +c.timestamp >= t0 && +c.timestamp < t0 + hours * HOUR);
            requireState(future.length === hours && future.every((c, i) => +c.timestamp === t0 + i * HOUR),
              `FUTURE_COVERAGE:${allocation.assetSymbol}:${hours}h`);
            return { ...allocation, series: { ...allocation.series, candles: future } };
          });
          const run = (decision: PortfolioPolicyDecision, candidateId: string) => metrics(this.replay.replay({
            allocations: ready, totalStartingCapitalUsd, freeCashUsd, policyParameters: parameters,
            feeBps: input.feeBps, slippageBps: input.slippageBps, nativeFeeUsd: input.nativeFeeUsd,
            candleIntervalMs: HOUR, minOrderQuoteUsd, adaptive: true,
            initialIntervention: { bandId: input.observation.bandId, observedAt: new Date(t0), decision, candidateId },
          }));
          output.horizons.push({ hours, status: "evaluated", reasons: [], branches: {
            keep: run(decisions.keep, "keep"), policy: run(decisions.policy, "policy"),
            jev: run(decisions.jev, input.selectedCandidateId === "abstain" ? "policy" : input.selectedCandidateId),
          } });
        } catch (error) {
          output.horizons.push({ hours, status: "censored", reasons: [reason(error)] });
        }
      }
      const evaluated = output.horizons.filter(h => h.status === "evaluated").length;
      output.status = evaluated === HORIZONS.length ? "evaluated" : evaluated > 0 ? "partial" : "censored";
      output.reasons = [...new Set(output.horizons.flatMap(h => h.reasons))];
    } catch (error) {
      output.reasons = [reason(error)];
      output.horizons = HORIZONS.map(hours => ({ hours, status: "censored", reasons: [...output.reasons] }));
    }
    return output;
  }
}

function prepare(input: ShadowJevV3EvaluationRequest) {
  const t0 = time(input.observation.observedAt, "observedAt");
  requireState(t0 % HOUR === 0, "UNALIGNED_OBSERVATION");
  const context = record(input.observation.context, "context");
  const snapshot = record(context.shadowReplayV3, "shadowReplayV3");
  requireState(snapshot.schemaVersion === "shadow-replay-v3", "UNSUPPORTED_SNAPSHOT_VERSION");
  requireState(time(snapshot.capturedAt, "capturedAt") >= t0, "CAPTURE_PRECEDES_OBSERVATION");
  const timing = record(context.shadowTiming, "shadowTiming");
  requireState(time(timing.marketClosedAt, "marketClosedAt") === t0 && time(timing.stateReadAt, "stateReadAt") >= t0 &&
    time(timing.stateReadAt, "stateReadAt") <= time(snapshot.capturedAt, "capturedAt"), "INCONSISTENT_CAPTURE_TIMING");
  const source = record(snapshot.source, "source");
  requireState(source.bandId === input.observation.bandId, "TARGET_BAND_MISMATCH");
  const portfolio = record(snapshot.portfolio, "portfolio");
  requireState(source.portfolioId === portfolio.id && source.portfolioVersion === portfolio.version, "PORTFOLIO_VERSION_MISMATCH");
  unchanged(portfolio, t0, "portfolio");
  requireState(array(snapshot.reservations, "reservations").length === 0, "PENDING_PORTFOLIO_RESERVATIONS");
  const quoteMint = string(portfolio.quoteMint, "quoteMint");
  const freeCashUsd = number(portfolio.freeQuoteAmount, "freeQuoteAmount");
  number(portfolio.nativeFeeReserveSol, "nativeFeeReserveSol");
  const policy = record(input.observation.policyInput, "policyInput");
  const parameters = record(policy.parameters, "parameters") as unknown as PortfolioPolicyParameters;
  requireState(["persistenceClosedBars", "cooldownMs", "maxDailyRevisions", "atrMultiplier", "realizedVolMultiplier",
    "amplitudeMultiplier", "minWidthPct", "maxWidthPct", "minUsefulOrderUsd", "maxBands", "maxLevels", "maxExposurePct",
    "lowerBandOffsetPct", "lowerBandWidthPct", "minimumSpacingPct"].every(key =>
      typeof (parameters as unknown as JsonRecord)[key] === "number" &&
      Number.isFinite((parameters as unknown as JsonRecord)[key]) && Number((parameters as unknown as JsonRecord)[key]) >= 0), "INVALID_POLICY_PARAMETERS");
  requireState(new Set(input.markets.map(m => m.assetSymbol)).size === input.markets.length, "DUPLICATE_MARKET_INPUT");
  const allocations: PortfolioReplayAllocation[] = [];
  const minimumOrders: number[] = [];
  let targetRevisionId: unknown, targetStrategyId: unknown, targetBotId: unknown;
  const seenSymbols = new Set<string>();
  for (const value of array(snapshot.strategies, "strategies")) {
    const strategy = record(value, "strategy");
    unchanged(strategy, t0, "strategy");
    requireState(strategy.portfolioId === portfolio.id, "STRATEGY_PORTFOLIO_MISMATCH");
    const symbol = string(strategy.baseSymbol, "baseSymbol");
    requireState(["BTC", "SOL"].includes(symbol) && !seenSymbols.has(symbol), "UNSUPPORTED_OR_DUPLICATE_ASSET");
    seenSymbols.add(symbol);
    const objective = strategy.objective;
    requireState(objective === "accumulate_base" || objective === "accumulate_usdc", "UNSUPPORTED_OBJECTIVE");
    const market = input.markets.find(m => m.assetSymbol === symbol);
    requireState(market && market.baseMint === strategy.baseMint && market.quoteMint === quoteMint, `MISSING_OR_MISMATCHED_MARKET:${symbol}`);
    requireState([market.provider, market.sourceMarket, market.inputId].every(s => typeof s === "string" && s.trim()), "MISSING_MARKET_PROVENANCE");
    requireState(market.warmupCandles.length >= 20 &&
      +market.warmupCandles.at(-1)!.timestamp + HOUR === t0, `WARMUP_COVERAGE:${symbol}`);
    const strategyAllocations: PortfolioReplayAllocation[] = [];
    for (const bandValue of array(strategy.bands, "bands")) {
      const band = record(bandValue, "band");
      unchanged(band, t0, "band");
      requireState(band.assetStrategyId === strategy.id, "BAND_STRATEGY_MISMATCH");
      requireState(band.status === "ACTIVE" || band.status === "PARKED_BELOW", "UNSUPPORTED_BAND_STATUS");
      requireState(number(band.reservedQuoteAmount, "reservedQuoteAmount") === 0 &&
        array(band.capitalReservations, "band reservations").length === 0, "PENDING_BAND_RESERVATIONS");
      const bot = record(band.bot, "bot");
      requireState(bot.id === band.botId && bot.baseMint === strategy.baseMint && bot.quoteMint === quoteMint &&
        bot.baseSymbol === symbol && bot.quoteSymbol === "USDC" && bot.strategyMode === objective, "BOT_ASSET_OR_OBJECTIVE_MISMATCH");
      requireState((bot.status === "running" || bot.status === "out_of_range") && !bot.archivedAt, "UNSUPPORTED_BOT_STATUS");
      requireState(bot.executionAttempt === null, "PENDING_EXECUTION");
      const config = record(bot.config, "config");
      unchanged(config, t0, "config");
      requireState(config.gridType === "arithmetic" && config.entryMode === "normal", "UNSUPPORTED_GRID_EXECUTION_MODE");
      const position = record(bot.position, "position");
      unchanged(position, t0, "position");
      const states = array(bot.stateSnapshots, "stateSnapshots");
      requireState(states.length === 1, "MISSING_RUNTIME_STATE");
      const state = record(states[0], "runtime state");
      const metadata = record(state.metadata, "metadata");
      requireState(!metadata.pendingSignal && Object.keys(record(metadata.levelLocks, "levelLocks")).length === 0,
        "PENDING_RUNTIME_SIGNAL_OR_LEVEL_LOCK");
      const history = array(metadata.recenterHistory, "recenterHistory");
      requireState(history.every(at => time(at, "recenterHistory") <= t0), "POST_CLOSE_REVISION");
      const revisions = array(band.revisions, "revisions").map(r => record(r, "revision"));
      requireState(revisions.length > 0, "MISSING_REVISION");
      revisions.forEach(revision => {
        requireState(time(revision.createdAt, "revision.createdAt") <= t0 && time(revision.observedAt, "revision.observedAt") <= t0,
          "POST_CLOSE_REVISION");
      });
      revisions.sort((a, b) => number(b.sequence, "sequence") - number(a.sequence, "sequence"));
      const revision = revisions[0]!;
      requireState(revision.gridType === "arithmetic" && revision.bandId === band.id, "UNSUPPORTED_REVISION");
      const lowPrice = number(revision.lowPrice, "lowPrice"), highPrice = number(revision.highPrice, "highPrice");
      const levelCount = number(revision.levelCount, "levelCount");
      requireState(number(config.lowPrice, "config.lowPrice") === lowPrice && number(config.highPrice, "config.highPrice") === highPrice &&
        number(config.levelCount, "config.levelCount") === levelCount, "CONFIG_REVISION_MISMATCH");
      const allocated = number(band.allocatedQuoteAmount, "allocatedQuoteAmount");
      requireState(number(config.reserveQuoteAmount, "reserveQuoteAmount") === 0 &&
        number(config.maxDeployableUsd, "maxDeployableUsd") === allocated, "UNMODELED_BAND_RESERVE_OR_SPEND_LIMIT");
      minimumOrders.push(number(config.minOrderQuoteAmount, "minOrderQuoteAmount"));
      const commitments = array(band.exitCommitments, "exitCommitments").map(c => record(c, "commitment"));
      requireState(new Set(commitments.map(c => c.lotId)).size === commitments.length, "DUPLICATE_EXIT_COMMITMENT");
      commitments.forEach(c => requireState(c.targetStatus === "KNOWN" && c.fulfilledAt === null && c.bandId === band.id &&
        time(c.createdAt, "commitment.createdAt") <= t0, "UNKNOWN_OR_POST_CLOSE_EXIT"));
      const initialLots: PortfolioReplayInitialLot[] = array(bot.positionLots, "positionLots").map(l => {
        const lot = record(l, "lot");
        requireState(lot.botId === bot.id && lot.closedAt === null && time(lot.openedAt, "lot.openedAt") <= t0,
          "INVALID_OR_POST_CLOSE_LOT");
        requireState(lot.kind === "trading" || lot.kind === "retained", "UNSUPPORTED_LOT_KIND");
        const entryPrice = number(lot.entryPrice, "entryPrice");
        let exitPrice = entryPrice, entrySpacing = (highPrice - lowPrice) / (levelCount - 1);
        let economicRule: "accumulate_base" | "accumulate_usdc" = objective;
        if (lot.kind === "trading") {
          const commitment = commitments.find(c => c.lotId === lot.id);
          requireState(commitment, "MISSING_EXIT_COMMITMENT");
          const origin = revisions.find(r => r.id === commitment.originRevisionId);
          requireState(origin && origin.gridType === "arithmetic", "MISSING_OR_UNSUPPORTED_ORIGIN_REVISION");
          exitPrice = number(commitment.sellTargetPrice, "sellTargetPrice");
          entrySpacing = (number(origin.highPrice, "origin.highPrice") - number(origin.lowPrice, "origin.lowPrice")) /
            (number(origin.levelCount, "origin.levelCount") - 1);
          requireState(commitment.economicRule === "accumulate_base" || commitment.economicRule === "accumulate_usdc", "UNSUPPORTED_EXIT_RULE");
          economicRule = commitment.economicRule;
        }
        return { kind: lot.kind, entryPrice, remainingBaseAmount: number(lot.remainingBaseAmount, "remainingBaseAmount"),
          costQuote: number(lot.costQuote, "costQuote"), exitPrice, entrySpacing, economicRule };
      });
      requireState(commitments.length === initialLots.filter(lot => lot.kind === "trading").length, "ORPHAN_EXIT_COMMITMENT");
      requireState(close(initialLots.reduce((sum, lot) => sum + lot.remainingBaseAmount, 0), number(position.baseAmount, "position.baseAmount")) &&
        close(initialLots.reduce((sum, lot) => sum + lot.costQuote, 0), number(band.deployedCostQuote, "deployedCostQuote")), "UNRECONCILED_POSITION");
      if (band.id === input.observation.bandId) {
        targetRevisionId = revision.id; targetStrategyId = strategy.id; targetBotId = bot.id;
      }
      strategyAllocations.push({ bandId: string(band.id, "band.id"), assetSymbol: symbol,
        baseMint: market.baseMint, quoteMint, baseDecimals: number(bot.baseDecimals, "baseDecimals"),
        series: { symbol, pair: `${symbol}/USDC`, resolution: "1h", candles: [] }, warmupCandles: market.warmupCandles,
        initialBudgetUsd: allocated, initialIdleQuoteUsd: number(band.availableQuoteAmount, "availableQuoteAmount"),
        initialRealizedLossUsd: number(band.realizedLossQuote, "realizedLossQuote"), initialLots,
        initialPreviousPrice: market.warmupCandles.at(-1)!.close, lowPrice, highPrice, levelCount,
        initialStatus: band.status === "PARKED_BELOW" ? "parked" : "active",
        initialLastRevisionAt: new Date(time(revision.observedAt, "revision.observedAt")),
        initialRevisionsToday: history.filter(at => new Date(time(at, "recenterHistory")).toISOString().slice(0, 10) === new Date(t0).toISOString().slice(0, 10)).length,
        strategy: objective });
    }
    requireState(strategyAllocations.length > 0 && close(strategyAllocations.reduce((sum, a) => sum + a.initialBudgetUsd, 0),
      number(strategy.allocatedQuoteAmount, "strategy.allocatedQuoteAmount")), "UNRECONCILED_STRATEGY_CAPITAL");
    requireState(close(strategyAllocations.flatMap(a => a.initialLots ?? []).filter(l => l.kind === "retained")
      .reduce((sum, lot) => sum + lot.remainingBaseAmount, 0), number(strategy.retainedBaseAmount, "retainedBaseAmount")), "UNRECONCILED_RETAINED_INVENTORY");
    allocations.push(...strategyAllocations);
  }
  requireState(allocations.length > 0 && allocations.some(a => a.bandId === input.observation.bandId), "MISSING_TARGET_ALLOCATION");
  requireState(new Set(minimumOrders).size === 1, "HETEROGENEOUS_MINIMUM_ORDER");
  const set = record(input.observation.candidateSet, "candidateSet");
  requireState(set.version === "shadow-grid-candidates-v3" || set.version === "shadow-grid-candidates-v3.1",
    "UNSUPPORTED_CANDIDATE_VERSION");
  const candidates = array(set.candidates, "candidates").map(c => record(c, "candidate"));
  requireState(candidates.length > 0 && candidates.length <= 6 && new Set(candidates.map(c => c.id)).size === candidates.length, "INVALID_CANDIDATE_SET");
  const keep = candidates.find(c => c.id === "keep");
  const target = allocations.find(a => a.bandId === input.observation.bandId)!;
  const policyBand = record(policy.band, "policy.band");
  const contextBand = record(context.band, "context.band");
  const contextRevision = record(contextBand.activeRevision, "context.band.activeRevision");
  const targetAllocations = allocations.filter(a => a.assetSymbol === target.assetSymbol);
  const inventoryKey = (lot: JsonRecord) => [lot.kind, number(lot.entryPrice, "policy lot entry"),
    number(lot.remainingBaseAmount, "policy lot amount"), number(lot.costQuote, "policy lot cost")].join("|");
  const policyLots = array(policyBand.openTradingLots, "policy.band.openTradingLots").map(l => inventoryKey(record(l, "policy lot"))).sort();
  const capturedLots = targetAllocations.flatMap(a => a.initialLots ?? []).map(l => inventoryKey(l as unknown as JsonRecord)).sort();
  requireState(time(policy.now, "policy.now") === t0 && number(policy.price, "policy.price") === target.warmupCandles!.at(-1)!.close &&
    source.strategyId === targetStrategyId && source.botId === targetBotId && policy.assetSymbol === target.assetSymbol &&
    policyBand.id === target.bandId && contextBand.id === target.bandId && contextRevision.id === targetRevisionId &&
    number(policyBand.lowPrice, "policy.lowPrice") === target.lowPrice && number(policyBand.highPrice, "policy.highPrice") === target.highPrice &&
    number(policyBand.levelCount, "policy.levelCount") === target.levelCount &&
    number(policyBand.allocatedCapitalUsd, "policy.allocatedCapitalUsd") === target.initialBudgetUsd &&
    close(number(policyBand.idleQuoteUsd, "policy.idleQuoteUsd"), target.initialIdleQuoteUsd!) && policyBand.status === target.initialStatus &&
    number(policy.bandCount, "policy.bandCount") === targetAllocations.length &&
    close(number(policy.availableCashUsd, "policy.availableCashUsd"), freeCashUsd) &&
    close(number(policy.assetAttributedCapitalUsd, "policy.assetAttributedCapitalUsd"), targetAllocations.reduce((sum, a) => sum + a.initialBudgetUsd, 0)) &&
    close(number(policy.totalPortfolioCapitalUsd, "policy.totalPortfolioCapitalUsd"), freeCashUsd + allocations.reduce((sum, a) => sum + a.initialBudgetUsd, 0)) &&
    JSON.stringify(policyLots) === JSON.stringify(capturedLots), "SNAPSHOT_POLICY_STATE_MISMATCH");
  requireState(keep && number(keep.lowPrice, "keep.lowPrice") === target.lowPrice && number(keep.highPrice, "keep.highPrice") === target.highPrice &&
    number(keep.levelCount, "keep.levelCount") === target.levelCount, "SNAPSHOT_CANDIDATE_STATE_MISMATCH");
  const keepDecision = record(keep.decision, "keep.decision") as unknown as PortfolioPolicyDecision;
  requireState(keepDecision.action === "wait", "INVALID_KEEP_DECISION");
  const policyDecision = record(input.observation.proposedDecision, "proposedDecision") as unknown as PortfolioPolicyDecision;
  const selected = candidates.find(c => c.id === input.selectedCandidateId);
  requireState(input.selectedCandidateId === "abstain" || selected, "UNKNOWN_JEV_CANDIDATE");
  const jevDecision = input.selectedCandidateId === "abstain" ? policyDecision :
    record(selected!.decision, "selected.decision") as unknown as PortfolioPolicyDecision;
  return { allocations, freeCashUsd, minOrderQuoteUsd: minimumOrders[0]!, parameters, t0,
    totalStartingCapitalUsd: freeCashUsd + allocations.reduce((sum, a) => sum + a.initialBudgetUsd, 0),
    decisions: { keep: keepDecision, policy: policyDecision, jev: jevDecision } };
}

function metrics(result: PortfolioPolicyReplayResult): ShadowJevV3Metrics {
  const last = result.points.at(-1)!;
  const baseAmountByAsset: Record<string, number> = {}, realizedUsdcByAsset: Record<string, number> = {};
  for (const lot of result.endingLots) baseAmountByAsset[lot.assetSymbol] = (baseAmountByAsset[lot.assetSymbol] ?? 0) + lot.remainingBaseAmount;
  for (const trade of result.trades) realizedUsdcByAsset[trade.assetSymbol] = (realizedUsdcByAsset[trade.assetSymbol] ?? 0) + trade.realizedProfitUsd;
  return { initialEquityUsd: result.initialPoint.equityUsd, equityUsd: last.equityUsd,
    equityBtc: last.priceByAsset.BTC ? last.equityUsd / last.priceByAsset.BTC : null,
    cashUsd: last.cashUsd, inventoryValueUsd: last.equityUsd - last.cashUsd, baseAmountByAsset,
    retainedBaseByAsset: last.retainedBaseByAsset, realizedUsdcByAsset, feesUsd: result.feesUsd,
    slippageCostUsd: result.slippageCostUsd, roundingCostUsd: result.roundingCostUsd, closedCycles: result.closedCycles,
    lockedLotCostUsd: last.tradingCostUsd, openTradingLots: last.openTradingLots };
}
function unchanged(value: JsonRecord, t0: number, path: string) {
  requireState(time(value.updatedAt, `${path}.updatedAt`) <= t0, `POST_CLOSE_MUTATION:${path}`);
  if (value.createdAt !== undefined) requireState(time(value.createdAt, `${path}.createdAt`) <= t0, `POST_CLOSE_CREATION:${path}`);
}
function record(value: unknown, path: string): JsonRecord {
  requireState(value !== null && typeof value === "object" && !Array.isArray(value), `INVALID_OBJECT:${path}`);
  return value as JsonRecord;
}
function array(value: unknown, path: string): unknown[] {
  requireState(Array.isArray(value), `INVALID_ARRAY:${path}`); return value;
}
function string(value: unknown, path: string): string {
  requireState(typeof value === "string" && value.trim(), `INVALID_STRING:${path}`); return value;
}
function number(value: unknown, path: string): number {
  requireState((typeof value === "number" || (typeof value === "string" && value.trim())) &&
    Number.isFinite(Number(value)) && Number(value) >= 0, `INVALID_NUMBER:${path}`); return Number(value);
}
function time(value: unknown, path: string): number {
  requireState(value instanceof Date || typeof value === "string", `INVALID_TIME:${path}`);
  const parsed = +new Date(value); requireState(Number.isFinite(parsed), `INVALID_TIME:${path}`); return parsed;
}
function close(a: number, b: number) { return Math.abs(a - b) <= 1e-8; }
function reason(error: unknown) { return error instanceof Censored ? error.message : `REPLAY_REJECTED:${error instanceof Error ? error.message : "unknown"}`; }
