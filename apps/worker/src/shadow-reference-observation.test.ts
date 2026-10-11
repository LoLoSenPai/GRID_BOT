import { describe, expect, it, vi } from "vitest";
import { MINTS } from "@grid-bot/common";
import { DEFAULT_PORTFOLIO_POLICY } from "@grid-bot/core";
import type { CaptureShadowObservationInput, ShadowObservationClientHandle } from "@grid-bot/db";
import { createShadowReferenceObserver, referenceBaselineOutcome, referencePriceGap } from "./shadow-reference-observation";

const at = new Date("2026-10-12T12:00:15Z"), hour = new Date("2026-10-12T12:00:00Z");
function fixture(options: { incomplete?: boolean; gap?: boolean; existing?: boolean; witness?: boolean; failFinalize?: boolean;
  previousHourWitness?: boolean; unfinishedExisting?: boolean; livePrice?: number; recentPrice?: number; staleRecent?: boolean;
  captureAt?: Date; wrongRecentIdentity?: boolean } = {}) {
  const captureAt = options.captureAt ?? at;
  const rows = Array.from({ length: options.incomplete ? 79 : 80 }, (_, i) => ({
    provider: "coinbase-reference", symbol: "BTC_REF", quoteSymbol: "USD", sourceMarket: "BTC-USD", resolution: "1h",
    openTime: new Date(+hour - (80 - i) * 3_600_000), closeTime: new Date(+hour - (79 - i) * 3_600_000),
    open: 100, high: 101, low: 99, close: 100, volume: 3, fetchedAt: new Date(+at - 5000) }));
  const lot = { kind: "retained", entryPrice: 95, remainingBaseAmount: 0.1, costQuote: 9.5 };
  const band = { id: "band", botId: "bot", assetStrategyId: "strategy", status: "ACTIVE", allocatedQuoteAmount: 100,
    availableQuoteAmount: 90.5, reservedQuoteAmount: 0, deployedCostQuote: 9.5, realizedLossQuote: 0,
    assetStrategy: { id: "strategy", portfolioId: "portfolio", baseSymbol: "BTC", baseMint: MINTS.BTC,
      objective: "accumulate_base", allocatedQuoteAmount: 100, retainedBaseAmount: 0.1,
      portfolio: { id: "portfolio", freeQuoteAmount: 500, shadowJevEnabled: true } },
    bot: { baseMint: MINTS.BTC, quoteMint: MINTS.USDC, currentPrice: options.livePrice ?? (options.gap ? 105 : 100), lastHeartbeatAt: captureAt,
      config: { minOrderQuoteAmount: 25 }, positionLots: [lot], stateSnapshots: [{ metadata: { recenterHistory: [] } }] },
    revisions: [{ id: "revision", lowPrice: 90, highPrice: 110, levelCount: 4, observedAt: new Date(+hour - 86400000) }], exitCommitments: [] };
  const decision = { action: "wait", reason: "recorded engine" };
  const witness = { id: "live-witness", observedAt: options.previousHourWitness ? new Date(+hour - 3_600_000) : hour,
    policyInput: { parameters: { ...DEFAULT_PORTFOLIO_POLICY, maxBands: 2 } },
    outcome: options.witness ? { status: "wait", effectiveDecision: decision, createdAt: new Date(+at - 1000) } : null };
  const sanityClose = Math.floor(+captureAt / 300_000) * 300_000 - (options.staleRecent ? 15 * 60_000 : 0);
  const sanityRow = { ...rows[0]!, resolution: "5m", close: options.recentPrice ?? 100,
    symbol: options.wrongRecentIdentity ? "BTC" : "BTC_REF", openTime: new Date(sanityClose - 300_000), closeTime: new Date(sanityClose) };
  const client = { marketCandle: { findMany: vi.fn(async (args: { where: { resolution: string } }) => args.where.resolution === "5m" ? [sanityRow] : rows) },
    gridBand: { findMany: vi.fn().mockResolvedValueOnce([band]).mockResolvedValue([band]) },
    shadowJevObservation: { findUniqueOrThrow: vi.fn(async () => ({ context: storage.capture.mock.calls[0]![0].context })),
      findFirst: vi.fn().mockResolvedValueOnce(options.unfinishedExisting
      ? { id: "unfinished", outcome: null, context: { referenceEngineWitness: { outcome: { status: "wait", effectiveDecision: decision } } } }
      : options.existing ? { id: "existing", outcome: { status: "observed_only" } } : null)
      .mockResolvedValue(witness) } };
  const storage = { capture: vi.fn(async (_input: CaptureShadowObservationInput) => ({ observationId: "captured", snapshotId: "snapshot" })),
    finalizeOutcome: vi.fn(async () => { if (options.failFinalize) throw new Error("DB down"); }) };
  return { client, storage, observer: createShadowReferenceObserver({ client } as unknown as ShadowObservationClientHandle, storage), decision };
}
describe("Independent BTC reference observer", () => {
  it("finalizes only the persisted winning context after a concurrent capture", async () => {
    const f = fixture();
    f.client.shadowJevObservation.findUniqueOrThrow.mockResolvedValueOnce({ context: { referenceEngineWitness: {
      outcome: { status: "wait", effectiveDecision: { action: "wait", reason: "winning witness" } } } } });
    await f.observer(at);
    expect(f.storage.finalizeOutcome).toHaveBeenCalledWith("captured", { status: "wait",
      effectiveDecision: { action: "wait", reason: "winning witness" } });
  });
  it("publishes the frozen reference input and witness to the durable journal", async () => {
    const f = fixture(); const publish = vi.fn(async () => undefined);
    await createShadowReferenceObserver({ client: f.client } as unknown as ShadowObservationClientHandle, f.storage, publish)(at);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ questionSetVersion: "shadow-jev-v4.2" }), { status: "observed_only" });
    expect(f.storage.capture).not.toHaveBeenCalled();
  });
  it("captures current capital, peer retained lots, exact revision and reference identity without inventing an engine decision", async () => {
    const f = fixture(); await f.observer(at);
    expect(f.storage.capture).toHaveBeenCalledTimes(1);
    const input = f.storage.capture.mock.calls[0]![0];
    expect(input).toMatchObject({ questionSetVersion: "shadow-jev-v4.2", observedAt: hour,
      marketMeta: { provider: "coinbase-reference", symbol: "BTC_REF", quoteSymbol: "USD", sourceMarket: "BTC-USD" },
      policyInput: { price: 100, assetSymbol: "BTC", availableCashUsd: 500, totalPortfolioCapitalUsd: 600,
        parameters: { maxBands: 2 }, band: { idleQuoteUsd: 90.5, openTradingLots: [{ kind: "retained" }] } },
      context: { referenceObserver: true, strategy: { objective: "accumulate_base", baseMint: MINTS.BTC },
        band: { id: "band", activeRevision: { id: "revision" } }, shadowMarketReference: { executableBaseMint: MINTS.BTC },
        referenceBaselineAssumption: "live_policy_observation_unavailable_wait_assumption" } });
    expect(f.storage.finalizeOutcome).toHaveBeenCalledWith("captured", { status: "observed_only" });
    expect(f.client.marketCandle.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      fetchedAt: { lte: at }, closeTime: { lte: hour } }) }));
  });
  it("uses only the exact same-hour recorded engine witness", async () => {
    const f = fixture({ witness: true }); await f.observer(at);
    expect(f.storage.finalizeOutcome).toHaveBeenCalledWith("captured", { status: "wait", effectiveDecision: f.decision });
    expect(f.storage.capture.mock.calls[0]![0].context).toMatchObject({ referenceEngineWitness: { observationId: "live-witness" } });
  });
  it("accepts intrahour movement when the recent reference agrees, while freezing hourly policy price", async () => {
    const captureAt = new Date(+at + 30 * 60_000);
    const f = fixture({ captureAt, livePrice: 105, recentPrice: 105 }); await f.observer(captureAt);
    expect(f.storage.capture).toHaveBeenCalledTimes(1);
    expect(f.storage.capture.mock.calls[0]![0]).toMatchObject({ policyInput: { price: 100, now: hour },
      context: { shadowMarketReference: { hourlyReferencePrice: 100, hourlyReferenceAsOf: hour,
        sanityReferencePrice: 105, sanityReferenceAsOf: new Date("2026-10-12T12:30:00Z"), relativePriceGap: 0 } } });
  });
  it.each([{ staleRecent: true }, { wrongRecentIdentity: true }, { livePrice: 105, recentPrice: 100 }])(
    "skips stale reference, incorrect identity or actual synchronized basis divergence %j", async options => {
      const f = fixture(options); await f.observer(at); expect(f.storage.capture).not.toHaveBeenCalled();
    });
  it("keeps prior-hour outcomes out of the current engine baseline", async () => {
    const f = fixture({ witness: true, previousHourWitness: true }); await f.observer(at);
    expect(f.storage.finalizeOutcome).toHaveBeenCalledWith("captured", { status: "observed_only" });
  });
  it("retries only the frozen outcome after capture committed but finalize failed", async () => {
    const f = fixture({ unfinishedExisting: true }); await f.observer(at);
    expect(f.storage.capture).not.toHaveBeenCalled();
    expect(f.storage.finalizeOutcome).toHaveBeenCalledWith("unfinished", { status: "wait", effectiveDecision: f.decision });
  });
  it.each([{ incomplete: true }, { gap: true }, { existing: true }])("skips insufficient data, divergent live price, or existing capture %j", async options => {
    const f = fixture(options); await f.observer(at); expect(f.storage.capture).not.toHaveBeenCalled();
  });
  it("does not propagate isolated outcome failures into the collector", async () => {
    const f = fixture({ failFinalize: true }); await expect(f.observer(at)).resolves.toBeUndefined();
    expect(f.storage.capture).toHaveBeenCalledTimes(1);
  });
  it("reports invalid price and strips decisions from observed-only witnesses", () => {
    expect(referencePriceGap(0, 100)).toBeNull(); expect(referencePriceGap(100, 100)).toBe(0);
    expect(referenceBaselineOutcome({ referenceEngineWitness: { outcome: { status: "observed_only", effectiveDecision: { action: "wait" } } } }))
      .toEqual({ status: "observed_only" });
  });
});
