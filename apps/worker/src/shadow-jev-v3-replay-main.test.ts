import { describe, expect, it, vi } from "vitest";
import { GECKOTERMINAL_POOLS, MINTS } from "@grid-bot/common";
import { evaluateStoredShadowV3, parseReplayArgs } from "./shadow-jev-v3-replay-main";

const observedAt = new Date("2026-09-28T12:00:00.000Z");
const provenance = { provider: "gecko-terminal", symbol: "BTC", quoteSymbol: "USDC",
  resolution: "1h", sourceMarket: `solana:${GECKOTERMINAL_POOLS.BTC_USDC}` };

function observation() {
  return {
    id: "observation-1", portfolioId: "portfolio-1", bandId: "band-btc", snapshotId: "market-1",
    observationHash: "hash-1", observedAt, questionSetVersion: "shadow-jev-v3",
    modelRequested: "jev-1.13.0", policyInput: { parameters: {
      estimatedExecutionFeeBps: 10, estimatedSlippageBps: 50 } },
    context: { shadowReplayV3: { schemaVersion: "shadow-replay-v3", source: { portfolioVersion: 3 },
      portfolio: { version: 3, quoteMint: MINTS.USDC },
      strategies: [
        { baseSymbol: "BTC", baseMint: MINTS.BTC, bands: [{ bot: { baseMint: MINTS.BTC, quoteMint: MINTS.USDC } }] },
        { baseSymbol: "SOL", baseMint: MINTS.SOL, bands: [{ bot: { baseMint: MINTS.SOL, quoteMint: MINTS.USDC } }] },
      ] } },
    candidateSet: { version: "shadow-grid-candidates-v3", candidates: [] },
    proposedDecision: { action: "wait" },
    marketMeta: provenance,
    snapshot: { contentHash: "market-hash", candleCount: 0,
      candles: [] as Array<{ openedAt: string; closedAt: string; open: number; high: number; low: number; close: number }>,
      provenance },
    outbox: { terminal: true, status: "completed", completedAt: new Date("2026-09-28T12:00:02.000Z"),
      latencyMs: 2000, probabilities: { grid_candidate: { candidate_id: "keep" } } },
  };
}

describe("read-only V3 replay runner", () => {
  it("accepts both pnpm and direct script argument forms", () => {
    const flags = ["--observation-id", "observation-1", "--native-fee-usd", "0.02"];
    const parsed = { observationId: "observation-1", nativeFeeUsd: 0.02 };
    expect(parseReplayArgs(["--", ...flags])).toEqual(parsed);
    expect(parseReplayArgs(flags)).toEqual(parsed);
  });

  it("censors an unfinished Jev job before reading future market data", async () => {
    const row = observation();
    row.outbox.status = "pending";
    const findMany = vi.fn();
    const output = await evaluateStoredShadowV3({
      shadowJevObservation: { findUnique: vi.fn(async () => row) }, marketCandle: { findMany },
    } as never, row.id, 0.02);
    expect(output).toMatchObject({ status: "censored", reasons: ["jev_not_completed"] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("accepts the versioned V3.1 observation and candidate pair", async () => {
    const row = observation();
    row.questionSetVersion = "shadow-jev-v3.1";
    row.candidateSet = { version: "shadow-grid-candidates-v3.1", candidates: [] };
    row.outbox.status = "pending";
    const output = await evaluateStoredShadowV3({
      shadowJevObservation: { findUnique: vi.fn(async () => row) }, marketCandle: { findMany: vi.fn() },
    } as never, row.id, 0.02);
    expect(output.reasons).toEqual(["jev_not_completed"]);
  });

  it("rejects a market pool mismatch and records the hypothetical decision timing", async () => {
    const row = observation();
    row.marketMeta = { ...provenance, sourceMarket: "solana:other-pool" };
    const findMany = vi.fn();
    const output = await evaluateStoredShadowV3({
      shadowJevObservation: { findUnique: vi.fn(async () => row) }, marketCandle: { findMany },
    } as never, row.id, 0.02);
    expect(output).toMatchObject({ status: "censored", reasons: ["invalid_market_snapshot"],
      provenance: { decisionTiming: "hypothetical_at_candle_close", jevLatencyMs: 2000 } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("censors cache rows from another pool before evaluating any future price", async () => {
    const row = observation();
    row.snapshot.candles = Array.from({ length: 20 }, (_, index) => {
      const openedAt = new Date(+observedAt - (20 - index) * 3_600_000);
      return { openedAt: openedAt.toISOString(), closedAt: new Date(+openedAt + 3_600_000).toISOString(),
        open: 100, high: 101, low: 99, close: 100 };
    });
    row.snapshot.candleCount = row.snapshot.candles.length;
    const findMany = vi.fn(async () => [{ id: "poisoned", sourceMarket: "solana:another-pool",
      openTime: observedAt, closeTime: new Date(+observedAt + 3_600_000), fetchedAt: new Date(+observedAt + 3_600_001),
      open: 100, high: 101, low: 99, close: 100 }]);
    const output = await evaluateStoredShadowV3({
      shadowJevObservation: { findUnique: vi.fn(async () => row) }, marketCandle: { findMany },
    } as never, row.id, 0.02);
    expect(output).toMatchObject({ status: "censored", reasons: ["invalid_btc_cache_provenance"] });
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
