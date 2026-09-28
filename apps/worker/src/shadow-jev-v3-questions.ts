import { createHash } from "node:crypto";
import type { ShadowGridCandidateSet } from "@grid-bot/core";
import type { ShadowJevPolicyInput } from "./shadow-jev-questions";

export const v3QuestionSetVersion = "shadow-jev-v3" as const;
export const currentV3QuestionSetVersion = "shadow-jev-v3.1" as const;
export const v3ModelRequested = "jev-1.13.0" as const;
export const V3_EVALUATION_HORIZON_HOURS = 24;

export interface ShadowJevV3Input {
  observedAt: Date | string;
  stateReadAt: Date | string;
  policyInput: ShadowJevPolicyInput;
  objective: "accumulate_base" | "accumulate_usdc";
  candidateSet: ShadowGridCandidateSet;
}

export interface ShadowJevV3Request {
  model: typeof v3ModelRequested;
  state: {
    observed_at: string;
    state_read_at: string;
    asset_symbol: string;
    objective: ShadowJevV3Input["objective"];
    current_price: number;
    current_band: { low_price: number; high_price: number; level_count: number; spacing_pct: number;
      status: string; idle_quote_usd: number; open_trading_lots: number; open_lot_cost_usd: number;
      open_lot_entry_low: number | null; open_lot_entry_high: number | null };
    capital: { allocated_usd: number; asset_attributed_usd: number; available_cash_usd: number;
      total_portfolio_capital_usd: number; band_count: number };
    estimated_costs: { execution_fee_bps: number; slippage_bps: number; min_useful_order_usd: number };
    market: { candle_interval_ms: number; closed_candle_count: number;
      window_close_change_pct: number; window_high_low_pct: number; mean_hourly_range_pct: number;
      recent_closed_candles: Array<{ closed_at: string; high: number; low: number; close: number }> };
    candidates: Array<{ option: string; family: string; rationale: string; strategy_parameters: Record<string, number | string>;
      action: string; low_price: number; high_price: number;
      level_count: number; spacing_pct: number; requested_capital_usd: number;
      economic_validation: "validated" | "baseline"; economic_validation_reasons: string[] }>;
  };
  questions: {
    grid_candidate: {
      type: "choice";
      instructions: { question: string; horizon: string; evidence_boundary: string; objective: string };
      criteria: Record<string, string>;
    };
  };
}

export interface ShadowJevV3PreparedRequest {
  request: ShadowJevV3Request;
  optionToCandidateId: Record<string, string>;
}

