import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MarketPrice } from "@grid-bot/core";

const databaseUrl = process.env.V2_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("V2 paper engine against PostgreSQL", () => {
  let db: typeof import("../index");
  let core: typeof import("@grid-bot/core");

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl!;
    core = await import("@grid-bot/core");
    db = await import("../index");
  });

  afterAll(async () => {
    await db?.prisma.$disconnect();
    await db?.botLockPool.end();
  });

  it("runs a durable paper buy, revises below it, then honors the old immutable exit after restart", async () => {
    const requestId = `engine-${randomUUID()}`;
    const portfolioId = await db.createPaperPortfolio({
      requestId, totalCapitalUsd: 400, baseAllocationUsd: 150, observedAt: new Date("2026-09-21T10:00:00Z"),
      envelopes: { BTC: { lowPrice: 90, highPrice: 110, levelCount: 3 }, SOL: { lowPrice: 140, highPrice: 180, levelCount: 3 } },
    });
    const context = (await new db.PrismaPortfolioRepository().listBandContexts(portfolioId))
      .find((entry) => entry.strategy.baseSymbol === "BTC")!;
    let price = 105;
    const marketPriceService = { getLatestPrice: vi.fn(async (): Promise<MarketPrice> => ({
      symbol: "BTC", pair: "BTC/USDC", price, confidence: 1, source: "integration", feedId: "fixed",
      timestamp: new Date(),
    })) };
    const makeEngine = () => {
      const paper = new core.PaperExecutionAdapter();
      return new core.BotEngineService(
      new db.PrismaBotStateRepository(), new db.PrismaTradeRepository(),
      { createPriceSnapshot: vi.fn(async () => undefined) },
      { writeLog: vi.fn(async () => undefined) }, marketPriceService,
      new core.ExecutionService({
        [core.ExecutionProvider.Paper]: paper,
        [core.ExecutionProvider.Jupiter]: paper,
        [core.ExecutionProvider.Dflow]: paper,
      }, false),
      new core.GridStrategyService(), new core.RiskManagerService(),
      new core.AlertService({ createAlert: vi.fn(async (alert) => ({ ...alert, id: randomUUID(), createdAt: new Date() })) }, []),
      );
    };

    const firstEngine = makeEngine();
    await firstEngine.runBot(context.band.botId);
    price = 99;
    await firstEngine.runBot(context.band.botId);

    let afterBuy = await new db.PrismaPortfolioRepository().getBandContext(context.band.botId);
    expect(afterBuy?.exitCommitments).toHaveLength(1);
    expect(afterBuy?.band.reservedQuoteAmount).toBe(0);
    expect(afterBuy?.band.deployedCostQuote).toBeGreaterThan(0);
    expect(await db.prisma.executionAttempt.count({ where: { botId: context.band.botId } })).toBe(0);
    const buyCommitment = afterBuy!.exitCommitments[0]!;

    const aggregate = await new db.PrismaBotStateRepository().getBotAggregate(context.band.botId);
    const revised = await new db.PrismaPortfolioRepository().reviseBand({
      portfolioId, bandId: context.band.id, expectedRevisionId: afterBuy!.band.activeRevision.id,
      expectedSnapshotId: aggregate!.latestState!.id, lowPrice: 70, highPrice: 90, levelCount: 3,
      gridType: "arithmetic" as never, reason: "integration move below open lot", observedAt: new Date(),
    });
    expect(revised.id).not.toBe(buyCommitment.originRevisionId);
    await new db.PrismaPortfolioRepository().setBandStatus(portfolioId, context.band.id, "ACTIVE", "PARKED_BELOW");

    price = buyCommitment.sellTargetPrice! + 1;
    await makeEngine().runBot(context.band.botId);

    const afterSell = await new db.PrismaPortfolioRepository().getBandContext(context.band.botId);
    expect(afterSell?.exitCommitments[0]?.fulfilledAt).toBeInstanceOf(Date);
    expect(afterSell?.band.deployedCostQuote).toBe(0);
    expect(afterSell?.portfolio.freeQuoteAmount).toBeGreaterThan(100);
    expect(await db.prisma.executionAttempt.count({ where: { botId: context.band.botId } })).toBe(0);
    const ledger = await db.prisma.capitalLedgerEntry.findMany({ where: { portfolioId, bandId: context.band.id } });
    expect(ledger.filter((entry) => entry.entryType === "BUY_SETTLEMENT")).toHaveLength(1);
    expect(ledger.filter((entry) => entry.entryType === "SELL_SETTLEMENT")).toHaveLength(1);
    expect(ledger.filter((entry) => entry.entryType === "PROFIT_SWEEP")).toHaveLength(1);
  }, 20_000);
});
