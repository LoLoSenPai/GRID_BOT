import { GridType } from "../domain/enums";
import type { RangePlanBasis, RangePlanDecision, RangePlanInput, RangePlanMidBasis, RangePlanRisk } from "../domain/types";
import { round } from "../utils/math";

const MIN_WIDTH_PCT = 4;
const MAX_WIDTH_PCT = 35;
const MIN_CYCLES = 4;
const MAX_CYCLES = 15;

export class RangePlanService {
  plan(input: RangePlanInput): RangePlanDecision {
    const currentPrice = Number(input.currentPrice);
    const currentLowPrice = Number(input.currentLowPrice);
    const currentHighPrice = Number(input.currentHighPrice);
    const currentWidthPct = currentLowPrice > 0 ? ((currentHighPrice - currentLowPrice) / currentLowPrice) * 100 : 10;

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return keepCurrentRange(input, "Invalid current price; keeping the existing range as a safe fallback.");
    }

    const regime = input.marketRegime ?? null;
    const indicators = input.indicators ?? null;
    const mid = deriveMidPrice({
      currentPrice,
      currentLowPrice,
      currentHighPrice,
      donchianHigh: indicators?.donchianHigh20 ?? null,
      donchianLow: indicators?.donchianLow20 ?? null,
      ema20: indicators?.ema20 ?? null,
      ema50: indicators?.ema50 ?? null,
      regime: regime?.regime ?? null
    });
    const width = deriveWidthPct({
      currentWidthPct,
      atrPct: indicators?.atrPct14 ?? null,
      donchianWidthPct: indicators?.donchianWidthPct20 ?? null,
      bollingerWidthPct: indicators?.bollingerWidth20 ?? null,
      regime: regime?.regime ?? null
    });

    if (regime?.regime === "CHAOTIC_HIGH_VOL" && regime.confidence >= 0.45) {
      return {
        ...buildPlan({
          midPrice: mid.price,
          midBasis: mid.basis,
          widthPct: Math.max(width.widthPct, clamp(currentWidthPct, MIN_WIDTH_PCT, MAX_WIDTH_PCT)),
          basis: width.basis,
          anchorRatio: 0.5,
          budgetUsd: input.budgetUsd,
          minOrderQuoteAmount: input.minOrderQuoteAmount,
          currentLevelCount: input.currentLevelCount,
          risk: "high",
          confidence: Math.max(0.25, regime.confidence * 0.6),
          costInput: input
        }),
        operatorAction: "Do not auto-recenter in high volatility. Use this only as a watch range and keep new buys conservative.",
        reasons: [
          `Regime is ${regime.regime} with ${Math.round(regime.confidence * 100)}% heuristic score.`,
          "High volatility can make an adaptive range chase price instead of farming it."
        ]
      };
    }

    const anchorRatio = getAnchorRatio(regime?.regime ?? null);
    const risk = getRisk(regime?.regime ?? null, regime?.confidence ?? 0, width.widthPct, input.budgetUsd, input.minOrderQuoteAmount);
    const confidence = getConfidence(regime?.confidence ?? 0.35, width.basis, indicators !== null);
    const plan = buildPlan({
      midPrice: mid.price,
      midBasis: mid.basis,
      widthPct: width.widthPct,
      basis: width.basis,
      anchorRatio,
      budgetUsd: input.budgetUsd,
      minOrderQuoteAmount: input.minOrderQuoteAmount,
      currentLevelCount: input.currentLevelCount,
      risk,
      confidence,
      costInput: input
    });

    return {
      ...plan,
      operatorAction:
        !plan.costFloorSatisfied ? "Do not launch: this range and budget cannot support the volatility and round-trip cost floor." : regime?.regime === "RANGE"
          ? "Use this as a candidate range in Lab before recreating a bot."
          : "Treat this as a defensive candidate; trend or low confidence means the static grid can become fragile.",
      reasons: buildReasons(width, mid, regime?.regime ?? null, regime?.confidence ?? null, plan)
    };
  }
}

function deriveMidPrice(input: {
  currentPrice: number;
  currentLowPrice: number;
  currentHighPrice: number;
  donchianHigh: number | null;
  donchianLow: number | null;
  ema20: number | null;
  ema50: number | null;
  regime: string | null;
}): { price: number; basis: RangePlanMidBasis } {
  if (input.regime === "RANGE" && isPositive(input.donchianHigh) && isPositive(input.donchianLow) && input.donchianHigh > input.donchianLow) {
    return {
      price: round((input.donchianHigh + input.donchianLow) / 2, 8),
      basis: "donchian_mid"
    };
  }

  if (input.regime === "RANGE" && isPositive(input.ema20) && isPositive(input.ema50)) {
    const emaSpreadPct = Math.abs(input.ema20 - input.ema50) / ((input.ema20 + input.ema50) / 2) * 100;
    if (emaSpreadPct <= 2) {
      return {
        price: round((input.ema20 + input.ema50) / 2, 8),
        basis: "ema_cluster"
      };
    }
  }

  if (isPositive(input.currentLowPrice) && isPositive(input.currentHighPrice) && input.currentHighPrice > input.currentLowPrice) {
    return {
      price: round((input.currentLowPrice + input.currentHighPrice) / 2, 8),
      basis: "current_range_mid"
    };
  }

  return {
    price: round(input.currentPrice, 8),
    basis: "current_price"
  };
}