/** Builds a neutral, short projection. The immutable full observation stays in the database. */
export function buildJevV3Request(input: ShadowJevV3Input): ShadowJevV3PreparedRequest {
  const observedAt = iso(input.observedAt, "observedAt");
  const stateReadAt = iso(input.stateReadAt, "stateReadAt");
  if (+new Date(stateReadAt) < +new Date(observedAt)) throw new TypeError("V3 state read precedes the market close.");
  const policy = input.policyInput;
  const set = input.candidateSet;
  if (!policy?.parameters || !policy.band || !Array.isArray(policy.candles)) {
    throw new TypeError("Invalid V3 policy input.");
  }
  if ((set?.version !== "shadow-grid-candidates-v3" && set?.version !== "shadow-grid-candidates-v3.1") ||
    !Array.isArray(set.candidates) ||
    set.candidates.length < 1 || set.candidates.length > 6 || set.candidates[0]?.id !== "keep") {
    throw new TypeError("Invalid V3 candidate set.");
  }
  const ids = new Set<string>();
  const optionToCandidateId: Record<string, string> = {};
  // Balance option positions across observations so a fixed first-option bias
  // cannot masquerade as a preference for KEEP. The seed is reproducible.
  const ordered = set.candidates.map((candidate, originalIndex) => ({ candidate, originalIndex }));
  const questionVersion = set.version === "shadow-grid-candidates-v3.1"
    ? currentV3QuestionSetVersion : v3QuestionSetVersion;
  const seed = createHash("sha256").update([questionVersion, observedAt, policy.assetSymbol,
    policy.band.id].join("|")).digest();
  for (let index = ordered.length - 1, byte = 0; index > 0; index--, byte++) {
    const other = seed[byte]! % (index + 1);
    [ordered[index], ordered[other]] = [ordered[other]!, ordered[index]!];
  }
  const candidates = ordered.map(({ candidate, originalIndex }, index) => {
    if (typeof candidate.id !== "string" || ids.has(candidate.id) ||
      (candidate.validation !== "validated" && !(candidate.validation === "baseline" &&
        ((originalIndex === 0 && candidate.id === "keep") || (candidate.id === "policy" &&
          (candidate.action === "park" || candidate.action === "reactivate")))))) {
      throw new TypeError("Invalid or duplicate V3 candidate.");
    }
    if (!Array.isArray(candidate.economicValidationReasons) ||
      candidate.economicValidationReasons.some(reason => typeof reason !== "string") ||
      candidate.economicallyValid !== (candidate.validation === "validated")) {
      throw new TypeError("Invalid V3 economic validation metadata.");
    }
    ids.add(candidate.id);
    const option = `option_${index}`;
    optionToCandidateId[option] = candidate.id;
    const low = finite(candidate.lowPrice, `${candidate.id}.lowPrice`);
    const high = finite(candidate.highPrice, `${candidate.id}.highPrice`);
    const spacing = finite(candidate.spacing, `${candidate.id}.spacing`);
    if (low <= 0 || high <= low || spacing <= 0 || !Number.isInteger(candidate.levelCount) || candidate.levelCount < 2) {
      throw new TypeError(`Invalid geometry for V3 candidate ${candidate.id}.`);
    }
    const strategyParameters = candidate.strategyParameters ?? {};
    if (Object.entries(strategyParameters).some(([key, value]) => !key ||
      (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))))) {
      throw new TypeError(`Invalid V3 strategy parameters for candidate ${candidate.id}.`);
    }
    return { option, family: candidate.kind, rationale: candidate.decision.reason,
      strategy_parameters: strategyParameters, action: candidate.action, low_price: low, high_price: high,
      level_count: candidate.levelCount, spacing_pct: 100 * spacing / low,
      requested_capital_usd: finite(candidate.requestedCapitalUsd, `${candidate.id}.requestedCapitalUsd`),
      economic_validation: candidate.validation,
      economic_validation_reasons: candidate.economicValidationReasons };
  });
  if (set.policyCandidateId !== null && !ids.has(set.policyCandidateId)) {
    throw new TypeError("V3 policy candidate is missing from the set.");
  }
  const candles = policy.candles
    .filter(candle => +new Date(candle.closedAt) <= +new Date(observedAt))
    .sort((a, b) => +new Date(a.closedAt) - +new Date(b.closedAt))
    .slice(-24)
    .map(candle => ({ closed_at: iso(candle.closedAt, "candle.closedAt"),
      high: finite(candle.high, "candle.high"), low: finite(candle.low, "candle.low"),
      close: finite(candle.close, "candle.close") }));
  if (candles.length === 0 || candles.at(-1)?.closed_at !== observedAt) {
    throw new TypeError("V3 requires a candle closed at observedAt.");
  }
  const windowHigh = Math.max(...candles.map(candle => candle.high));
  const windowLow = Math.min(...candles.map(candle => candle.low));
  const firstClose = candles[0]!.close;
  if (firstClose <= 0 || windowLow <= 0 || candles.some(candle => candle.close <= 0)) {
    throw new TypeError("V3 requires positive market prices.");
  }
  const band = policy.band;
  const lots = band.openTradingLots.filter(lot => lot.kind !== "retained" && lot.remainingBaseAmount > 0);
  if (!Number.isInteger(policy.bandCount) || policy.bandCount < 1 ||
    !Number.isInteger(band.levelCount) || band.levelCount < 2 ||
    (band.status !== "active" && band.status !== "parked")) {
    throw new TypeError("Invalid V3 band or portfolio state.");
  }
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[candidate.option] = `${candidate.family} / ${candidate.action}: range ${candidate.low_price}–${candidate.high_price}, ` +
      `${candidate.level_count} levels, spacing ${candidate.spacing_pct.toFixed(3)}%, ` +
      `new capital ${candidate.requested_capital_usd.toFixed(2)} USDC. ` +
      `Construction: ${candidate.rationale} ` +
      `${candidate.economic_validation === "baseline" ? "Existing baseline; current cost rules would reject it for a new grid. " : ""}` +
      "Existing lot exit targets remain unchanged.";
  }
  criteria.abstain = "Available evidence does not meaningfully distinguish these configurations for the stated horizon.";
  return {
    optionToCandidateId,
    request: {
      model: v3ModelRequested,
      state: {
        observed_at: observedAt, state_read_at: stateReadAt,
        asset_symbol: policy.assetSymbol, objective: input.objective,
        current_price: finite(policy.price, "policy.price"),
        current_band: { low_price: finite(band.lowPrice, "band.lowPrice"),
          high_price: finite(band.highPrice, "band.highPrice"),
          level_count: band.levelCount, spacing_pct: finite(100 * band.spacing / band.lowPrice, "band.spacingPct"),
          status: band.status, idle_quote_usd: finite(band.idleQuoteUsd, "band.idleQuoteUsd"),
          open_trading_lots: lots.length,
          open_lot_cost_usd: finite(lots.reduce((sum, lot) => sum + lot.costQuote, 0), "lots.costQuote"),
          open_lot_entry_low: lots.length ? finite(Math.min(...lots.map(lot => lot.entryPrice)), "lots.entryLow") : null,
          open_lot_entry_high: lots.length ? finite(Math.max(...lots.map(lot => lot.entryPrice)), "lots.entryHigh") : null },
        capital: { allocated_usd: finite(band.allocatedCapitalUsd, "band.allocatedCapitalUsd"),
          asset_attributed_usd: finite(policy.assetAttributedCapitalUsd, "policy.assetAttributedCapitalUsd"),
          available_cash_usd: finite(policy.availableCashUsd, "policy.availableCashUsd"),
          total_portfolio_capital_usd: finite(policy.totalPortfolioCapitalUsd, "policy.totalPortfolioCapitalUsd"),
          band_count: policy.bandCount },
        estimated_costs: { execution_fee_bps: finite(policy.parameters.estimatedExecutionFeeBps ?? 0, "cost.executionFeeBps"),
          slippage_bps: finite(policy.parameters.estimatedSlippageBps ?? 0, "cost.slippageBps"),
          min_useful_order_usd: finite(policy.parameters.minUsefulOrderUsd, "cost.minUsefulOrderUsd") },
        market: { candle_interval_ms: finite(policy.candleIntervalMs, "policy.candleIntervalMs"),
          closed_candle_count: candles.length,
          window_close_change_pct: finite(100 * (candles.at(-1)!.close / firstClose - 1), "window change"),
          window_high_low_pct: finite(100 * (windowHigh / windowLow - 1), "window range"),
          mean_hourly_range_pct: finite(candles.reduce((sum, candle) =>
            sum + 100 * (candle.high - candle.low) / candle.close, 0) / candles.length, "hourly range"),
          recent_closed_candles: candles },
        candidates,
      },
      questions: {
        grid_candidate: {
          type: "choice",
          instructions: {
            question: "Which offered grid configuration is most suitable for useful two-sided oscillations over the next 24 hours after estimated trading costs? Choose one offered option or abstain. This is a shadow hypothesis, not a trading instruction.",
            horizon: "Compare later at 1, 3, 6 and 24 completed hourly candles, with the same initial portfolio state, capital and costs.",
            evidence_boundary: "Candles end at `observed_at`; portfolio state was read at `state_read_at` and may be later. Use only the supplied history and state. Candidate families are construction rules, not evidence of profitability. Do not assume a rebound or invent future prices. Existing lot exit targets stay fixed. New configurations passed deterministic geometry, capital and cost checks; KEEP may be a legacy baseline. Timing eligibility is recorded separately.",
            objective: input.objective === "accumulate_base"
              ? "Favor BTC retained only together with full portfolio equity and locked inventory valuation."
              : "Favor net USDC generation together with full portfolio equity and locked inventory valuation.",
          },
          criteria,
        },
      },
    },
  };
}

function iso(value: Date | string, path: string): string {
  const date = new Date(value);
  if (!Number.isFinite(+date)) throw new TypeError(`${path} must be a valid date.`);
  return date.toISOString();
}
function finite(value: number, path: string): number {
  if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite.`);
  return value;
}
