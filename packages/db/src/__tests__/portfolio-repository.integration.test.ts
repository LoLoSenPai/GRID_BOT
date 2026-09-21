import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { BotMode, BotStatus, ExecutionProvider, GridType, StrategyMode } from "@grid-bot/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaPortfolioRepository } from "../repositories/portfolio-repository";

const databaseUrl = process.env.V2_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const runId = `v2-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let client: PrismaClient;
let repository: PrismaPortfolioRepository;

describeDatabase("V2 portfolio repository against PostgreSQL", () => {
  beforeAll(() => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl! }) });
    repository = new PrismaPortfolioRepository(client);
  });

  afterAll(async () => client?.$disconnect());

  it("serializes concurrent reservations and never allocates the same band cash twice", async () => {
    const fixture = await seedBand("concurrency", 100);
    const attempts = await Promise.allSettled([
      repository.reserveCapital({ portfolioId: fixture.portfolioId, bandId: fixture.bandId, quoteAmount: 60,
        idempotencyKey: `${runId}:reserve:a`, reason: "first concurrent buy" }),
      repository.reserveCapital({ portfolioId: fixture.portfolioId, bandId: fixture.bandId, quoteAmount: 60,
        idempotencyKey: `${runId}:reserve:b`, reason: "second concurrent buy" }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const band = await client.gridBand.findUniqueOrThrow({ where: { id: fixture.bandId } });
    expect(band.availableQuoteAmount.toNumber()).toBe(100);
    expect(band.reservedQuoteAmount.toNumber()).toBe(60);
  });

  it("moves explicit free-pool capital into a band once under an idempotency key", async () => {
    const fixture = await seedBand("allocation", 0, 50);
    const input = { portfolioId: fixture.portfolioId, bandId: fixture.bandId, quoteAmount: 30,
      idempotencyKey: `${runId}:allocation`, reason: "fund new equal band" };
    await repository.allocateCapital(input);
    await repository.allocateCapital(input);
    const context = await repository.getBandContext(fixture.botId);
    expect(context?.portfolio.freeQuoteAmount).toBe(20);
    expect(context?.strategy.allocatedQuoteAmount).toBe(30);
    expect(context?.band).toMatchObject({ allocatedQuoteAmount: 30, availableQuoteAmount: 30, reservedQuoteAmount: 0 });
    expect(await client.capitalLedgerEntry.count({ where: { portfolioId: fixture.portfolioId,
      idempotencyKey: input.idempotencyKey } })).toBe(1);
  });

  it("makes reservations idempotent and blocks new capital until an unknown outcome is reconciled", async () => {
    const fixture = await seedBand("unknown", 100);
    const input = { portfolioId: fixture.portfolioId, bandId: fixture.bandId, quoteAmount: 25,
      idempotencyKey: `${runId}:unknown:reserve`, reason: "uncertain buy" };
    const first = await repository.reserveCapital(input);
    const second = await repository.reserveCapital(input);
    expect(second.id).toBe(first.id);
    await repository.markReservationUnknown(fixture.portfolioId, first.id, "RPC outcome unavailable");
    await expect(repository.reserveCapital({ ...input, quoteAmount: 10, idempotencyKey: `${runId}:unknown:blocked` }))
      .rejects.toThrow(/blocked until reservation/);
    await expect(repository.releaseReservation({ portfolioId: fixture.portfolioId, reservationId: first.id,
      idempotencyKey: `${runId}:unknown:release`, reason: "unsafe release" })).rejects.toThrow(/reconciled/);
    await repository.reconcileReservation({ portfolioId: fixture.portfolioId, reservationId: first.id,
      idempotencyKey: `${runId}:unknown:reconcile`, resolution: "RELEASE", reason: "chain confirms no fill" });
    const context = await repository.getBandContext(fixture.botId);
    expect(context?.band.reservedQuoteAmount).toBe(0);
    expect(context?.capitalBlockedReason).toBeNull();
  });

  it("settles actual buy debit, preserves partial exit targets, then sweeps only net USDC profit", async () => {
    const fixture = await seedBand("settlement", 100);
    const reservation = await repository.reserveCapital({ portfolioId: fixture.portfolioId, bandId: fixture.bandId,
      quoteAmount: 50, idempotencyKey: `${runId}:settlement:reserve`, reason: "buy" });
    const buy = { portfolioId: fixture.portfolioId, bandId: fixture.bandId, executionId: `${runId}:buy-execution`,
      idempotencyKey: `${runId}:settlement:buy`, side: "buy" as const, reservationId: reservation.id,
      cashQuoteDebited: 40, acquiredCostQuote: 40.5, externalFeeQuote: 0.5, baseReceived: 0.4,
      exitCommitment: { lotId: `${runId}:lot`, targetStatus: "KNOWN" as const, buyLevelIndex: 0, sellLevelIndex: 1,
        buyTargetPrice: 90, sellTargetPrice: 100, economicRule: "accumulate_base" as const,
        originRevisionId: fixture.revisionId, maxAdverseDriftBps: 50 } };
    expect((await repository.settleFill(buy)).applied).toBe(true);
    expect((await repository.settleFill(buy)).applied).toBe(false);
    let context = await repository.getBandContext(fixture.botId);
    expect(context?.band).toMatchObject({ availableQuoteAmount: 60, reservedQuoteAmount: 0, deployedCostQuote: 40.5 });

    const partial = await repository.settleFill({ portfolioId: fixture.portfolioId, bandId: fixture.bandId,
      executionId: `${runId}:sell-partial`, idempotencyKey: `${runId}:settlement:sell-partial`, side: "sell",
      lotId: `${runId}:lot`, costBasisReleased: 20, netQuoteReceived: 22, externalFeeQuote: 0.5,
      retainedBaseAmount: 0.01, lotClosed: false });
    expect(partial).toMatchObject({ principalReturnedQuote: 20, profitSweptQuote: 1.5, retainedBaseAmount: 0.01 });
    expect((await client.lotExitCommitment.findUniqueOrThrow({ where: { lotId: `${runId}:lot` } })).fulfilledAt).toBeNull();

    const terminal = await repository.settleFill({ portfolioId: fixture.portfolioId, bandId: fixture.bandId,
      executionId: `${runId}:sell-terminal`, idempotencyKey: `${runId}:settlement:sell-terminal`, side: "sell",
      lotId: `${runId}:lot`, costBasisReleased: 20.5, netQuoteReceived: 23, externalFeeQuote: 0.5,
      retainedBaseAmount: 0.02, lotClosed: true });
    expect(terminal.profitSweptQuote).toBe(2);
    context = await repository.getBandContext(fixture.botId);
    expect(context?.portfolio.freeQuoteAmount).toBe(3.5);
    expect(context?.strategy.retainedBaseAmount).toBe(0.03);
    expect(context?.band.deployedCostQuote).toBe(0);
    expect(context?.exitCommitments[0]?.fulfilledAt).toBeInstanceOf(Date);
  });

  it("adopts only persisted cycle targets, excludes retained lots, and refuses adaptation for an unknown target", async () => {
    const portfolio = await repository.createPortfolio({ mode: BotMode.Paper, walletIdentity: `${runId}:wallet:adopt`,
      quoteMint: "USDC", initialFreeQuoteAmount: 7, autoLive: false, idempotencyKey: `${runId}:portfolio:adopt` });
    const botId = `${runId}:bot:adopt`;
    await seedLegacyBot(botId);
    const context = await repository.adoptExistingBot({ portfolioId: portfolio.id, botId, attributedCapitalQuote: 100,
      availableQuoteAmount: 60, reason: "explicit test adoption", observedAt: new Date("2026-09-21T12:00:00Z"),
      idempotencyKey: `${runId}:adopt` });
    expect(context.band.status).toBe("ACTIVE");
    expect(context.strategy.retainedBaseAmount).toBe(0.1);
    expect(context.exitCommitments).toHaveLength(2);
    expect(context.exitCommitments.find((entry) => entry.lotId.endsWith(":known"))).toMatchObject({
      targetStatus: "KNOWN", buyTargetPrice: 90, sellTargetPrice: 100,
    });
    expect(context.exitCommitments.find((entry) => entry.lotId.endsWith(":unknown"))?.targetStatus).toBe("UNKNOWN");
    expect(context.capitalBlockedReason).toMatch(/unknown absolute exit target/);
    await expect(repository.reviseBand({ portfolioId: portfolio.id, bandId: context.band.id,
      expectedRevisionId: context.band.activeRevision.id, expectedSnapshotId: context.band.activeRevision.snapshotId,
      lowPrice: 80, highPrice: 120, levelCount: 5, gridType: GridType.Arithmetic,
      reason: "must remain blocked", observedAt: new Date("2026-09-21T13:00:00Z") })).rejects.toThrow(/unknown absolute exit target/);
    await expect(client.gridRevision.update({ where: { id: context.band.activeRevision.id }, data: { reason: "rewrite history" } }))
      .rejects.toThrow(/immutable/);
  });

  it("revises from an exact snapshot while preserving open cycles in the new baseline", async () => {
    const fixture = await seedBand("revision", 100);
    const snapshot = await client.botStateSnapshot.create({ data: { botId: fixture.botId, status: BotStatus.Running,
      currentPrice: 100, availableQuoteAmount: 100, availableBaseAmount: 0, deployedQuoteAmount: 0,
      averageEntryPrice: null, realizedPnlUsd: 0, unrealizedPnlUsd: 0, totalEquityUsd: 100,
      consecutiveFailures: 0, lastProcessedAt: new Date("2026-09-21T10:00:00Z"),
      metadata: { levelLocks: { "0": "old-lock" }, pendingSignal: { levelIndex: 0 }, recenterHistory: [],
        recentExecutions: [], gridCycles: { "0": { lotId: "open-lot", buyLevelIndex: 0, sellLevelIndex: 1 } } } } });
    const revision = await repository.reviseBand({ portfolioId: fixture.portfolioId, bandId: fixture.bandId,
      expectedRevisionId: fixture.revisionId, expectedSnapshotId: snapshot.id, lowPrice: 80, highPrice: 120,
      levelCount: 5, gridType: GridType.Arithmetic, reason: "closed-candle decision",
      observedAt: new Date("2026-09-21T12:00:00Z") });
    expect(revision.sequence).toBe(2);
    const latest = await client.botStateSnapshot.findFirstOrThrow({ where: { botId: fixture.botId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    expect(latest.metadata).toMatchObject({ levelLocks: {}, pendingSignal: null,
      gridCycles: { "0": { lotId: "open-lot", buyLevelIndex: 0, sellLevelIndex: 1 } },
      gridRevisionId: revision.id, revisionBaselinePending: true });
    const config = await client.botConfig.findUniqueOrThrow({ where: { botId: fixture.botId } });
    expect(config).toMatchObject({ levelCount: 5 });
    expect(config.lowPrice.toNumber()).toBe(80);
    await client.bot.update({ where: { id: fixture.botId }, data: { status: BotStatus.Paused } });
    await expect(repository.reviseBand({ portfolioId: fixture.portfolioId, bandId: fixture.bandId,
      expectedRevisionId: revision.id, expectedSnapshotId: latest.id, lowPrice: 75, highPrice: 125,
      levelCount: 5, gridType: GridType.Arithmetic, reason: "operator wins",
      observedAt: new Date("2026-09-21T13:00:00Z") })).rejects.toThrow(/paused/);
  });
});

async function seedBand(label: string, availableQuoteAmount: number, freeQuoteAmount = 0) {
  const botId = `${runId}:bot:${label}`;
  await client.bot.create({ data: { id: botId, key: `${runId}:key:${label}`, name: label, baseMint: `mint:${label}`,
    quoteMint: "USDC", baseSymbol: "BTC", quoteSymbol: "USDC", baseDecimals: 8, quoteDecimals: 6,
    strategyMode: StrategyMode.AccumulateBase, mode: BotMode.Paper, status: BotStatus.Running,
    executionProvider: ExecutionProvider.Paper } });
  await client.botConfig.create({ data: configData(botId) });
  const portfolio = await repository.createPortfolio({ mode: BotMode.Paper, walletIdentity: `${runId}:wallet:${label}`,
    quoteMint: "USDC", initialFreeQuoteAmount: freeQuoteAmount, autoLive: false, idempotencyKey: `${runId}:portfolio:${label}` });
  const strategy = await client.assetStrategy.create({ data: { portfolioId: portfolio.id, baseMint: `mint:${label}`,
    baseSymbol: "BTC", objective: StrategyMode.AccumulateBase, allocatedQuoteAmount: availableQuoteAmount } });
  const band = await client.gridBand.create({ data: { assetStrategyId: strategy.id, botId,
    allocatedQuoteAmount: availableQuoteAmount, availableQuoteAmount } });
  const revision = await client.gridRevision.create({ data: { bandId: band.id, sequence: 1, lowPrice: 90,
    highPrice: 110, levelCount: 3, gridType: GridType.Arithmetic, reason: "test fixture", observedAt: new Date() } });
  return { portfolioId: portfolio.id, bandId: band.id, revisionId: revision.id, botId };
}

async function seedLegacyBot(botId: string) {
  await client.bot.create({ data: { id: botId, key: `${runId}:key:adopt`, name: "adopt", baseMint: "BTC-MINT",
    quoteMint: "USDC", baseSymbol: "BTC", quoteSymbol: "USDC", baseDecimals: 8, quoteDecimals: 6,
    strategyMode: StrategyMode.AccumulateBase, mode: BotMode.Paper, status: BotStatus.Running,
    executionProvider: ExecutionProvider.Paper } });
  await client.botConfig.create({ data: configData(botId) });
  const knownLot = `${runId}:lot:known`;
  const unknownLot = `${runId}:lot:unknown`;
  await client.positionLot.createMany({ data: [
    { id: knownLot, botId, originalBaseAmount: 0.2, remainingBaseAmount: 0.2, entryPrice: 90,
      costQuote: 20, openedByExecutionId: "legacy-known", openedAt: new Date("2026-09-20T10:00:00Z") },
    { id: unknownLot, botId, originalBaseAmount: 0.2, remainingBaseAmount: 0.2, entryPrice: 95,
      costQuote: 20, openedByExecutionId: "legacy-unknown", openedAt: new Date("2026-09-20T11:00:00Z") },
    { id: `${runId}:lot:retained`, botId, kind: "retained", originalBaseAmount: 0.1, remainingBaseAmount: 0.1,
      entryPrice: 90, costQuote: 9, openedByExecutionId: "legacy-retained", openedAt: new Date("2026-09-20T12:00:00Z") },
  ] });
  await client.botStateSnapshot.create({ data: { id: `${runId}:snapshot:adopt`, botId, status: BotStatus.Running,
    currentPrice: 100, availableQuoteAmount: 60, availableBaseAmount: 0.5, deployedQuoteAmount: 40,
    averageEntryPrice: 92.5, realizedPnlUsd: 0, unrealizedPnlUsd: 0, totalEquityUsd: 100,
    consecutiveFailures: 0, lastProcessedAt: new Date("2026-09-21T11:59:00Z"),
    metadata: { levelLocks: {}, recenterHistory: [], recentExecutions: [],
      gridCycles: { "0": { buyLevelIndex: 0, sellLevelIndex: 1, lotId: knownLot, openedAt: "2026-09-20T10:00:00Z" } } } } });
}

function configData(botId: string) {
  return { botId, totalBudgetUsd: 100, maxDeployableUsd: 100, reserveQuoteAmount: 0, lowPrice: 90, highPrice: 110,
    levelCount: 3, gridType: GridType.Arithmetic, minOrderQuoteAmount: 10, maxSlippageBps: 50, cooldownMs: 1000,
    maxOrdersPerHour: 20, maxDrawdownPct: 20, maxConsecutiveFailures: 3, levelLockMs: 1000,
    priceConfirmationWindowMs: 1000, recenterMode: "manual_recenter" as const, autoRecenterMinIntervalMs: 1000,
    autoRecenterMaxPerDay: 1, outOfRangePause: true };
}
