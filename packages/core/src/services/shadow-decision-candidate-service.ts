import type { PortfolioPolicyDecision, PortfolioPolicyInput } from "./portfolio-policy-service";
import { buildShadowGridCandidates, type ShadowGridCandidateOptions, type ShadowGridCandidateSet } from "./shadow-grid-candidate-service";
import type { ShadowObservedCostProfile } from "./shadow-observed-cost-service";
import type { ShadowReplayExitUpdate } from "./portfolio-policy-replay-service";
import { gridCostFloorPct } from "../utils/grid-cost-floor";

export interface ShadowExitCandidate { id: string; kind: "keep" | "closer" | "farther";
  updates: ShadowReplayExitUpdate[]; strategyParameters: Record<string, number | string>; }
export interface ShadowDecisionCandidateSet { version: "shadow-decisions-v4"; grid: ShadowGridCandidateSet;
  exit: { version: "shadow-exits-v1"; candidates: ShadowExitCandidate[]; rejected: Array<{ id: string; reasons: string[] }> };
  costProfile: ShadowObservedCostProfile | null; }
type RecordValue = Record<string, any>;

/** Pure counterfactual preparation; economic admission here never authorizes execution. */
export function buildShadowDecisionCandidates(input: { policyInput: PortfolioPolicyInput;
  proposedDecision: PortfolioPolicyDecision; options?: ShadowGridCandidateOptions; replaySnapshot: unknown;
  costProfile: ShadowObservedCostProfile | null }): ShadowDecisionCandidateSet {
  const policy = input.policyInput, profile = input.costProfile;
  const snapshot = object(input.replaySnapshot);
  const target = targetBand(snapshot, policy.band.id);
  const usable = isShadowCostProfileUsable(profile, policy, target);
  const legacy = buildShadowGridCandidates(policy, input.proposedDecision, input.options);
  if (input.proposedDecision.action !== "wait" && !legacy.candidates.some(c => c.kind === "policy")) {
    const decision = structuredClone(input.proposedDecision), band = policy.band;
    const geometry = decision.action === "create_band" && decision.candidate ? decision.candidate : decision.action === "revise"
      ? { lowPrice: decision.nextLowPrice!, highPrice: decision.nextHighPrice!, levelCount: decision.nextLevelCount!,
        spacing: decision.nextSpacing!, requestedCapitalUsd: 0 }
      : { lowPrice: band.lowPrice, highPrice: band.highPrice, levelCount: band.levelCount, spacing: band.spacing, requestedCapitalUsd: 0 };
    legacy.candidates.splice(1, 0, { id: "policy", kind: "policy", action: decision.action === "wait" ? "keep" : decision.action, ...geometry, decision,
      validation: "baseline", economicallyValid: false, economicValidationReasons: legacy.rejected.find(r => r.id === "policy")?.reasons ??
        ["Current proposal retained exactly as a baseline; shadow economic admission did not validate it."],
      currentlyPolicyEligible: true, policyEligibilityReasons: [] });
    legacy.candidates = legacy.candidates.slice(0, 6); legacy.policyCandidateId = "policy";
  }
  let grid = structuredClone(legacy);
  if (usable && profile) {
    const minimumOrder = Math.max(policy.parameters.minUsefulOrderUsd, profile.notionalBucket.minUsd, 0.01);
    const fee = profile.feeBps! + profile.p90NativeFeeUsd! / minimumOrder * 10_000;
    const slip = profile.adverseSlippageBps! + profile.safetyMarginBps;
    const spacingFloor = gridCostFloorPct(slip, fee) + 0.25;
    const shadowInput = { ...policy, parameters: { ...policy.parameters, minWidthPct: 2,
      minimumSpacingPct: spacingFloor, estimatedExecutionFeeBps: fee, estimatedSlippageBps: slip } };
    const shadow = buildShadowGridCandidates(shadowInput, input.proposedDecision, { ...input.options, maxCandidates: 6 });
    const exact = legacy.candidates.filter(c => c.kind === "keep" || c.kind === "policy");
    const experiments = shadow.candidates.filter(c => c.kind !== "keep" && c.kind !== "policy" &&
      !exact.some(base => Math.abs(c.lowPrice - base.lowPrice) <= Math.max(1e-8, base.lowPrice * 1e-10) &&
        Math.abs(c.highPrice - base.highPrice) <= Math.max(1e-8, base.highPrice * 1e-10) && c.levelCount === base.levelCount) &&
      (c.action === "create_band" ? c.requestedCapitalUsd : policy.band.allocatedCapitalUsd) / (c.levelCount - 1) >= profile.notionalBucket.minUsd &&
      (c.action === "create_band" ? c.requestedCapitalUsd : policy.band.allocatedCapitalUsd) / (c.levelCount - 1) < profile.notionalBucket.maxUsd).map(c => ({ ...c,
      id: `v4_${c.id}`, currentlyPolicyEligible: false,
      policyEligibilityReasons: ["Experimental shadow geometry; admission does not establish live eligibility."],
      strategyParameters: { ...c.strategyParameters, experiment: "shadow-only-v4", minimum_width_pct: 2,
        cost_floor_pct: spacingFloor, cost_profile_as_of: profile.asOf, live_validity: "unvalidated" } }));
    grid = { ...grid, candidates: [...exact, ...experiments].slice(0, Math.min(6, input.options?.maxCandidates ?? 6)),
      rejected: [...legacy.rejected, ...shadow.rejected.map(r => ({ ...r, id: `v4_${r.id}` }))] };
    // Global reserve may fund a separately owned band even when the original band remains in range.
    if (policy.band.idleQuoteUsd < minimumOrder && policy.availableCashUsd >= minimumOrder * 2 &&
      policy.bandCount < policy.parameters.maxBands && !input.options?.hasUnknownExitCommitment &&
      grid.candidates.length < Math.min(6, Math.max(2, input.options?.maxCandidates ?? 6)) && (input.options?.assetAllocations ?? []).every(a =>
        a.allocatedCapitalUsd + 1e-8 >= policy.assetAttributedCapitalUsd)) {
      const low = policy.price * 0.97, high = policy.price * 1.03;
      const levelCount = Math.max(2, Math.min(policy.parameters.maxLevels,
        Math.floor(policy.availableCashUsd / minimumOrder) + 1,
        Math.floor((high - low) / (high * spacingFloor / 100)) + 1));
      const capital = minimumOrder * (levelCount - 1), spacing = (high - low) / (levelCount - 1);
      if (capital <= policy.availableCashUsd && (policy.assetAttributedCapitalUsd + capital) /
        policy.totalPortfolioCapitalUsd * 100 <= policy.parameters.maxExposurePct &&
        (low !== policy.band.lowPrice || high !== policy.band.highPrice || levelCount !== policy.band.levelCount)) {
        const decision: PortfolioPolicyDecision = { action: "create_band", reason: "Shadow reserve-funded band for fully invested inventory.",
          nextLowPrice: null, nextHighPrice: null, nextLevelCount: null, nextSpacing: null, protectedLowPrice: null,
          protectedHighPrice: null, candidate: { lowPrice: low, highPrice: high, levelCount, spacing, requestedCapitalUsd: capital } };
        grid.candidates.push({ id: "v4_reserve_band", kind: "range_variant", action: "create_band", lowPrice: low,
          highPrice: high, levelCount, spacing, requestedCapitalUsd: capital, decision, validation: "validated",
          economicallyValid: true, economicValidationReasons: [], currentlyPolicyEligible: false,
          policyEligibilityReasons: ["Counterfactual reserve allocation; the live policy does not select an in-range new band."],
          strategyParameters: { experiment: "shadow-only-v4", live_validity: "unvalidated", funding: "existing-global-reserve" } });
      }
    }
  }
  const exit: ShadowDecisionCandidateSet["exit"] = { version: "shadow-exits-v1",
    candidates: [{ id: "keep", kind: "keep", updates: [], strategyParameters: { experiment: "shadow-only-v4" } }], rejected: [] };
  if (!usable || !profile || !target) {
    exit.rejected.push({ id: "closer", reasons: ["Missing usable cost profile or exact captured lot state; retain fixed exits."] },
      { id: "farther", reasons: ["Missing usable cost profile or exact captured lot state; retain fixed exits."] });
    return { version: "shadow-decisions-v4", grid, exit, costProfile: profile };
  }
  const closed = policy.candles.filter(c => c.closedAt <= policy.now).slice(-20);
  const amplitude = closed.length >= 14 ? (Math.max(...closed.map(c => c.high)) - Math.min(...closed.map(c => c.low))) /
    policy.price * 100 : NaN;
  const volatility = policy.indicators?.atrPct ?? (closed.length >= 14
    ? closed.slice(-14).reduce((s, c) => s + (c.high - c.low) / c.close * 100, 0) / 14 : NaN);
  const clampPct = Math.min(5, amplitude / 2, volatility * 2);
  if (!Number.isFinite(clampPct) || clampPct <= 0) {
    exit.rejected.push({ id: "closer", reasons: ["Insufficient closed volatility/amplitude data."] },
      { id: "farther", reasons: ["Insufficient closed volatility/amplitude data."] });
    return { version: "shadow-decisions-v4", grid, exit, costProfile: profile };
  }
  const lots = target.bot.positionLots as RecordValue[], commitments = target.exitCommitments as RecordValue[];
  for (const kind of ["closer", "farther"] as const) {
    const updates: ShadowReplayExitUpdate[] = [], reasons: string[] = [];
    for (const lot of lots) {
      if (lot.kind !== "trading" || lot.closedAt != null) continue;
      const commitment = commitments.find(c => c.lotId === lot.id);
      if (!commitment || commitment.targetStatus !== "KNOWN" || commitment.fulfilledAt != null ||
        !["accumulate_base", "accumulate_usdc"].includes(commitment.economicRule)) { reasons.push("Unknown captured exit commitment."); break; }
      const qty = Number(lot.remainingBaseAmount), cost = Number(lot.costQuote), old = Number(commitment.sellTargetPrice);
      const scale = 10 ** Number(target.bot.baseDecimals), nativeFee = profile.p90NativeFeeUsd!;
      const netFactor = (1 - (profile.adverseSlippageBps! + profile.safetyMarginBps) / 10_000) * (1 - profile.feeBps! / 10_000);
      const minimumNetGainUsd = commitment.economicRule === "accumulate_usdc" ? Math.max(0.05, cost * 0.001) : 0;
      const minimumRetainedBaseAmount = commitment.economicRule === "accumulate_base"
        ? Math.max(2 / scale, Math.ceil(Math.max(qty * 0.001, 0.05 / policy.price) * scale) / scale) : 0;
      const saleable = Math.floor((qty - minimumRetainedBaseAmount) * scale + 1e-8) / scale;
      if (![qty, cost, old, netFactor, saleable].every(v => Number.isFinite(v) && v > 0)) { reasons.push("Invalid or uneconomic captured lot."); break; }
      const floor = (cost + nativeFee + minimumNetGainUsd) / (saleable * netFactor) * (1 + 1e-10);
      const desired = old * (1 + (kind === "closer" ? -1 : 1) * clampPct / 100);
      const next = Math.max(floor, desired);
      const notional = commitment.economicRule === "accumulate_base" ? cost : qty * next;
      if (notional < profile.notionalBucket.minUsd || notional >= profile.notionalBucket.maxUsd) {
        reasons.push("Lot exit is outside the observed notional bucket."); break;
      }
      if (Math.abs(next / old - 1) * 100 > clampPct + 1e-7 || (kind === "closer" && next >= old)) continue;
      updates.push({ sourceLotId: String(lot.id), bandId: policy.band.id, oldTargetPrice: old, newTargetPrice: next,
        costQuote: cost, remainingBaseAmount: qty, economicRule: commitment.economicRule,
        minimumNetGainUsd, minimumRetainedBaseAmount });
    }
    if (reasons.length || !updates.length) exit.rejected.push({ id: kind, reasons: reasons.length ? reasons : ["No target clears the bounded economic move."] });
    else exit.candidates.push({ id: kind, kind, updates, strategyParameters: { experiment: "shadow-only-v4",
      clamp_pct: clampPct, min_net_gain_usd: 0.05, min_retained_value_usd: 0.05, cost_profile_as_of: profile.asOf,
      live_validity: "unvalidated" } });
  }
  return { version: "shadow-decisions-v4", grid, exit, costProfile: profile };
}

