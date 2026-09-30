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
function btcExecution(id = "btc"): ShadowCostExecution {
  const row = execution(id); row.assetSymbol = "BTC"; row.baseMint = MINTS.BTC; row.baseDecimals = 8;
  row.executedOutputAmount = 0.000999;
  Object.assign(raw(row).order, { outputMint: MINTS.BTC, feeMint: MINTS.BTC, outAmount: "99900" });
  Object.assign(raw(row).executeResponse, { totalOutputAmount: "99900", outputAmountResult: "100000" });
  return row;
}
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
  it("prefers settled native USDC valuation to reconstructed prices without changing embedded swap fees", () => {
    const row = btcExecution(); row.executedFeeAmount = 0.00060821; row.executedFeeValuedAt = row.completedAt;
    raw(row).totalWalletNativeCostLamports = 5_111;
    row.nativeUsdReference = { price: 9_999, capturedAt: "2026-09-30T10:00:01Z" };
    const result = decomposeShadowExecutionCost(row);
    expect(result.walletNativeCostUsd).toBe(0.00060821);
    expect(result.walletNativeCostUsdBasis).toBe("persisted-executed-fee-quote");
    expect(result.walletNativeCostUsdValuedAt).toBe("2026-09-30T10:00:02.000Z");
    expect(result.feeBps).toBeCloseTo(10); expect(result.embeddedFeeAmount).toBeCloseTo(0.000001);
    expect(result.walletInputAmount).toBe(100); expect(result.walletOutputAmount).toBe(0.000999);
  });
  it("requires confirmed native basis, USDC, consistent amounts and a known nonfuture settlement time", () => {
    const valid = btcExecution(); valid.executedFeeAmount = 0.00060821; valid.executedFeeValuedAt = valid.completedAt;
    for (const change of [
      (row: ShadowCostExecution) => { raw(row).nativeFeeBasis = "order-estimate"; },
      (row: ShadowCostExecution) => { row.quoteMint = MINTS.HYPE; raw(row).order.inputMint = MINTS.HYPE; },
      (row: ShadowCostExecution) => { row.executedInputAmount = 101; },
      (row: ShadowCostExecution) => { row.executedFeeValuedAt = null; },
      (row: ShadowCostExecution) => { row.executedFeeValuedAt = "2026-09-30T12:00:01Z"; },
      (row: ShadowCostExecution) => { row.executedFeeAmount = 0; },
      (row: ShadowCostExecution) => { row.executedFeeAmount = -1; },
      (row: ShadowCostExecution) => { row.executedFeeAmount = NaN; },
    ]) {
      const row = structuredClone(valid); change(row);
      expect(decomposeShadowExecutionCost(row).walletNativeCostUsd).toBeNull();
      expect(decomposeShadowExecutionCost(row).walletNativeCostUsdBasis).toBe("unavailable");
    }
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
  it("retains all seven frozen BTC native valuations when historical SOL prices have been purged", () => {
    const fees = [0.00060821, 0.00379092, 0.00079413, 0.00317026, 0.00156753, 0.00064743, 0.00072545];
    const lamports = [5_111, 33_333, 7_025, 27_275, 13_174, 5_221, 5_962];
    const rows = fees.map((fee, i) => { const row = btcExecution(String(i)); row.executedFeeAmount = fee;
      row.executedFeeValuedAt = row.completedAt; raw(row).totalWalletNativeCostLamports = lamports[i]; return row; });
    const result = profile(rows, { baseMint: MINTS.BTC, assetSymbol: "BTC" });
    expect(result.coverage).toEqual({ fee: 7, adverseSlippage: 7, nativeFeeUsd: 7 });
    expect(result.usable).toBe(true); expect(result.p90NativeFeeUsd).toBe(0.00379092);
    expect(rows.reduce((sum, row) => sum + decomposeShadowExecutionCost(row).walletNativeCostUsd!, 0)).toBeCloseTo(0.01130393, 10);
    expect(profile(rows, { baseMint: MINTS.BTC, assetSymbol: "BTC", asOf: "2026-09-30T10:00:01Z" }).count).toBe(0);
  });
});
