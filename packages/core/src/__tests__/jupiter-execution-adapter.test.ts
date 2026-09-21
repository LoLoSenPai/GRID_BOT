import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { MINTS } from "@grid-bot/common";

const loadExecutionWalletMock = vi.hoisted(() => vi.fn());
vi.mock("@grid-bot/common", async (importOriginal) => ({
  ...await importOriginal<typeof import("@grid-bot/common")>(),
  getEnv: () => ({ JUPITER_API_KEY: "test-key", EXECUTION_WALLET_SECRET_KEY_PATH: "ignored", RPC_HTTP_URL: "https://rpc.invalid" })
}));
vi.mock("../services/wallet-service", () => ({ loadExecutionWallet: loadExecutionWalletMock }));

import { JupiterExecutionAdapter, type PreparedJupiterExecution } from "../adapters/jupiter-execution-adapter";
import { ExecutionStatus, TradeSide } from "../domain/enums";
import type { ExecuteSwapParams } from "../domain/types";

const params: ExecuteSwapParams = { botId: "bot-1", clientOrderId: "client-1", inputMint: MINTS.USDC,
  outputMint: "output-token", amount: 100, inputDecimals: 6, outputDecimals: 9, tradeSide: TradeSide.Buy, slippageBps: 50 };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe("JupiterExecutionAdapter", () => {
  let wallet: Keypair;
  let order: Record<string, unknown>;
  beforeEach(() => {
    wallet = Keypair.generate(); // Ephemeral test signer; never sent to a network.
    loadExecutionWalletMock.mockReturnValue({ keypair: wallet });
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message());
    order = { inputMint: params.inputMint, outputMint: params.outputMint, inAmount: "100000000", outAmount: "1000000000",
      otherAmountThreshold: "995000000", slippageBps: 50, mode: "ultra",
      transaction: Buffer.from(transaction.serialize()).toString("base64"), requestId: "request-1",
      signatureFeeLamports: 5000, prioritizationFeeLamports: 20000, rentFeeLamports: 2039280 };
  });
  afterEach(() => { vi.restoreAllMocks(); loadExecutionWalletMock.mockReset(); });

  async function prepare(overrides: Partial<ExecuteSwapParams> = {}) {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json(order));
    const adapter = new JupiterExecutionAdapter({ fetchFn });
    const input = { ...params, ...overrides };
    const estimate = await adapter.prepareExecution(input);
    return { fetchFn, adapter, input, estimate, prepared: estimate.rawQuote as PreparedJupiterExecution };
  }

  function confirmedTransaction(
    prepared: PreparedJupiterExecution,
    fee = 12000,
    err: unknown = null,
    walletCost = fee,
    solBalances?: { preNative?: number; postNative?: number; preWrapped?: string; postWrapped?: string }
  ) {
    const tx = VersionedTransaction.deserialize(Buffer.from(prepared.signedTransaction, "base64"));
    const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
    const signerIndex = keys.indexOf(prepared.walletPublicKey);
    const preBalances = keys.map(() => solBalances?.preNative ?? 1_000_000_000);
    const postBalances = [...preBalances];
    postBalances[signerIndex] = solBalances?.postNative ?? preBalances[signerIndex]! - walletCost;
    const tokenBalance = (amount: string) => ({ accountIndex: keys.length, mint: MINTS.SOL,
      owner: prepared.walletPublicKey, uiTokenAmount: { amount } });
    const preTokenBalances = solBalances?.preWrapped === undefined ? [] : [tokenBalance(solBalances.preWrapped)];
    const postTokenBalances = solBalances?.postWrapped === undefined ? [] : [tokenBalance(solBalances.postWrapped)];
    return { result: { meta: { fee, err, preBalances, postBalances, preTokenBalances, postTokenBalances }, transaction: {
      signatures: keys.slice(0, tx.message.header.numRequiredSignatures).map((key) => key === prepared.walletPublicKey ? prepared.signerSignature : prepared.txId),
      message: { accountKeys: keys }
    } } };
  }

  it("signs and serializes the exact durable authorization before execute, without posting", async () => {
    const { fetchFn, estimate, prepared } = await prepare();
    expect(fetchFn).toHaveBeenCalledOnce();
    const url = String(fetchFn.mock.calls[0]?.[0]);
    expect(url).not.toContain("slippageBps=");
    expect(url).not.toContain("priorityFeeLamports=");
    expect(url).not.toContain("broadcastFeeType=");
    expect(prepared.kind).toBe("jupiter-prepared-v1");
    expect(prepared.txId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(prepared.signerSignature).toBe(prepared.txId);
    expect(JSON.parse(JSON.stringify(estimate))).toEqual(estimate);
    expect(VersionedTransaction.deserialize(Buffer.from(prepared.signedTransaction, "base64")).signatures[0]?.some(Boolean)).toBe(true);
  });

  it("uses wallet totals once and captures transaction fees, tips and rent in the SOL balance delta", async () => {
    const { fetchFn, adapter, estimate, prepared } = await prepare();
    fetchFn.mockResolvedValueOnce(json({ status: "Success", code: 0, signature: prepared.txId,
      totalInputAmount: "100100000", totalOutputAmount: "995000000", inputAmountResult: "100000000", outputAmountResult: "1000000000" }));
    fetchFn.mockResolvedValueOnce(json(confirmedTransaction(prepared, 12000, null, 21000)));
    const result = await adapter.executePreparedSwap(params, estimate);
    expect(result.status).toBe(ExecutionStatus.Filled);
    expect(result.inputAmount).toBe(100.1);
    expect(result.outputAmount).toBe(0.995);
    expect(result.effectivePrice).toBeCloseTo(100.1 / 0.995);
    expect(result.feeAmount).toBe(0);
    expect(result.nativeFeeAmount).toBe(0.000021);
    expect(result.rawReport).toMatchObject({ nativeFeeBasis: "confirmed-wallet-sol-delta", totalNetworkFeeLamports: 12000,
      totalWalletNativeCostLamports: 21000, rentFeeEstimateLamports: 2039280 });
    expect(JSON.stringify(result.rawReport)).not.toContain(prepared.signedTransaction);
  });

  it("keeps the provider minimum output and requests the tighter swap tolerance", async () => {
    order = { ...order, mode: "manual", slippageBps: 10, otherAmountThreshold: "999000000" };
    const { estimate, fetchFn, prepared } = await prepare({
      executionPolicy: { transactionSlippage: "bounded_manual", transactionSlippageBps: 10 }
    });
    expect(estimate.minimumOutputAmount).toBe(0.999);
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("slippageBps=10");
    expect(prepared.order.otherAmountThreshold).toBe("999000000");
  });

  it("accepts a provider tolerance stricter than the requested maximum", async () => {
    order = { ...order, mode: "manual", slippageBps: 0, otherAmountThreshold: "1000000000" };
    expect((await prepare({ executionPolicy: { transactionSlippage: "bounded_manual", transactionSlippageBps: 10 } })).estimate.minimumOutputAmount).toBe(1);
  });

  it.each([
    { slippageBps: 50 },
    { slippageBps: -1 },
    { otherAmountThreshold: "1000000001" },
    { otherAmountThreshold: "invalid" }
  ])("rejects an unsafe provider slippage/minimum response %j", async (extra) => {
    order = { ...order, mode: "manual", ...extra };
    await expect(prepare({ executionPolicy: { transactionSlippage: "bounded_manual", transactionSlippageBps: 10 } })).rejects.toThrow();
  });

  it("fails closed when a live order omits the provider minimum output", async () => {
    delete order.otherAmountThreshold;
    await expect(prepare()).rejects.toThrow("authoritative minimum output");
  });

  it("converts sell totals with each mint's decimals and reports quote per base", async () => {
    order = { ...order, inputMint: MINTS.BTC, outputMint: MINTS.USDC, inAmount: "15000000", outAmount: "12810000",
      otherAmountThreshold: "12700000" };
    const { fetchFn, adapter, estimate, prepared, input } = await prepare({ inputMint: MINTS.BTC, outputMint: MINTS.USDC,
      amount: 0.15, inputDecimals: 8, outputDecimals: 6, tradeSide: TradeSide.Sell });
    expect(estimate.inputAmount).toBe(0.15);
    expect(estimate.expectedPrice).toBeCloseTo(85.4);
    fetchFn.mockResolvedValueOnce(json({ status: "Success", code: 0, signature: prepared.txId,
      totalInputAmount: "15000000", totalOutputAmount: "12800000" }));
    fetchFn.mockResolvedValueOnce(json(confirmedTransaction(prepared, 12000, null, 0)));
    const result = await adapter.executePreparedSwap(input, estimate);
    expect(result.inputAmount).toBe(0.15);
    expect(result.outputAmount).toBe(12.8);
    expect(result.effectivePrice).toBeCloseTo(12.8 / 0.15);
  });

  it.each([
    {
      name: "native SOL input",
      input: { inputMint: MINTS.SOL, outputMint: MINTS.USDC, amount: 0.15, inputDecimals: 9, outputDecimals: 6, tradeSide: TradeSide.Sell },
      order: { inputMint: MINTS.SOL, outputMint: MINTS.USDC, inAmount: "150000000", outAmount: "12810000", otherAmountThreshold: "12700000" },
      totals: { totalInputAmount: "150000000", totalOutputAmount: "12800000" },
      balances: { preNative: 1_000_000_000, postNative: 849_978_000, preWrapped: "0", postWrapped: "0" }
    },
    {
      name: "native SOL output",
      input: { inputMint: MINTS.USDC, outputMint: MINTS.SOL, amount: 100, inputDecimals: 6, outputDecimals: 9, tradeSide: TradeSide.Buy },
      order: { inputMint: MINTS.USDC, outputMint: MINTS.SOL, inAmount: "100000000", outAmount: "128000000", otherAmountThreshold: "127000000" },
      totals: { totalInputAmount: "100000000", totalOutputAmount: "128000000" },
      balances: { preNative: 1_000_000_000, postNative: 1_127_978_000, preWrapped: "0", postWrapped: "0" }
    },
    {
      name: "wrapped SOL output",
      input: { inputMint: MINTS.USDC, outputMint: MINTS.SOL, amount: 100, inputDecimals: 6, outputDecimals: 9, tradeSide: TradeSide.Buy },
      order: { inputMint: MINTS.USDC, outputMint: MINTS.SOL, inAmount: "100000000", outAmount: "128000000", otherAmountThreshold: "127000000" },
      totals: { totalInputAmount: "100000000", totalOutputAmount: "128000000" },
      balances: { preNative: 1_000_000_000, postNative: 999_978_000, preWrapped: "0", postWrapped: "128000000" }
    },
    {
      name: "wrapped SOL input",
      input: { inputMint: MINTS.SOL, outputMint: MINTS.USDC, amount: 0.15, inputDecimals: 9, outputDecimals: 6, tradeSide: TradeSide.Sell },
      order: { inputMint: MINTS.SOL, outputMint: MINTS.USDC, inAmount: "150000000", outAmount: "12810000", otherAmountThreshold: "12700000" },
      totals: { totalInputAmount: "150000000", totalOutputAmount: "12800000" },
      balances: { preNative: 1_000_000_000, postNative: 999_978_000, preWrapped: "150000000", postWrapped: "0" }
    }
  ])("reconciles $name principal separately from the complete wallet SOL cost", async ({ input: overrides, order: orderOverrides, totals, balances }) => {
    order = { ...order, ...orderOverrides };
    const { fetchFn, adapter, estimate, prepared, input } = await prepare(overrides);
    fetchFn.mockResolvedValueOnce(json({ status: "Success", code: 0, signature: prepared.txId, ...totals }));
    fetchFn.mockResolvedValueOnce(json(confirmedTransaction(prepared, 12000, null, 0, balances)));
    const result = await adapter.executePreparedSwap(input, estimate);
    expect(result.status).toBe(ExecutionStatus.Filled);
    expect(result.nativeFeeAmount).toBe(0.000022);
    expect(result.rawReport).toMatchObject({ totalNetworkFeeLamports: 12000, totalWalletNativeCostLamports: 22000,
      walletNativeRefundLamports: 0 });
  });

  it("records a net wallet rent refund without turning it into a negative fee or unresolved execution", async () => {
    const { fetchFn, adapter, estimate, prepared } = await prepare();
    fetchFn.mockResolvedValueOnce(json({ status: "Success", code: 0, signature: prepared.txId,
      totalInputAmount: "100000000", totalOutputAmount: "995000000" }));
    fetchFn.mockResolvedValueOnce(json(confirmedTransaction(prepared, 12000, null, -5000)));
    const result = await adapter.executePreparedSwap(params, estimate);
    expect(result.status).toBe(ExecutionStatus.Filled);
    expect(result.nativeFeeAmount).toBe(0);
    expect(result.rawReport).toMatchObject({ totalWalletNativeCostLamports: 0, walletNativeRefundLamports: 5000 });
  });

  it.each([
    [{ status: "Failed", code: -1000 }, ExecutionStatus.Unknown],
    [{ status: "Failed", code: -2003 }, ExecutionStatus.Unknown],
    [{ status: "Failed", code: -2 }, ExecutionStatus.Failed],
    [{ status: "Failed", code: -1 }, ExecutionStatus.Unknown],
    [{ status: "Failed", code: -1001 }, ExecutionStatus.Unknown],
    [{ status: "Failed", code: -2001 }, ExecutionStatus.Unknown],
    [{ status: "Failed" }, ExecutionStatus.Unknown],
    [{ status: "Success", code: -1000 }, ExecutionStatus.Unknown],
    [{ status: "Success", code: 0 }, ExecutionStatus.Unknown],
    [{}, ExecutionStatus.Unknown],
    [null, ExecutionStatus.Unknown],
  ])("classifies incomplete or failed execution %j as %s without booking amounts", async (response, status) => {
    const { fetchFn, adapter, estimate } = await prepare();
    fetchFn.mockResolvedValueOnce(json(response));
    const report = await adapter.executePreparedSwap(params, estimate);
    expect(report.status).toBe(status);
    expect(report.inputAmount).toBe(0);
    expect(report.outputAmount).toBe(0);
  });

  it.each([undefined, "0", "-1", "1.1", "NaN", 100])("does not substitute the quote for an invalid actual total %s", async (total) => {
    const { fetchFn, adapter, estimate, prepared } = await prepare();
    fetchFn.mockResolvedValueOnce(json({ status: "Success", code: 0, signature: prepared.txId,
      totalInputAmount: "100000000", totalOutputAmount: total }));
    expect((await adapter.executePreparedSwap(params, estimate)).status).toBe(ExecutionStatus.Unknown);
  });

  it("reuses the same signed bytes and request ID after lost response and simulated process restart", async () => {
    const { fetchFn, adapter, estimate, prepared } = await prepare();
    fetchFn.mockRejectedValueOnce(new Error("fetch failed"));
    expect((await adapter.executePreparedSwap(params, estimate)).status).toBe(ExecutionStatus.Unknown);
    loadExecutionWalletMock.mockImplementation(() => { throw new Error("must not reload wallet"); });
    const retryFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ status: "Success", code: 0, signature: prepared.txId,
      totalInputAmount: "100000000", totalOutputAmount: "995000000" })).mockResolvedValueOnce(json(confirmedTransaction(prepared)));
    const restarted = new JupiterExecutionAdapter({ fetchFn: retryFetch });
    expect((await restarted.executePreparedSwap(params, JSON.parse(JSON.stringify(estimate)))).status).toBe(ExecutionStatus.Filled);
    expect(retryFetch.mock.calls[0]?.[1]?.body).toBe(fetchFn.mock.calls[1]?.[1]?.body);
    expect(retryFetch).toHaveBeenCalledTimes(2);
  });

  it("bounds response body reads and treats timeout after send as unknown", async () => {
    const { estimate } = await prepare();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as Response);
    const adapter = new JupiterExecutionAdapter({ fetchFn, executeTimeoutMs: 5 });
    expect((await adapter.executePreparedSwap(params, estimate)).status).toBe(ExecutionStatus.Unknown);
  });

  it("does not invent a new order if a durable preparation is missing or belongs to another trade", async () => {
    const { fetchFn, adapter, estimate } = await prepare();
    await expect(adapter.executePreparedSwap(params, { ...estimate, rawQuote: order })).rejects.toThrow("refusing");
    await expect(adapter.executePreparedSwap({ ...params, amount: 101 }, estimate)).rejects.toThrow("refusing");
    await expect(adapter.executeSwap(params)).rejects.toThrow("durable persistence");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects priority fees over the cap before signing", async () => {
    order.prioritizationFeeLamports = 2_000_000;
    await expect(prepare()).rejects.toThrow("exceeds configured cap");
  });

  it("does not charge sponsored fees to the taker", async () => {
    const sponsor = Keypair.generate();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: sponsor.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [new TransactionInstruction({ programId: SystemProgram.programId,
        keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(0) })]
    }).compileToV0Message());
    tx.sign([sponsor]);
    order.transaction = Buffer.from(tx.serialize()).toString("base64");
    order.signatureFeePayer = sponsor.publicKey.toBase58();
    order.prioritizationFeePayer = order.signatureFeePayer;
    const { fetchFn, adapter, estimate, prepared } = await prepare();
    fetchFn.mockResolvedValueOnce(json({ status: "Success", code: 0, signature: prepared.txId,
      totalInputAmount: "100000000", totalOutputAmount: "995000000" }));
    fetchFn.mockResolvedValueOnce(json(confirmedTransaction(prepared, 12000, null, 0)));
    expect((await adapter.executePreparedSwap(params, estimate)).nativeFeeAmount).toBe(0);
  });

  it("uses token units consistently for legacy quotes", async () => {
    order = { ...order, outputMint: MINTS.BTC, outAmount: "100000000", otherAmountThreshold: "99500000" };
    const adapter = new JupiterExecutionAdapter({ fetchFn: vi.fn<typeof fetch>().mockResolvedValue(json(order)) });
    expect((await adapter.getQuote(MINTS.USDC, MINTS.BTC, 100, 50)).expectedOutputAmount).toBe(1);
  });

  it("returns only independently confirmed RPC failures, never a fictitious submitted/fill report", async () => {
    const { prepared, estimate } = await prepare();
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ result: { value: [null] } }))
      .mockResolvedValueOnce(json({ result: { value: [{ err: null, confirmationStatus: "confirmed" }] } }))
      .mockResolvedValueOnce(json({ result: { value: [{ err: { InstructionError: [1, "error"] }, confirmationStatus: "finalized" }] } }))
      .mockResolvedValueOnce(json(confirmedTransaction(prepared, 7000, { InstructionError: [1, "error"] })));
    const adapter = new JupiterExecutionAdapter({ fetchFn });
    expect(await adapter.getExecutionReport("request-id")).toBeNull();
    expect(await adapter.getExecutionReport(prepared.txId!, estimate)).toBeNull();
    expect(await adapter.getExecutionReport(prepared.txId!, estimate)).toBeNull();
    expect((await adapter.getExecutionReport(prepared.txId!, estimate))?.status).toBe(ExecutionStatus.Failed);
  });
  it("retains a successful execute response until actual fees arrive and never resubmits it on restart", async () => {
    const { fetchFn, adapter, estimate, prepared } = await prepare();
    const response = { status: "Success", code: 0, signature: prepared.txId, totalInputAmount: "100000000", totalOutputAmount: "995000000" };
    fetchFn.mockResolvedValueOnce(json(response)).mockResolvedValueOnce(json({ result: null }));
    const unresolved = await adapter.executePreparedSwap(params, estimate);
    expect(unresolved.status).toBe(ExecutionStatus.Unknown);
    expect(unresolved.rawReport).toMatchObject({ executeResponse: response });
    loadExecutionWalletMock.mockImplementation(() => { throw new Error("No signer reload during recovery"); });
    const retryFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json(confirmedTransaction(prepared, 17000)));
    const restarted = new JupiterExecutionAdapter({ fetchFn: retryFetch });
    const recovered = await restarted.executePreparedSwap(params, JSON.parse(JSON.stringify(estimate)), JSON.parse(JSON.stringify(unresolved)));
    expect(recovered.status).toBe(ExecutionStatus.Filled);
    expect(recovered.nativeFeeAmount).toBe(0.000017);
    expect(retryFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(retryFetch.mock.calls[0]?.[1]?.body)).method).toBe("getTransaction");
  });

  it("refuses fee metadata for another transaction or missing/invalid chain fees", async () => {
    for (const fee of [-1, 1.5, undefined]) {
      const { fetchFn, adapter, estimate, prepared } = await prepare();
      const rpc = confirmedTransaction(prepared);
      (rpc.result.meta as { fee?: number }).fee = fee;
      fetchFn.mockResolvedValueOnce(json({ status: "Success", code: 0, signature: prepared.txId,
        totalInputAmount: "100000000", totalOutputAmount: "995000000" })).mockResolvedValueOnce(json(rpc));
      expect((await adapter.executePreparedSwap(params, estimate)).status).toBe(ExecutionStatus.Unknown);
    }
    const { fetchFn, adapter, estimate, prepared } = await prepare();
    const rpc = confirmedTransaction(prepared);
    rpc.result.transaction.signatures[0] = "another";
    fetchFn.mockResolvedValueOnce(json({ status: "Success", code: 0, signature: prepared.txId,
      totalInputAmount: "100000000", totalOutputAmount: "995000000" })).mockResolvedValueOnce(json(rpc));
    expect((await adapter.executePreparedSwap(params, estimate)).status).toBe(ExecutionStatus.Unknown);
  });

  it("requires independent confirmed failure and actual paid fee for an execute failure", async () => {
    const { fetchFn, adapter, estimate, prepared } = await prepare();
    fetchFn.mockResolvedValueOnce(json({ status: "Failed", code: -1000, signature: prepared.txId }))
      .mockResolvedValueOnce(json({ result: { value: [{ err: { InstructionError: [0, "failure"] }, confirmationStatus: "confirmed" }] } }))
      .mockResolvedValueOnce(json(confirmedTransaction(prepared, 9000, { InstructionError: [0, "failure"] })));
    const report = await adapter.executePreparedSwap(params, estimate);
    expect(report.status).toBe(ExecutionStatus.Failed);
    expect(report.nativeFeeAmount).toBe(0.000009);
    expect(report.inputAmount).toBe(0);
  });

});
