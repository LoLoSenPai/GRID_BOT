import type { RecenterBreakoutSide, RecenterPolicyDecision, RecenterPolicyInput, RecenterPolicyRisk } from "../domain/types";
import { round } from "../utils/math";

const HARD_BREAKOUT_BARS = 3;
const HYBRID_BREAKOUT_BARS = 2;
const HIGH_OCCUPANCY_PCT = 85;
const SATURATED_OCCUPANCY_PCT = 95;
const LOW_CONFIDENCE = 0.45;

export class RecenterPolicyService {
  evaluate(input: RecenterPolicyInput): RecenterPolicyDecision {
    const lowPrice = Number(input.lowPrice);
    const highPrice = Number(input.highPrice);
    const currentPrice = Number(input.currentPrice);

    if (!Number.isFinite(currentPrice) || !Number.isFinite(lowPrice) || !Number.isFinite(highPrice) || highPrice <= lowPrice || lowPrice <= 0) {
      return decision({
        mode: "hard",
        side: "inside",
        allowNewBuys: false,
        allowRecoverySells: false,
        risk: "high",
        operatorAction: "Fix the range before running recenter logic.",
        reasons: ["Invalid range or current price."]
      });
    }

    const side = getBreakoutSide(currentPrice, lowPrice, highPrice);
    if (side === "inside") {
      return decision({
        mode: "none",
        side,
        allowNewBuys: true,
        allowRecoverySells: true,
        risk: "low",
        operatorAction: "Keep the current grid.",
        reasons: ["Price is inside the configured range."]
      });
    }

    const reasons: string[] = [`Price is ${side} the configured range.`];
    const openCycleCount = Math.max(0, input.openCycleCount);
    const maxOccupancyPct = Math.max(0, input.maxOccupancyPct);
    const consecutiveOutsideBars = Math.max(0, input.consecutiveOutsideBars);
    const regime = input.marketRegime ?? null;

    if (regime) {
      reasons.push(`Regime is ${regime.regime} with ${Math.round(regime.confidence * 100)}% confidence.`);
    }

    if (regime?.regime === "CHAOTIC_HIGH_VOL" && regime.confidence >= LOW_CONFIDENCE) {
      return decision({
        mode: "soft",
        side,
        allowNewBuys: false,
        allowRecoverySells: true,
        risk: "high",
        operatorAction: "Pause new buys and only allow recovery sells until volatility normalizes.",
        reasons: [...reasons, "High volatility makes a range shift unreliable."]
      });
    }

    if (consecutiveOutsideBars < HYBRID_BREAKOUT_BARS) {
      return decision({
        mode: "soft",
        side,
        allowNewBuys: false,
        allowRecoverySells: true,
        risk: "medium",
        operatorAction: "Wait for a second outside close before moving rails.",
        reasons: [...reasons, "Breakout is not confirmed yet."]
      });
    }

    if (maxOccupancyPct >= SATURATED_OCCUPANCY_PCT) {
      return decision({
        mode: "soft",
        side,
        allowNewBuys: false,
        allowRecoverySells: true,
        risk: "high",
        operatorAction: "Do not move the full grid while occupancy is saturated. Defend inventory first.",
        reasons: [...reasons, `Occupancy is ${round(maxOccupancyPct, 1)}%.`]
      });
    }

    const suggestedRange = suggestHybridRange({ currentPrice, lowPrice, highPrice, side });

    if (openCycleCount > 0) {
      return decision({
        mode: "hybrid",
        side,
        allowNewBuys: false,
        allowRecoverySells: true,
        suggestedLowPrice: suggestedRange.low,
        suggestedHighPrice: suggestedRange.high,
        risk: maxOccupancyPct >= HIGH_OCCUPANCY_PCT ? "high" : "medium",
        operatorAction: "Move only free rails and keep recovery sells available for open cycles.",
        reasons: [...reasons, `${openCycleCount} open cycle(s) still need paired exits.`]
      });
    }

    if (consecutiveOutsideBars >= HARD_BREAKOUT_BARS && isDirectionalBreakout(side, regime)) {
      return decision({
        mode: "hard",
        side,
        allowNewBuys: false,
        allowRecoverySells: false,
        suggestedLowPrice: suggestedRange.low,
        suggestedHighPrice: suggestedRange.high,
        risk: "medium",
        operatorAction: "Recreate the bot around a new range because no open cycle has to be protected.",
        reasons: [...reasons, "Breakout is confirmed and no open cycle remains."]
      });
    }

    return decision({
      mode: "hybrid",
      side,
      allowNewBuys: false,
      allowRecoverySells: true,
      suggestedLowPrice: suggestedRange.low,
      suggestedHighPrice: suggestedRange.high,
      risk: "medium",
      operatorAction: "Shift the range progressively and keep new buys paused until the next inside close.",
      reasons: [...reasons, "Breakout is confirmed but not directional enough for a hard recreate."]
    });
  }
}

function getBreakoutSide(currentPrice: number, lowPrice: number, highPrice: number): RecenterBreakoutSide {
  if (currentPrice > highPrice) {
    return "above";
  }

  if (currentPrice < lowPrice) {
    return "below";
  }

  return "inside";
}

function suggestHybridRange(input: { currentPrice: number; lowPrice: number; highPrice: number; side: Exclude<RecenterBreakoutSide, "inside"> }) {
  const width = input.highPrice - input.lowPrice;
  const anchorRatio = input.side === "above" ? 0.65 : 0.35;
  const low = Math.max(input.currentPrice - width * anchorRatio, input.currentPrice * 0.01);
  const high = low + width;

  return {
    low: round(low, 8),
    high: round(high, 8)
  };
}

function isDirectionalBreakout(side: Exclude<RecenterBreakoutSide, "inside">, regime: RecenterPolicyInput["marketRegime"]) {
  if (!regime || regime.confidence < LOW_CONFIDENCE) {
    return false;
  }

  return (side === "above" && regime.regime === "TREND_UP") || (side === "below" && regime.regime === "TREND_DOWN");
}

function decision(input: {
  mode: RecenterPolicyDecision["mode"];
  side: RecenterBreakoutSide;
  allowNewBuys: boolean;
  allowRecoverySells: boolean;
  suggestedLowPrice?: number | null;
  suggestedHighPrice?: number | null;
  risk: RecenterPolicyRisk;
  operatorAction: string;
  reasons: string[];
}): RecenterPolicyDecision {
  return {
    mode: input.mode,
    side: input.side,
    allowNewBuys: input.allowNewBuys,
    allowRecoverySells: input.allowRecoverySells,
    suggestedLowPrice: input.suggestedLowPrice ?? null,
    suggestedHighPrice: input.suggestedHighPrice ?? null,
    risk: input.risk,
    operatorAction: input.operatorAction,
    reasons: input.reasons
  };
}