function object(value: unknown): RecordValue | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null; }
function targetBand(snapshot: RecordValue | null, bandId: string): RecordValue | null {
  if (snapshot?.schemaVersion !== "shadow-replay-v3" || !Array.isArray(snapshot.strategies)) return null;
  for (const strategy of snapshot.strategies) for (const band of strategy.bands ?? []) if (band.id === bandId &&
    Array.isArray(band.bot?.positionLots) && Array.isArray(band.exitCommitments)) return band;
  return null;
}
export function isShadowCostProfileUsable(profile: ShadowObservedCostProfile | null, policy: PortfolioPolicyInput,
  target: RecordValue | null): boolean {
  const minOrder = policy.parameters.minUsefulOrderUsd;
  return !!profile && profile.usable && profile.count >= 5 && profile.assetSymbol === policy.assetSymbol && !!target &&
    profile.botId === target.bot.id &&
    profile.baseMint === target.bot.baseMint && profile.quoteMint === target.bot.quoteMint &&
    Number.isFinite(+new Date(profile.asOf)) && +new Date(profile.asOf) <= +policy.now &&
    minOrder >= profile.notionalBucket.minUsd && minOrder < profile.notionalBucket.maxUsd &&
    [profile.feeBps, profile.adverseSlippageBps, profile.p90NativeFeeUsd, profile.safetyMarginBps]
      .every(v => typeof v === "number" && Number.isFinite(v) && v >= 0) &&
    profile.feeBps! < 10_000 && profile.adverseSlippageBps! + profile.safetyMarginBps < 10_000;
}
