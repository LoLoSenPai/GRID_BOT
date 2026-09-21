import { randomUUID } from "node:crypto";
import { MINTS } from "@grid-bot/common";
import { BotMode, GridType, DEFAULT_PORTFOLIO_POLICY, type BandExecutionContext, type BotAggregate,
  type PortfolioManagerStore, type PortfolioPolicyDecision } from "@grid-bot/core";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../client";
import { mapAggregate } from "../mappers";
import { PrismaPortfolioRepository, allocatePortfolioCapitalInTransaction } from "./portfolio-repository";

type Envelope = { lowPrice: number; highPrice: number; levelCount: number };
type Tx = Prisma.TransactionClient;

/** Virtual funds only. One transaction creates both equally funded strategies and their first revisions. */
export async function createPaperPortfolio(input: { totalCapitalUsd: number; baseAllocationUsd: number;
  envelopes: Record<"BTC" | "SOL", Envelope>; observedAt: Date; requestId: string }, client: PrismaClient = prisma) {
  if (![input.totalCapitalUsd, input.baseAllocationUsd].every(Number.isFinite) || input.baseAllocationUsd < 100 ||
    input.totalCapitalUsd < 2 * input.baseAllocationUsd || input.totalCapitalUsd > 100_000) throw new Error("Invalid paper capital.");
  for (const e of Object.values(input.envelopes)) validateEnvelope(e);
  return client.$transaction(async tx => {
    const identity = `paper-v2:${input.requestId}`;
    const existing = await tx.portfolio.findUnique({ where: { mode_walletIdentity_quoteMint: {
      mode: "paper", walletIdentity: identity, quoteMint: MINTS.USDC } } });
    if (existing) return existing.id;
    const portfolio = await tx.portfolio.create({ data: { mode: "paper", walletIdentity: identity,
      quoteMint: MINTS.USDC, autoLive: false, freeQuoteAmount: input.totalCapitalUsd } });
    await tx.capitalLedgerEntry.create({ data: { portfolioId: portfolio.id, entryType: "PORTFOLIO_FUNDING",
      idempotencyKey: "initial-paper-funding", portfolioFreeQuoteDelta: input.totalCapitalUsd, reason: "Virtual paper capital" } });
    for (const symbol of ["BTC", "SOL"] as const) {
      const strategy = await tx.assetStrategy.create({ data: { portfolioId: portfolio.id,
        baseMint: MINTS[symbol], baseSymbol: symbol, objective: symbol === "BTC" ? "accumulate_base" : "accumulate_usdc" } });
      const band = await createPaperBand(tx, { strategyId: strategy.id, symbol, envelope: input.envelopes[symbol],
        budget: input.baseAllocationUsd, now: input.observedAt, reason: "Initial grid from closed observations" });
      await allocatePortfolioCapitalInTransaction(tx, { portfolioId: portfolio.id, bandId: band.id,
        quoteAmount: input.baseAllocationUsd, idempotencyKey: `initial-allocation:${symbol}`, reason: "Equal initial BTC/SOL allocation" });
    }
    return portfolio.id;
  });
}

