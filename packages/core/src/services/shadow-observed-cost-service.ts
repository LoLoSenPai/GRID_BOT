import { MINTS } from "@grid-bot/common";
import { Decimal } from "decimal.js";

export const SHADOW_OBSERVED_COST_VERSION = "shadow-observed-cost-v1" as const;
export interface ShadowCostExecution {
  id: string; botId: string; provider: string; mode: string; status: string;
  side: "buy" | "sell"; createdAt: Date | string; completedAt: Date | string | null;
  assetSymbol: string; baseMint: string; quoteMint: string; baseDecimals: number; quoteDecimals: number;
  executedInputAmount: number | null; executedOutputAmount: number | null; rawReport: unknown;
  /** Quote-denominated accounting valuation frozen before completedAt, not an extra swap fee. */
  executedFeeAmount?: number | null;
  /** Availability of the frozen native USD valuation; persisted alongside feeAmount in the commit. */
  executedFeeValuedAt?: Date | string | null;
  /** Causal USD reference, never a current price applied retrospectively. */
  nativeUsdReference?: { price: number; capturedAt: Date | string } | null;
}
export interface ShadowCostProfileOptions {
  windowStart?: Date | string; windowDays?: number; notionalBucket?: { minUsd: number; maxUsd: number };
  minSamples?: number; safetyMarginBps?: number;
}
export interface ShadowObservedCostProfile {
  version: typeof SHADOW_OBSERVED_COST_VERSION; portfolioId: string; botId: string;
  asOf: string; windowStart: string; assetSymbol: string; baseMint: string; quoteMint: string;
  notionalBucket: { minUsd: number; maxUsd: number }; count: number; minSamples: number; usable: boolean;
  feeBps: number | null; adverseSlippageBps: number | null; p90NativeFeeUsd: number | null;
  safetyMarginBps: number; coverageWarnings: string[]; executionIds: string[];
  coverage: { fee: number; adverseSlippage: number; nativeFeeUsd: number };
  /** Identified swap fees are descriptive components of wallet totals. */
  feeBasis: "embedded-wallet-totals";
}
export interface ShadowExecutionCostBreakdown {
  executionId: string; completedAt: string | null; notionalUsd: number | null;
  walletInputAmount: number | null; walletOutputAmount: number | null;
  embeddedFeeMint: string | null; embeddedFeeAmount: number | null; embeddedFeeUsd: number | null;
  feeBps: number | null; quotedFeeBps: number | null; adverseSlippageBps: number | null;
  netQuoteToFillAdverseBps: number | null;
  walletNativeCostSol: number | null; walletNativeRefundSol: number | null; walletNativeCostUsd: number | null;
  walletNativeCostUsdBasis: "persisted-executed-fee-quote" | "execution-sol-fill-price" | "causal-sol-price" | "confirmed-zero" | "unavailable";
  walletNativeCostUsdValuedAt: string | null;
  networkFeeSol: number | null; networkPaidByWalletSol: number | null; networkPaidElsewhereSol: number | null;
  rentEstimateSol: number | null; rentActualSol: null; route: string | null;
  approximateCreationToCompletionMs: number | null; warnings: string[];
}

