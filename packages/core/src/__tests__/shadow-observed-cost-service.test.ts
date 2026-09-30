import { describe, expect, it } from "vitest";
import { MINTS } from "@grid-bot/common";
import { buildObservedCostProfile, decomposeShadowExecutionCost, type ShadowCostExecution } from "../services/shadow-observed-cost-service";

function execution(id = "execution"): ShadowCostExecution {
  return { id, botId: "bot", provider: "jupiter", mode: "live", status: "filled", side: "buy",
    createdAt: "2026-09-30T10:00:00Z", completedAt: "2026-09-30T10:00:02Z", assetSymbol: "SOL",
    baseMint: MINTS.SOL, quoteMint: MINTS.USDC, baseDecimals: 9, quoteDecimals: 6,
    executedInputAmount: 100, executedOutputAmount: 0.999,
    rawReport: { order: { inputMint: MINTS.USDC, outputMint: MINTS.SOL, inAmount: "100000000", outAmount: "999000000",
      feeMint: MINTS.SOL, feeBps: 10, taker: "wallet", router: "metis", rentFeeLamports: 2_000_000 },
      executeResponse: { totalInputAmount: "100000000", totalOutputAmount: "999000000", inputAmountResult: "100000000", outputAmountResult: "1000000000" },
      nativeFeeBasis: "confirmed-wallet-sol-delta", totalWalletNativeCostLamports: 2_005_000, totalNetworkFeeLamports: 5_000,
      nativeFeePayer: "wallet", walletNativeRefundLamports: 0 } };
}
function raw(row: ShadowCostExecution) { return row.rawReport as { order: Record<string, unknown>; executeResponse: Record<string, unknown>; [key: string]: unknown }; }
function profile(rows: ShadowCostExecution[], extra = {}) {
  return buildObservedCostProfile({ portfolioId: "portfolio", botId: "bot", assetSymbol: "SOL", baseMint: MINTS.SOL,
    quoteMint: MINTS.USDC, asOf: "2026-09-30T12:00:00Z", executions: rows, ...extra });
}

describe("observed Jupiter cost decomposition", () => {
  it("keeps embedded swap fee and rent descriptive without adding either to wallet totals twice", () => {
    const result = decomposeShadowExecutionCost(execution());
    expect(result.walletInputAmount).toBe(100); expect(result.walletOutputAmount).toBe(0.999);
    expect(result.embeddedFeeAmount).toBeCloseTo(0.001); expect(result.feeBps).toBeCloseTo(10);
    expect(result.adverseSlippageBps).toBeCloseTo(0); expect(result.netQuoteToFillAdverseBps).toBeCloseTo(0);
    expect(result.walletNativeCostSol).toBe(0.002005); expect(result.networkFeeSol).toBe(0.000005);
    expect(result.rentEstimateSol).toBe(0.002); expect(result.rentActualSol).toBeNull();
    expect(result.walletNativeCostUsd).toBeCloseTo(0.002005 * (100 / 0.999));
    expect(result.approximateCreationToCompletionMs).toBe(2000);
  });
  it("does not count an input fee again as quote drift when quote input provenance is ambiguous", () => {
    const row = execution(); row.executedInputAmount = 101; row.executedOutputAmount = 1;
    Object.assign(raw(row).order, { feeMint: MINTS.USDC, feeBps: 100, outAmount: "1000000000" });
    Object.assign(raw(row).executeResponse, { totalInputAmount: "101000000", totalOutputAmount: "1000000000", outputAmountResult: "1000000000" });
    const result = decomposeShadowExecutionCost(row);
    expect(result.feeBps).toBeCloseTo(10_000 / 101); expect(result.adverseSlippageBps).toBeNull();
    expect(result.netQuoteToFillAdverseBps).toBeCloseTo(10_000 / 101);
  });
  it("separates output fee from route drift and records sponsored network cost", () => {
    const row = execution(); row.executedOutputAmount = 0.98901;
    Object.assign(raw(row).executeResponse, { totalOutputAmount: "989010000", outputAmountResult: "990000000" });
    raw(row).nativeFeePayer = "sponsor"; raw(row).totalWalletNativeCostLamports = 0;
    const result = decomposeShadowExecutionCost(row);
    expect(result.feeBps).toBeCloseTo(10); expect(result.adverseSlippageBps).toBeCloseTo(100);
    expect(result.networkPaidByWalletSol).toBe(0); expect(result.networkPaidElsewhereSol).toBe(0.000005);
    expect(result.walletNativeCostUsd).toBe(0);
  });
  it("handles a fee in buy input without adding it to route drift", () => {
    const row = execution(); row.executedOutputAmount = 0.999;
    Object.assign(raw(row).order, { feeMint: MINTS.USDC, feeBps: 10 });
    Object.assign(raw(row).executeResponse, { inputAmountResult: "99900000", outputAmountResult: "999000000" });
    const result = decomposeShadowExecutionCost(row);
    expect(result.embeddedFeeAmount).toBeCloseTo(0.1); expect(result.feeBps).toBeCloseTo(10);
    expect(result.embeddedFeeUsd).toBeCloseTo(0.1); expect(result.adverseSlippageBps).toBeCloseTo(0);
  });
  it("uses BTC mint decimals and quote output fee correctly on a sell", () => {
    const row = execution(); row.side = "sell"; row.assetSymbol = "BTC"; row.baseMint = MINTS.BTC; row.baseDecimals = 8;
    row.executedInputAmount = 0.001; row.executedOutputAmount = 99.9;
    Object.assign(raw(row).order, { inputMint: MINTS.BTC, outputMint: MINTS.USDC, inAmount: "100000", outAmount: "99900000", feeMint: MINTS.USDC });
    Object.assign(raw(row).executeResponse, { totalInputAmount: "100000", totalOutputAmount: "99900000", inputAmountResult: "100000", outputAmountResult: "100000000" });
    const result = decomposeShadowExecutionCost(row);
    expect(result.walletInputAmount).toBe(0.001); expect(result.embeddedFeeAmount).toBeCloseTo(0.1);
    expect(result.feeBps).toBeCloseTo(10); expect(result.adverseSlippageBps).toBeCloseTo(0);
  });
  it("never promotes missing fee/native evidence to zero", () => {
    const row = execution(); delete raw(row).executeResponse.outputAmountResult; delete raw(row).totalWalletNativeCostLamports;
    const result = decomposeShadowExecutionCost(row);
    expect(result.feeBps).toBeNull(); expect(result.walletNativeCostSol).toBeNull(); expect(result.walletNativeCostUsd).toBeNull();
  });
  it("rejects future and stale SOL USD references for non-SOL inventory", () => {
    const row = execution(); row.assetSymbol = "BTC"; row.baseMint = MINTS.BTC;
    raw(row).order.outputMint = MINTS.BTC; raw(row).order.feeMint = MINTS.BTC;
    row.nativeUsdReference = { price: 100, capturedAt: "2026-09-30T10:00:03Z" };
    expect(decomposeShadowExecutionCost(row).walletNativeCostUsd).toBeNull();
    row.nativeUsdReference.capturedAt = "2026-09-30T08:00:00Z";
    expect(decomposeShadowExecutionCost(row).walletNativeCostUsd).toBeNull();
    row.nativeUsdReference.capturedAt = "2026-09-30T10:00:01Z";
    expect(decomposeShadowExecutionCost(row).walletNativeCostUsd).toBeCloseTo(0.2005);
  });
});

