import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// This diagnostic has no database, RPC, signer, execution adapter or notification sink.
process.env.LIVE_TRADING_ENABLED = "false";
process.env.DATABASE_URL = "postgresql://diagnostic:diagnostic@127.0.0.1:1/diagnostic";
process.env.RPC_HTTP_URL = "http://127.0.0.1:1";
process.env.RPC_WS_URL = "ws://127.0.0.1:1";
process.env.EXECUTION_WALLET_SECRET_KEY_PATH = "";
process.env.DISCORD_WEBHOOK_URL = "";

const { getEnv } = await import("@grid-bot/common");
const { MarketPriceService } = await import("@grid-bot/core");
const keyAvailable = Boolean(getEnv().JUPITER_API_KEY);
const originalFetch = globalThis.fetch;
let requests = 0;
const samples: Array<Record<string, unknown>> = [];
const service = new MarketPriceService({
  baseUrl: "https://api.jup.ag/price/v3", timeoutMs: 5_000, retryDelaysMs: [],
  fetchFn: async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://api.jup.ag" || url.pathname !== "/price/v3" || (init?.method ?? "GET") !== "GET") {
      throw new Error("Diagnostic permits only Jupiter Price V3 reads.");
    }
    requests += 1;
    return originalFetch(input, { ...init, redirect: "error" });
  }
});
if (keyAvailable) {
  for (let index = 0; index < 12; index += 1) {
    try {
      const prices = await service.fetchLatestPrices(["SOL", "BTC", "HYPE"], "USDC");
      samples.push({ checkedAt: new Date().toISOString(), status: "fresh", prices: prices.map((price) => ({
        pair: price.pair, price: price.price, sourceBlockId: price.sourceBlockId,
        quoteSourceBlockId: price.quoteSourceBlockId, sourceObservedAt: price.sourceObservedAt?.toISOString()
      })) });
    } catch (error) {
      // Deliberately record only the typed HTTP status, never headers, URLs or provider response bodies.
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      samples.push({ checkedAt: new Date().toISOString(), status: "unavailable_or_warming_up", httpStatus: status ?? null });
      if (status === 401 || status === 403 || status === 429) break;
    }
    if (index < 11) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
const freshSamplesByPair = Object.fromEntries(["SOL/USDC", "BTC/USDC", "HYPE/USDC"].map((pair) => [pair,
  samples.filter((sample) => Array.isArray(sample.prices) && sample.prices.some((price: { pair?: string }) => price.pair === pair)).length]));
const result = { checkedAt: new Date().toISOString(), keyAvailable, requests, freshSamplesByPair,
  freshSamples: samples.filter((sample) => sample.status === "fresh").length,
  mode: "read-only-price-feed", transactionsBroadcast: 0, databaseConnections: 0,
  note: "A bounded operational price-feed check, not a paper performance study.", samples };
await writeFile(fileURLToPath(new URL("../../../audits/2026-09-10/price-feed-results.json", import.meta.url)), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ keyAvailable, requests, freshSamples: result.freshSamples, mode: result.mode }));
