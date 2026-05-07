import { getEnv } from "@grid-bot/common";
import { Keypair, VersionedTransaction } from "@solana/web3.js";

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
  routePlan?: unknown[];
  transaction?: string | null;
  requestId?: string;
  router?: string | null;
  signatureFeeLamports?: number;
  prioritizationFeeLamports?: number;
  rentFeeLamports?: number;
  errorCode?: number;
  errorMessage?: string;
}

interface JupiterExecuteResponse {
  signature?: string;
  status?: string;
  slot?: number;
  code?: number;
  error?: string;
}

const LAMPORTS_PER_SOL = 1_000_000_000;

export class JupiterExecutionAdapter implements ExecutionAdapter {
  private readonly env = getEnv();

  async getQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<ExecutionQuote> {
    const order = await this.fetchOrder({
      inputMint,
      outputMint,
      amount,
      inputDecimals: 6,
      slippageBps
    });

    return {
      provider: ExecutionProvider.Jupiter,
      inputMint,
      outputMint,
      inputAmount: amount,
      expectedOutputAmount: Number(order.outAmount),
      // Jupiter returns network fees in lamports. Bot accounting expects quote-denominated fees,
      // so treating lamports as quote units badly distorts equity on USDC bots.
      estimatedFeeAmount: 0,
      priceImpactPct: Number(order.priceImpact ?? 0),
      requestId: order.requestId,
      route: order.router ?? null,
      rawQuote: order
    };
  }

  async estimateExecution(params: ExecuteSwapParams): Promise<ExecutionEstimate> {
    const order = await this.fetchOrder({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      inputDecimals: params.inputDecimals,
      slippageBps: params.slippageBps
    });

    return {
      provider: ExecutionProvider.Jupiter,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inputAmount: params.amount,
      expectedOutputAmount: Number(order.outAmount) / 10 ** params.outputDecimals,
      estimatedFeeAmount: 0,
      priceImpactPct: Number(order.priceImpact ?? 0),
      requestId: order.requestId,
      route: order.router ?? null,
      rawQuote: order,
      expectedPrice: this.calculateEffectivePrice(params, Number(order.outAmount) / 10 ** params.outputDecimals)
    };
  }

  async prepareExecution(params: ExecuteSwapParams): Promise<ExecutionEstimate> {
    const wallet = this.loadWallet();
    const order = await this.fetchOrder({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      inputDecimals: params.inputDecimals,
      slippageBps: params.slippageBps,
      taker: params.walletPublicKey ?? wallet.publicKey.toBase58()
    });

    return this.buildEstimateFromOrder(params, order);
  }

  async executeSwap(params: ExecuteSwapParams): Promise<ExecutionReport> {
    if (!this.env.JUPITER_API_KEY) {
      throw new Error("JUPITER_API_KEY is required for live execution.");
    }

    const wallet = this.loadWallet();
    const order = await this.fetchOrder({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      inputDecimals: params.inputDecimals,
      slippageBps: params.slippageBps,
      taker: params.walletPublicKey ?? wallet.publicKey.toBase58()
    });

    return this.executeOrder(params, order);
  }

  async executePreparedSwap(params: ExecuteSwapParams, preparedExecution: ExecutionEstimate): Promise<ExecutionReport> {
    if (!this.env.JUPITER_API_KEY) {
      throw new Error("JUPITER_API_KEY is required for live execution.");
    }

    const order = this.getPreparedOrder(preparedExecution);
    if (!order) {
      return this.executeSwap(params);
    }

    return this.executeOrder(params, order);
  }

