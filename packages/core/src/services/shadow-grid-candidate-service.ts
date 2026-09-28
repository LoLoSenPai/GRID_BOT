import { blocksDuplicateEntry, type PortfolioPolicyDecision, type PortfolioPolicyInput } from "./portfolio-policy-service";
import { gridCostFloorPct } from "../utils/grid-cost-floor";
import { round } from "../utils/math";

/**
 * A small, deterministic candidate set for the Jev shadow experiment.
 *
 * This service is deliberately detached from execution and persistence. It
 * consumes the same policy input and decision that the portfolio manager
 * already produced, and returns plain JSON values suitable for an observation
 * payload. It does not choose a winner or change the live policy.
 */
export const SHADOW_GRID_CANDIDATE_VERSION = "shadow-grid-candidates-v2" as const;

export type ShadowGridCandidateKind = "keep" | "policy" | "range_variant" | "spacing_variant";
export type ShadowGridCandidateAction = "keep" | "revise" | "create_band" | "park" | "reactivate";

export interface ShadowGridCandidate {
  id: string;
  kind: ShadowGridCandidateKind;
  action: ShadowGridCandidateAction;
  lowPrice: number;
  highPrice: number;
  levelCount: number;
  spacing: number;
  requestedCapitalUsd: number;
  /** Complete, JSON-safe policy decision used to replay this candidate. */
  decision: PortfolioPolicyDecision;
  /** Baseline is retained for comparison even when legacy settings fail current floors. */
  validation: "validated" | "baseline";
  economicallyValid: boolean;
  economicValidationReasons: string[];
  /** Whether the current policy would select this candidate at this observation. */
  currentlyPolicyEligible: boolean;
  policyEligibilityReasons: string[];
}

export interface RejectedShadowGridCandidate {
  id: string;
  kind: ShadowGridCandidateKind;
  reasons: string[];
}

export interface ShadowGridCandidateOptions {
  /** Maximum returned candidates, including KEEP and the policy proposal. */
  maxCandidates?: number;
  /** Width multipliers for the two range variants. At most two are used. */
  rangeMultipliers?: readonly number[];
  /** Level-count deltas for the two spacing variants. At most two are used. */
  spacingLevelDeltas?: readonly number[];
  /** Needed to reproduce the PortfolioManager's cross-asset lower-band priority. */
  assetAllocations?: readonly { assetSymbol: string; allocatedCapitalUsd: number }[];
  /** An unknown lot exit prevents creating another band. */
  hasUnknownExitCommitment?: boolean;
}

export interface ShadowGridCandidateSet {
  version: typeof SHADOW_GRID_CANDIDATE_VERSION;
  candidates: ShadowGridCandidate[];
  policyCandidateId: string | null;
  rejected: RejectedShadowGridCandidate[];
}

const DEFAULT_MAX_CANDIDATES = 6;
const MAX_CANDIDATES = 6;
const DEFAULT_RANGE_MULTIPLIERS = [0.85, 1.15] as const;
const DEFAULT_SPACING_LEVEL_DELTAS = [1, -1] as const;

/**
 * Builds a bounded candidate population for shadow-only evaluation.
 *
 * The order is stable: KEEP, the current portfolio-policy proposal, then
 * narrower/wider ranges and finer/coarser spacing. Invalid candidates are
 * excluded and retained in `rejected` with concise reasons for auditability.
 */
