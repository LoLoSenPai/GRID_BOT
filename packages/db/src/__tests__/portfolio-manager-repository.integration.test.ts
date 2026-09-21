import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archivePaperPortfolioBand, createPaperPortfolio, PrismaPortfolioManagerStore, resumePortfolioBand } from "../repositories/portfolio-manager-repository";
import { PrismaPortfolioRepository } from "../repositories/portfolio-repository";

const url = process.env.V2_TEST_DATABASE_URL;
let client: PrismaClient;
let repo: PrismaPortfolioRepository;
const seed = () => createPaperPortfolio({ requestId: randomUUID(), totalCapitalUsd: 1500, baseAllocationUsd: 500,
  envelopes: { BTC: { lowPrice: 90, highPrice: 110, levelCount: 5 }, SOL: { lowPrice: 18, highPrice: 22, levelCount: 5 } },
  observedAt: new Date() }, client);

(url ? describe : describe.skip)("V2 paper bootstrap and manager PostgreSQL", () => {
  beforeAll(() => { client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) }); repo = new PrismaPortfolioRepository(client); });
  afterAll(async () => client.$disconnect());
  it("creates equal allocations plus an unassigned pool with no extra virtual money", async () => {
    const id = await seed();
    const bands = await repo.listBandContexts(id);
    expect(bands).toHaveLength(2);
    expect(bands.every(b => b.portfolio.mode === "paper" && !b.portfolio.autoLive)).toBe(true);
    expect(bands.map(b => b.band.availableQuoteAmount)).toEqual([500, 500]);
    expect(bands[0]!.portfolio.freeQuoteAmount + bands.reduce((s, b) => s + b.band.availableQuoteAmount, 0)).toBe(1500);
    const snapshots = await client.botStateSnapshot.findMany({ where: { botId: { in: bands.map(b => b.band.botId) } } });
    expect(snapshots.every(s => Number(s.availableQuoteAmount) === 500 && (s.metadata as any).revisionBaselinePending)).toBe(true);
  });
  it("serializes competing BTC/SOL fallback allocations against the same free pool", async () => {
    const id = await seed();
    const bands = await repo.listBandContexts(id);
    const store = new PrismaPortfolioManagerStore(client);
    const inputs = await Promise.all(bands.map(async context => ({ context, bot: (await store.getBot(context.band.botId))! })));
    const decision = { action: "create_band" as const, reason: "test immobilized band", nextLowPrice: null, nextHighPrice: null,
      nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null,
      candidate: { lowPrice: 70, highPrice: 80, levelCount: 9, spacing: 1.25, requestedCapitalUsd: 300 } };
    const outcomes = await Promise.allSettled(inputs.map(i => store.applyDecision(i.context, i.bot, decision, new Date())));
    expect(outcomes.filter(o => o.status === "fulfilled"), outcomes.filter(o => o.status === "rejected").map(o => String(o.reason)).join("\n")).toHaveLength(1);
    const updated = await repo.listBandContexts(id);
    expect(updated).toHaveLength(3);
    expect(updated[0]!.portfolio.freeQuoteAmount).toBe(200);
    expect(updated.reduce((s, b) => s + b.band.allocatedQuoteAmount, 200)).toBe(1500);
  });
  it("refuses an adaptation if an operator pauses the observed bot", async () => {
    const id = await seed(); const context = (await repo.listBandContexts(id))[0]!;
    const store = new PrismaPortfolioManagerStore(client); const bot = (await store.getBot(context.band.botId))!;
    await client.bot.update({ where: { id: bot.bot.id }, data: { status: "paused" } });
    await expect(store.applyDecision(context, bot, { action: "park", reason: "test", nextLowPrice: null,
      nextHighPrice: null, nextLevelCount: null, nextSpacing: null, protectedLowPrice: null, protectedHighPrice: null }, new Date()))
      .rejects.toThrow(/changed/);
    expect((await repo.getBandContext(bot.bot.id))!.band.status).toBe("ACTIVE");
  });
  it("preserves cash on resume and returns cash exactly once on paper closure", async () => {
    const id = await seed(); const context = (await repo.listBandContexts(id))[0]!; const botId = context.band.botId;
    await client.bot.update({ where: { id: botId }, data: { status: "paused" } });
    await resumePortfolioBand(botId, client);
    expect(Number((await client.botStateSnapshot.findFirstOrThrow({ where: { botId }, orderBy: { createdAt: "desc" } })).availableQuoteAmount)).toBe(500);
    await client.bot.update({ where: { id: botId }, data: { status: "stopped" } });
    await archivePaperPortfolioBand(botId, client);
    await archivePaperPortfolioBand(botId, client);
    const updated = (await repo.getBandContext(botId))!;
    expect(updated.portfolio.freeQuoteAmount).toBe(1000);
    expect(updated.band.availableQuoteAmount).toBe(0);
    expect(updated.band.status).toBe("CLOSED");
    await expect(resumePortfolioBand(botId, client)).rejects.toThrow(/cannot resume/);
  });
});