async function createPaperBand(tx: Tx, input: { strategyId: string; symbol: "BTC" | "SOL"; envelope: Envelope;
  budget: number; now: Date; reason: string }) {
  validateEnvelope(input.envelope);
  const envelope = { lowPrice: input.envelope.lowPrice, highPrice: input.envelope.highPrice, levelCount: input.envelope.levelCount };
  const bot = await tx.bot.create({ data: { key: `v2-${input.symbol.toLowerCase()}-${randomUUID()}`,
    name: `${input.symbol} / USDC · V2 paper`, baseMint: MINTS[input.symbol], quoteMint: MINTS.USDC,
    baseSymbol: input.symbol, quoteSymbol: "USDC", baseDecimals: input.symbol === "BTC" ? 8 : 9, quoteDecimals: 6,
    strategyMode: input.symbol === "BTC" ? "accumulate_base" : "accumulate_usdc", mode: "paper", status: "running", executionProvider: "paper" } });
  await tx.botConfig.create({ data: { botId: bot.id, totalBudgetUsd: input.budget, maxDeployableUsd: input.budget,
    reserveQuoteAmount: 0, ...envelope, gridType: "arithmetic", minOrderQuoteAmount: 25, maxSlippageBps: 50,
    cooldownMs: 5_000, maxOrdersPerHour: 30, maxDrawdownPct: 100, maxConsecutiveFailures: 5,
    levelLockMs: 30_000, priceConfirmationWindowMs: 0, recenterMode: "manual_recenter", entryMode: "normal",
    autoRecenterMinIntervalMs: DEFAULT_PORTFOLIO_POLICY.cooldownMs, autoRecenterMaxPerDay: DEFAULT_PORTFOLIO_POLICY.maxDailyRevisions,
    outOfRangePause: false } });
  const band = await tx.gridBand.create({ data: { botId: bot.id, assetStrategyId: input.strategyId,
    allocatedQuoteAmount: 0, availableQuoteAmount: 0 } });
  const revision = await tx.gridRevision.create({ data: { bandId: band.id, sequence: 1, ...envelope,
    gridType: "arithmetic", reason: input.reason, observedAt: input.now } });
  await tx.position.create({ data: { botId: bot.id, baseAmount: 0, quoteSpent: 0, averageEntryPrice: 0,
    realizedPnlUsd: 0, unrealizedPnlUsd: 0, totalFeesQuote: 0 } });
  await tx.botStateSnapshot.create({ data: { botId: bot.id, status: "running", availableQuoteAmount: input.budget,
    availableBaseAmount: 0, deployedQuoteAmount: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, totalEquityUsd: input.budget,
    lastProcessedAt: input.now, metadata: { gridRevisionId: revision.id, revisionBaselinePending: true, gridCycles: {},
      pendingSignal: null, levelLocks: {}, recenterHistory: [], recentExecutions: [] } } });
  return band;
}