describe("immutable causal observed cost profiles", () => {
  it("uses exact mint, bot, filled provider, bucket and completion asOf; requires at least five unique fills", () => {
    const rows = Array.from({ length: 5 }, (_, i) => execution(String(i)));
    const future = execution("future"); future.completedAt = "2026-09-30T12:00:01Z";
    const wrongMint = execution("wrong"); wrongMint.baseMint = MINTS.BTC;
    const paper = execution("paper"); paper.mode = "paper";
    const failed = execution("failed"); failed.status = "failed";
    const result = profile([...rows, rows[0]!, future, wrongMint, paper, failed]);
    expect(result.count).toBe(5); expect(result.usable).toBe(true); expect(result.executionIds).toEqual(["0", "1", "2", "3", "4"]);
    expect(result.feeBps).toBeCloseTo(10); expect(result.safetyMarginBps).toBe(0);
    expect(profile(rows.slice(0, 4), { options: { minSamples: 1 } }).usable).toBe(false);
    expect(profile(rows, { options: { notionalBucket: { minUsd: 101, maxUsd: 200 } } }).count).toBe(0);
  });
  it("refuses complete usability when one eligible fill lacks evidence, even if five others are covered", () => {
    const rows = Array.from({ length: 6 }, (_, i) => execution(String(i)));
    delete raw(rows[5]!).executeResponse.outputAmountResult;
    const result = profile(rows, { options: { safetyMarginBps: 7 } });
    expect(result.count).toBe(6); expect(result.usable).toBe(false); expect(result.coverage.fee).toBe(5);
    expect(result.safetyMarginBps).toBe(7); expect(result.coverageWarnings).toContain("incomplete_embedded_fee_coverage");
  });
  it("uses deterministic nearest-rank p90 and leaves pessimistic margin outside observations", () => {
    const rows = Array.from({ length: 10 }, (_, i) => {
      const row = execution(String(i)); raw(row).totalWalletNativeCostLamports = (i + 1) * 1_000_000; return row;
    });
    const result = profile(rows, { options: { safetyMarginBps: 20 } });
    expect(result.p90NativeFeeUsd).toBeCloseTo(0.009 * (100 / 0.999)); expect(result.safetyMarginBps).toBe(20);
    expect(profile([...rows].reverse()).p90NativeFeeUsd).toBe(result.p90NativeFeeUsd);
  });
});
