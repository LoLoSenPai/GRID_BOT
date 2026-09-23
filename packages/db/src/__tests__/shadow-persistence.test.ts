import { describe, expect, it, vi } from "vitest";
import { canonicalShadowHash, shadowMarketContentHash, PrismaShadowObservationRepository } from "../repositories/shadow-observation-repository";
import { PrismaShadowJevOutboxRepository } from "../repositories/shadow-jev-outbox-repository";

describe("shadow persistence hashing", () => {
  it("is stable across object key order and Date serialization", () => {
    expect(canonicalShadowHash({ b: 2, a: new Date("2026-09-23T10:00:00.000Z") }))
      .toBe(canonicalShadowHash({ a: "2026-09-23T10:00:00.000Z", b: 2 }));
  });

  it("deduplicates market snapshots independently of fetch metadata", () => {
    const candles = [{ openedAt: new Date("2026-09-23T09:00:00.000Z"), open: 100, close: 101 }];
    const identity = { provider: "gecko", symbol: "sol", quoteSymbol: "usdc", resolution: "1h", sourceMarket: "pool-1" };
    const first = shadowMarketContentHash({ ...identity, fetchedAt: new Date(0), cacheHit: false }, candles);
    const replay = shadowMarketContentHash({ ...identity, fetchedAt: new Date(1), cacheHit: true }, candles);
    expect(first).toBe(replay);
  });

  it("separates identical candles from different market identities", () => {
    const candles = [{ openedAt: "2026-09-23T09:00:00.000Z", open: 100, close: 101 }];
    const common = { provider: "gecko", symbol: "SOL", quoteSymbol: "USDC", resolution: "1h" };
    expect(shadowMarketContentHash({ ...common, sourceMarket: "pool-1" }, candles))
      .not.toBe(shadowMarketContentHash({ ...common, sourceMarket: "pool-2" }, candles));
  });
});

describe("shadow Jev attempt journal", () => {
  it("records a completed attempt in the same transaction as the terminal outbox update", async () => {
    const attemptCreate = vi.fn(async () => undefined);
    const tx = {
      shadowJevOutbox: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ id: "job-1", attemptCount: 2,
          claimedAt: new Date("2026-09-23T10:00:00.000Z") })),
      },
      shadowJevAttempt: { create: attemptCreate },
    };
    const client = { $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
    const repository = new PrismaShadowJevOutboxRepository(client as never);
    await repository.complete({ jobId: "job-1", workerId: "worker-1", rawRequest: { request: true },
      rawResponse: { response: true }, probabilities: { up: 0.6 }, modelVersion: "jev-1", latencyMs: 12,
      completedAt: new Date("2026-09-23T10:00:01.000Z") });
    expect(attemptCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      outboxId: "job-1", attemptNumber: 2, status: "completed", modelVersion: "jev-1", latencyMs: 12,
    }) });
  });

  it("records a retryable failure before releasing the job lease", async () => {
    const attemptCreate = vi.fn(async () => undefined);
    const tx = {
      shadowJevOutbox: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ id: "job-2", attemptCount: 1,
          claimedAt: new Date("2026-09-23T10:00:00.000Z") })),
      },
      shadowJevAttempt: { create: attemptCreate },
    };
    const client = { $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
    const repository = new PrismaShadowJevOutboxRepository(client as never);
    await repository.fail({ jobId: "job-2", workerId: "worker-1", error: { code: "TIMEOUT", message: "timed out" },
      retryAt: new Date("2026-09-23T10:01:00.000Z"), failedAt: new Date("2026-09-23T10:00:01.000Z") });
    expect(attemptCreate).toHaveBeenCalledWith({ data: expect.objectContaining({
      outboxId: "job-2", attemptNumber: 1, status: "failed", errorCode: "TIMEOUT", errorMessage: "timed out",
    }) });
  });
});

describe("shadow-only engine outcomes", () => {
  it("stores an observed-only live outcome without an effective policy decision", async () => {
    const create = vi.fn(async () => undefined);
    const client = { shadowEngineOutcome: { findUnique: vi.fn(async () => null), create } };
    await new PrismaShadowObservationRepository(client as never).finalizeOutcome("observation-live", {
      status: "observed_only",
    });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      observationId: "observation-live", status: "observed_only", effectiveDecision: undefined,
    }) });
  });
});
