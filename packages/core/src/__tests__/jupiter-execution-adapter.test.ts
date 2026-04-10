import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@grid-bot/common", () => ({
  getEnv: () => ({
    JUPITER_API_KEY: "test-key",
    EXECUTION_WALLET_SECRET_KEY_PATH: "ignored"
  })
}));

vi.mock("../services/wallet-service", () => ({
  loadExecutionWallet: () => {
    throw new Error("wallet should not be loaded in this test");
  }
}));

import { JupiterExecutionAdapter } from "../adapters/jupiter-execution-adapter";

describe("JupiterExecutionAdapter", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
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
      tradeSide: "buy",
      inputDecimals: 6,
      outputDecimals: 9,
      slippageBps: 50,
      clientOrderId: "client-1",
      referencePrice: 84
    });

    expect(quote.estimatedFeeAmount).toBe(0);
    expect(estimate.estimatedFeeAmount).toBe(0);
  });
});