export function buildShadowGridCandidates(
  policyInput: PortfolioPolicyInput,
  proposedDecision: PortfolioPolicyDecision,
  options: ShadowGridCandidateOptions = {}
): ShadowGridCandidateSet {
  const candidates: ShadowGridCandidate[] = [];
  const rejected: RejectedShadowGridCandidate[] = [];
  const maxCandidates = boundedCandidateLimit(options.maxCandidates);
  const seen = new Set<string>();

  const add = (candidate: Omit<ShadowGridCandidate, "validation" | "economicallyValid" | "economicValidationReasons" | "currentlyPolicyEligible" | "policyEligibilityReasons">, retainBaseline = false) => {
    if (candidates.length >= maxCandidates) return;
    const key = candidateKey(candidate);
    if (seen.has(key)) return;
    seen.add(key);
    const reasons = validateCandidate(policyInput, candidate, options);
    if (reasons.length) {
      if (retainBaseline) {
        const currentlyPolicyEligible = candidate.kind === "policy" || proposedDecision.action === "wait";
        candidates.push({ ...candidate, validation: "baseline", economicallyValid: false, economicValidationReasons: reasons,
          currentlyPolicyEligible,
          policyEligibilityReasons: currentlyPolicyEligible ? [] : ["The current policy proposed a portfolio adaptation instead of KEEP."] });
        return;
      }
      rejected.push({ id: candidate.id, kind: candidate.kind, reasons });
      return;
    }
    const currentlyPolicyEligible = candidate.kind === "policy"
      ? true
      : candidate.kind === "keep"
        ? proposedDecision.action === "wait"
        : false;
    candidates.push({ ...candidate, validation: "validated", economicallyValid: true, economicValidationReasons: [],
      currentlyPolicyEligible,
      policyEligibilityReasons: currentlyPolicyEligible ? [] : [candidate.kind === "keep"
        ? "The current policy proposed a portfolio adaptation instead of KEEP."
        : "Counterfactual range/spacing variant; the live policy did not select it at this observation."] });
  };

  const band = policyInput.band;
  add({
    id: "keep",
    kind: "keep",
    action: "keep",
    lowPrice: band.lowPrice,
    highPrice: band.highPrice,
    levelCount: band.levelCount,
    spacing: band.spacing,
    requestedCapitalUsd: 0,
    decision: keepDecision(band)
  }, true);

  const proposal = proposalCandidate(policyInput, proposedDecision);
  let policyCandidateId: string | null = null;
  if (proposedDecision.action === "wait") {
    // WAIT explicitly agrees with the unchanged baseline, even if the legacy
    // band is now below a newer economic floor.
    policyCandidateId = "keep";
  } else if (proposal) {
    add(proposal, proposal.action === "park" || proposal.action === "reactivate");
    if (candidates.some(candidate => candidate.id === proposal.id)) policyCandidateId = proposal.id;
  }

  // Variants use the policy proposal when there is one. With WAIT/PARK, the
  // current band remains the anchor so Jev can measure an earlier
  // counterfactual adaptation; timing eligibility is recorded separately.
  const variantProposal = proposal && (proposal.action === "revise" || proposal.action === "create_band") ? proposal : null;
  const variantAnchor = variantProposal ?? {
    id: "keep",
    kind: "keep" as const,
    action: "revise" as const,
    lowPrice: band.lowPrice,
    highPrice: band.highPrice,
    levelCount: band.levelCount,
    spacing: band.spacing,
    requestedCapitalUsd: 0,
    decision: keepDecision(band)
  };
  if (candidates.length < maxCandidates && (!proposal || variantProposal)) {
    const center = variantProposal ? (variantProposal.lowPrice + variantProposal.highPrice) / 2 : policyInput.price;
    const width = variantAnchor.highPrice - variantAnchor.lowPrice;
    const rangeMultipliers = boundedNumbers(options.rangeMultipliers, DEFAULT_RANGE_MULTIPLIERS);
    rangeMultipliers.forEach((multiplier, index) => {
      if (candidates.length >= maxCandidates) return;
      const nextWidth = boundedCenteredWidth(center, width * multiplier, policyInput.parameters.minWidthPct, policyInput.parameters.maxWidthPct);
      const low = center - nextWidth / 2;
      const high = center + nextWidth / 2;
      add({
        id: `range_${index === 0 ? "narrow" : "wide"}`,
        kind: "range_variant",
        action: variantAnchor.action,
        lowPrice: low,
        highPrice: high,
        levelCount: variantAnchor.levelCount,
        spacing: nextWidth / Math.max(1, variantAnchor.levelCount - 1),
        requestedCapitalUsd: requestedCapital(policyInput, variantAnchor.action, variantAnchor.levelCount),
        decision: candidateDecision(policyInput, variantAnchor, low, high, variantAnchor.levelCount)
      });
    });

    const spacingDeltas = boundedIntegers(options.spacingLevelDeltas, DEFAULT_SPACING_LEVEL_DELTAS);
    spacingDeltas.forEach((delta, index) => {
      if (candidates.length >= maxCandidates) return;
      const levelCount = variantAnchor.levelCount + delta;
      add({
        id: `spacing_${index === 0 ? "fine" : "coarse"}`,
        kind: "spacing_variant",
        action: variantAnchor.action,
        lowPrice: variantAnchor.lowPrice,
        highPrice: variantAnchor.highPrice,
        levelCount,
        spacing: (variantAnchor.highPrice - variantAnchor.lowPrice) / Math.max(1, levelCount - 1),
        requestedCapitalUsd: requestedCapital(policyInput, variantAnchor.action, levelCount),
        decision: candidateDecision(policyInput, variantAnchor, variantAnchor.lowPrice, variantAnchor.highPrice, levelCount)
      });
    });
  }

  return { version: SHADOW_GRID_CANDIDATE_VERSION, candidates, policyCandidateId, rejected };
}

