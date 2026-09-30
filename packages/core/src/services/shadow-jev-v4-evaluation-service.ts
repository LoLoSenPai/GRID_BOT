import type { PortfolioPolicyDecision } from "./portfolio-policy-service";
import { PortfolioPolicyReplayService, type PortfolioReplayCashflow, type PortfolioPolicyReplayResult,
  type PortfolioReplayExecutionCosts } from "./portfolio-policy-replay-service";
import { prepareShadowJevV3Replay, shadowReplayMetrics, type ShadowJevV3EvaluationRequest, type ShadowJevV3Metrics } from "./shadow-jev-v3-evaluation-service";
import type { ShadowDecisionCandidateSet } from "./shadow-decision-candidate-service";
import type { HistoricalCandle } from "../domain/types";

const HOUR = 3_600_000, HORIZONS = [1, 3, 6, 24] as const;
export interface ShadowJevV4EvaluationRequest extends Omit<ShadowJevV3EvaluationRequest, "selectedCandidateId" | "markets"> {
  markets: Array<ShadowJevV3EvaluationRequest["markets"][number] & { futureExecutionCandles?: HistoricalCandle[] }>;
  selectedGridCandidateId: string; selectedExitCandidateId: string; decisionAvailableAt: Date | string;
  cashflows?: PortfolioReplayCashflow[];
}
export interface ShadowJevV4Metrics extends ShadowJevV3Metrics {
  externalCashflowUsd: number; equityChangeExcludingCashflowsUsd: number; maxDrawdownPct: number;
  exitRevisions: number; exitRevisionAppliedAt: string | null;
}
export interface ShadowJevV4EvaluationResult {
  version: "shadow-jev-v4-evaluation-v1"; mode: "single_delayed_shadow_intervention";
  status: "evaluated" | "partial" | "censored"; reasons: string[]; assumptions: string[];
  decisionAvailableAt: string | null; costProfile: ShadowDecisionCandidateSet["costProfile"];
  horizons: Array<{ hours: typeof HORIZONS[number]; status: "evaluated" | "censored"; reasons: string[];
    branches?: Record<"keep" | "currentPolicy" | "gridOnly" | "exitOnly" | "combined", ShadowJevV4Metrics> }>;
  provenance: Array<{ assetSymbol: string; baseMint: string; quoteMint: string; provider: string; sourceMarket: string; inputId: string }>;
}