function deriveWidthPct(input: {
  currentWidthPct: number;
  atrPct: number | null;
  donchianWidthPct: number | null;
  bollingerWidthPct: number | null;
  regime: string | null;
}): { widthPct: number; basis: RangePlanBasis } {
  const candidates: Array<{ value: number; basis: RangePlanBasis }> = [];

  if (isPositive(input.donchianWidthPct)) {
    candidates.push({ value: input.donchianWidthPct * 1.15, basis: "donchian" });
  }

  if (isPositive(input.bollingerWidthPct)) {
    candidates.push({ value: input.bollingerWidthPct * 0.9, basis: "bollinger" });
  }

  if (isPositive(input.atrPct)) {
    candidates.push({ value: input.atrPct * (input.regime === "RANGE" ? 7 : 9), basis: "atr" });
  }

  if (!candidates.length) {
    return {
      widthPct: clamp(input.currentWidthPct, MIN_WIDTH_PCT, MAX_WIDTH_PCT),
      basis: "current_range"
    };
  }

  candidates.sort((left, right) => right.value - left.value);
  const selected = candidates[0]!;

  return {
    widthPct: clamp(selected.value, MIN_WIDTH_PCT, MAX_WIDTH_PCT),
    basis: selected.basis
  };
}

function buildPlan(input: {
  midPrice: number;
  midBasis: RangePlanMidBasis;
  widthPct: number;
  basis: RangePlanBasis;
  anchorRatio: number;
  budgetUsd: number;
  minOrderQuoteAmount: number;
  currentLevelCount: number;
  risk: RangePlanRisk;
  confidence: number;
  costInput: RangePlanInput;
}): RangePlanDecision {
  const widthPrice = input.midPrice * (input.widthPct / 100);
  const low = Math.max(input.midPrice - widthPrice * input.anchorRatio, input.midPrice * 0.01);
  const high = low + widthPrice;
  const slippage = Math.min(0.99, Math.max(0, input.costInput.maxSlippageBps ?? 50) / 10_000);
  const fee = Math.min(0.99, Math.max(0, input.costInput.executionFeeBps ?? 10) / 10_000);
  const roundTripCostPct = ((1 + slippage) * (1 + fee) / ((1 - slippage) * (1 - fee)) - 1) * 100;
  const natr = Math.max(0, input.costInput.indicators?.atrPct14 ?? 0);
  const minimumStepPct = Math.max(natr * (input.costInput.natrMultiplier ?? 0.5), roundTripCostPct + (input.costInput.netMarginPct ?? 0.25));
  const gridType = input.widthPct >= 14 ? GridType.Geometric : GridType.Arithmetic;
  const spacingLimit = gridType === GridType.Geometric
    ? Math.floor(Math.log(high / low) / Math.log(1 + minimumStepPct / 100))
    : Math.floor((high - low) / (high * minimumStepPct / 100));
  const affordable = input.minOrderQuoteAmount > 0 ? Math.floor(input.budgetUsd / (input.minOrderQuoteAmount * (1 + fee))) : MAX_CYCLES;
  const cycles = Math.max(1, Math.min(spacingLimit, affordable, deriveCycleCount(input.budgetUsd, input.minOrderQuoteAmount, input.widthPct, input.currentLevelCount)));
  const stepPct = gridType === GridType.Geometric ? (Math.pow(high / low, 1 / cycles) - 1) * 100 : (high - low) / cycles / high * 100;
  const costFloorSatisfied = spacingLimit >= 1 && affordable >= 1 && stepPct + 1e-8 >= minimumStepPct;

  return {
    recommendedLowPrice: round(low, 8),
    recommendedHighPrice: round(high, 8),
    recommendedLevelCount: cycles + 1,
    recommendedGridType: gridType,
    minimumStepPct: round(minimumStepPct, 4),
    estimatedRoundTripCostPct: round(roundTripCostPct, 4),
    costFloorSatisfied,
    midPrice: round(input.midPrice, 8),
    midBasis: input.midBasis,
    widthPct: round(input.widthPct, 4),
    stepPct: round(stepPct, 4),
    basis: input.basis,
    confidence: round(input.confidence, 2),
    risk: costFloorSatisfied ? input.risk : "high",
    operatorAction: "Use this as a Lab-only candidate.",
    reasons: []
  };
}