export class PrismaPortfolioManagerStore implements PortfolioManagerStore {
  private readonly portfolios: PrismaPortfolioRepository;
  constructor(private readonly client: PrismaClient = prisma) { this.portfolios = new PrismaPortfolioRepository(client); }
  listBandContexts() { return this.portfolios.listBandContexts(); }
  async getBot(botId: string) {
    const bot = await this.client.bot.findFirst({ where: { id: botId, archivedAt: null }, include: {
      config: true, position: true, positionLots: { where: { closedAt: null } },
      stateSnapshots: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
    if (!bot) return null;
    const aggregate = mapAggregate({ bot, config: bot.config, position: bot.position, positionLots: bot.positionLots,
      stateSnapshots: bot.stateSnapshots });
    return aggregate ? { ...aggregate, portfolio: await this.portfolios.getBandContext(botId) } : null;
  }
  getContext(botId: string) { return this.portfolios.getBandContext(botId); }
  async applyDecision(context: BandExecutionContext, bot: BotAggregate, decision: PortfolioPolicyDecision, now: Date) {
    if (context.portfolio.mode !== BotMode.Paper) throw new Error("Autonomous live adaptation awaits paper validation.");
    if (decision.action === "revise") {
      await this.portfolios.reviseBand({ portfolioId: context.portfolio.id, bandId: context.band.id,
        expectedRevisionId: context.band.activeRevision.id, expectedSnapshotId: bot.latestState?.id ?? null,
        lowPrice: decision.nextLowPrice!, highPrice: decision.nextHighPrice!, levelCount: decision.nextLevelCount!,
        gridType: GridType.Arithmetic, reason: decision.reason, observedAt: now });
      return;
    }
    if (decision.action === "wait") return;
    await this.client.$transaction(async tx => {
      const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${bot.bot.id}, 0)) AS locked`;
      if (!lock[0]?.locked) throw new Error("Bot execution is observing this revision; adaptation deferred.");
      await tx.$queryRaw`SELECT id FROM bots WHERE id = ${bot.bot.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM portfolios WHERE id = ${context.portfolio.id} FOR UPDATE`;
      const current = await tx.bot.findUniqueOrThrow({ where: { id: bot.bot.id }, include: { executionAttempt: true,
        stateSnapshots: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
      const band = await tx.gridBand.findUniqueOrThrow({ where: { id: context.band.id }, include: {
        revisions: { orderBy: { sequence: "desc" }, take: 1 }, assetStrategy: { include: { portfolio: true } } } });
      if (current.archivedAt || ["paused", "stopped"].includes(current.status) || current.executionAttempt ||
        current.stateSnapshots[0]?.id !== bot.latestState?.id || band.revisions[0]?.id !== context.band.activeRevision.id ||
        band.status !== context.band.status) throw new Error("Band changed while evaluating policy.");
      if (decision.action === "park" || decision.action === "reactivate") {
        await tx.gridBand.update({ where: { id: band.id }, data: { status: decision.action === "park" ? "PARKED_BELOW" : "ACTIVE" } });
        // Re-entry begins with an observation, never with a synthetic crossing.
        const latest = current.stateSnapshots[0];
        if (latest) { const { id: _id, createdAt: _at, ...data } = latest;
          await tx.botStateSnapshot.create({ data: { ...data, metadata: { ...(latest.metadata as object),
            pendingSignal: null, revisionBaselinePending: true }, lastProcessedAt: now } }); }
      } else if (decision.action === "create_band") {
        const c = decision.candidate!;
        const strategy = band.assetStrategy;
        const strategies = await tx.assetStrategy.findMany({ where: { portfolioId: context.portfolio.id } });
        const allBands = await tx.gridBand.findMany({ where: { assetStrategy: { portfolioId: context.portfolio.id }, status: { not: "CLOSED" } } });
        const total = Number(strategy.portfolio.freeQuoteAmount) + allBands.reduce((s, b) => s + Number(b.allocatedQuoteAmount), 0);
        if (!["BTC", "SOL"].includes(strategy.baseSymbol) || !c || Number(strategy.portfolio.freeQuoteAmount) < c.requestedCapitalUsd ||
          strategies.some(s => Number(s.allocatedQuoteAmount) < Number(strategy.allocatedQuoteAmount)) ||
          allBands.filter(b => b.assetStrategyId === strategy.id).length >= DEFAULT_PORTFOLIO_POLICY.maxBands ||
          (Number(strategy.allocatedQuoteAmount) + c.requestedCapitalUsd) / total * 100 > DEFAULT_PORTFOLIO_POLICY.maxExposurePct ||
          await tx.lotExitCommitment.count({ where: { bandId: band.id, targetStatus: "UNKNOWN", fulfilledAt: null } })) {
          throw new Error("Lower-band capital or exposure constraints changed.");
        }
        const newBand = await createPaperBand(tx, { strategyId: strategy.id, symbol: strategy.baseSymbol as "BTC" | "SOL",
          envelope: c, budget: c.requestedCapitalUsd, now, reason: decision.reason });
        await allocatePortfolioCapitalInTransaction(tx, { portfolioId: context.portfolio.id, bandId: newBand.id,
          quoteAmount: c.requestedCapitalUsd, idempotencyKey: `fallback:${band.id}:${band.revisions[0]!.id}`,
          reason: decision.reason });
        await tx.gridBand.update({ where: { id: band.id }, data: { status: "PARKED_BELOW" } });
      }
      await tx.portfolio.update({ where: { id: context.portfolio.id }, data: { version: { increment: 1 } } });
    });
  }
  async recordDecision(botId: string, decision: PortfolioPolicyDecision, now: Date, completeObservation = true) {
    const prior = await this.client.systemLog.findFirst({ where: { botId, category: "portfolio_policy" }, orderBy: { createdAt: "desc" } });
    const priorObservation = prior?.metadata as { observedAt?: string; completeObservation?: boolean } | null;
    if (completeObservation && priorObservation?.completeObservation && priorObservation.observedAt === now.toISOString()) return;
    if (!completeObservation && prior?.message === decision.reason && Date.now() - +prior.createdAt < 60_000) return;
    await this.client.systemLog.create({ data: { botId, level: "info", category: "portfolio_policy", message: decision.reason,
      metadata: { ...decision, observedAt: now.toISOString(), completeObservation, policy: DEFAULT_PORTFOLIO_POLICY } as Prisma.InputJsonValue } });
  }
}

function validateEnvelope(e: Envelope) {
  if (![e.lowPrice, e.highPrice, e.levelCount].every(Number.isFinite) || e.lowPrice <= 0 || e.highPrice <= e.lowPrice ||
    !Number.isInteger(e.levelCount) || e.levelCount < 2 || e.levelCount > 100) throw new Error("Invalid grid envelope.");
}

/** Operator resume preserves accounting and exits; only the next entry observation is reset. */
export async function resumePortfolioBand(botId: string, client: PrismaClient = prisma) {
  await client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
    const bot = await tx.bot.findUniqueOrThrow({ where: { id: botId }, include: { gridBand: true, executionAttempt: true,
      stateSnapshots: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
    if (!bot.gridBand || bot.gridBand.status === "CLOSED" || bot.archivedAt || bot.executionAttempt || !bot.stateSnapshots[0]) {
      throw new Error("Band cannot resume before pending execution/accounting is reconciled.");
    }
    const { id: _id, createdAt: _at, ...snapshot } = bot.stateSnapshots[0];
    await tx.bot.update({ where: { id: botId }, data: { status: "running" } });
    await tx.botStateSnapshot.create({ data: { ...snapshot, status: "running", lastProcessedAt: new Date(),
      metadata: { ...(snapshot.metadata as object), pendingSignal: null, revisionBaselinePending: true } } });
  });
}

/** Paper closure returns only unreserved cash; retained base stays in history and is never liquidated. */
export async function archivePaperPortfolioBand(botId: string, client: PrismaClient = prisma) {
  await client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`;
    const bot = await tx.bot.findUniqueOrThrow({ where: { id: botId }, include: { gridBand: { include: { assetStrategy: true } },
      executionAttempt: true, stateSnapshots: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 } } });
    const band = bot.gridBand;
    if (!band || bot.mode !== "paper" || bot.status !== "stopped" || bot.executionAttempt || Number(band.reservedQuoteAmount) > 0 ||
      await tx.positionLot.count({ where: { botId, kind: "trading", closedAt: null, remainingBaseAmount: { gt: 0 } } })) {
      throw new Error("Stop the paper band after its trading lots and pending executions are settled before archiving.");
    }
    if (band.status === "CLOSED") return;
    const portfolioId = band.assetStrategy.portfolioId;
    await tx.$queryRaw`SELECT id FROM portfolios WHERE id = ${portfolioId} FOR UPDATE`;
    const cash = band.availableQuoteAmount;
    if (cash.gt(band.allocatedQuoteAmount)) throw new Error("Band cash must be reconciled before closure.");
    await tx.portfolio.update({ where: { id: portfolioId }, data: { freeQuoteAmount: { increment: cash }, version: { increment: 1 } } });
    await tx.assetStrategy.update({ where: { id: band.assetStrategyId }, data: { allocatedQuoteAmount: { decrement: cash } } });
    await tx.gridBand.update({ where: { id: band.id }, data: { status: "CLOSED", availableQuoteAmount: 0, allocatedQuoteAmount: { decrement: cash } } });
    await tx.capitalLedgerEntry.create({ data: { portfolioId, bandId: band.id, assetStrategyId: band.assetStrategyId,
      entryType: "RECONCILIATION", idempotencyKey: `close:${band.id}`, portfolioFreeQuoteDelta: cash,
      bandAvailableQuoteDelta: cash.negated(), bandAllocatedQuoteDelta: cash.negated(), strategyAllocatedQuoteDelta: cash.negated(),
      reason: "Paper band closure: return cash, preserve accumulated base history" } });
    const latest = bot.stateSnapshots[0];
    if (latest) { const { id: _id, createdAt: _at, ...snapshot } = latest;
      await tx.botStateSnapshot.create({ data: { ...snapshot, availableQuoteAmount: 0,
        totalEquityUsd: latest.totalEquityUsd.minus(cash), lastProcessedAt: new Date(), metadata: latest.metadata as Prisma.InputJsonValue } }); }
    await tx.bot.update({ where: { id: botId }, data: { archivedAt: new Date() } });
  });
}