function proposalCandidate(input: PortfolioPolicyInput, decision: PortfolioPolicyDecision): Omit<ShadowGridCandidate, "validation" | "economicallyValid" | "economicValidationReasons" | "currentlyPolicyEligible" | "policyEligibilityReasons"> | null {
  if (decision.action === "revise" && decision.nextLowPrice !== null && decision.nextHighPrice !== null &&
    decision.nextLevelCount !== null && decision.nextSpacing !== null) {
    return {
      id: "policy",
      kind: "policy",
      action: "revise",
      lowPrice: decision.nextLowPrice,
      highPrice: decision.nextHighPrice,
      levelCount: decision.nextLevelCount,
      spacing: decision.nextSpacing,
      requestedCapitalUsd: 0,
      decision
    };
  }

  if (decision.action === "create_band" && decision.candidate) {
    return {
      id: "policy",
      kind: "policy",
      action: "create_band",
      lowPrice: decision.candidate.lowPrice,
      highPrice: decision.candidate.highPrice,
      levelCount: decision.candidate.levelCount,
      spacing: decision.candidate.spacing,
      requestedCapitalUsd: decision.candidate.requestedCapitalUsd,
      decision
    };
  }

  if (decision.action === "park" || decision.action === "reactivate") {
    const band = input.band;
    return {
      id: "policy",
      kind: "policy",
      action: decision.action,
      lowPrice: band.lowPrice,
      highPrice: band.highPrice,
      levelCount: band.levelCount,
      spacing: band.spacing,
      requestedCapitalUsd: 0,
      decision
    };
  }

  return null;
}

function keepDecision(band: PortfolioPolicyInput["band"]): PortfolioPolicyDecision {
  return {
    action: "wait",
    reason: "KEEP current band for shadow comparison.",
    nextLowPrice: null,
    nextHighPrice: null,
    nextLevelCount: null,
    nextSpacing: null,
    protectedLowPrice: null,
    protectedHighPrice: null,
    candidate: undefined
  };
}

