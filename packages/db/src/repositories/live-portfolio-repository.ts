import { getEnv, MINTS } from "@grid-bot/common";
import { DEFAULT_PORTFOLIO_POLICY } from "@grid-bot/core";
import { prisma } from "../client";
import { assertLiveWalletCapital, lockLiveWallet } from "./live-wallet-capital";
import { createPaperBand } from "./portfolio-manager-repository";
import { allocatePortfolioCapitalInTransaction } from "./portfolio-repository";

const policyFingerprint = () => JSON.stringify(DEFAULT_PORTFOLIO_POLICY);

/** Explicit fee-budget attribution, never a SOL purchase or an automatic restart. */
export async function topUpLiveFeeEnvelope(portfolioId: string, amountSol: number, requestId: string) {
  if (!Number.isFinite(amountSol) || amountSol <= 0 || !requestId.trim()) throw new Error("Invalid fee funding request.");
  return prisma.$transaction(async tx => {
    await lockLiveWallet(tx);
    const key = `native-fee-funding:${requestId}`;
    const previous = await tx.capitalLedgerEntry.findUnique({ where: { portfolioId_idempotencyKey: { portfolioId, idempotencyKey: key } } });
    if (previous) {
      if ((previous.metadata as { amountSol?: number } | null)?.amountSol !== amountSol) throw new Error("Fee funding request changed.");
      return;
    }
    const p = await tx.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    if (p.mode !== "live") throw new Error("Live portfolio required.");
    await assertLiveWalletCapital(tx, 0, amountSol);
    await tx.portfolio.update({ where: { id: portfolioId }, data: { nativeFeeReserveSol: { increment: amountSol } } });
    await tx.capitalLedgerEntry.create({ data: { portfolioId, entryType: "RECONCILIATION", idempotencyKey: key,
      reason: "Explicit native SOL fee envelope funding", metadata: { amountSol } } });
  }, { timeout: 15000 });
}

/** Stage fresh funding as paused live bots; never convert virtual balances or existing inventory. */
export async function stageLivePortfolio(input: { totalCapital: number; baseAllocation: number; feeSol: number;
  envelopes: Record<"BTC" | "SOL", { lowPrice: number; highPrice: number; levelCount: number }>;
  observedAt: Date }) {
  if (input.baseAllocation < 100 || input.totalCapital < 2 * input.baseAllocation || !(input.feeSol > 0) ||
    ![input.totalCapital, input.baseAllocation, input.feeSol].every(Number.isFinite) ||
    !Number.isFinite(+input.observedAt) || +input.observedAt > Date.now() || Date.now() - +input.observedAt > 2 * 3600000)
    throw new Error("Invalid live allocation or stale grid observation.");
  return prisma.$transaction(async tx => {
    const wallet = await assertLiveWalletCapital(tx, input.totalCapital, input.feeSol);
    if (await tx.portfolio.findFirst({ where: { mode: "live", walletIdentity: wallet.pubkey } }))
      throw new Error("A live portfolio already exists; do not allocate it twice.");
    const p = await tx.portfolio.create({ data: { mode: "live", walletIdentity: wallet.pubkey, quoteMint: MINTS.USDC,
      freeQuoteAmount: input.totalCapital, nativeFeeReserveSol: input.feeSol, autoLive: false } });
    await tx.capitalLedgerEntry.create({ data: { portfolioId: p.id, entryType: "PORTFOLIO_FUNDING",
      idempotencyKey: "initial-live-funding", portfolioFreeQuoteDelta: input.totalCapital,
      reason: "Fresh wallet cash reserved under wallet allocation lock", metadata: { feeSol: input.feeSol } } });
    for (const symbol of ["BTC", "SOL"] as const) {
      const s = await tx.assetStrategy.create({ data: { portfolioId: p.id, baseMint: MINTS[symbol], baseSymbol: symbol,
        objective: symbol === "BTC" ? "accumulate_base" : "accumulate_usdc" } });
      const b = await createPaperBand(tx, { strategyId: s.id, symbol, envelope: input.envelopes[symbol],
        budget: input.baseAllocation, now: input.observedAt, reason: "Prepared live grid, activation locked", livePaused: true });
      await allocatePortfolioCapitalInTransaction(tx, { portfolioId: p.id, bandId: b.id, quoteAmount: input.baseAllocation,
        idempotencyKey: `initial:${symbol}`, reason: "Equal initial live allocation" });
    }
    return p.id;
  }, { timeout: 15000 });
}

