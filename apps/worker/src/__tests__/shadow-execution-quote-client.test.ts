import { describe, expect, it, vi } from "vitest";
import { MINTS } from "@grid-bot/common";
import { ShadowExecutionQuoteClient } from "../shadow-execution-quote-client";

const request = { baseMint: MINTS.SOL, quoteMint: MINTS.USDC, rawQuoteAmount: "100000000" };
function response(url: string) {
  const params = new URL(url).searchParams;
  return { inputMint: params.get("inputMint"), outputMint: params.get("outputMint"), inAmount: params.get("amount"),
    outAmount: params.get("inputMint") === MINTS.USDC ? "999000000" : "98000000", otherAmountThreshold: "90000000",
    feeBps: 10, feeMint: MINTS.SOL, router: "metis", signatureFeeLamports: 5_000, prioritizationFeeLamports: 0, rentFeeLamports: 0,
    transaction: "sensitive", swapInstruction: { data: "sensitive" }, apiKey: "sensitive" };
}
const options = { apiKey: "dedicated-test-key", quotaIsolated: true, buildTakerPublicKey: MINTS.SOL };

describe("isolated shadow quote client", () => {
  it("requires both a separate key and confirmed independent quota before any request", async () => {
    const fetchFn = vi.fn();
    expect((await new ShadowExecutionQuoteClient({ fetchFn }).compare(request)).status).toBe("skipped");
    expect((await new ShadowExecutionQuoteClient({ apiKey: "key", fetchFn }).compare(request)).status).toBe("skipped");
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("reads four GET quotes serially, chains each net output and drops all transaction fields", async () => {
    const urls: string[] = []; let outstanding = 0; let maximum = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      outstanding++; maximum = Math.max(maximum, outstanding); const value = String(url); urls.push(value);
      expect(init?.method).toBe("GET"); expect(init?.headers).toEqual({ "x-api-key": "dedicated-test-key" });
      await Promise.resolve(); outstanding--; return { ok: true, json: async () => response(value) } as Response;
    });
    const result = await new ShadowExecutionQuoteClient({ ...options, fetchFn }).compare(request);
    expect(result.status).toBe("completed"); expect(maximum).toBe(1); expect(urls).toHaveLength(4);
    expect(urls[0]).toContain("/order?"); expect(new URL(urls[0]!).searchParams.has("taker")).toBe(false);
    expect(new URL(urls[1]!).searchParams.get("amount")).toBe("999000000");
    expect(urls[2]).toContain("/build?"); expect(result.paths[0]?.netRoundTripLossBps).toBe(200);
    expect(result.paths[1]?.buy?.estimatedNativeFeeLamports).toBeNull();
    expect(result.economicallyComparable).toBe(false); expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(JSON.stringify(result)).not.toContain("dedicated-test-key");
  });
  it("reports a failed quote path while allowing the other path to complete", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const value = String(url); if (value.includes("/order?")) throw new Error("upstream leaked token=secret");
      return { ok: true, json: async () => response(value) } as Response;
    });
    const result = await new ShadowExecutionQuoteClient({ ...options, fetchFn }).compare(request);
    expect(result.status).toBe("partial"); expect(result.paths[0]?.status).toBe("failed"); expect(result.paths[1]?.status).toBe("completed");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("journals the HTTP status without retaining provider error text", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 429,
      json: async () => ({ error: "token=secret" }) } as Response));
    const result = await new ShadowExecutionQuoteClient({ ...options, fetchFn }).compare(request);
    expect(result.paths[0]?.warnings).toContain("shadow_quote_http_429");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("refuses mint/size mismatch and bounds a hanging fetch with timeout", async () => {
    const mismatch = vi.fn(async () => ({ ok: true, json: async () => ({ ...response("https://host?inputMint=x&outputMint=y&amount=1") }) } as Response));
    const failed = await new ShadowExecutionQuoteClient({ ...options, fetchFn: mismatch }).compare(request);
    expect(failed.status).toBe("failed"); expect(failed.paths[0]?.warnings).toContain("shadow_quote_provenance_mismatch");
    const hanging = vi.fn(() => new Promise<Response>(() => {}));
    const timedOut = await new ShadowExecutionQuoteClient({ ...options, timeoutMs: 10, fetchFn: hanging }).compare(request);
    expect(timedOut.status).toBe("failed"); expect(timedOut.paths[0]?.warnings).toContain("shadow_quote_timeout");
  });
  it("retains partial first-leg evidence and skips build without a configured public address", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const value = String(url); if (new URL(value).searchParams.get("inputMint") === MINTS.SOL) return { ok: false } as Response;
      return { ok: true, json: async () => response(value) } as Response;
    });
    const result = await new ShadowExecutionQuoteClient({ apiKey: "key", quotaIsolated: true, fetchFn }).compare(request);
    expect(result.status).toBe("partial"); expect(result.paths[0]?.status).toBe("partial"); expect(result.paths[0]?.netRoundTripLossBps).toBeNull();
    expect(result.paths[1]?.status).toBe("skipped"); expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
