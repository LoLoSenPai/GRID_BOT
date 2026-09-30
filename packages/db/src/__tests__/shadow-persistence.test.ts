import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { DEFAULT_PORTFOLIO_POLICY, buildShadowGridCandidates, type PortfolioPolicyInput,
  type PortfolioPolicyDecision, type ShadowObservedCostProfile } from "@grid-bot/core";
import { canonicalShadowHash, shadowMarketContentHash, PrismaShadowObservationRepository } from "../repositories/shadow-observation-repository";
import { PrismaShadowJevOutboxRepository } from "../repositories/shadow-jev-outbox-repository";
import { PrismaShadowCostRepository } from "../repositories/shadow-cost-repository";

afterEach(() => vi.restoreAllMocks());

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

describe("V2 candidate capture", () => {
  const captureInput = {
    portfolioId: "portfolio", strategyId: "strategy", bandId: "band", botId: "bot",
    observedAt: new Date("2026-09-28T12:00:00.000Z"), questionSetVersion: "shadow-jev-v2",
    modelRequested: "jev-1.13.0", policyInput: { candles: [{ close: 100 }] },
    context: {}, botState: {}, proposedDecision: { action: "wait" },
    marketMeta: { provider: "gecko", symbol: "BTC", quoteSymbol: "USDC", resolution: "1h" },
  };

  it("requires a candidate set before touching the database", async () => {
    const client = { $transaction: vi.fn() };
    await expect(new PrismaShadowObservationRepository(client as never).capture(captureInput))
      .rejects.toThrow("requires its immutable candidate set");
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it("stores the candidates with the observation and outbox atomically", async () => {
    const statements: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const tx = {
      $executeRaw: vi.fn(async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        statements.push(query); return 1;
      }),
      shadowMarketSnapshot: { findUniqueOrThrow: vi.fn(async () => ({ id: "market" })) },
      shadowJevObservation: { findUniqueOrThrow: vi.fn(async (args: { where: { observationHash: string } }) =>
        ({ id: "observation", observationHash: args.where.observationHash })) },
      shadowJevOutbox: { findUniqueOrThrow: vi.fn(async () => ({ observationId: "observation" })) },
    };
    const client = { $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
    const candidateSet = { version: "shadow-grid-candidates-v2", candidates: [{ id: "keep" }] };
    const result = await new PrismaShadowObservationRepository(client as never)
      .capture({ ...captureInput, candidateSet });
    expect(result).toEqual({ observationId: "observation", snapshotId: "market" });
    expect(statements).toHaveLength(3);
    expect(statements[1]!.strings.join(" ")).toContain('"candidate_set"');
    expect(statements[1]!.values).toContain(JSON.stringify({ candidates: candidateSet.candidates,
      version: candidateSet.version }));
  });
});

describe("V3 portfolio replay capture", () => {
  it("uses one immutable observation per band and candle even when a retry reads a newer state", async () => {
    const hashes: string[] = [];
    const tx = {
      portfolio: { findUniqueOrThrow: vi.fn(async () => ({
        id: "portfolio", version: hashes.length + 1, capitalReservations: [],
        assetStrategies: [{ id: "strategy", bands: [{ id: "band", botId: "bot", bot: {
          id: "bot", positionLots: [], stateSnapshots: [],
        }, revisions: [], exitCommitments: [], capitalReservations: [] }] }],
      })) },
      $executeRaw: vi.fn(async () => 1),
      shadowMarketSnapshot: { findUniqueOrThrow: vi.fn(async () => ({ id: "market" })) },
      shadowJevObservation: { findUniqueOrThrow: vi.fn(async (args: { where: { observationHash: string } }) => {
        hashes.push(args.where.observationHash);
        return { id: "first-observation", observationHash: args.where.observationHash };
      }) },
      shadowJevOutbox: { findUniqueOrThrow: vi.fn(async () => ({ observationId: "first-observation" })) },
    };
    const client = { $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
    const repository = new PrismaShadowObservationRepository(client as never);
    const input = {
      portfolioId: "portfolio", strategyId: "strategy", bandId: "band", botId: "bot",
      observedAt: new Date("2026-09-28T12:00:00.000Z"), questionSetVersion: "shadow-jev-v3",
      modelRequested: "jev-1.13.0", policyInput: { candles: [{ close: 100 }] },
      botState: {}, proposedDecision: { action: "wait" },
      marketMeta: { provider: "gecko", symbol: "BTC", quoteSymbol: "USDC", resolution: "1h" },
      candidateSet: { version: "shadow-grid-candidates-v3", candidates: [] },
    };
    const first = await repository.capture({ ...input, context: { state: "first" } });
    const retry = await repository.capture({ ...input, context: { state: "later" },
      candidateSet: { version: "shadow-grid-candidates-v3", candidates: [{ id: "changed" }] } });
    expect(first).toEqual(retry);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("stores a decimal-safe full portfolio view in the observation transaction", async () => {
    const statements: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const portfolioRead = vi.fn(async () => ({
      id: "portfolio", version: 7, freeQuoteAmount: new Prisma.Decimal("250.1234567890"),
      assetStrategies: [{ id: "strategy", baseSymbol: "BTC", bands: [{
        id: "band", botId: "bot", availableQuoteAmount: new Prisma.Decimal("80.0000000001"),
        bot: { id: "bot", config: { lowPrice: new Prisma.Decimal("100.0000000001") },
          positionLots: [{ id: "lot", remainingBaseAmount: new Prisma.Decimal("0.0000000001") }],
          executionAttempt: { executionId: "execution", uncertain: true } },
        revisions: [{ id: "revision", sequence: 2 }],
        exitCommitments: [{ id: "commitment", lotId: "lot" }],
        capitalReservations: [{ id: "reservation" }],
      }] }],
      capitalReservations: [{ id: "reservation" }],
    }));
    const tx = {
      portfolio: { findUniqueOrThrow: portfolioRead },
      $executeRaw: vi.fn(async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        statements.push(query); return 1;
      }),
      shadowMarketSnapshot: { findUniqueOrThrow: vi.fn(async () => ({ id: "market" })) },
      shadowJevObservation: { findUniqueOrThrow: vi.fn(async (args: { where: { observationHash: string } }) =>
        ({ id: "observation", observationHash: args.where.observationHash })) },
      shadowJevOutbox: { findUniqueOrThrow: vi.fn(async () => ({ observationId: "observation" })) },
    };
    const client = { $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
    await new PrismaShadowObservationRepository(client as never).capture({
      portfolioId: "portfolio", strategyId: "strategy", bandId: "band", botId: "bot",
      observedAt: new Date("2026-09-28T12:00:00.000Z"), questionSetVersion: "shadow-jev-v3.1",
      modelRequested: "jev-1.13.0", policyInput: { candles: [{ close: 100 }] },
      context: { prior: true }, botState: {}, proposedDecision: { action: "wait" },
      marketMeta: { provider: "gecko", symbol: "BTC", quoteSymbol: "USDC", resolution: "1h" },
      candidateSet: { version: "shadow-grid-candidates-v3.1", candidates: [] },
    });
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    expect(portfolioRead).toHaveBeenCalledTimes(1);
    const observation = statements[1]!;
    const stored = JSON.parse(observation.values.find(value => typeof value === "string" &&
      value.includes('"shadowReplayV3"')) as string);
    expect(stored.prior).toBe(true);
    expect(stored.shadowReplayV3).toMatchObject({
      schemaVersion: "shadow-replay-v3", source: { portfolioVersion: 7, bandId: "band" },
      portfolio: { freeQuoteAmount: "250.123456789" },
      strategies: [{ bands: [{ bot: { config: { lowPrice: "100.0000000001" },
        positionLots: [{ remainingBaseAmount: "1e-10" }] } }] }],
    });
    expect(Number.isFinite(Date.parse(stored.shadowReplayV3.capturedAt))).toBe(true);
    expect(statements).toHaveLength(3);
  });
});

describe("V4 transaction capture", () => {
  const observedAt = new Date("2026-09-30T12:00:00Z"), hour = 3_600_000;
  const wait: PortfolioPolicyDecision = { action: "wait", reason: "Wait", nextLowPrice: null, nextHighPrice: null,
    nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null };
  function fixture() {
    const policyInput: PortfolioPolicyInput = { now: observedAt, price: 100, assetSymbol: "SOL",
      band: { id: "band", lowPrice: 90, highPrice: 110, levelCount: 5, spacing: 5,
        status: "active", allocatedCapitalUsd: 500, idleQuoteUsd: 400,
        openTradingLots: [{ entryPrice: 80, remainingBaseAmount: 1, costQuote: 100, kind: "trading" }] },
      bandCount: 1, assetAttributedCapitalUsd: 500, availableCashUsd: 200, totalPortfolioCapitalUsd: 1_000,
      candleIntervalMs: hour, maxCandleAgeMs: 2 * hour, indicators: { atrPct: 1 },
      parameters: { ...DEFAULT_PORTFOLIO_POLICY, minWidthPct: 6, minUsefulOrderUsd: 25 },
      candles: Array.from({ length: 80 }, (_, i) => ({ openedAt: new Date(+observedAt + (i - 80) * hour),
        closedAt: new Date(+observedAt + (i - 79) * hour), open: 100, high: 101.5, low: 98.5, close: 100 })) };
    const costProfile = { version: "shadow-observed-cost-v1", portfolioId: "portfolio", botId: "bot",
      asOf: observedAt.toISOString(), windowStart: new Date(+observedAt - hour).toISOString(),
      assetSymbol: "SOL", baseMint: "base", quoteMint: "quote", notionalBucket: { minUsd: 25, maxUsd: 500 },
      count: 8, minSamples: 5, usable: true, feeBps: 2, adverseSlippageBps: 2, p90NativeFeeUsd: 0.005,
      safetyMarginBps: 2, coverageWarnings: [], executionIds: ["fill"],
      coverage: { fee: 8, adverseSlippage: 8, nativeFeeUsd: 8 }, feeBasis: "embedded-wallet-totals" } satisfies ShadowObservedCostProfile;
    const portfolio = { id: "portfolio", version: 7, freeQuoteAmount: new Prisma.Decimal("200"),
      capitalReservations: [], assetStrategies: [{ id: "strategy", baseSymbol: "SOL", allocatedQuoteAmount: new Prisma.Decimal("500"),
        bands: [{ id: "band", botId: "bot", bot: { id: "bot", baseMint: "base", quoteMint: "quote", baseDecimals: 9,
          // This exact lot id exists only in the transaction view, not the supplied context/policy.
          positionLots: [{ id: "mvcc-lot", kind: "trading", closedAt: null, remainingBaseAmount: new Prisma.Decimal("1"), costQuote: new Prisma.Decimal("100") }] },
          revisions: [], capitalReservations: [], exitCommitments: [{ lotId: "mvcc-lot", targetStatus: "KNOWN", fulfilledAt: null,
            sellTargetPrice: new Prisma.Decimal("110"), economicRule: "accumulate_usdc" }] }] }] };
    const fineRows = [0, 1].map(i => ({ openTime: new Date(+observedAt - (2 - i) * 300_000),
      closeTime: new Date(+observedAt - (1 - i) * 300_000), open: new Prisma.Decimal("99.1234"),
      high: new Prisma.Decimal("100"), low: new Prisma.Decimal("99"), close: new Prisma.Decimal("99.5") }));
    const statements: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const fineHashes = new Set<string>();
    const tx = {
      portfolio: { findUniqueOrThrow: vi.fn(async () => portfolio) },
      marketCandle: { findMany: vi.fn(async () => fineRows) },
      $executeRaw: vi.fn(async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        statements.push(query);
        if (query.values.some(value => typeof value === "string" && value.includes('"resolution":"5m"')))
          fineHashes.add(query.values[1] as string);
        return 1;
      }),
      shadowMarketSnapshot: { findUniqueOrThrow: vi.fn(async (args: { where: { contentHash: string } }) =>
        ({ id: fineHashes.has(args.where.contentHash) ? "immutable-fine" : "immutable-hourly" })) },
      shadowJevObservation: { findUniqueOrThrow: vi.fn(async (args: { where: { observationHash: string } }) =>
        ({ id: "immutable-observation", observationHash: args.where.observationHash })) },
      shadowJevOutbox: { findUniqueOrThrow: vi.fn(async () => ({ observationId: "immutable-observation" })) },
    };
    const client = { $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
    const input = { portfolioId: "portfolio", strategyId: "strategy", bandId: "band", botId: "bot", observedAt,
      questionSetVersion: "shadow-jev-v4", modelRequested: "jev-1.13.0", policyInput,
      context: { prior: true }, botState: {}, proposedDecision: wait,
      // Deliberately supplied obsolete candidates must be rebuilt from the transaction state in V4.
      candidateSet: { version: "obsolete", candidates: [{ id: "stale" }] },
      marketMeta: { provider: "gecko", symbol: "SOL", quoteSymbol: "USDC", resolution: "1h", sourceMarket: "pool-1" } };
    const observation = () => statements.find(q => q.strings.join(" ").includes('INSERT INTO "shadow_jev_observations"'))!;
    const context = () => JSON.parse(observation().values[11] as string);
    const candidates = () => JSON.parse(observation().values[15] as string);
    return { input, costProfile, statements, fineHashes, tx, client, observation, context, candidates };
  }

  it("builds V4 candidates from the captured MVCC portfolio and queues the same immutable observation atomically", async () => {
    const f = fixture(), readProfile = vi.spyOn(PrismaShadowCostRepository.prototype, "readProfile").mockResolvedValue(f.costProfile);
    const result = await new PrismaShadowObservationRepository(f.client as never).capture(f.input);
    expect(readProfile).toHaveBeenCalledWith("portfolio", "bot", observedAt);
    expect(f.client.$transaction).toHaveBeenCalledTimes(1);
    expect(f.client.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    expect(f.tx.portfolio.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(f.context().shadowReplayV3.source).toMatchObject({ portfolioVersion: 7, bandId: "band", botId: "bot" });
    expect(f.candidates()).toMatchObject({ version: "shadow-decisions-v4", costProfile: f.costProfile });
    const updates = f.candidates().exit.candidates.flatMap((c: { updates: unknown[] }) => c.updates);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates).toEqual(expect.arrayContaining([expect.objectContaining({ sourceLotId: "mvcc-lot", oldTargetPrice: 110 })]));
    expect(JSON.stringify(f.candidates())).not.toContain('"stale"');
    expect(result).toEqual({ observationId: "immutable-observation", snapshotId: "immutable-hourly" });
    expect(f.statements).toHaveLength(4);
    const outbox = f.statements[3]!;
    expect(outbox.strings.join(" ")).toContain('INSERT INTO "shadow_jev_outbox"');
    expect(outbox.values).toContain(result.observationId);
    expect(f.tx.shadowJevOutbox.findUniqueOrThrow).toHaveBeenCalledWith({ where: { observationId: result.observationId } });
  });

  it("keeps legacy candidates and fixed exits when the observed cost read fails", async () => {
    const f = fixture(); vi.spyOn(PrismaShadowCostRepository.prototype, "readProfile").mockRejectedValue(new Error("cost read unavailable"));
    await new PrismaShadowObservationRepository(f.client as never).capture(f.input);
    expect(f.candidates().costProfile).toBeNull();
    expect(f.candidates().grid).toEqual(buildShadowGridCandidates(f.input.policyInput, wait,
      { assetAllocations: [{ assetSymbol: "SOL", allocatedCapitalUsd: 500 }] }));
    expect(f.candidates().exit.candidates.map((c: { id: string }) => c.id)).toEqual(["keep"]);
    expect(f.tx.shadowJevOutbox.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });

  it("references one immutable 5m snapshot and deduplicates it on retry without copying its candles into context", async () => {
    const f = fixture(); vi.spyOn(PrismaShadowCostRepository.prototype, "readProfile").mockResolvedValue(f.costProfile);
    const repo = new PrismaShadowObservationRepository(f.client as never);
    const first = await repo.capture(f.input), retry = await repo.capture(f.input);
    expect(retry).toEqual(first); expect(f.fineHashes.size).toBe(1);
    expect(f.context().shadowFineMarket).toEqual({ status: "captured", snapshotId: "immutable-fine", contentHash: [...f.fineHashes][0],
      candleCount: 2, closedThrough: observedAt.toISOString() });
    expect(f.context().shadowFineMarket).not.toHaveProperty("candles");
    expect(JSON.stringify(f.context())).not.toContain("99.1234");
    const fine = f.statements.filter(q => q.values.some(value => typeof value === "string" && value.includes('"resolution":"5m"')));
    expect(fine).toHaveLength(2);
    expect(fine[0]!.strings.join(" ")).toContain("ON CONFLICT (content_hash) DO NOTHING");
    expect(fine[0]!.values[1]).toBe(fine[1]!.values[1]);
    expect(JSON.parse(fine[0]!.values[3] as string)).toHaveLength(2);
    expect(f.tx.marketCandle.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      provider: "gecko", symbol: "SOL", sourceMarket: "pool-1", resolution: "5m",
      closeTime: { gte: new Date(+observedAt - 2 * hour), lte: observedAt },
      fetchedAt: { lte: new Date(f.context().shadowReplayV3.capturedAt) },
    }) }));
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
