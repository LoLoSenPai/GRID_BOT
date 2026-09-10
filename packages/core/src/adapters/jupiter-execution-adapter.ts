import { getEnv, MINTS } from "@grid-bot/common";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { Decimal } from "decimal.js";

import { ExecutionProvider, ExecutionStatus } from "../domain/enums";
import type { ExecuteSwapParams, ExecutionEstimate, ExecutionQuote, ExecutionReport } from "../domain/types";
import { loadExecutionWallet } from "../services/wallet-service";
import type { ExecutionAdapter } from "./execution-adapter";

interface JupiterOrderResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpact?: number;
  transaction?: string | null;
  requestId?: string;
  router?: string | null;
  taker?: string | null;
  signatureFeeLamports?: number;
  signatureFeePayer?: string | null;
  prioritizationFeeLamports?: number;
  prioritizationFeePayer?: string | null;
  rentFeeLamports?: number;
  errorCode?: number;
  errorMessage?: string;
  lastValidBlockHeight?: string;
}

interface JupiterExecuteResponse {
  signature?: string;
  status?: string;
  code?: number;
  error?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
}

/** Persist this entire object before sending it. It contains a transaction authorization. */
export interface PreparedJupiterExecution {
  kind: "jupiter-prepared-v1";
  order: JupiterOrderResponse;
  signedTransaction: string;
  requestId: string;
  txId: string | null;
  signerSignature: string;
  walletPublicKey: string;
  preparedAt: string;
}

export interface JupiterExecutionAdapterOptions {
  fetchFn?: typeof fetch;
  quoteTimeoutMs?: number;
  executeTimeoutMs?: number;
}

const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_PRIORITY_FEE_LAMPORTS = 50_000;
const DEFINITIVE_FAILURE_CODES = new Set([-2, -3, -1000, -1002, -1003, -1004, -2000, -2002, -2003, -2004]);
const PRE_BROADCAST_INVALID_CODES = new Set([-2, -3, -1002, -1003, -1004, -2002]);

export class JupiterExecutionAdapter implements ExecutionAdapter {
  private readonly env = getEnv();
  constructor(private readonly options: JupiterExecutionAdapterOptions = {}) {}

  async getQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<ExecutionQuote> {
    const decimalsFor = (mint: string) => {
      const symbol = Object.entries(MINTS).find(([, value]) => value === mint)?.[0] ?? mint;
      const decimals = ({ SOL: 9, USDC: 6, BTC: 8, HYPE: 6 } as Record<string, number>)[symbol];
      if (decimals === undefined) throw new Error("Use estimateExecution with explicit token decimals for this mint.");
      return decimals;
    };
    return this.estimateExecution({ botId: "quote", clientOrderId: "quote", inputMint, outputMint, amount,
      slippageBps, inputDecimals: decimalsFor(inputMint), outputDecimals: decimalsFor(outputMint) });
  }

  async estimateExecution(params: ExecuteSwapParams): Promise<ExecutionEstimate> {
    const order = await this.fetchOrder(params);
    return this.buildEstimateFromOrder(params, order);
  }

  async prepareExecution(params: ExecuteSwapParams): Promise<ExecutionEstimate> {
    const wallet = this.loadWallet();
    const walletPublicKey = wallet.publicKey.toBase58();
    if (params.walletPublicKey && params.walletPublicKey !== walletPublicKey) {
      throw new Error("Execution wallet does not match requested taker.");
    }
    const order = await this.fetchOrder({ ...params, taker: walletPublicKey });
    if (!order.transaction || !order.requestId || order.errorCode !== undefined) {
      throw new Error(order.errorMessage ?? "Jupiter did not return an executable transaction.");
    }
    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    transaction.sign([wallet]);
    const signerIndex = transaction.message.staticAccountKeys.findIndex((key) => key.toBase58() === walletPublicKey);
    const signerSignature = encodeSignature(transaction.signatures[signerIndex]);
    if (!signerSignature) throw new Error("Prepared transaction has no wallet signature.");
    const prepared: PreparedJupiterExecution = {
      kind: "jupiter-prepared-v1", order,
      signedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
      requestId: order.requestId,
      // A sponsored transaction can require the fee payer's signature from Jupiter.
      txId: encodeSignature(transaction.signatures[0]),
      signerSignature, walletPublicKey, preparedAt: new Date().toISOString()
    };
    return { ...this.buildEstimateFromOrder({ ...params, walletPublicKey }, order), rawQuote: prepared };
  }

  async executeSwap(_params: ExecuteSwapParams): Promise<ExecutionReport> {
    throw new Error("Live execution requires prepareExecution, durable persistence, then executePreparedSwap.");
  }