  private async executeOrder(params: ExecuteSwapParams, order: JupiterOrderResponse): Promise<ExecutionReport> {
    const apiKey = this.env.JUPITER_API_KEY;
    if (!apiKey) {
      throw new Error("JUPITER_API_KEY is required for live execution.");
    }

    if (!order.transaction || !order.requestId) {
      throw new Error(order.errorMessage ?? "Jupiter did not return a transaction.");
    }

    const wallet = this.loadWallet();
    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    transaction.sign([wallet]);
    const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
    const executeResponse = await this.fetchJson<JupiterExecuteResponse>("https://api.jup.ag/swap/v2/execute", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        signedTransaction,
        requestId: order.requestId
      })
    });

    return {
      provider: ExecutionProvider.Jupiter,
      status: executeResponse.error ? ExecutionStatus.Failed : ExecutionStatus.Submitted,
      executionId: order.requestId,
      txId: executeResponse.signature ?? null,
      inputAmount: params.amount,
      outputAmount: Number(order.outAmount) / 10 ** params.outputDecimals,
      effectivePrice: this.calculateEffectivePrice(params, Number(order.outAmount) / 10 ** params.outputDecimals),
      feeAmount: 0,
      nativeFeeAmount: this.getNativeFeeSol(order),
      nativeFeeSymbol: "SOL",
      rawReport: {
        order,
        executeResponse
      }
    };
  }

  async getExecutionReport(id: string): Promise<ExecutionReport | null> {
    return {
      provider: ExecutionProvider.Jupiter,
      status: ExecutionStatus.Submitted,
      executionId: id,
      txId: id,
      inputAmount: 0,
      outputAmount: 0,
      effectivePrice: 0,
      feeAmount: 0
    };
  }

  private async fetchOrder(params: {
    inputMint: string;
    outputMint: string;
    amount: number;
    inputDecimals: number;
    slippageBps: number;
    taker?: string;
  }): Promise<JupiterOrderResponse> {
    const query = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: String(Math.round(params.amount * 10 ** params.inputDecimals)),
      slippageBps: String(params.slippageBps),
      swapMode: "ExactIn"
    });

    if (params.taker) {
      query.set("taker", params.taker);
    }

    const headers: Record<string, string> = {};
    if (this.env.JUPITER_API_KEY) {
      headers["x-api-key"] = this.env.JUPITER_API_KEY;
    }

    return this.fetchJson<JupiterOrderResponse>(`https://api.jup.ag/swap/v2/order?${query.toString()}`, {
      headers
    });
  }

  private buildEstimateFromOrder(params: ExecuteSwapParams, order: JupiterOrderResponse): ExecutionEstimate {
    const expectedOutputAmount = Number(order.outAmount) / 10 ** params.outputDecimals;
    return {
      provider: ExecutionProvider.Jupiter,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inputAmount: params.amount,
      expectedOutputAmount,
      estimatedFeeAmount: 0,
      priceImpactPct: Number(order.priceImpact ?? 0),
      requestId: order.requestId,
      route: order.router ?? null,
      rawQuote: order,
      expectedPrice: this.calculateEffectivePrice(params, expectedOutputAmount)
    };
  }

  private getPreparedOrder(preparedExecution: ExecutionEstimate): JupiterOrderResponse | null {
    const rawQuote = preparedExecution.rawQuote;
    if (!rawQuote || typeof rawQuote !== "object") {
      return null;
    }

    const order = rawQuote as Partial<JupiterOrderResponse>;
    if (!order.transaction || !order.requestId) {
      return null;
    }

    return order as JupiterOrderResponse;
  }

  private calculateEffectivePrice(params: ExecuteSwapParams, outputAmount: number): number {
    if (outputAmount <= 0 || params.amount <= 0) {
      return 0;
    }

    return params.tradeSide === "sell" ? outputAmount / params.amount : params.amount / outputAmount;
  }

  private getNativeFeeSol(order: JupiterOrderResponse): number {
    const lamports =
      (Number(order.signatureFeeLamports) || 0) +
      (Number(order.prioritizationFeeLamports) || 0) +
      (Number(order.rentFeeLamports) || 0);

    return lamports > 0 ? lamports / LAMPORTS_PER_SOL : 0;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jupiter request failed with status ${response.status}: ${text}`);
    }

    return (await response.json()) as T;
  }

  private loadWallet(): Keypair {
    return loadExecutionWallet(this.env.EXECUTION_WALLET_SECRET_KEY_PATH).keypair;
  }
}