/** Called by the operator after inspecting paper ledger and automated regression results, not by a public API. */
export async function recordLivePaperReview(paperPortfolioId: string, reviewReference: string) {
  if (!reviewReference.trim()) throw new Error("A reproducible review reference is required.");
  const p = await prisma.portfolio.findUniqueOrThrow({ where: { id: paperPortfolioId }, include: {
    assetStrategies: { include: { bands: { include: { revisions: true, exitCommitments: true } } } } } });
  if (p.mode !== "paper" || !["BTC", "SOL"].every(symbol => p.assetStrategies.some(s => s.baseSymbol === symbol &&
    s.bands.some(b => b.exitCommitments.some(c => c.fulfilledAt))))) throw new Error("Paper requires settled BTC and SOL cycles.");
  if (!p.assetStrategies.some(s => s.bands.some(b => b.revisions.some(r => r.sequence > 1 &&
    b.exitCommitments.some(c => c.originRevisionId !== r.id && c.createdAt < r.createdAt && c.fulfilledAt && c.fulfilledAt > r.createdAt)))))
    throw new Error("Paper requires an old lot exit after an adaptation with inventory.");
  const botIds = p.assetStrategies.flatMap(s => s.bands.map(b => b.botId));
  if (await prisma.executionAttempt.count({ where: { botId: { in: botIds } } })) throw new Error("Paper execution pending.");
  return prisma.systemLog.create({ data: { category: "portfolio_live_review", level: "info", message: reviewReference,
    metadata: { paperPortfolioId, policyFingerprint: policyFingerprint() } } });
}

export async function activateLivePortfolio(portfolioId: string, reviewId: string) {
  if (!getEnv().LIVE_TRADING_ENABLED || !getEnv().V2_LIVE_ENABLED) throw new Error("Live activation is deployment-locked.");
  return prisma.$transaction(async tx => {
    await lockLiveWallet(tx);
    const p = await tx.portfolio.findUniqueOrThrow({ where: { id: portfolioId }, include: {
      assetStrategies: { include: { bands: { include: { bot: true } } } } } });
    const review = await tx.systemLog.findUnique({ where: { id: reviewId } });
    const evidence = review?.metadata as { policyFingerprint?: string } | null;
    if (review?.category !== "portfolio_live_review" || evidence?.policyFingerprint !== policyFingerprint())
      throw new Error("A recorded review of this policy is required.");
    if (p.mode !== "live" || p.autoLive || Number(p.nativeFeeReserveSol) <= 0) throw new Error("Portfolio is not staged for activation.");
    const bands = p.assetStrategies.flatMap(s => s.bands);
    if (bands.length !== 2 || bands.some(b => b.status !== "ACTIVE" || b.bot.archivedAt || b.bot.status !== "paused"))
      throw new Error("Only the two explicitly staged paused bands may be activated.");
    await assertLiveWalletCapital(tx, 0);
    for (const b of bands) {
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${b.botId} FOR UPDATE`;
      const current = await tx.bot.findUniqueOrThrow({ where: { id: b.botId } });
      if (current.archivedAt || current.status !== "paused" || current.updatedAt.getTime() !== b.bot.updatedAt.getTime())
        throw new Error("Operator changed a staged bot during activation.");
      const latest = await tx.botStateSnapshot.findFirstOrThrow({ where: { botId: b.botId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      const { id: _id, createdAt: _at, ...snapshot } = latest;
      await tx.bot.update({ where: { id: b.botId }, data: { status: "running" } });
      await tx.botStateSnapshot.create({ data: { ...snapshot, status: "running", lastProcessedAt: new Date(),
        metadata: { ...(latest.metadata as object), pendingSignal: null, revisionBaselinePending: true } } });
    }
    await tx.portfolio.update({ where: { id: p.id }, data: { autoLive: true, version: { increment: 1 } } });
    await tx.systemLog.create({ data: { category: "portfolio_live_activation", level: "info", message: "Explicit live activation",
      metadata: { portfolioId, reviewId, policyFingerprint: policyFingerprint() } } });
  }, { timeout: 15000 });
}
