import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadExecutionWalletMock = vi.hoisted(() =>
  vi.fn((): unknown => {
    throw new Error("wallet should not be loaded in this test");
  })
);

vi.mock("@grid-bot/common", () => ({
  getEnv: () => ({
    JUPITER_API_KEY: "test-key",
    EXECUTION_WALLET_SECRET_KEY_PATH: "ignored"
  })
}));

vi.mock("../services/wallet-service", () => ({
  loadExecutionWallet: loadExecutionWalletMock
}));

import { JupiterExecutionAdapter } from "../adapters/jupiter-execution-adapter";
import { TradeSide } from "../domain/enums";

describe("JupiterExecutionAdapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    loadExecutionWalletMock.mockImplementation(() => {
      throw new Error("wallet should not be loaded in this test");
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          inputMint: "USDC",
          outputMint: "SOL",
          inAmount: "10000000",
          outAmount: "119000000",
          signatureFeeLamports: 5000,
          prioritizationFeeLamports: 20000,
          rentFeeLamports: 2039280
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    loadExecutionWalletMock.mockReset();
    vi.restoreAllMocks();
  });

  it("does not treat lamport network fees as quote-denominated fees in estimates", async () => {
    const adapter = new JupiterExecutionAdapter();

    const quote = await adapter.getQuote("USDC", "SOL", 10, 50);
    const estimate = await adapter.estimateExecution({
      botId: "bot-1",
      inputMint: "USDC",
      outputMint: "SOL",
      amount: 10,
      tradeSide: TradeSide.Buy,
      inputDecimals: 6,
      outputDecimals: 9,
      slippageBps: 50,
      clientOrderId: "client-1",
      referencePrice: 84
    });

    expect(quote.estimatedFeeAmount).toBe(0);
    expect(estimate.estimatedFeeAmount).toBe(0);
  });

  it("reports sell effective price as quote per base", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          inputMint: "SOL",
          outputMint: "USDC",
          inAmount: "150000000",
          outAmount: "12810000",
          signatureFeeLamports: 5000,
          prioritizationFeeLamports: 20000,
          rentFeeLamports: 0
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    ) as typeof fetch;

    const adapter = new JupiterExecutionAdapter();
    const estimate = await adapter.estimateExecution({
      botId: "bot-1",
      inputMint: "SOL",
      outputMint: "USDC",
      amount: 0.15,
      tradeSide: TradeSide.Sell,
      inputDecimals: 9,
      outputDecimals: 6,
      slippageBps: 50,
      clientOrderId: "client-1",
      referencePrice: 85.36
    });

    expect(estimate.expectedOutputAmount).toBe(12.81);
    expect(estimate.expectedPrice).toBeCloseTo(85.4, 6);
  });

  it("prepares one executable order that can be reused after quote validation", async () => {
    loadExecutionWalletMock.mockReturnValue({
      keypair: {
        publicKey: {
          toBase58: () => "wallet-public-key"
        }
      }
    });
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          inputMint: "USDC",
          outputMint: "SOL",
          inAmount: "12730000",
          outAmount: "150000000",
          transaction: "prepared-transaction",
          requestId: "prepared-order",
          signatureFeeLamports: 5000,
          prioritizationFeeLamports: 20000,
          rentFeeLamports: 0
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      )
    ) as typeof fetch;

    const adapter = new JupiterExecutionAdapter();
    const estimate = await adapter.prepareExecution({
      botId: "bot-1",
      inputMint: "USDC",
      outputMint: "SOL",
      amount: 12.73,
      tradeSide: TradeSide.Buy,
      inputDecimals: 6,
      outputDecimals: 9,
      slippageBps: 50,
      clientOrderId: "client-1",
      referencePrice: 84.82
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("taker=wallet-public-key"),
      expect.any(Object)
    );
    expect(estimate.requestId).toBe("prepared-order");
    expect(estimate.expectedOutputAmount).toBe(0.15);
    expect(estimate.expectedPrice).toBeCloseTo(84.86666667, 6);
    expect(estimate.rawQuote).toEqual(expect.objectContaining({
      transaction: "prepared-transaction",
      requestId: "prepared-order"
    }));
  });
});