  async executePreparedSwap(params: ExecuteSwapParams, estimate: ExecutionEstimate, previousReport?: ExecutionReport): Promise<ExecutionReport> {
    const prepared = this.getPreparedExecution(estimate, params);
    const savedResponse = (previousReport?.rawReport as { executeResponse?: JupiterExecuteResponse } | undefined)?.executeResponse;
    let response: JupiterExecuteResponse;
    const validSavedSuccess = savedResponse?.status === "Success" && savedResponse.code === 0 && !savedResponse.error &&
      isSignature(savedResponse.signature) && typeof savedResponse.totalInputAmount === "string" && typeof savedResponse.totalOutputAmount === "string";
    try {
      // A confirmed execute response is durable evidence. Fee retries must not resubmit after Execute cache expiry.
      response = validSavedSuccess ? savedResponse! : await this.fetchJson<JupiterExecuteResponse>("https://api.jup.ag/swap/v2/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": this.requireApiKey() },
        body: JSON.stringify({ signedTransaction: prepared.signedTransaction, requestId: prepared.requestId,
          ...(prepared.order.lastValidBlockHeight ? { lastValidBlockHeight: prepared.order.lastValidBlockHeight } : {}) })
      }, this.options.executeTimeoutMs ?? 30_000);
    } catch (error) {
      return this.unresolved(prepared, error instanceof Error ? error.message : String(error));
    }
    if (!response || typeof response !== "object") return this.unresolved(prepared, "Malformed execute response.");
    if (response.signature && prepared.txId && response.signature !== prepared.txId) {
      return this.unresolved(prepared, "Execute signature does not match the prepared transaction.", response);
    }
    if (response.status === "Failed" && typeof response.code === "number" &&
      DEFINITIVE_FAILURE_CODES.has(response.code)) {
      if (PRE_BROADCAST_INVALID_CODES.has(response.code)) {
        return { ...this.unresolved(prepared, response.error ?? `Jupiter execute code ${response.code}`, response), status: ExecutionStatus.Failed };
      }
      const signature = isSignature(response.signature) ? response.signature : prepared.txId;
      if (signature) {
        try {
          const failed = await this.getExecutionReport(signature, estimate);
          if (failed) return failed;
        } catch { /* Keep uncertainty until independent chain evidence is available. */ }
      }
      return this.unresolved(prepared, "Execute failure does not establish the on-chain outcome and paid fees.", response);
    }
    if (response.status !== "Success" || response.code !== 0 || response.error ||
      !isSignature(response.signature)) {
      return this.unresolved(prepared, "Execute outcome is not a confirmed success or definitive failure.", response);
    }
    try {
      const inputAmount = tokenAmount(response.totalInputAmount, params.inputDecimals);
      const outputAmount = tokenAmount(response.totalOutputAmount, params.outputDecimals);
      const fees = await this.getActualNetworkFee(response.signature, prepared, false);
      return {
        provider: ExecutionProvider.Jupiter, status: ExecutionStatus.Filled,
        executionId: prepared.requestId, txId: response.signature,
        inputAmount, outputAmount,
        effectivePrice: this.calculateEffectivePrice(params, inputAmount, outputAmount),
        // Wallet totals already include the swap fee. Never deduct that fee again.
        feeAmount: 0,
        nativeFeeAmount: fees.nativeFeeAmount, nativeFeeSymbol: "SOL",
        rawReport: { order: this.reportOrder(prepared.order), executeResponse: response,
          nativeFeeBasis: "confirmed-transaction-meta", nativeFeePayer: fees.feePayer,
          totalNetworkFeeLamports: fees.feeLamports,
          rentFeeEstimateLamports: prepared.order.rentFeeLamports ?? 0, rentCostBasis: "order-estimate-not-charged" }
      };
    } catch {
      return this.unresolved(prepared, "Confirmed execution awaits valid wallet totals and confirmed transaction fee metadata; reconciliation required.", response);
    }
  }

  async getExecutionReport(id: string, preparedExecution?: ExecutionEstimate): Promise<ExecutionReport | null> {
    const prepared = preparedExecution?.rawQuote as PreparedJupiterExecution | undefined;
    if (!isSignature(id) || !this.env.RPC_HTTP_URL || prepared?.kind !== "jupiter-prepared-v1") return null;
    // A signature status proves failure, but cannot supply the wallet token deltas for a fill.
    const payload = await this.fetchJson<{ result?: { value?: ({ err: unknown; confirmationStatus?: string } | null)[] } }>(
      this.env.RPC_HTTP_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses",
          params: [[id], { searchTransactionHistory: true }] }) }, this.options.quoteTimeoutMs ?? 5_000);
    const status = payload.result?.value?.[0];
    if (!status || !status.err || !["confirmed", "finalized"].includes(status.confirmationStatus ?? "")) return null;
    try {
      const fees = await this.getActualNetworkFee(id, prepared, true);
      return { provider: ExecutionProvider.Jupiter, status: ExecutionStatus.Failed, executionId: id, txId: id,
        inputAmount: 0, outputAmount: 0, effectivePrice: 0, feeAmount: 0,
        nativeFeeAmount: fees.nativeFeeAmount, nativeFeeSymbol: "SOL",
        rawReport: { rpcStatus: status, nativeFeeBasis: "confirmed-transaction-meta", nativeFeePayer: fees.feePayer, totalNetworkFeeLamports: fees.feeLamports } };
    } catch { return null; }
  }

  private async getActualNetworkFee(signature: string, prepared: PreparedJupiterExecution, failed: boolean) {
    if (!this.env.RPC_HTTP_URL) throw new Error("Confirmed transaction fee RPC is unavailable.");
    const response = await this.fetchJson<{ result?: { meta?: { fee?: number; err?: unknown };
      transaction?: { signatures?: string[]; message?: { accountKeys?: string[] } } } | null }>(
      this.env.RPC_HTTP_URL, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
          params: [signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }] }) },
      this.options.quoteTimeoutMs ?? 5_000);
    const transaction = response.result?.transaction;
    const meta = response.result?.meta;
    const keys = transaction?.message?.accountKeys;
    const signerIndex = keys?.indexOf(prepared.walletPublicKey) ?? -1;
    const expectedKeys = VersionedTransaction.deserialize(Buffer.from(prepared.signedTransaction, "base64")).message.staticAccountKeys.map((key) => key.toBase58());
    if (keys?.length !== expectedKeys.length || expectedKeys.some((key, index) => keys?.[index] !== key)) {
      throw new Error("Confirmed transaction account keys differ from the prepared authorization.");
    }
    if (!meta || !Number.isSafeInteger(meta.fee) || meta.fee! < 0 ||
        (failed ? !meta.err : meta.err !== null) || !keys?.[0] ||
        transaction?.signatures?.[0] !== signature || signerIndex < 0 ||
        transaction.signatures[signerIndex] !== prepared.signerSignature) {
      throw new Error("Confirmed transaction metadata does not match the prepared authorization.");
    }
    return { feePayer: keys[0], feeLamports: meta.fee!,
      nativeFeeAmount: keys[0] === prepared.walletPublicKey ? meta.fee! / LAMPORTS_PER_SOL : 0 };
  }

  private unresolved(prepared: PreparedJupiterExecution, reason: string, response?: JupiterExecuteResponse): ExecutionReport {
    return { provider: ExecutionProvider.Jupiter, status: ExecutionStatus.Unknown,
      executionId: prepared.requestId, txId: prepared.txId ?? (isSignature(response?.signature) ? response.signature : null),
      inputAmount: 0, outputAmount: 0, effectivePrice: 0, feeAmount: 0,
      rawReport: { reason, executeResponse: response ?? null, reconciliationRequired: true } };
  }

  private async fetchOrder(params: Pick<ExecuteSwapParams, "inputMint" | "outputMint" | "amount" | "inputDecimals" | "slippageBps"> & { taker?: string }): Promise<JupiterOrderResponse> {
    const rawAmount = toRawAmount(params.amount, params.inputDecimals);
    if (!Number.isInteger(params.slippageBps) || params.slippageBps < 0 || params.slippageBps > 10_000) {
      throw new Error("Invalid slippage basis points.");
    }
    const query = new URLSearchParams({ inputMint: params.inputMint, outputMint: params.outputMint,
      amount: rawAmount, slippageBps: String(params.slippageBps), swapMode: "ExactIn" });
    if (params.taker) {
      query.set("taker", params.taker);
      query.set("priorityFeeLamports", String(this.env.JUPITER_PRIORITY_FEE_LAMPORTS ?? DEFAULT_PRIORITY_FEE_LAMPORTS));
      query.set("broadcastFeeType", this.env.JUPITER_BROADCAST_FEE_TYPE ?? "maxCap");
    }
    const order = await this.fetchJson<JupiterOrderResponse>(`https://api.jup.ag/swap/v2/order?${query}`, {
      headers: { "x-api-key": this.requireApiKey() }
    }, this.options.quoteTimeoutMs ?? 5_000);
    if (!order || order.inputMint !== params.inputMint || order.outputMint !== params.outputMint ||
      order.inAmount !== rawAmount) throw new Error("Jupiter order does not match requested mints and amount.");
    tokenAmount(order.outAmount, 0);
    if (params.taker) {
      const priority = lamports(order.prioritizationFeeLamports);
      const cap = this.env.JUPITER_PRIORITY_FEE_LAMPORTS ?? DEFAULT_PRIORITY_FEE_LAMPORTS;
      if (priority > cap) throw new Error(`Jupiter priority fee ${priority} lamports exceeds configured cap ${cap} lamports.`);
    }
    return order;
  }

  private buildEstimateFromOrder(params: ExecuteSwapParams, order: JupiterOrderResponse): ExecutionEstimate {
    const inputAmount = tokenAmount(order.inAmount, params.inputDecimals);
    const expectedOutputAmount = tokenAmount(order.outAmount, params.outputDecimals);
    return { provider: ExecutionProvider.Jupiter, inputMint: params.inputMint, outputMint: params.outputMint,
      inputAmount, expectedOutputAmount, estimatedFeeAmount: 0, nativeFeeAmount: this.getNativeFeeSol(order, params.walletPublicKey),
      nativeFeeSymbol: "SOL", priceImpactPct: Number(order.priceImpact ?? 0), requestId: order.requestId,
      route: order.router ?? null, rawQuote: order,
      expectedPrice: this.calculateEffectivePrice(params, inputAmount, expectedOutputAmount) };
  }

  private getPreparedExecution(estimate: ExecutionEstimate, params: ExecuteSwapParams): PreparedJupiterExecution {
    const raw = estimate.rawQuote as Partial<PreparedJupiterExecution> | undefined;
    if (!raw || raw.kind !== "jupiter-prepared-v1" || !raw.signedTransaction || !raw.requestId || !raw.order ||
      !raw.signerSignature || !raw.walletPublicKey || raw.requestId !== raw.order.requestId ||
      raw.order.inputMint !== params.inputMint || raw.order.outputMint !== params.outputMint ||
      raw.order.inAmount !== toRawAmount(params.amount, params.inputDecimals) ||
      (params.walletPublicKey && params.walletPublicKey !== raw.walletPublicKey)) {
      throw new Error("Missing or mismatched durable Jupiter preparation; refusing to prepare a replacement.");
    }
    return raw as PreparedJupiterExecution;
  }

  private calculateEffectivePrice(params: ExecuteSwapParams, input: number, output: number): number {
    return params.tradeSide === "sell" ? output / input : input / output;
  }

  private getNativeFeeSol(order: JupiterOrderResponse, taker?: string): number {
    const paidByTaker = (payer?: string | null) => !payer || !taker || payer === taker;
    return ((paidByTaker(order.signatureFeePayer) ? lamports(order.signatureFeeLamports) : 0) +
      (paidByTaker(order.prioritizationFeePayer) ? lamports(order.prioritizationFeeLamports) : 0)) / LAMPORTS_PER_SOL;
  }

  private reportOrder(order: JupiterOrderResponse) {
    const { transaction: _transaction, ...safeOrder } = order;
    return safeOrder;
  }

  private async fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => { controller.abort(); reject(new Error("Jupiter request timed out.")); }, timeoutMs);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await (this.options.fetchFn ?? fetch)(url, { ...init, signal: controller.signal });
        if (!response.ok) throw new Error(`Jupiter request failed with status ${response.status}`);
        return await response.json() as T;
      })()]);
    } finally { clearTimeout(timeoutId); }
  }

  private requireApiKey() {
    if (!this.env.JUPITER_API_KEY) throw new Error("JUPITER_API_KEY is required for Jupiter.");
    return this.env.JUPITER_API_KEY;
  }
  private loadWallet(): Keypair { return loadExecutionWallet(this.env.EXECUTION_WALLET_SECRET_KEY_PATH).keypair; }
}

function assertDecimals(decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Invalid token decimals.");
}
function toRawAmount(amount: number, decimals: number): string {
  assertDecimals(decimals);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid input amount.");
  const raw = new Decimal(amount).mul(new Decimal(10).pow(decimals)).floor();
  if (raw.lte(0) || raw.gt("18446744073709551615")) throw new Error("Input amount outside token units range.");
  return raw.toFixed(0);
}
function tokenAmount(raw: unknown, decimals: number): number {
  assertDecimals(decimals);
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error("Invalid token amount.");
  const units = new Decimal(raw);
  if (units.gt("18446744073709551615")) throw new Error("Token amount exceeds u64 units range.");
  const amount = units.div(new Decimal(10).pow(decimals)).toNumber();
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid token amount.");
  return amount;
}
function lamports(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid network fee lamports.");
  return value;
}
function isSignature(value: unknown): value is string {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value);
}
function encodeSignature(bytes: Uint8Array | undefined): string | null {
  if (!bytes || bytes.length !== 64 || !bytes.some((byte) => byte !== 0)) return null;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let encoded = "";
  while (value > 0n) { encoded = alphabet[Number(value % 58n)] + encoded; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; encoded = "1" + encoded; }
  return encoded;
}