function candidateDecision(
  input: PortfolioPolicyInput,
  proposal: Omit<ShadowGridCandidate, "validation" | "economicallyValid" | "economicValidationReasons" | "currentlyPolicyEligible" | "policyEligibilityReasons">,
  lowPrice: number,
  highPrice: number,
  levelCount: number
): PortfolioPolicyDecision {
  const spacing = (highPrice - lowPrice) / Math.max(1, levelCount - 1);
  if (proposal.action === "create_band") {
    return {
      action: "create_band",
      reason: `Shadow range/spacing variant of the policy proposal (${proposal.id}).`,
      nextLowPrice: null,
      nextHighPrice: null,
      nextLevelCount: null,
      nextSpacing: null,
      protectedLowPrice: proposal.decision.protectedLowPrice,
      protectedHighPrice: proposal.decision.protectedHighPrice,
      candidate: { lowPrice, highPrice, levelCount, spacing, requestedCapitalUsd: requestedCapital(input, "create_band", levelCount) }
    };
  }
  return {
    action: "revise",
    reason: `Shadow range/spacing variant of the policy proposal (${proposal.id}).`,
    nextLowPrice: lowPrice,
    nextHighPrice: highPrice,
    nextLevelCount: levelCount,
    nextSpacing: spacing,
    protectedLowPrice: proposal.decision.protectedLowPrice,
    protectedHighPrice: proposal.decision.protectedHighPrice
  };
}

function validateCandidate(input: PortfolioPolicyInput, candidate: Omit<ShadowGridCandidate, "validation" | "economicallyValid" | "economicValidationReasons" | "currentlyPolicyEligible" | "policyEligibilityReasons">,
  options: ShadowGridCandidateOptions): string[] {
  const { parameters: p } = input;
  const reasons: string[] = [];
  const values = [candidate.lowPrice, candidate.highPrice, candidate.levelCount, candidate.spacing, candidate.requestedCapitalUsd];
  if (!values.every(Number.isFinite)) return ["Candidate contains a non-finite value."];
  if (candidate.lowPrice <= 0 || candidate.highPrice <= candidate.lowPrice) reasons.push("Range is not strictly positive.");
  if (!Number.isInteger(candidate.levelCount) || candidate.levelCount < 2 || candidate.levelCount > p.maxLevels) {
    reasons.push(`Level count must be an integer between 2 and ${p.maxLevels}.`);
  }
  if (candidate.spacing <= 0) reasons.push("Spacing must be positive.");

  // PortfolioPolicyService defines envelope width relative to its center.
  const center = (candidate.lowPrice + candidate.highPrice) / 2;
  const widthPct = center > 0 ? (candidate.highPrice - candidate.lowPrice) / center * 100 : Number.NaN;
  if (Number.isFinite(widthPct) && (widthPct < p.minWidthPct || widthPct > p.maxWidthPct)) {
    reasons.push(`Width must stay between ${p.minWidthPct}% and ${p.maxWidthPct}%.`);
  }

  if (Number.isInteger(candidate.levelCount) && candidate.levelCount >= 2 && Number.isFinite(candidate.highPrice) && candidate.highPrice > candidate.lowPrice) {
    const expectedSpacing = (candidate.highPrice - candidate.lowPrice) / (candidate.levelCount - 1);
    const tolerance = Math.max(1e-8, Math.abs(expectedSpacing) * 1e-6);
    if (!Number.isFinite(candidate.spacing) || Math.abs(candidate.spacing - expectedSpacing) > tolerance) {
      reasons.push("Spacing does not match the evenly spaced rails.");
    }
  }

  if (Number.isFinite(candidate.spacing) && candidate.highPrice > 0) {
    const atrPct = input.indicators?.atrPct ?? 0;
    const costSpacingPct = gridCostFloorPct(p.estimatedSlippageBps ?? 0, p.estimatedExecutionFeeBps ?? 0) + 0.25;
    const minimumSpacingPct = Math.max(p.minimumSpacingPct, atrPct * 0.5, costSpacingPct);
    if (candidate.spacing / candidate.highPrice * 100 + 1e-8 < minimumSpacingPct) {
      reasons.push(`Spacing does not clear the ${round(minimumSpacingPct, 4)}% policy/cost floor.`);
    }
  }

  if (candidate.action === "revise" || candidate.action === "create_band") {
    if (input.price < candidate.lowPrice || input.price > candidate.highPrice) {
      reasons.push("Current price is outside the candidate range.");
    }
    if (candidate.action === "revise" && input.band.idleQuoteUsd < p.minUsefulOrderUsd) {
      reasons.push("Idle quote is below the minimum useful order for a revision.");
    }
    const lots = input.band.openTradingLots.filter(lot => lot.kind !== "retained" && lot.remainingBaseAmount > 0 && lot.costQuote > 0);
    const widerSpacing = Math.max(input.band.spacing, candidate.spacing);
    const hasUnblockedFutureRail = Number.isInteger(candidate.levelCount) && candidate.levelCount >= 2 &&
      candidate.levelCount <= p.maxLevels &&
      Array.from({ length: candidate.levelCount - 1 }, (_, index) => candidate.lowPrice + index * candidate.spacing)
        .some(price => !lots.some(lot => blocksDuplicateEntry({ oldEntryPrice: lot.entryPrice, currentPrice: price, widerSpacing, openTradingLot: true })));
    if (!hasUnblockedFutureRail) reasons.push("No future rail remains outside the open-lot duplicate-entry guard.");
  }

  if (candidate.action === "create_band") {
    const requiredCapitalUsd = requestedCapital(input, candidate.action, candidate.levelCount);
    if (candidate.requestedCapitalUsd + 1e-8 < requiredCapitalUsd) reasons.push("Requested capital is below the policy minimum.");
    const exposureAfter = (input.assetAttributedCapitalUsd + requiredCapitalUsd) / input.totalPortfolioCapitalUsd * 100;
    if (input.bandCount >= p.maxBands) reasons.push("Maximum band count reached.");
    if (input.availableCashUsd + 1e-8 < requiredCapitalUsd) reasons.push("Available cash does not fund the candidate.");
    if (exposureAfter > p.maxExposurePct + 1e-8) reasons.push("Candidate exceeds the asset exposure limit.");
    if (options.hasUnknownExitCommitment) reasons.push("An open lot has an unknown exit commitment.");
    const allocations = options.assetAllocations;
    if (!allocations?.length || !allocations.some(asset => asset.assetSymbol === input.assetSymbol)) {
      reasons.push("Cross-asset capital priority is unavailable.");
    } else if (allocations.some(asset => asset.allocatedCapitalUsd + 1e-8 < input.assetAttributedCapitalUsd)) {
      reasons.push("Another asset has less attributed capital and takes funding priority.");
    }
  }

  // KEEP is a description of the running band. It must still be represented
  // as a candidate, but it does not request capital or alter the band.
  if (candidate.action === "keep" && candidate.requestedCapitalUsd !== 0) reasons.push("KEEP cannot request additional capital.");
  return reasons;
}