function deriveCycleCount(budgetUsd: number, minOrderQuoteAmount: number, widthPct: number, fallbackLevelCount: number) {
  const maxAffordableCycles = minOrderQuoteAmount > 0 ? Math.floor(budgetUsd / minOrderQuoteAmount) : MAX_CYCLES;
  const targetStepPct = widthPct >= 18 ? 1.6 : widthPct >= 10 ? 1.1 : 0.75;
  const targetCycles = Math.round(widthPct / targetStepPct);
  const fallbackCycles = Math.max(1, fallbackLevelCount - 1);
  const cycles = Number.isFinite(targetCycles) && targetCycles > 0 ? targetCycles : fallbackCycles;

  return Math.max(1, Math.min(MAX_CYCLES, Math.max(Math.min(MIN_CYCLES, maxAffordableCycles), Math.min(cycles, maxAffordableCycles || fallbackCycles))));
}

function getAnchorRatio(regime: string | null) {
  if (regime === "TREND_UP") {
    return 0.62;
  }

  if (regime === "TREND_DOWN") {
    return 0.38;
  }

  return 0.5;
}

function getRisk(regime: string | null, confidence: number, widthPct: number, budgetUsd: number, minOrderQuoteAmount: number): RangePlanRisk {
  const affordableCycles = minOrderQuoteAmount > 0 ? budgetUsd / minOrderQuoteAmount : 999;
  if (regime === "CHAOTIC_HIGH_VOL" || widthPct >= 30 || affordableCycles < MIN_CYCLES) {
    return "high";
  }

  if (regime !== "RANGE" || confidence < 0.55 || widthPct >= 20) {
    return "medium";
  }

  return "low";
}

function getConfidence(regimeConfidence: number, basis: RangePlanBasis, hasIndicators: boolean) {
  const basisScore = basis === "current_range" ? 0.25 : 0.55;
  const indicatorScore = hasIndicators ? 0.15 : 0;
  return clamp(basisScore + indicatorScore + regimeConfidence * 0.25, 0.2, 0.9);
}

function buildReasons(
  width: { widthPct: number; basis: RangePlanBasis },
  mid: { price: number; basis: RangePlanMidBasis },
  regime: string | null,
  regimeConfidence: number | null,
  plan: RangePlanDecision
) {
  const reasons = [`Width comes from ${width.basis.replace("_", " ")} at ${round(width.widthPct, 2)}%.`];
  reasons.push(`Center comes from ${mid.basis.replace(/_/g, " ")} at ${round(mid.price, 4)}.`);

  if (regime) {
    reasons.push(`Market regime is ${regime}${regimeConfidence === null ? "" : ` with ${Math.round(regimeConfidence * 100)}% heuristic score`}.`);
  }

  reasons.push(`${plan.recommendedLevelCount} rails target roughly ${round(plan.stepPct, 2)}% per cycle.`);
  reasons.push(`Spacing recommendation is ${plan.recommendedGridType}.`);
  reasons.push(`Minimum spacing is ${plan.minimumStepPct}%: max(NATR × multiplier, round-trip costs ${plan.estimatedRoundTripCostPct}% + net margin). These parameters are research assumptions.`);
  if (!plan.costFloorSatisfied) reasons.push("No affordable interval clears the estimated cost floor; decline a new launch.");
  return reasons;
}

function keepCurrentRange(input: RangePlanInput, reason: string): RangePlanDecision {
  const low = Number(input.currentLowPrice);
  const high = Number(input.currentHighPrice);
  const widthPct = low > 0 && high > low ? ((high - low) / low) * 100 : 0;
  const cycles = Math.max(1, input.currentLevelCount - 1);

  return {
    recommendedLowPrice: Number.isFinite(low) ? round(low, 8) : 0,
    recommendedHighPrice: Number.isFinite(high) ? round(high, 8) : 0,
    recommendedLevelCount: Math.max(2, input.currentLevelCount),
    recommendedGridType: GridType.Arithmetic,
    midPrice: Number.isFinite(low) && Number.isFinite(high) ? round((low + high) / 2, 8) : 0,
    midBasis: "current_range_mid",
    widthPct: round(widthPct, 4),
    stepPct: round(widthPct / cycles, 4),
    basis: "current_range",
    confidence: 0.2,
    risk: "high",
    operatorAction: "Keep the current range until indicators are available.",
    reasons: [reason]
  };
}

function isPositive(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
