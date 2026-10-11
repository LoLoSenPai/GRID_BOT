import type { PortfolioPolicyDecision } from "./portfolio-policy-service";
import { PortfolioPolicyReplayService, type PortfolioReplayCashflow, type PortfolioPolicyReplayResult,
  type PortfolioReplayExecutionCosts, type PortfolioReplayExecutionFidelity,
  type PortfolioReplayExecutionDiagnostics } from "./portfolio-policy-replay-service";
import { prepareShadowJevV3Replay, shadowReplayMetrics, type ShadowJevV3EvaluationRequest, type ShadowJevV3Metrics } from "./shadow-jev-v3-evaluation-service";
import type { ShadowDecisionCandidateSet } from "./shadow-decision-candidate-service";
import type { HistoricalCandle } from "../domain/types";
import type { ShadowInventoryReconciliation } from "./shadow-inventory-reconciliation-service";
import type { ShadowBandCapitalReconciliation } from "./shadow-band-capital-reconciliation-service";

const HOUR = 3_600_000, HORIZONS = [1, 3, 6, 24] as const;
export interface ShadowJevV4EvaluationRequest extends Omit<ShadowJevV3EvaluationRequest, "selectedCandidateId" | "markets"> {
  markets: Array<ShadowJevV3EvaluationRequest["markets"][number] & { futureExecutionCandles?: HistoricalCandle[] }>;
  selectedGridCandidateId: string; selectedExitCandidateId: string; decisionAvailableAt: Date | string;
  cashflows?: PortfolioReplayCashflow[];
  /** Opt in; historical callers retain the original extreme/multiple-fill model. */
  executionFidelity?: PortfolioReplayExecutionFidelity & { compareOhlcPaths?: boolean };
  /** Matching delays the causal dense rule to the actual Jev response's first full candle. */
  comparisonClock?: "recorded_latency" | "matched_next_candle";
}
export interface ShadowJevV4Metrics extends ShadowJevV3Metrics {
  externalCashflowUsd: number; equityChangeExcludingCashflowsUsd: number; maxDrawdownPct: number;
  exitRevisions: number; exitRevisionAppliedAt: string | null;
  gridRevisions: number; bandsCreated: number;
  executionDiagnostics: PortfolioReplayExecutionDiagnostics;
}
export type ShadowJevV4Branch = "keep" | "currentPolicy" | "denseRule" | "gridOnly" | "exitOnly" | "combined";
export interface ShadowJevV4EvaluationResult {
  version: "shadow-jev-v4-evaluation-v2" | "shadow-jev-v4-evaluation-v3"; mode: "single_delayed_shadow_intervention";
  inventoryReconciliation: ShadowInventoryReconciliation[];
  capitalReconciliation: ShadowBandCapitalReconciliation[];
  policyBaselineSource: "recorded_engine_outcome" | "frozen_proposal_assumption" | "reference_no_adaptation_assumption";
  status: "evaluated" | "partial" | "censored"; reasons: string[]; assumptions: string[];
  decisionAvailableAt: string | null; costProfile: ShadowDecisionCandidateSet["costProfile"];
  executionFidelity?: { model: PortfolioReplayExecutionFidelity["model"]; primaryPath: "high_low" | "low_high";
    stateAvailableAt: string;
    comparisonClock: "recorded_latency" | "matched_next_candle"; constraintsByBand: PortfolioReplayExecutionFidelity["constraintsByBand"];
    denseRuleCandidateId: string | null; denseRuleSource: "captured_valid_density" | ShadowJevV4EvaluationResult["policyBaselineSource"] };
  horizons: Array<{ hours: typeof HORIZONS[number]; status: "evaluated" | "censored"; reasons: string[];
    executionResolution?: "5m" | "1h";
    interventionTiming?: { jevFirstFullCandleAt: string; denseRuleFirstFullCandleAt: string; matched: boolean };
    /** These are two deterministic path scenarios, not bounds over every possible intrabar sequence. */
    ohlcPathSensitivity?: { alternativePath: "high_low" | "low_high"; alternativeBranches: Partial<Record<ShadowJevV4Branch, ShadowJevV4Metrics>>;
      equityRangeUsd: Partial<Record<ShadowJevV4Branch, { min: number; max: number }>> };
    branches?: Record<"keep" | "currentPolicy" | "gridOnly" | "exitOnly" | "combined", ShadowJevV4Metrics> &
      Partial<Record<"denseRule", ShadowJevV4Metrics>> }>;
  provenance: Array<{ assetSymbol: string; baseMint: string; quoteMint: string; provider: string; sourceMarket: string; inputId: string }>;
}

