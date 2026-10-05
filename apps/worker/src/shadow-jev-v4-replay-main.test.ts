import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), evaluate: vi.fn() }));
vi.mock("./shadow-jev-v3-replay-main", () => ({ evaluateStoredShadowV3: mocks.load, parseReplayArgs: vi.fn() }));
vi.mock("@grid-bot/core", async importOriginal => ({ ...await importOriginal<object>(),
  ShadowJevV4EvaluationService: class { evaluate(input: unknown) { return mocks.evaluate(input); } },
}));
import { evaluateStoredShadowV4 } from "./shadow-jev-v4-replay-main";

const observedAt = new Date("2026-09-30T12:00:00Z");
const completedAt = new Date(+observedAt + 37_000);
function fixture() {
  const set = { version: "shadow-decisions-v4", grid: { version: "shadow-grid-candidates-v3.1", candidates: [] },
    exit: { version: "shadow-exits-v1", candidates: [] }, costProfile: null };
  const row = { id: "obs", observedAt, questionSetVersion: "shadow-jev-v4", candidateSet: set,
    outcome: { status: "wait", effectiveDecision: { action: "wait", reason: "Recorded engine" } },
    outbox: { completedAt, status: "completed", probabilities: {
      grid_candidate: { candidate_id: "grid" }, exit_candidate: { candidate_id: "closer" } } } };
  const market = { provider: "gecko-terminal", assetSymbol: "BTC", sourceMarket: "solana:pool", futureCandles: [] };
  const prepared = { observation: { id: row.id, candidateSet: set.grid }, markets: [market] };
  const client = { shadowJevObservation: { findUnique: vi.fn(async () => row) }, marketCandle: { findMany: vi.fn(async () => []) } };
  mocks.load.mockImplementation(async (_client, _id, _fee, callback) => {
    callback(prepared); return { status: "censored", reasons: ["V3_IGNORED"], provenance: { source: "strict-loader" } };
  });
  mocks.evaluate.mockReturnValue({ status: "partial", reasons: ["FUTURE_COVERAGE"], horizons: [] });
  return { client, row, market };
}

describe("read-only V4 replay orchestration", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("requires both recorded choices and completion before reading outcomes", async () => {
    const { client, row } = fixture(); row.outbox.status = "processing";
    expect(await evaluateStoredShadowV4(client as never, "obs", 0.02)).toMatchObject({ reasons: ["jev_not_completed"] });
    expect(mocks.load).not.toHaveBeenCalled(); expect(client.marketCandle.findMany).not.toHaveBeenCalled();
  });
  it("preserves response availability, external flows and exact replay inputs", async () => {
    const { client } = fixture();
    const cashflows = [{ id: "deposit", at: new Date(+observedAt + 60_000), amountUsd: 100 }];
    const output = await evaluateStoredShadowV4(client as never, "obs", 0.02, cashflows);
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({
      initialEngineDecision: { action: "wait", reason: "Recorded engine" } }), decisionAvailableAt: completedAt,
      cashflows, selectedGridCandidateId: "grid", selectedExitCandidateId: "closer" }));
    expect(output).toMatchObject({ status: "partial", frozenReplayInput: { decisionAvailableAt: completedAt },
      provenance: { source: "strict-loader", decisionTiming: "after_recorded_response_completion", replayInputHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  });
  it("refuses a missing engine outcome instead of assuming the proposal was applied", async () => {
    const { client, row } = fixture(); delete (row as any).outcome;
    expect(await evaluateStoredShadowV4(client as never, "obs", 0.02)).toMatchObject({ reasons: ["missing_effective_engine_outcome"] });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("adapts the V4.1 generation to V3.2 and rejects mixed versions", async () => {
    const { client, row } = fixture(); row.questionSetVersion = "shadow-jev-v4.1";
    row.candidateSet.version = "shadow-decisions-v4.1";
    row.candidateSet.grid.version = "shadow-grid-candidates-v3.2";
    await evaluateStoredShadowV4(client as never, "obs", 0.02);
    expect(mocks.load.mock.calls[0]![0].shadowJevObservation.findUnique()).resolves.toMatchObject({ questionSetVersion: "shadow-jev-v3.2" });
    row.candidateSet.grid.version = "shadow-grid-candidates-v3.1";
    expect(await evaluateStoredShadowV4(client as never, "obs", 0.02)).toMatchObject({ reasons: ["invalid_v4_candidate_version"] });
  });
  it("rejects a 5m series from a different pool before simulation", async () => {
    const { client, market } = fixture();
    client.marketCandle.findMany.mockResolvedValueOnce([{ id: "bad", provider: market.provider,
      symbol: "BTC", quoteSymbol: "USDC", resolution: "5m", sourceMarket: "another-pool",
      openTime: observedAt, closeTime: new Date(+observedAt + 300_000), fetchedAt: new Date(+observedAt + 300_001) }] as never);
    expect(await evaluateStoredShadowV4(client as never, "obs", 0.02)).toMatchObject({ reasons: ["invalid_fine_market_provenance"] });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("keeps a strict snapshot rejection and does not read 5m outcomes", async () => {
    const { client } = fixture();
    mocks.load.mockImplementationOnce(async () => ({ status: "censored", reasons: ["POSITION_CHANGED_AFTER_CLOSE"] }));
    expect(await evaluateStoredShadowV4(client as never, "obs", 0.02)).toMatchObject({ reasons: ["POSITION_CHANGED_AFTER_CLOSE"] });
    expect(client.marketCandle.findMany).not.toHaveBeenCalled(); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
