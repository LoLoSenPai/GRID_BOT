import { describe, expect, it, vi } from "vitest";
import { GECKOTERMINAL_POOLS, MINTS } from "@grid-bot/common";
import { evaluateStoredShadowV3, loadShadowInventoryEvidence, loadShadowCapitalEvidence, parseReplayArgs } from "./shadow-jev-v3-replay-main";

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
  it("loads every ledger type up to t0, including zero-delta reconciliation information", async () => {
    const zero = { toString: () => "0.0000000000" }, findMany = vi.fn(async () => [{ id: "transition", portfolioId: "p",
      bandId: "b", entryType: "RECONCILIATION", createdAt: observedAt, executionId: "execution",
      bandAllocatedQuoteDelta: zero, bandAvailableQuoteDelta: zero, bandDeployedCostDelta: zero,
      bandReservedQuoteDelta: zero, externalFeeQuoteDelta: zero, metadata: { transition: "RESERVED_TO_UNKNOWN" } }]);
    const evidence = await loadShadowCapitalEvidence({ capitalLedgerEntry: { findMany } } as never,
      [{ bands: [{ id: "b" }] }], "p", observedAt);
    expect(findMany).toHaveBeenCalledWith({ where: { bandId: "b", createdAt: { lte: observedAt } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(evidence[0]).toMatchObject({ scope: "all_band_entries_through_state", stateAt: observedAt.toISOString(),
      rows: [{ entryType: "RECONCILIATION", metadata: { transition: "RESERVED_TO_UNKNOWN" } }] });
  });
  it("extracts full histories without dropping unknown statuses or decimal precision", async () => {
    const bot = { id: "bot", mode: "live", baseMint: MINTS.SOL, quoteMint: MINTS.USDC,
      createdAt: "2026-09-22T00:00:00Z", position: { updatedAt: "2026-09-28T11:00:00Z" } };
    const findMany = vi.fn(async () => [{ id: "receipt", botId: bot.id, mode: "live", status: "submitted",
      order: { side: "buy", botId: bot.id }, createdAt: new Date(bot.createdAt), completedAt: null,
      executedInputAmount: { toString: () => "100.0000000000" }, executedOutputAmount: { toString: () => "0.1234567891" } }]);
    const evidence = await loadShadowInventoryEvidence({ execution: { findMany } } as never, [{ bands: [{ bot }] }]);
    expect(findMany).toHaveBeenCalledWith({ where: { botId: bot.id, createdAt: { lte: new Date(bot.position.updatedAt) } },
      include: { order: { select: { side: true, botId: true } } }, orderBy: [{ completedAt: "asc" }, { id: "asc" }] });
    expect(evidence[0]).toMatchObject({ version: "ordered-receipts-v1", scope: "all_bot_executions_through_position_state",
      stateAt: bot.position.updatedAt, rows: [{ status: "submitted", executedOutputAmount: "0.1234567891", completedAt: null }] });
    expect(evidence[0]!.rows[0]!.createdAt).toMatch(/Z$/);
    const invalid = { ...bot, position: { updatedAt: "invalid" } };
    await expect(loadShadowInventoryEvidence({ execution: { findMany } } as never, [{ bands: [{ bot: invalid }] }]))
      .rejects.toThrow(/boundary/);
  });
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
