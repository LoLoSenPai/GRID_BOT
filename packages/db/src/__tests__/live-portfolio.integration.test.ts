import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { getEnv } from "@grid-bot/common";
import { DEFAULT_PORTFOLIO_POLICY, WalletService } from "@grid-bot/core";
import { prisma } from "../client";
import { stageLivePortfolio, activateLivePortfolio, recordLivePaperReview, topUpLiveFeeEnvelope } from "../repositories/live-portfolio-repository";
import { assertLiveWalletCapital } from "../repositories/live-wallet-capital";
import { resolveLiveNativeFeePolicy } from "../repositories/live-native-fees";

// Use a fresh dedicated LOCAL database; this suite deliberately shares one configured wallet.
(process.env.LIVE_PREFLIGHT_TEST_DATABASE === "true" ? describe : describe.skip)("live wallet wiring PostgreSQL", () => {
  let portfolioId: string;
  beforeAll(() => {
    const url = new URL(getEnv().DATABASE_URL);
    if (url.hostname !== "127.0.0.1" || !url.pathname.includes("live_readiness")) throw new Error("Dedicated local DB required.");
    vi.spyOn(WalletService, "fromEnv").mockReturnValue({ getBalances: async () => ({ pubkey: "test-wallet", usdc: 1500,
      sol: 1, wbtc: 0, hype: 0 }), getPubkey: () => "test-wallet" } as WalletService);
  });
  afterAll(async () => { vi.restoreAllMocks(); getEnv().V2_LIVE_ENABLED = false; await prisma.$disconnect(); });
  it("stages equal real allocations paused, reserving capital once", async () => {
    portfolioId = await stageLivePortfolio({ totalCapital: 1000, baseAllocation: 400, feeSol: 0.1,
      observedAt: new Date(), envelopes: { BTC: { lowPrice: 80, highPrice: 100, levelCount: 3 }, SOL: { lowPrice: 80, highPrice: 100, levelCount: 3 } } });
    const p = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId }, include: { assetStrategies: { include: { bands: { include: { bot: true } } } } } });
    expect(Number(p.freeQuoteAmount)).toBe(200); expect(Number(p.nativeFeeReserveSol)).toBe(0.1);
    expect(p.autoLive).toBe(false);
    expect(p.assetStrategies.flatMap(s => s.bands).every(b => b.bot.mode === "live" && b.bot.status === "paused" && Number(b.availableQuoteAmount) === 400)).toBe(true);
  });
  it("serializes two competing funding requests using the same remaining wallet cash", async () => {
    const allocate = () => prisma.$transaction(async tx => {
      await assertLiveWalletCapital(tx, 400);
      await tx.portfolio.update({ where: { id: portfolioId }, data: { freeQuoteAmount: { increment: 400 } } });
    }, { timeout: 15000 });
    const results = await Promise.allSettled([allocate(), allocate()]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("cannot activate via a review id while the deployment gate is off", async () => {
    getEnv().V2_LIVE_ENABLED = false;
    await expect(activateLivePortfolio(portfolioId, "anything")).rejects.toThrow("deployment-locked");
  });
  it("requires persisted reviewed policy even when deployment permits live", async () => {
    getEnv().LIVE_TRADING_ENABLED = true; getEnv().V2_LIVE_ENABLED = true;
    await expect(activateLivePortfolio(portfolioId, "missing")).rejects.toThrow("recorded review");
    await expect(recordLivePaperReview(portfolioId, "test")).rejects.toThrow("Paper requires");
  });
  it("activates only staged bands and supplies the reserved fee budget", async () => {
    // Trusted operator evidence fixture; public APIs cannot create this record.
    const review = await prisma.systemLog.create({ data: { category: "portfolio_live_review", level: "info", message: "fixture",
      metadata: { policyFingerprint: JSON.stringify(DEFAULT_PORTFOLIO_POLICY) } } });
    await activateLivePortfolio(portfolioId, review.id);
    const bot = await prisma.bot.findFirstOrThrow({ where: { gridBand: { assetStrategy: { portfolioId } } } });
    expect(bot.status).toBe("running");
    const policy = await resolveLiveNativeFeePolicy({ botId: bot.id, inputMint: "usdc", outputMint: bot.baseMint,
      amount: 10, inputDecimals: 6, outputDecimals: 8, slippageBps: 50, clientOrderId: "test" });
    expect(policy.maxFeeAmount).toBe(0.1);
    await expect(activateLivePortfolio(portfolioId, review.id)).rejects.toThrow("not staged");
  });
  it("adds fee funding once, rejects overspending, and never changes activation", async () => {
    await prisma.portfolio.update({ where: { id: portfolioId }, data: { autoLive: false } });
    await topUpLiveFeeEnvelope(portfolioId, 0.05, "fund-1");
    await topUpLiveFeeEnvelope(portfolioId, 0.05, "fund-1");
    const p = await prisma.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(Number(p.nativeFeeReserveSol)).toBe(0.15); expect(p.autoLive).toBe(false);
    await expect(topUpLiveFeeEnvelope(portfolioId, 2, "fund-2")).rejects.toThrow("Insufficient unassigned native SOL");
    await expect(topUpLiveFeeEnvelope(portfolioId, 0.1, "fund-1")).rejects.toThrow("request changed");
  });
});
