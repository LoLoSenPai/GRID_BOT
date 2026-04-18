import type {
  MarketRegime,
  StrategyDescriptor,
  StrategyCandidateScore,
  StrategyFamily,
  StrategyPosture,
  StrategySelectionDecision,
  StrategySelectionInput
} from "../domain/types";
import { round } from "../utils/math";
import { StrategyRegistryService } from "./strategy-registry-service";

export class StrategySelectionService {
  private readonly registryService: StrategyRegistryService;

  constructor(registryService = new StrategyRegistryService()) {
    this.registryService = registryService;
  }

  select(input: StrategySelectionInput): StrategySelectionDecision {
    const registry = this.registryService.list();
    const candidates = scoreCandidates(input, registry);
    candidates.sort((left, right) => right.score - left.score);
    const recommended =
      candidates[0] ??
      buildCandidateScore(registry, "range_grid", 0.2, "Fallback to range grid until signals are available.");
    const posture = choosePosture(input, recommended.family);
    const confidence = computeConfidence(candidates);
    const activeLiveFamily = getActiveLiveFamily(recommended.family, registry);

    return {
      recommendedFamily: recommended.family,
      activeLiveFamily,
      posture,
      confidence,
      operatorAction: buildOperatorAction(input.marketRegime.regime, recommended.family, posture),
      reasons: buildReasons(input, recommended.family),
      candidates,
      registry
    };
  }
}

function scoreCandidates(input: StrategySelectionInput, registry: StrategyDescriptor[]): StrategyCandidateScore[] {
  const regime = input.marketRegime.regime;
  const rangePlan = input.rangePlan;
  const metrics = input.validationMetrics ?? null;
  const timeInRange = metrics?.timeInRangePct ?? 0;
  const maxOccupancy = metrics?.maxOccupancyPct ?? 100;
  const drawdown = metrics?.maxDrawdownPct ?? 0;
  const closedCycles = metrics?.closedCycleCount ?? 0;

  let rangeScore = regime === "RANGE" ? 0.55 : 0.22;
  rangeScore += input.marketRegime.confidence * (regime === "RANGE" ? 0.25 : 0.08);
  rangeScore += rangePlan.risk === "low" ? 0.12 : rangePlan.risk === "medium" ? 0.04 : -0.1;
  rangeScore += timeInRange >= 70 ? 0.12 : timeInRange >= 50 ? 0.04 : -0.08;
  rangeScore += maxOccupancy <= 85 ? 0.06 : maxOccupancy <= 95 ? -0.02 : -0.12;
  rangeScore += closedCycles > 0 ? 0.04 : -0.03;
  rangeScore -= drawdown >= 12 ? 0.08 : 0;

  let trendScore = regime === "TREND_UP" ? 0.5 : regime === "TREND_DOWN" ? 0.42 : 0.1;
  trendScore += input.marketRegime.confidence * (regime === "TREND_UP" || regime === "TREND_DOWN" ? 0.28 : 0.04);
  trendScore -= rangePlan.risk === "high" ? 0.02 : 0;

  let defenseScore = regime === "CHAOTIC_HIGH_VOL" ? 0.62 : regime === "TREND_DOWN" ? 0.34 : 0.12;
  defenseScore += input.marketRegime.confidence * (regime === "CHAOTIC_HIGH_VOL" ? 0.22 : 0.08);
  defenseScore += rangePlan.risk === "high" ? 0.14 : 0;
  defenseScore += maxOccupancy > 95 ? 0.12 : maxOccupancy > 85 ? 0.06 : 0;
  defenseScore += timeInRange < 50 ? 0.1 : 0;
  defenseScore += drawdown >= 12 ? 0.08 : 0;

  return [
    buildCandidateScore(registry, "range_grid", rangeScore, "Specialized for range conditions and repeated adjacent cycles."),
    buildCandidateScore(registry, "trend_following", trendScore, "Future candidate for directional regimes; not implemented for live execution yet."),
    buildCandidateScore(registry, "capital_defense", defenseScore, "Prioritizes preserving quote and avoiding new exposure in fragile regimes.")
  ];
}

function buildCandidateScore(registry: StrategyDescriptor[], family: StrategyFamily, rawScore: number, reason: string): StrategyCandidateScore {
  const descriptor = registry.find((candidate) => candidate.family === family);

  return {
    family,
    score: normalizeScore(rawScore),
    reason,
    readiness: descriptor?.readiness ?? "planned",
    liveEnabled: descriptor?.liveEnabled ?? false
  };
}

function choosePosture(input: StrategySelectionInput, family: StrategyFamily): StrategyPosture {
  const regime = input.marketRegime.regime;
  const metrics = input.validationMetrics ?? null;
  const timeInRange = metrics?.timeInRangePct ?? 0;
  const maxOccupancy = metrics?.maxOccupancyPct ?? 100;

  if (family === "capital_defense") {
    return regime === "CHAOTIC_HIGH_VOL" || maxOccupancy > 95 ? "pause" : "caution";
  }

  if (family === "trend_following") {
    return "watch";
  }

  if (regime === "RANGE" && input.rangePlan.risk === "low" && timeInRange >= 70 && maxOccupancy <= 85) {
    return "active";
  }

  return "caution";
}

function buildOperatorAction(regime: MarketRegime, family: StrategyFamily, posture: StrategyPosture) {
  if (family === "range_grid" && posture === "active") {
    return "Range grid is the preferred model here. Replay the adaptive plan, then recreate manually only if validation stays healthy.";
  }

  if (family === "range_grid") {
    return "Range grid can still run, but keep it defensive: no automatic recenter, watch occupancy, and recreate on confirmed range break.";
  }

  if (family === "trend_following") {
    return "Trend logic is not live-ready yet. Treat this as a signal to avoid dense range farming until the future trend module exists.";
  }

  return regime === "CHAOTIC_HIGH_VOL"
    ? "Pause new exposure in this regime. Recovery sells are useful, but new range buys are fragile."
    : "Prefer capital defense over adding exposure. Wait for range conditions to return before recreating a grid.";
}

function buildReasons(input: StrategySelectionInput, family: StrategyFamily) {
  const reasons = [
    `Detected regime is ${input.marketRegime.regime} with ${Math.round(input.marketRegime.confidence * 100)}% confidence.`,
    `Adaptive range risk is ${input.rangePlan.risk}.`
  ];

  if (input.validationMetrics) {
    reasons.push(`Validation stayed in range ${round(input.validationMetrics.timeInRangePct, 1)}% of the time.`);
    reasons.push(`Max occupancy reached ${round(input.validationMetrics.maxOccupancyPct, 1)}%.`);
  }

  if (family === "trend_following") {
    reasons.push("Trend family is only a placeholder in this phase; the live bot remains grid-only.");
  }

  return reasons;
}

function getActiveLiveFamily(recommendedFamily: StrategyFamily, registry: StrategyDescriptor[]): StrategyFamily {
  const recommended = registry.find((candidate) => candidate.family === recommendedFamily);
  return recommended?.liveEnabled ? recommended.family : "range_grid";
}

function computeConfidence(candidates: StrategyCandidateScore[]) {
  const sorted = [...candidates].sort((left, right) => right.score - left.score);
  const top = sorted[0]?.score ?? 0;
  const second = sorted[1]?.score ?? 0;
  return round(Math.max(0.25, Math.min(0.95, 0.35 + top * 0.45 + (top - second) * 0.35)), 2);
}

function normalizeScore(value: number) {
  return round(Math.max(0, Math.min(1, value)), 4);
}