/** Read-only decomposition: amounts remain net; embedded fees and rent estimates are never added again. */
export function decomposeShadowExecutionCost(row: ShadowCostExecution): ShadowExecutionCostBreakdown {
  const raw = record(row.rawReport), order = record(raw.order), result = record(raw.executeResponse);
  const warnings = ["amm_spread_impact_not_separately_identifiable", "creation_to_completion_is_not_end_to_end_latency"];
  const completed = date(row.completedAt), created = date(row.createdAt);
  const pairMatches = row.side === "buy"
    ? order.inputMint === row.quoteMint && order.outputMint === row.baseMint
    : order.inputMint === row.baseMint && order.outputMint === row.quoteMint;
  if (!pairMatches) warnings.push("missing_or_mismatched_quote_mints");
  const inputDecimals = row.side === "buy" ? row.quoteDecimals : row.baseDecimals;
  const outputDecimals = row.side === "buy" ? row.baseDecimals : row.quoteDecimals;
  const totalInput = units(result.totalInputAmount, inputDecimals);
  const totalOutput = units(result.totalOutputAmount, outputDecimals);
  const input = totalInput ?? positive(row.executedInputAmount), output = totalOutput ?? positive(row.executedOutputAmount);
  const amountMatches = totalInput !== null && totalOutput !== null &&
    close(totalInput, row.executedInputAmount) && close(totalOutput, row.executedOutputAmount);
  if (!amountMatches) warnings.push("wallet_totals_missing_or_inconsistent");
  const notionalUsd = row.quoteMint === MINTS.USDC ? row.side === "buy" ? input : output : null;
  const baseUsd = input !== null && output !== null && row.quoteMint === MINTS.USDC
    ? row.side === "buy" ? input / output : output / input : null;
  const feeMint = text(order.feeMint) ?? text(record(order.platformFee).feeMint);
  let embeddedFeeAmount: number | null = null;
  let feeBps: number | null = null;
  if (pairMatches && amountMatches && feeMint === order.inputMint) {
    const routeInput = units(result.inputAmountResult, inputDecimals);
    if (routeInput !== null && routeInput <= totalInput!) {
      embeddedFeeAmount = new Decimal(totalInput!).minus(routeInput).toNumber();
      feeBps = embeddedFeeAmount / totalInput! * 10_000;
    }
  } else if (pairMatches && amountMatches && feeMint === order.outputMint) {
    const routeOutput = units(result.outputAmountResult, outputDecimals);
    if (routeOutput !== null && routeOutput >= totalOutput!) {
      embeddedFeeAmount = new Decimal(routeOutput).minus(totalOutput!).toNumber();
      feeBps = embeddedFeeAmount / routeOutput * 10_000;
    }
  }
  const quotedFeeBps = nonnegative(order.feeBps) ?? nonnegative(record(order.platformFee).feeBps);
  if (feeBps === null) warnings.push("embedded_fee_not_observed");
  const embeddedFeeUsd = embeddedFeeAmount === null ? null : feeMint === row.quoteMint && row.quoteMint === MINTS.USDC
    ? embeddedFeeAmount : feeMint === row.baseMint && baseUsd !== null ? embeddedFeeAmount * baseUsd : null;
  const quotedInput = units(order.inAmount, inputDecimals), quotedOutput = units(order.outAmount, outputDecimals);
  const netQuoteToFillAdverseBps = pairMatches && amountMatches && quotedInput !== null && quotedOutput !== null
    ? Math.max(0, (1 - (totalOutput! / totalInput!) / (quotedOutput / quotedInput)) * 10_000) : null;
  // The profile adds fee + drift: isolate route drift first. If quote fee/input semantics are ambiguous,
  // keep a net diagnostic but refuse an additive drift estimate instead of counting the fee twice.
  let adverseSlippageBps: number | null = null;
  const routeInput = units(result.inputAmountResult, inputDecimals), routeOutput = units(result.outputAmountResult, outputDecimals);
  if (pairMatches && amountMatches && quotedInput !== null && quotedOutput !== null && close(quotedInput, totalInput) &&
    routeInput !== null && routeOutput !== null && quotedFeeBps !== null && quotedFeeBps < 10_000 &&
    (feeMint === order.inputMint || feeMint === order.outputMint)) {
    const fraction = 1 - quotedFeeBps / 10_000;
    const quotedRouteInput = feeMint === order.inputMint ? quotedInput * fraction : quotedInput;
    const quotedRouteOutput = feeMint === order.outputMint ? quotedOutput / fraction : quotedOutput;
    adverseSlippageBps = Math.max(0, (1 - (routeOutput / routeInput) / (quotedRouteOutput / quotedRouteInput)) * 10_000);
  }
  if (adverseSlippageBps === null) warnings.push("fee_exclusive_quote_fill_drift_unidentified");
  const walletNativeCostSol = raw.nativeFeeBasis === "confirmed-wallet-sol-delta"
    ? lamports(raw.totalWalletNativeCostLamports) : null;
  const walletNativeRefundSol = raw.nativeFeeBasis === "confirmed-wallet-sol-delta"
    ? lamports(raw.walletNativeRefundLamports) : null;
  const networkFeeSol = lamports(raw.totalNetworkFeeLamports);
  const taker = text(order.taker), payer = text(raw.nativeFeePayer);
  const networkPaidByWalletSol = networkFeeSol === null || taker === null || payer === null ? null : payer === taker ? networkFeeSol : 0;
  const networkPaidElsewhereSol = networkPaidByWalletSol === null ? null : networkFeeSol! - networkPaidByWalletSol;
  let nativePrice: number | null = row.baseMint === MINTS.SOL ? baseUsd : null;
  const referenceTime = date(row.nativeUsdReference?.capturedAt);
  if (nativePrice === null && completed !== null && referenceTime !== null && referenceTime <= completed &&
    completed - referenceTime <= 60 * 60 * 1_000) nativePrice = positive(row.nativeUsdReference?.price);
  const walletNativeCostUsd = walletNativeCostSol === null ? null : walletNativeCostSol === 0 ? 0
    : nativePrice === null ? null : walletNativeCostSol * nativePrice;
  // Jupiter returns feeAmount=0 because wallet token totals already include swap fees. The engine then
  // converts the separate confirmed SOL wallet cost into quote units BEFORE accounting commit, where
  // executedFeeAmount is frozen. Use that settled valuation before any reconstructed SOL/USD price.
  // Legacy generic fee columns, unconfirmed native reports and non-USDC quote units cannot prove USD.
  const settledValuedAt = date(row.executedFeeValuedAt);
  const settledNativeUsd = row.provider === "jupiter" && row.mode === "live" && row.status === "filled" &&
    completed !== null && settledValuedAt !== null && settledValuedAt <= completed && row.quoteMint === MINTS.USDC && pairMatches && amountMatches &&
    walletNativeCostSol !== null && walletNativeCostSol > 0 ? positive(row.executedFeeAmount) : null;
  const nativeCostUsd = settledNativeUsd ?? walletNativeCostUsd;
  const walletNativeCostUsdBasis: ShadowExecutionCostBreakdown["walletNativeCostUsdBasis"] = settledNativeUsd !== null
    ? "persisted-executed-fee-quote" : nativeCostUsd === null ? "unavailable" : walletNativeCostSol === 0 ? "confirmed-zero"
      : row.baseMint === MINTS.SOL ? "execution-sol-fill-price" : "causal-sol-price";
  const nativeValuedAt = settledNativeUsd !== null ? settledValuedAt : nativeCostUsd === null ? null
    : row.baseMint === MINTS.SOL || walletNativeCostSol === 0 ? completed : referenceTime;
  if (settledNativeUsd !== null) warnings.push("native_usd_valuation_frozen_at_accounting_commit");
  if (walletNativeCostSol === null) warnings.push("wallet_native_fee_unconfirmed");
  if (nativeCostUsd === null) warnings.push("native_fee_usd_missing_causal_price");
  warnings.push("rent_estimate_not_actual_rent", "wallet_native_total_already_includes_native_costs");
  return { executionId: row.id, completedAt: completed === null ? null : new Date(completed).toISOString(), notionalUsd,
    walletInputAmount: input, walletOutputAmount: output, embeddedFeeMint: feeMint, embeddedFeeAmount, embeddedFeeUsd,
    feeBps, quotedFeeBps, adverseSlippageBps, netQuoteToFillAdverseBps, walletNativeCostSol, walletNativeRefundSol,
    walletNativeCostUsd: nativeCostUsd, walletNativeCostUsdBasis,
    walletNativeCostUsdValuedAt: nativeValuedAt === null ? null : new Date(nativeValuedAt).toISOString(),
    networkFeeSol, networkPaidByWalletSol, networkPaidElsewhereSol, rentEstimateSol: lamports(order.rentFeeLamports),
    rentActualSol: null, route: text(order.router), approximateCreationToCompletionMs:
      completed !== null && created !== null && completed >= created ? completed - created : null, warnings };
}