/** Recorded decisions affect only replay-owned state, once their complete response is available. */
export class ShadowJevV4EvaluationService {
  constructor(private readonly replay = new PortfolioPolicyReplayService()) {}
  evaluate(input: ShadowJevV4EvaluationRequest): ShadowJevV4EvaluationResult {
    const set = input.observation.candidateSet as ShadowDecisionCandidateSet;
    const output: ShadowJevV4EvaluationResult = { version: "shadow-jev-v4-evaluation-v1",
      mode: "single_delayed_shadow_intervention", status: "censored", reasons: [], decisionAvailableAt: null,
      costProfile: set?.costProfile ?? null, horizons: [], provenance: input.markets.map(({ assetSymbol, baseMint, quoteMint,
        provider, sourceMarket, inputId }) => ({ assetSymbol, baseMint, quoteMint, provider, sourceMarket, inputId })),
      assumptions: ["One intervention, followed by the existing deterministic hourly policy in every branch; no continuous Jev expert is simulated.",
        "Synthetic OHLC fills, on five-minute candles when all assets have complete execution coverage, otherwise hourly. Policy cadence remains hourly. Intervention starts at the first full execution candle open after availability.",
        "Observed asset costs, when usable, are a conservative model with safety margin; provider quotes and fill guarantees are not modeled.",
        "All branches receive identical dated external cashflows, which are excluded from reported equity change.",
        "USDC is valued at one USD. Native SOL reserve is excluded from modeled equity and spendable quote cash.",
        "Public candles remain a market proxy; exact declared mint provenance does not prove execution liquidity."] };
    try {
      ensure(set?.version === "shadow-decisions-v4" && set.grid && set.exit?.version === "shadow-exits-v1", "UNSUPPORTED_V4_CANDIDATE_VERSION");
      ensure(Array.isArray(set.exit.candidates) && set.exit.candidates.length > 0 && set.exit.candidates.length <= 3 &&
        new Set(set.exit.candidates.map(c => c.id)).size === set.exit.candidates.length, "INVALID_EXIT_CANDIDATE_SET");
      const keepExit = set.exit.candidates.find(c => c.id === "keep");
      ensure(keepExit?.kind === "keep" && Array.isArray(keepExit.updates) && keepExit.updates.length === 0, "INVALID_KEEP_EXIT");
      const exitId = input.selectedExitCandidateId === "abstain" ? "keep" : input.selectedExitCandidateId;
      const exit = set.exit.candidates.find(c => c.id === exitId);
      ensure(exit && Array.isArray(exit.updates), "UNKNOWN_JEV_EXIT_CANDIDATE");
      const prepared = prepareShadowJevV3Replay({ ...input, selectedCandidateId: input.selectedGridCandidateId,
        observation: { ...input.observation, candidateSet: set.grid } });
      const { allocations, freeCashUsd, totalStartingCapitalUsd, minOrderQuoteUsd, parameters, decisions, t0 } = prepared;
      const context = input.observation.context as Record<string, any>, capturedAt = +new Date(context.shadowReplayV3.capturedAt);
      const availableAt = +new Date(input.decisionAvailableAt);
      ensure(Number.isFinite(availableAt) && availableAt >= capturedAt && availableAt >= t0, "DECISION_AVAILABILITY_PRECEDES_CAPTURE");
      output.decisionAvailableAt = new Date(availableAt).toISOString();
      const executionCostsByAsset: Record<string, PortfolioReplayExecutionCosts> = {};
      const profile = set.costProfile, target = allocations.find(a => a.bandId === input.observation.bandId)!;
      let usable = false;
      if (profile?.usable) {
        ensure(profile.count >= 5 && profile.assetSymbol === target.assetSymbol && profile.baseMint === target.baseMint &&
          profile.quoteMint === target.quoteMint && profile.botId === context.shadowReplayV3.source.botId &&
          profile.portfolioId === context.shadowReplayV3.source.portfolioId &&
          Number.isFinite(+new Date(profile.asOf)) && +new Date(profile.asOf) <= t0 &&
          [profile.feeBps, profile.adverseSlippageBps, profile.p90NativeFeeUsd, profile.safetyMarginBps]
            .every(v => typeof v === "number" && Number.isFinite(v) && v >= 0) &&
          minOrderQuoteUsd >= profile.notionalBucket.minUsd && minOrderQuoteUsd < profile.notionalBucket.maxUsd,
        "INVALID_OR_NONCAUSAL_COST_PROFILE");
        executionCostsByAsset[profile.assetSymbol] = { feeBps: profile.feeBps!,
          slippageBps: profile.adverseSlippageBps! + profile.safetyMarginBps, nativeFeeUsd: profile.p90NativeFeeUsd!,
          notionalBucket: profile.notionalBucket };
        usable = true;
      }
      ensure(usable || exit.updates.length === 0, "EXIT_ADAPTATION_REQUIRES_OBSERVED_COSTS");
      const policyInput = input.observation.policyInput as Record<string, any>;
      const history = input.markets.find(m => m.assetSymbol === target.assetSymbol)!.warmupCandles.slice(-20);
      const amplitudePct = history.length >= 14 ? (Math.max(...history.map(c => c.high)) - Math.min(...history.map(c => c.low))) /
        Number(policyInput.price) * 100 : NaN;
      const volatilityPct = Number(policyInput.indicators?.atrPct ?? (history.length >= 14
        ? history.slice(-14).reduce((sum, c) => sum + (c.high - c.low) / c.close * 100, 0) / 14 : NaN));
      const exitMoveClampPct = Math.min(5, amplitudePct / 2, volatilityPct * 2);
      for (const update of exit.updates) {
        const source = target.initialLots?.find(l => l.sourceLotId === update.sourceLotId);
        ensure(source?.kind === "trading" && update.bandId === target.bandId && source.exitPrice === update.oldTargetPrice &&
          source.costQuote === update.costQuote && source.remainingBaseAmount === update.remainingBaseAmount &&
          source.economicRule === update.economicRule, "EXIT_CANDIDATE_CAPTURE_STATE_MISMATCH");
        const notional = update.economicRule === "accumulate_base" ? update.costQuote : update.remainingBaseAmount * update.newTargetPrice;
        ensure(profile && notional >= profile.notionalBucket.minUsd && notional < profile.notionalBucket.maxUsd,
          "EXIT_CANDIDATE_OUTSIDE_OBSERVED_NOTIONAL_BUCKET");
        ensure(Number.isFinite(exitMoveClampPct) && exitMoveClampPct > 0 &&
          Math.abs(update.newTargetPrice / update.oldTargetPrice - 1) * 100 <= exitMoveClampPct + 1e-7 &&
          (exit.kind === "closer" ? update.newTargetPrice < update.oldTargetPrice : exit.kind === "farther" &&
            update.newTargetPrice > update.oldTargetPrice), "EXIT_CANDIDATE_VOLATILITY_BOUND_MISMATCH");
        ensure(update.economicRule === "accumulate_usdc"
          ? update.minimumNetGainUsd >= Math.max(0.05, source.costQuote * 0.001) && update.minimumRetainedBaseAmount === 0
          : update.minimumRetainedBaseAmount >= Math.max(2 / 10 ** (target.baseDecimals ?? 8),
            source.remainingBaseAmount * 0.001, 0.05 / Number(policyInput.price)), "EXIT_CANDIDATE_ECONOMIC_FLOOR_MISMATCH");
      }
      for (const hours of HORIZONS) {
        try {
          const end = t0 + hours * HOUR;
          ensure(availableAt < end, "DECISION_UNAVAILABLE_WITHIN_HORIZON");
          const fine = input.markets.some(m => m.futureExecutionCandles !== undefined), executionInterval = fine ? 300_000 : HOUR;
          ensure(Math.ceil(availableAt / executionInterval) * executionInterval < end, "DECISION_DEFERRED_BEYOND_HORIZON");
          const ready = allocations.map(a => {
            const market = input.markets.find(m => m.assetSymbol === a.assetSymbol)!;
            const future = market.futureCandles.filter(c => +c.timestamp >= t0 && +c.timestamp < end);
            ensure(future.length === hours && future.every((c, i) => +c.timestamp === t0 + i * HOUR), `FUTURE_COVERAGE:${a.assetSymbol}:${hours}h`);
            const execution = market.futureExecutionCandles?.filter(c => +c.timestamp >= t0 && +c.timestamp < end);
            if (fine) ensure(execution?.length === hours * 12 && execution.every((c, i) => +c.timestamp === t0 + i * 300_000),
              `EXECUTION_FUTURE_COVERAGE:${a.assetSymbol}:${hours}h`);
            return { ...a, series: { ...a.series, candles: future }, executionSeries: fine
              ? { ...a.series, resolution: "5m", candles: execution! } : undefined };
          });
          const run = (decision: PortfolioPolicyDecision, candidateId: string, changeExits: boolean) => v4Metrics(this.replay.replay({
            allocations: ready, totalStartingCapitalUsd, freeCashUsd, policyParameters: parameters, feeBps: input.feeBps,
            slippageBps: input.slippageBps, nativeFeeUsd: input.nativeFeeUsd, executionCostsByAsset,
            candleIntervalMs: HOUR, minOrderQuoteUsd, adaptive: true,
            cashflows: input.cashflows?.filter(f => +f.at < end),
            timedIntervention: { availableAt: new Date(availableAt),
              grid: { bandId: input.observation.bandId, decision, candidateId }, exitUpdates: changeExits ? exit.updates : [] },
          }));
          output.horizons.push({ hours, status: "evaluated", reasons: [], branches: {
            keep: run(decisions.keep, "keep", false), currentPolicy: run(decisions.policy, "policy", false),
            gridOnly: run(decisions.jev, input.selectedGridCandidateId, false),
            exitOnly: run(decisions.policy, "policy", true), combined: run(decisions.jev, input.selectedGridCandidateId, true) } });
        } catch (error) { output.horizons.push({ hours, status: "censored", reasons: [message(error)] }); }
      }
      const evaluated = output.horizons.filter(h => h.status === "evaluated").length;
      output.status = evaluated === HORIZONS.length ? "evaluated" : evaluated > 0 ? "partial" : "censored";
      output.reasons = [...new Set(output.horizons.flatMap(h => h.reasons))];
    } catch (error) { output.reasons = [message(error)]; output.horizons = HORIZONS.map(hours => ({ hours,
      status: "censored", reasons: [...output.reasons] })); }
    return output;
  }
}
function v4Metrics(result: PortfolioPolicyReplayResult): ShadowJevV4Metrics {
  let peak = result.initialPoint.equityUsd, maxDrawdownPct = 0;
  for (const point of result.points) {
    const flows = result.cashflows.filter(f => +f.at <= +point.timestamp).reduce((sum, f) => sum + f.amountUsd, 0);
    const equity = point.equityUsd - flows;
    peak = Math.max(peak, equity); if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
  }
  const changes = result.exitUpdates.filter(u => u.status === "applied");
  return { ...shadowReplayMetrics(result), externalCashflowUsd: result.externalCashflowUsd,
    equityChangeExcludingCashflowsUsd: result.endingEquityUsd - result.initialPoint.equityUsd - result.externalCashflowUsd,
    maxDrawdownPct, exitRevisions: changes.length, exitRevisionAppliedAt: changes[0]?.appliedAt.toISOString() ?? null };
}
function ensure(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function message(error: unknown) { return error instanceof Error ? error.message : "REPLAY_REJECTED:unknown"; }