function requestedCapital(input: PortfolioPolicyInput, action: ShadowGridCandidateAction, levelCount: number): number {
  return action === "create_band" && Number.isInteger(levelCount) && levelCount >= 2
    ? input.parameters.minUsefulOrderUsd * (levelCount - 1)
    : 0;
}

function boundedCenteredWidth(center: number, width: number, minWidthPct: number, maxWidthPct: number): number {
  if (!Number.isFinite(center) || center <= 0 || !Number.isFinite(width) || width <= 0) return width;
  const minWidth = center * minWidthPct / 100;
  const maxWidth = center * maxWidthPct / 100;
  return Math.max(minWidth, Math.min(maxWidth, width));
}

function candidateKey(candidate: Pick<ShadowGridCandidate, "lowPrice" | "highPrice" | "levelCount" | "spacing" | "action">): string {
  return [candidate.action, candidate.lowPrice, candidate.highPrice, candidate.levelCount, candidate.spacing].join("|");
}

function boundedCandidateLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CANDIDATES;
  return Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(value!)));
}

function boundedNumbers(values: readonly number[] | undefined, fallback: readonly number[]): number[] {
  const source = values ?? fallback;
  return source.filter(Number.isFinite).slice(0, 2);
}

function boundedIntegers(values: readonly number[] | undefined, fallback: readonly number[]): number[] {
  return boundedNumbers(values, fallback).map(Math.trunc);
}