/** Recorded decisions affect only replay-owned state, once their complete response is available. */
export class ShadowJevV4EvaluationService {
  constructor(private readonly replay = new PortfolioPolicyReplayService()) {}
  evaluate(input: ShadowJevV4EvaluationRequest): ShadowJevV4EvaluationResult {
    const set = input.observation.candidateSet as ShadowDecisionCandidateSet;
    const fidelity = input.executionFidelity;
    const output: ShadowJevV4EvaluationResult = { version: fidelity ? "shadow-jev-v4-evaluation-v3" : "shadow-jev-v4-evaluation-v2",
      inventoryReconciliation: [], capitalReconciliation: [], policyBaselineSource: input.observation.initialEngineDecision === undefined
        ? "frozen_proposal_assumption" : "recorded_engine_outcome",
      mode: "single_delayed_shadow_intervention", status: "censored", reasons: [], decisionAvailableAt: null,
      costProfile: set?.costProfile ?? null, horizons: [], provenance: input.markets.map(({ assetSymbol, baseMint, quoteMint,
        provider, sourceMarket, inputId }) => ({ assetSymbol, baseMint, quoteMint, provider, sourceMarket, inputId })),
      assumptions: ["KEEP is a fixed-entry-grid baseline. currentPolicy continues autonomously at each hourly close. Jev branches share the initial engine decision, then apply a single delayed intervention and continue the hourly policy; no continuous Jev expert is simulated.",
        "Synthetic OHLC fills on five-minute candles with complete coverage. If no five-minute future candles exist for any asset, hourly fills are explicitly used; partial fine coverage stays censored. Intervention starts at the first full execution candle open after availability.",
        "Receipt reconciliation is reconstructed after capture from exhaustive persisted execution reads, not part of the original immutable observation; it does not attest on-chain completeness.",
        "Observed asset costs, when usable, are a conservative model with safety margin; provider quotes and fill guarantees are not modeled.",
        "All branches receive identical dated external cashflows, which are excluded from reported equity change.",
        "USDC is valued at one USD. Native SOL reserve is excluded from modeled equity and spendable quote cash.",
        "Public candles remain a market proxy; exact declared mint provenance does not prove execution liquidity."] };
    output.assumptions.push("The non-target asset warmup is reconstructed from the later cache; availability/version at t0 is not attested. This is a conditional historical-price replay, not a complete reconstruction of live information availability.");
    if (fidelity) {
      output.assumptions[0] = "All branches share the recorded engine decision at t0 (or the flagged frozen-proposal assumption). KEEP freezes entry geometry after that decision; the other branches continue hourly policy. DenseRule chooses the captured economically valid v4_vol_cost_density once, otherwise follows currentPolicy, independently of Jev and future returns. Existing lot exits are preserved.";
      output.assumptions[1] = "rail_one_intent_v1: at most one modeled execution per bot/band per full execution candle, at the crossed entry rail or committed exit target with adverse slippage, never at a favorable low/high extreme. high_low and low_high are deterministic synthetic paths; interpolation only assigns modeled crossing times.";
      output.assumptions.push("Captured optional constraints gate buys on cooldown, rolling-hour executions (buys and sells), entry-level locks, deployable capital and drawdown; blockedUntil gates both sides. Missing constraints remain unmodeled. Future execution failures, pending signals, price-feed polling and exact live quotes are not reconstructed.",
        "Every branch, including KEEP and currentPolicy, suppresses all modeled fills from execution candles opened before captured state availability. A candle overlapping capture is skipped in full; marks, cashflows and hourly policy observations continue progressing.",
        "Fees include the native cost once. Observed cost profiles apply only within their declared wallet-notional bucket; trades outside it use explicit configured estimates and are counted. Fees modeled from an observed profile are estimates, not realized receipts.",
        "The primary OHLC order is frozen before replay. The optional second OHLC order is sensitivity evidence only; its min/max are not guaranteed bounds across arbitrary intrabar paths.");
    }
    try {
      ensure(["shadow-decisions-v4", "shadow-decisions-v4.1", "shadow-decisions-v4.2"].includes(set?.version) && set.grid && set.exit?.version === "shadow-exits-v1", "UNSUPPORTED_V4_CANDIDATE_VERSION");
      ensure(Array.isArray(set.exit.candidates) && set.exit.candidates.length > 0 && set.exit.candidates.length <= 3 &&
        new Set(set.exit.candidates.map(c => c.id)).size === set.exit.candidates.length, "INVALID_EXIT_CANDIDATE_SET");
      const keepExit = set.exit.candidates.find(c => c.id === "keep");
      ensure(keepExit?.kind === "keep" && Array.isArray(keepExit.updates) && keepExit.updates.length === 0, "INVALID_KEEP_EXIT");
      const exitId = input.selectedExitCandidateId === "abstain" ? "keep" : input.selectedExitCandidateId;
      const exit = set.exit.candidates.find(c => c.id === exitId);
      ensure(exit && Array.isArray(exit.updates), "UNKNOWN_JEV_EXIT_CANDIDATE");
      const prepared = prepareShadowJevV3Replay({ ...input, selectedCandidateId: input.selectedGridCandidateId,
        observation: { ...input.observation, candidateSet: set.grid } }, output.inventoryReconciliation, output.capitalReconciliation);
      const { allocations, freeCashUsd, totalStartingCapitalUsd, minOrderQuoteUsd, parameters, decisions, t0 } = prepared;
      const context = input.observation.context as Record<string, any>, capturedAt = +new Date(context.shadowReplayV3.capturedAt);
      // The deterministic rule needs the captured state/candidates too. Candle t0 alone does not attest their availability.
      const stateReadyAt = Math.max(capturedAt, +new Date(context.shadowTiming.stateReadAt));
      const availableAt = +new Date(input.decisionAvailableAt);
      ensure(Number.isFinite(availableAt) && availableAt >= stateReadyAt && availableAt >= t0, "DECISION_AVAILABILITY_PRECEDES_CAPTURE");
      output.decisionAvailableAt = new Date(availableAt).toISOString();
      const engineDecision = (input.observation.initialEngineDecision ?? decisions.policy) as PortfolioPolicyDecision;
      ensure(!input.comparisonClock || ["recorded_latency", "matched_next_candle"].includes(input.comparisonClock), "INVALID_COMPARISON_CLOCK");
      const density = fidelity ? set.grid.candidates.find(c => c.id === "v4_vol_cost_density" && c.economicallyValid === true &&
        c.validation === "validated" && c.economicValidationReasons.length === 0) : undefined;
      if (fidelity) output.executionFidelity = { model: fidelity.model, primaryPath: fidelity.intrabarPath ?? "high_low",
        stateAvailableAt: new Date(stateReadyAt).toISOString(),
        comparisonClock: input.comparisonClock ?? "recorded_latency", constraintsByBand: fidelity.constraintsByBand,
        denseRuleCandidateId: density?.id ?? null, denseRuleSource: density ? "captured_valid_density" : output.policyBaselineSource };
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
          const fine = input.markets.some(m => m.futureExecutionCandles?.length), executionInterval = fine ? 300_000 : HOUR;
          const firstWholeAfterT0 = t0 + executionInterval;
          const jevOpen = Math.max(fidelity ? firstWholeAfterT0 : t0, Math.ceil(availableAt / executionInterval) * executionInterval);
          const denseOpen = input.comparisonClock === "matched_next_candle" ? jevOpen
            : Math.max(firstWholeAfterT0, Math.ceil(stateReadyAt / executionInterval) * executionInterval);
          ensure(jevOpen < end, "DECISION_DEFERRED_BEYOND_HORIZON");
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
          const run = (branch: ShadowJevV4Branch, intrabarPath = fidelity?.intrabarPath ?? "high_low") => {
            const changeGrid = ((branch === "gridOnly" || branch === "combined") && input.selectedGridCandidateId !== "abstain") ||
              (branch === "denseRule" && density !== undefined);
            const changeExits = branch === "exitOnly" || branch === "combined";
            const timed = changeGrid || (changeExits && exit.updates.length > 0);
            return v4Metrics(this.replay.replay({
            allocations: ready, totalStartingCapitalUsd, freeCashUsd, policyParameters: parameters, feeBps: input.feeBps,
            slippageBps: input.slippageBps, nativeFeeUsd: input.nativeFeeUsd, executionCostsByAsset,
            executionFidelity: fidelity ? { ...fidelity, intrabarPath, stateAvailableAt: new Date(stateReadyAt) } : undefined,
            candleIntervalMs: HOUR, minOrderQuoteUsd, adaptive: branch !== "keep",
            cashflows: input.cashflows?.filter(f => +f.at < end),
            initialIntervention: branch === "keep" && !fidelity ? undefined : { bandId: input.observation.bandId,
              observedAt: new Date(t0), decision: engineDecision, candidateId: "engine_t0" },
            timedIntervention: timed ? { availableAt: new Date(fidelity ? branch === "denseRule" ? denseOpen : jevOpen : availableAt),
              grid: changeGrid ? { bandId: input.observation.bandId, decision: branch === "denseRule" ? density!.decision : decisions.jev,
                candidateId: branch === "denseRule" ? density!.id : input.selectedGridCandidateId } : undefined,
              exitUpdates: changeExits ? exit.updates : [] } : undefined,
          })); };
          const branches: NonNullable<ShadowJevV4EvaluationResult["horizons"][number]["branches"]> = {
            keep: run("keep"), currentPolicy: run("currentPolicy"), gridOnly: run("gridOnly"),
            exitOnly: run("exitOnly"), combined: run("combined") };
          if (fidelity) branches.denseRule = run("denseRule");
          let ohlcPathSensitivity: ShadowJevV4EvaluationResult["horizons"][number]["ohlcPathSensitivity"];
          if (fidelity?.compareOhlcPaths) {
            const alternativePath = (fidelity.intrabarPath ?? "high_low") === "high_low" ? "low_high" : "high_low";
            const entries = (Object.keys(branches) as ShadowJevV4Branch[]).map(branch => [branch, run(branch, alternativePath)] as const);
            ohlcPathSensitivity = { alternativePath, alternativeBranches: Object.fromEntries(entries),
              equityRangeUsd: Object.fromEntries(entries.map(([branch, alternative]) => [branch, {
                min: Math.min(branches[branch]!.equityUsd, alternative.equityUsd),
                max: Math.max(branches[branch]!.equityUsd, alternative.equityUsd) }])) };
          }
          output.horizons.push({ hours, status: "evaluated", reasons: [], executionResolution: fine ? "5m" : "1h", branches,
            ...(fidelity ? { interventionTiming: { jevFirstFullCandleAt: new Date(jevOpen).toISOString(),
              denseRuleFirstFullCandleAt: new Date(denseOpen).toISOString(), matched: denseOpen === jevOpen } } : {}),
            ...(ohlcPathSensitivity ? { ohlcPathSensitivity } : {}) });
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
    maxDrawdownPct, exitRevisions: changes.length, exitRevisionAppliedAt: changes[0]?.appliedAt.toISOString() ?? null,
    gridRevisions: result.actions.filter(a => a.action === "revise").length,
    bandsCreated: result.actions.filter(a => a.action === "create_band").length,
    executionDiagnostics: result.executionDiagnostics };
}
function ensure(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function message(error: unknown) { return error instanceof Error ? error.message : "REPLAY_REJECTED:unknown"; }