export function buildObservedCostProfile(input: {
  portfolioId: string; botId: string; asOf: Date | string; assetSymbol: string; baseMint: string; quoteMint: string;
  executions: readonly ShadowCostExecution[]; options?: ShadowCostProfileOptions;
}): ShadowObservedCostProfile {
  const asOf = date(input.asOf);
  if (asOf === null) throw new Error("Invalid observed cost asOf.");
  const options = input.options ?? {}, windowDays = options.windowDays ?? 30;
  if (!Number.isFinite(windowDays) || windowDays <= 0) throw new Error("Invalid observed cost window.");
  const windowStart = options.windowStart === undefined ? asOf - windowDays * 86_400_000 : date(options.windowStart);
  const bucket = options.notionalBucket ?? { minUsd: 25, maxUsd: 250 };
  const minSamples = Math.max(5, options.minSamples ?? 5), safetyMarginBps = options.safetyMarginBps ?? 0;
  if (windowStart === null || windowStart > asOf || !Number.isFinite(bucket.minUsd) || !Number.isFinite(bucket.maxUsd) ||
    bucket.minUsd < 0 || bucket.maxUsd <= bucket.minUsd || !Number.isInteger(minSamples) || !Number.isFinite(safetyMarginBps) || safetyMarginBps < 0)
    throw new Error("Invalid observed cost profile options.");
  const rows = input.executions.filter(row => {
    const completed = date(row.completedAt);
    return row.botId === input.botId && row.provider === "jupiter" && row.mode === "live" && row.status === "filled" &&
      row.baseMint === input.baseMint && row.quoteMint === input.quoteMint && completed !== null && completed >= windowStart && completed <= asOf;
  }).sort((a, b) => date(a.completedAt)! - date(b.completedAt)! || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const samples = rows.filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true; })
    .map(decomposeShadowExecutionCost).filter(row => row.notionalUsd !== null && row.notionalUsd >= bucket.minUsd && row.notionalUsd < bucket.maxUsd);
  const fees = numbers(samples.map(row => row.feeBps)), adverse = numbers(samples.map(row => row.adverseSlippageBps)), native = numbers(samples.map(row => row.walletNativeCostUsd));
  const warnings = new Set(samples.flatMap(row => row.warnings));
  warnings.add("amm_spread_impact_not_separately_identifiable");
  warnings.add("descriptive_history_not_profit_validation");
  if (samples.length < minSamples) warnings.add("insufficient_filled_samples");
  if (fees.length < samples.length) warnings.add("incomplete_embedded_fee_coverage");
  if (adverse.length < samples.length) warnings.add("incomplete_quote_fill_coverage");
  if (native.length < samples.length) warnings.add("incomplete_native_fee_coverage");
  const completeCoverage = fees.length === samples.length && adverse.length === samples.length && native.length === samples.length;
  return { version: SHADOW_OBSERVED_COST_VERSION, portfolioId: input.portfolioId, botId: input.botId, asOf: new Date(asOf).toISOString(),
    windowStart: new Date(windowStart).toISOString(), assetSymbol: input.assetSymbol, baseMint: input.baseMint, quoteMint: input.quoteMint,
    notionalBucket: { ...bucket }, count: samples.length, minSamples, usable: samples.length >= minSamples && completeCoverage,
    feeBps: fees.length >= minSamples ? p90(fees) : null, adverseSlippageBps: adverse.length >= minSamples ? p90(adverse) : null,
    p90NativeFeeUsd: native.length >= minSamples ? p90(native) : null, safetyMarginBps,
    coverageWarnings: [...warnings].sort(), executionIds: samples.map(row => row.executionId),
    coverage: { fee: fees.length, adverseSlippage: adverse.length, nativeFeeUsd: native.length }, feeBasis: "embedded-wallet-totals" };
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string | null { return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null; }
function nonnegative(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function positive(value: unknown): number | null { const n = nonnegative(value); return n !== null && n > 0 ? n : null; }
function date(value: unknown): number | null { if (!(value instanceof Date) && typeof value !== "string") return null; const n = new Date(value).getTime(); return Number.isFinite(n) ? n : null; }
function lamports(value: unknown): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value / 1_000_000_000 : null; }
function units(value: unknown, decimals: number): number | null {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || typeof value !== "string" || !/^\d{1,20}$/.test(value)) return null;
  const raw = new Decimal(value); return raw.gt(0) && raw.lte("18446744073709551615") ? raw.div(new Decimal(10).pow(decimals)).toNumber() : null;
}
function close(a: number, b: number | null): boolean { return b !== null && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-12, Math.abs(a) * 1e-10); }
function numbers(values: Array<number | null>): number[] { return values.filter((n): n is number => n !== null && Number.isFinite(n) && n >= 0); }
function p90(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(0.9 * sorted.length) - 1]!; }
