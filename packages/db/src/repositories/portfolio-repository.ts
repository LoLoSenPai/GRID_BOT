import {
  type AdoptExistingBotInput,
  type AllocatePortfolioCapitalInput,
  type AssetStrategyRecord,
  type BandExecutionContext,
  type CapitalReservationRecord,
  type CreatePortfolioInput,
  type ExitCommitmentInput,
  type GridBandStatus,
  type GridRevisionRecord,
  type LotExitCommitmentRecord,
  type PortfolioFillSettlementInput,
  type PortfolioFillSettlementResult,
  type PortfolioRecord,
  type PortfolioRepository,
  type ReconcilePortfolioReservationInput,
  type ReleasePortfolioReservationInput,
  type ReservePortfolioCapitalInput,
  type ReviseGridBandInput,
} from "@grid-bot/core";
import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma } from "../client";

type Tx = Prisma.TransactionClient;
type DbClient = PrismaClient | Tx;
const ZERO = new Prisma.Decimal(0);

export class PrismaPortfolioRepository implements PortfolioRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async createPortfolio(input: CreatePortfolioInput): Promise<PortfolioRecord> {
    requireText(input.walletIdentity, "walletIdentity");
    requireText(input.quoteMint, "quoteMint");
    requireText(input.idempotencyKey, "idempotencyKey");
    requireNonnegative(input.initialFreeQuoteAmount, "initialFreeQuoteAmount");
    if (input.autoLive !== undefined && input.autoLive !== false) {
      throw new Error("A portfolio cannot be created with automatic live execution enabled.");
    }
    const row = await this.client.$transaction(async (tx) => {
      const existing = await tx.portfolio.findUnique({
        where: { mode_walletIdentity_quoteMint: { mode: input.mode as never, walletIdentity: input.walletIdentity, quoteMint: input.quoteMint } },
      });
      if (existing) {
        const ledger = await tx.capitalLedgerEntry.findUnique({
          where: { portfolioId_idempotencyKey: { portfolioId: existing.id, idempotencyKey: input.idempotencyKey } },
        });
        if (!ledger || ledger.entryType !== "PORTFOLIO_FUNDING" || toNumber(ledger.portfolioFreeQuoteDelta) !== input.initialFreeQuoteAmount) {
          throw new Error("This wallet identity is already attached to a different portfolio creation request.");
        }
        return existing;
      }
      const created = await tx.portfolio.create({
        data: {
          ...(input.id ? { id: input.id } : {}), mode: input.mode as never, walletIdentity: input.walletIdentity,
          quoteMint: input.quoteMint, freeQuoteAmount: input.initialFreeQuoteAmount, autoLive: false,
        },
      });
      await tx.capitalLedgerEntry.create({ data: {
        portfolioId: created.id, entryType: "PORTFOLIO_FUNDING", idempotencyKey: input.idempotencyKey,
        portfolioFreeQuoteDelta: input.initialFreeQuoteAmount, reason: "Explicit initial unassigned quote funding",
      } });
      return created;
    });
    return mapPortfolio(row);
  }

  async listPortfolios(): Promise<PortfolioRecord[]> {
    return (await this.client.portfolio.findMany({ orderBy: { createdAt: "asc" } })).map(mapPortfolio);
  }

  async getPortfolio(portfolioId: string): Promise<PortfolioRecord | null> {
    const row = await this.client.portfolio.findUnique({ where: { id: portfolioId } });
    return row ? mapPortfolio(row) : null;
  }

  async listBandContexts(portfolioId?: string): Promise<BandExecutionContext[]> {
    const bands = await this.client.gridBand.findMany({
      where: portfolioId ? { assetStrategy: { portfolioId } } : undefined,
      include: contextInclude,
      orderBy: { createdAt: "asc" },
    });
    return Promise.all(bands.map((band) => mapBandContext(this.client, band)));
  }

  async getBandContext(botId: string): Promise<BandExecutionContext | null> {
    const band = await this.client.gridBand.findUnique({ where: { botId }, include: contextInclude });
    return band ? mapBandContext(this.client, band) : null;
  }

  async setBandStatus(portfolioId: string, bandId: string, expectedStatus: GridBandStatus, status: GridBandStatus): Promise<void> {
    await this.client.$transaction(async (tx) => {
      await lockBandBot(tx, bandId);
      await lockPortfolio(tx, portfolioId);
      const updated = await tx.gridBand.updateMany({
        where: { id: bandId, status: expectedStatus as never, assetStrategy: { portfolioId } },
        data: { status: status as never },
      });
      if (updated.count !== 1) throw new Error("Grid band status changed concurrently or does not belong to the portfolio.");
      await tx.portfolio.update({ where: { id: portfolioId }, data: { version: { increment: 1 } } });
    });
  }

  async reserveCapital(input: ReservePortfolioCapitalInput): Promise<CapitalReservationRecord> {
    return mapReservation(await this.client.$transaction((tx) => reservePortfolioCapitalInTransaction(tx, input)));
  }

  async allocateCapital(input: AllocatePortfolioCapitalInput): Promise<void> {
    await this.client.$transaction((tx) => allocatePortfolioCapitalInTransaction(tx, input));
  }

  async releaseReservation(input: ReleasePortfolioReservationInput): Promise<CapitalReservationRecord> {
    return mapReservation(await this.client.$transaction((tx) => releasePortfolioReservationInTransaction(tx, input)));
  }

  async markReservationUnknown(portfolioId: string, reservationId: string, reason: string): Promise<CapitalReservationRecord> {
    requireText(reason, "reason");
    const row = await this.client.$transaction(async (tx) => {
      const preflight = await tx.capitalReservation.findUnique({ where: { id: reservationId }, select: { bandId: true } });
      if (!preflight) throw new Error("Capital reservation does not exist.");
      await lockBandBot(tx, preflight.bandId);
      await lockPortfolio(tx, portfolioId);
      const reservation = await getReservation(tx, portfolioId, reservationId);
      if (reservation.status === "SETTLED" || reservation.status === "RELEASED") {
        throw new Error("A terminal capital reservation cannot become unknown.");
      }
      if (reservation.status === "UNKNOWN") return reservation;
      const updated = await tx.capitalReservation.update({
        where: { id: reservationId }, data: { status: "UNKNOWN", unknownReason: reason },
      });
      await tx.capitalLedgerEntry.create({ data: {
        portfolioId, bandId: reservation.bandId, reservationId, entryType: "RECONCILIATION",
        idempotencyKey: `reservation-unknown:${reservationId}`, reason, metadata: { transition: "RESERVED_TO_UNKNOWN" },
      } });
      await tx.portfolio.update({ where: { id: portfolioId }, data: { version: { increment: 1 } } });
      return updated;
    });
    return mapReservation(row);
  }

  async reconcileReservation(input: ReconcilePortfolioReservationInput): Promise<CapitalReservationRecord> {
    requireText(input.idempotencyKey, "idempotencyKey");
    requireText(input.reason, "reason");
    const row = await this.client.$transaction(async (tx) => {
      const preflight = await tx.capitalReservation.findUnique({ where: { id: input.reservationId }, select: { bandId: true } });
      if (!preflight) throw new Error("Capital reservation does not exist.");
      await lockBandBot(tx, preflight.bandId);
      await lockPortfolio(tx, input.portfolioId);
      const reservation = await getReservation(tx, input.portfolioId, input.reservationId);
      const prior = await tx.capitalLedgerEntry.findUnique({
        where: { portfolioId_idempotencyKey: { portfolioId: input.portfolioId, idempotencyKey: input.idempotencyKey } },
      });
      if (prior) {
        if (prior.entryType !== "RECONCILIATION" || prior.reservationId !== reservation.id) {
          throw new Error("Reconciliation idempotency key was reused with different terms.");
        }
        return reservation;
      }
      if (reservation.status !== "UNKNOWN") throw new Error("Only an unknown reservation can be reconciled.");
      if (input.resolution === "RELEASE") {
        await tx.gridBand.update({ where: { id: reservation.bandId }, data: {
          reservedQuoteAmount: { decrement: reservation.quoteAmount },
        } });
      }
      const status = input.resolution === "RELEASE" ? "RELEASED" : "RESERVED";
      const updated = await tx.capitalReservation.update({
        where: { id: reservation.id }, data: { status, unknownReason: null },
      });
      await tx.capitalLedgerEntry.create({ data: {
        portfolioId: input.portfolioId, bandId: reservation.bandId, reservationId: reservation.id,
        entryType: "RECONCILIATION", idempotencyKey: input.idempotencyKey, reason: input.reason,
        bandAvailableQuoteDelta: ZERO,
        bandReservedQuoteDelta: input.resolution === "RELEASE" ? reservation.quoteAmount.negated() : ZERO,
        metadata: { resolution: input.resolution },
      } });
      await tx.portfolio.update({ where: { id: input.portfolioId }, data: { version: { increment: 1 } } });
      return updated;
    });
    return mapReservation(row);
  }

  async settleFill(input: PortfolioFillSettlementInput): Promise<PortfolioFillSettlementResult> {
    return this.client.$transaction((tx) => settlePortfolioFillInTransaction(tx, input));
  }

  async reviseBand(input: ReviseGridBandInput): Promise<GridRevisionRecord> {
    validateRevision(input);
    const revision = await this.client.$transaction(async (tx) => {
      const preflightBand = await tx.gridBand.findUnique({ where: { id: input.bandId }, select: { botId: true } });
      if (!preflightBand) throw new Error("Grid band does not exist.");
      const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${preflightBand.botId}, 0)) AS locked`;
      if (!lock[0]?.locked) throw new Error("Bot execution is observing this revision; adaptation deferred.");
      await lockBot(tx, preflightBand.botId);
      await lockPortfolio(tx, input.portfolioId);
      await assertPortfolioUnblocked(tx, input.portfolioId);
      const band = await tx.gridBand.findFirst({
        where: { id: input.bandId, assetStrategy: { portfolioId: input.portfolioId } }, include: { bot: true },
      });
      if (!band) throw new Error("Grid band does not belong to the portfolio.");
      if (band.status === "CLOSED") throw new Error("A closed grid band cannot be revised.");
      if (band.bot.archivedAt || band.bot.status === "paused" || band.bot.status === "stopped") {
        throw new Error("An archived, paused, or stopped bot cannot be revised.");
      }
      const active = await tx.gridRevision.findFirst({ where: { bandId: band.id }, orderBy: { sequence: "desc" } });
      if (!active || active.id !== input.expectedRevisionId) throw new Error("Grid revision changed concurrently.");
      const latestSnapshot = await tx.botStateSnapshot.findFirst({
        where: { botId: band.botId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      if ((latestSnapshot?.id ?? null) !== input.expectedSnapshotId) throw new Error("Bot accounting changed since the adaptation observation.");
      if (!latestSnapshot) throw new Error("A persisted accounting snapshot is required before adapting a band.");
      const unsafeTargetCount = await tx.lotExitCommitment.count({
        where: { bandId: band.id, fulfilledAt: null, targetStatus: "UNKNOWN" },
      });
      if (unsafeTargetCount) throw new Error("Adaptation is blocked because an open lot has an unknown absolute exit target.");
      const pendingExecution = await tx.executionAttempt.findUnique({ where: { botId: band.botId }, select: { botId: true } });
      if (pendingExecution) throw new Error("Adaptation is blocked while an execution requires settlement or reconciliation.");
      const created = await tx.gridRevision.create({ data: {
        bandId: band.id, sequence: active.sequence + 1, lowPrice: input.lowPrice, highPrice: input.highPrice,
        levelCount: input.levelCount, gridType: input.gridType as never, reason: input.reason,
        observedAt: input.observedAt, snapshotId: input.expectedSnapshotId,
      } });
      await tx.botConfig.update({ where: { botId: band.botId }, data: {
        lowPrice: input.lowPrice, highPrice: input.highPrice, levelCount: input.levelCount, gridType: input.gridType as never,
      } });
      const previousMetadata = latestSnapshot.metadata && typeof latestSnapshot.metadata === "object" && !Array.isArray(latestSnapshot.metadata)
        ? latestSnapshot.metadata as Record<string, unknown> : {};
      const previousHistory = Array.isArray(previousMetadata.recenterHistory)
        ? previousMetadata.recenterHistory.filter((value): value is string => typeof value === "string") : [];
      await tx.botStateSnapshot.create({ data: {
        botId: band.botId, status: latestSnapshot.status, currentPrice: latestSnapshot.currentPrice,
        availableQuoteAmount: latestSnapshot.availableQuoteAmount, availableBaseAmount: latestSnapshot.availableBaseAmount,
        deployedQuoteAmount: latestSnapshot.deployedQuoteAmount, averageEntryPrice: latestSnapshot.averageEntryPrice,
        realizedPnlUsd: latestSnapshot.realizedPnlUsd, unrealizedPnlUsd: latestSnapshot.unrealizedPnlUsd,
        totalEquityUsd: latestSnapshot.totalEquityUsd, consecutiveFailures: latestSnapshot.consecutiveFailures,
        lastExecutionAt: latestSnapshot.lastExecutionAt, lastProcessedAt: input.observedAt, lastRecenterAt: input.observedAt,
        metadata: { ...previousMetadata, pendingSignal: null, levelLocks: {},
          gridCycles: previousMetadata.gridCycles ?? {}, gridRevisionId: created.id,
          revisionBaselinePending: true, recenterHistory: [...previousHistory, input.observedAt.toISOString()] } as Prisma.InputJsonValue,
      } });
      await tx.gridBand.update({ where: { id: band.id }, data: { status: "ACTIVE" } });
      await tx.portfolio.update({ where: { id: input.portfolioId }, data: { version: { increment: 1 } } });
      return created;
    });
    return mapRevision(revision);
  }

  async adoptExistingBot(input: AdoptExistingBotInput): Promise<BandExecutionContext> {
    requireText(input.reason, "reason");
    requireText(input.idempotencyKey, "idempotencyKey");
    requireNonnegative(input.attributedCapitalQuote, "attributedCapitalQuote");
    requireNonnegative(input.availableQuoteAmount, "availableQuoteAmount");
    const botId = await this.client.$transaction(async (tx) => {
      await lockBot(tx, input.botId);
      const portfolio = await lockPortfolio(tx, input.portfolioId);
      const existingBand = await tx.gridBand.findUnique({ where: { botId: input.botId } });
      if (existingBand) {
        const ledger = await tx.capitalLedgerEntry.findUnique({
          where: { portfolioId_idempotencyKey: { portfolioId: input.portfolioId, idempotencyKey: input.idempotencyKey } },
        });
        if (!ledger || ledger.bandId !== existingBand.id) throw new Error("Bot was already adopted by another request.");
        return input.botId;
      }
      const bot = await tx.bot.findUnique({ where: { id: input.botId }, include: {
        config: true, positionLots: { where: { closedAt: null, remainingBaseAmount: { gt: 0 } }, orderBy: { openedAt: "asc" } },
        stateSnapshots: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 }, executionAttempt: true,
      } });
      if (!bot?.config) throw new Error("Existing bot and configuration are required for explicit adoption.");
      if (bot.executionAttempt) throw new Error("Cannot adopt a bot while an execution requires settlement or reconciliation.");
      if (bot.mode !== portfolio.mode || bot.quoteMint !== portfolio.quoteMint) {
        throw new Error("Bot mode and quote mint must match its portfolio.");
      }
      const objective = objectiveForBot(bot.baseSymbol, bot.strategyMode);
      const tradingLots = bot.positionLots.filter((lot) => lot.kind !== "retained");
      const retainedBaseAmount = sum(bot.positionLots.filter((lot) => lot.kind === "retained").map((lot) => toNumber(lot.remainingBaseAmount)));
      const deployedCostQuote = sum(tradingLots.map((lot) => toNumber(lot.costQuote)));
      const accounted = input.availableQuoteAmount + deployedCostQuote;
      if (accounted > input.attributedCapitalQuote + 1e-8) {
        throw new Error("Explicit attributed capital is below persisted available quote plus open-lot cost.");
      }
      const strategy = await tx.assetStrategy.upsert({
        where: { portfolioId_baseMint: { portfolioId: portfolio.id, baseMint: bot.baseMint } },
        create: { portfolioId: portfolio.id, baseMint: bot.baseMint, baseSymbol: bot.baseSymbol,
          objective: objective as never, allocationPolicy: "equal", allocatedQuoteAmount: input.attributedCapitalQuote,
          retainedBaseAmount },
        update: { allocatedQuoteAmount: { increment: input.attributedCapitalQuote }, retainedBaseAmount: { increment: retainedBaseAmount } },
      });
      if (strategy.objective !== objective || strategy.allocationPolicy !== "equal") {
        throw new Error("Existing asset strategy has incompatible economic terms.");
      }
      const band = await tx.gridBand.create({ data: {
        assetStrategyId: strategy.id, botId: bot.id, status: bot.archivedAt ? "CLOSED" : "ACTIVE",
        allocatedQuoteAmount: input.attributedCapitalQuote, availableQuoteAmount: input.availableQuoteAmount,
        deployedCostQuote, realizedLossQuote: Math.max(0, input.attributedCapitalQuote - accounted),
      } });
      const latestState = bot.stateSnapshots[0] ?? null;
      const revision = await tx.gridRevision.create({ data: {
        bandId: band.id, sequence: 1, lowPrice: bot.config.lowPrice, highPrice: bot.config.highPrice,
        levelCount: bot.config.levelCount, gridType: bot.config.gridType, reason: input.reason,
        observedAt: input.observedAt, snapshotId: latestState?.id ?? null,
      } });
      const levels = calculateLevels(toNumber(bot.config.lowPrice), toNumber(bot.config.highPrice), bot.config.levelCount, bot.config.gridType);
      const cycles = readGridCycles(latestState?.metadata);
      for (const lot of tradingLots) {
        const cycle = Object.values(cycles).find((value) => value.lotId === lot.id);
        const buy = cycle ? levels[cycle.buyLevelIndex] : undefined;
        const sell = cycle?.sellLevelIndex === null || cycle?.sellLevelIndex === undefined ? undefined : levels[cycle.sellLevelIndex];
        const known = Boolean(cycle && buy && sell);
        await upsertLotExitCommitmentInTransaction(tx, {
          bandId: band.id, lotId: lot.id, targetStatus: known ? "KNOWN" : "UNKNOWN",
          buyLevelIndex: cycle?.buyLevelIndex ?? null, sellLevelIndex: cycle?.sellLevelIndex ?? null,
          buyTargetPrice: buy ?? null, sellTargetPrice: sell ?? null, economicRule: objective,
          originRevisionId: revision.id, maxAdverseDriftBps: bot.config.maxSlippageBps,
        });
      }
      await tx.capitalLedgerEntry.create({ data: {
        portfolioId: portfolio.id, assetStrategyId: strategy.id, bandId: band.id, entryType: "BAND_ALLOCATION",
        idempotencyKey: input.idempotencyKey, bandAvailableQuoteDelta: input.availableQuoteAmount,
        strategyAllocatedQuoteDelta: input.attributedCapitalQuote, bandAllocatedQuoteDelta: input.attributedCapitalQuote,
        bandDeployedCostDelta: deployedCostQuote, reason: input.reason,
        strategyRetainedBaseDelta: retainedBaseAmount,
        metadata: { source: "explicit_existing_bot_adoption", attributedCapitalQuote: input.attributedCapitalQuote,
          retainedBaseAmount },
      } });
      await tx.portfolio.update({ where: { id: portfolio.id }, data: { version: { increment: 1 } } });
      return bot.id;
    });
    const context = await this.getBandContext(botId);
    if (!context) throw new Error("Adopted grid band was not found.");
    return context;
  }
}

export async function allocatePortfolioCapitalInTransaction(tx: Tx, input: AllocatePortfolioCapitalInput): Promise<void> {
  requireText(input.idempotencyKey, "idempotencyKey");
  requireText(input.reason, "reason");
  requirePositive(input.quoteAmount, "quoteAmount");
  await lockBandBot(tx, input.bandId);
  const portfolio = await lockPortfolio(tx, input.portfolioId);
  const prior = await tx.capitalLedgerEntry.findUnique({
    where: { portfolioId_idempotencyKey: { portfolioId: input.portfolioId, idempotencyKey: input.idempotencyKey } },
  });
  if (prior) {
    if (prior.entryType !== "BAND_ALLOCATION" || prior.bandId !== input.bandId ||
      toNumber(prior.bandAllocatedQuoteDelta) !== input.quoteAmount) {
      throw new Error("Capital allocation idempotency key was reused with different terms.");
    }
    return;
  }
  await assertPortfolioUnblocked(tx, input.portfolioId);
  if (toNumber(portfolio.freeQuoteAmount) < input.quoteAmount) throw new Error("Portfolio free quote pool is insufficient.");
  const band = await tx.gridBand.findFirst({ where: { id: input.bandId, assetStrategy: { portfolioId: input.portfolioId } } });
  if (!band) throw new Error("Grid band does not belong to the portfolio.");
  if (band.status === "CLOSED") throw new Error("A closed band cannot receive capital.");
  await tx.portfolio.update({ where: { id: portfolio.id }, data: {
    freeQuoteAmount: { decrement: input.quoteAmount }, version: { increment: 1 },
  } });
  await tx.assetStrategy.update({ where: { id: band.assetStrategyId }, data: {
    allocatedQuoteAmount: { increment: input.quoteAmount },
  } });
  await tx.gridBand.update({ where: { id: band.id }, data: {
    allocatedQuoteAmount: { increment: input.quoteAmount }, availableQuoteAmount: { increment: input.quoteAmount },
  } });
  await tx.capitalLedgerEntry.create({ data: {
    portfolioId: portfolio.id, assetStrategyId: band.assetStrategyId, bandId: band.id,
    entryType: "BAND_ALLOCATION", idempotencyKey: input.idempotencyKey,
    portfolioFreeQuoteDelta: -input.quoteAmount, strategyAllocatedQuoteDelta: input.quoteAmount,
    bandAllocatedQuoteDelta: input.quoteAmount, bandAvailableQuoteDelta: input.quoteAmount, reason: input.reason,
  } });
}

export async function reservePortfolioCapitalInTransaction(tx: Tx, input: ReservePortfolioCapitalInput) {
  requireText(input.idempotencyKey, "idempotencyKey");
  requireText(input.reason, "reason");
  requirePositive(input.quoteAmount, "quoteAmount");
  await lockBandBot(tx, input.bandId);
  await lockPortfolio(tx, input.portfolioId);
  const existing = await tx.capitalReservation.findUnique({
    where: { portfolioId_idempotencyKey: { portfolioId: input.portfolioId, idempotencyKey: input.idempotencyKey } },
  });
  if (existing) {
    if (existing.bandId !== input.bandId || toNumber(existing.quoteAmount) !== input.quoteAmount) {
      throw new Error("Capital reservation idempotency key was reused with different terms.");
    }
    return existing;
  }
  await assertPortfolioUnblocked(tx, input.portfolioId);
  const band = await tx.gridBand.findFirst({ where: { id: input.bandId, assetStrategy: { portfolioId: input.portfolioId } } });
  if (!band) throw new Error("Grid band does not belong to the portfolio.");
  if (band.status !== "ACTIVE") throw new Error("Only an active grid band can reserve buy capital.");
  if (toNumber(band.availableQuoteAmount) - toNumber(band.reservedQuoteAmount) < input.quoteAmount) {
    throw new Error("Grid band has insufficient unreserved attributed capital.");
  }
  const reservation = await tx.capitalReservation.create({ data: {
    portfolioId: input.portfolioId, bandId: input.bandId, quoteAmount: input.quoteAmount,
    idempotencyKey: input.idempotencyKey, status: "RESERVED",
  } });
  await tx.gridBand.update({ where: { id: band.id }, data: {
    reservedQuoteAmount: { increment: input.quoteAmount },
  } });
  await tx.capitalLedgerEntry.create({ data: {
    portfolioId: input.portfolioId, assetStrategyId: band.assetStrategyId, bandId: band.id,
    reservationId: reservation.id, entryType: "RESERVATION", idempotencyKey: input.idempotencyKey,
    bandReservedQuoteDelta: input.quoteAmount, reason: input.reason,
  } });
  await tx.portfolio.update({ where: { id: input.portfolioId }, data: { version: { increment: 1 } } });
  return reservation;
}

export async function releasePortfolioReservationInTransaction(tx: Tx, input: ReleasePortfolioReservationInput) {
  requireText(input.idempotencyKey, "idempotencyKey");
  requireText(input.reason, "reason");
  const preflight = await tx.capitalReservation.findUnique({ where: { id: input.reservationId }, select: { bandId: true } });
  if (!preflight) throw new Error("Capital reservation does not exist.");
  await lockBandBot(tx, preflight.bandId);
  await lockPortfolio(tx, input.portfolioId);
  const reservation = await getReservation(tx, input.portfolioId, input.reservationId);
  const prior = await tx.capitalLedgerEntry.findUnique({
    where: { portfolioId_idempotencyKey: { portfolioId: input.portfolioId, idempotencyKey: input.idempotencyKey } },
  });
  if (prior) {
    if (prior.entryType !== "RESERVATION_RELEASE" || prior.reservationId !== reservation.id) {
      throw new Error("Reservation release idempotency key was reused with different terms.");
    }
    return reservation;
  }
  if (reservation.status === "UNKNOWN") throw new Error("Unknown execution outcome must be reconciled before releasing capital.");
  if (reservation.status === "SETTLED") throw new Error("Settled capital cannot be released.");
  if (reservation.status === "RELEASED") throw new Error("Reservation was released by a different idempotency request.");
  const updated = await tx.capitalReservation.update({ where: { id: reservation.id }, data: { status: "RELEASED" } });
  await tx.gridBand.update({ where: { id: reservation.bandId }, data: {
    reservedQuoteAmount: { decrement: reservation.quoteAmount },
  } });
  await tx.capitalLedgerEntry.create({ data: {
    portfolioId: input.portfolioId, bandId: reservation.bandId, reservationId: reservation.id,
    entryType: "RESERVATION_RELEASE", idempotencyKey: input.idempotencyKey,
    bandReservedQuoteDelta: reservation.quoteAmount.negated(), reason: input.reason,
  } });
  await tx.portfolio.update({ where: { id: input.portfolioId }, data: { version: { increment: 1 } } });
  return updated;
}

export async function settlePortfolioFillInTransaction(tx: Tx, input: PortfolioFillSettlementInput): Promise<PortfolioFillSettlementResult> {
  requireText(input.executionId, "executionId");
  requireText(input.idempotencyKey, "idempotencyKey");
  await lockBandBot(tx, input.bandId);
  await lockPortfolio(tx, input.portfolioId);
  const prior = await tx.capitalLedgerEntry.findUnique({
    where: { portfolioId_idempotencyKey: { portfolioId: input.portfolioId, idempotencyKey: input.idempotencyKey } },
  });
  if (prior) {
    const expectedType = input.side === "buy" ? "BUY_SETTLEMENT" : "SELL_SETTLEMENT";
    if (prior.entryType !== expectedType || prior.bandId !== input.bandId || prior.executionId !== input.executionId) {
      throw new Error("Fill settlement idempotency key was reused with different terms.");
    }
    return settlementResult(prior.metadata, false);
  }
  const band = await tx.gridBand.findFirst({ where: { id: input.bandId, assetStrategy: { portfolioId: input.portfolioId } } });
  if (!band) throw new Error("Grid band does not belong to the portfolio.");
  const externalFeeQuote = input.externalFeeQuote ?? 0;
  requireNonnegative(externalFeeQuote, "externalFeeQuote");
  let result: PortfolioFillSettlementResult;
  if (input.side === "buy") {
    requirePositive(input.cashQuoteDebited, "cashQuoteDebited");
    requirePositive(input.acquiredCostQuote, "acquiredCostQuote");
    requirePositive(input.baseReceived, "baseReceived");
    const reservation = await getReservation(tx, input.portfolioId, input.reservationId);
    if (reservation.bandId !== band.id) throw new Error("Reservation belongs to another grid band.");
    if (reservation.status === "UNKNOWN" && !input.reconcilesUnknown) {
      throw new Error("Unknown execution outcome must be explicitly reconciled during fill settlement.");
    }
    if (reservation.status !== "RESERVED" && reservation.status !== "UNKNOWN") {
      throw new Error("Capital reservation is already terminal.");
    }
    const reserved = toNumber(reservation.quoteAmount);
    if (input.cashQuoteDebited > reserved + 1e-8) throw new Error("Actual quote debit exceeds the durable reservation.");
    await tx.gridBand.update({ where: { id: band.id }, data: {
      availableQuoteAmount: { decrement: input.cashQuoteDebited }, reservedQuoteAmount: { decrement: reserved },
      deployedCostQuote: { increment: input.acquiredCostQuote },
    } });
    await tx.capitalReservation.update({ where: { id: reservation.id }, data: {
      status: "SETTLED", executionId: input.executionId, unknownReason: null,
    } });
    await upsertLotExitCommitmentInTransaction(tx, { bandId: band.id, ...input.exitCommitment });
    result = { applied: true, principalReturnedQuote: 0, profitSweptQuote: 0, portfolioCreditQuote: 0,
      lossRealizedQuote: 0, retainedBaseAmount: 0 };
    await tx.capitalLedgerEntry.create({ data: {
      portfolioId: input.portfolioId, assetStrategyId: band.assetStrategyId, bandId: band.id,
      reservationId: reservation.id, entryType: "BUY_SETTLEMENT", idempotencyKey: input.idempotencyKey,
      executionId: input.executionId, bandAvailableQuoteDelta: -input.cashQuoteDebited, bandReservedQuoteDelta: -reserved,
      bandDeployedCostDelta: input.acquiredCostQuote, externalFeeQuoteDelta: externalFeeQuote,
      reason: "Atomic buy fill settlement", metadata: result as unknown as Prisma.InputJsonValue,
    } });
  } else {
    requirePositive(input.costBasisReleased, "costBasisReleased");
    requireNonnegative(input.netQuoteReceived, "netQuoteReceived");
    requireNonnegative(input.retainedBaseAmount, "retainedBaseAmount");
    if (input.costBasisReleased > toNumber(band.deployedCostQuote) + 1e-8) {
      throw new Error("Released lot cost exceeds the band deployed cost ledger.");
    }
    const commitment = await tx.lotExitCommitment.findUnique({ where: { lotId: input.lotId } });
    if (!commitment || commitment.bandId !== band.id) throw new Error("Sell fill has no durable lot exit commitment for this band.");
    if (commitment.fulfilledAt) throw new Error("Lot exit commitment is already fulfilled by another settlement.");
    const principalReturned = Math.min(input.netQuoteReceived, input.costBasisReleased);
    const grossExcess = Math.max(0, input.netQuoteReceived - input.costBasisReleased);
    const profit = Math.max(0, grossExcess - externalFeeQuote);
    const feeAllowance = grossExcess - profit;
    const loss = Math.max(0, input.costBasisReleased - input.netQuoteReceived);
    await tx.gridBand.update({ where: { id: band.id }, data: {
      availableQuoteAmount: { increment: principalReturned + feeAllowance },
      deployedCostQuote: { decrement: input.costBasisReleased }, realizedLossQuote: { increment: loss },
    } });
    await tx.portfolio.update({ where: { id: input.portfolioId }, data: {
      freeQuoteAmount: { increment: profit }, version: { increment: 1 },
    } });
    if (input.retainedBaseAmount > 0) {
      await tx.assetStrategy.update({ where: { id: band.assetStrategyId }, data: {
        retainedBaseAmount: { increment: input.retainedBaseAmount },
      } });
    }
    if (input.lotClosed !== false) {
      await tx.lotExitCommitment.update({ where: { id: commitment.id }, data: { fulfilledAt: new Date() } });
    }
    result = { applied: true, principalReturnedQuote: principalReturned, profitSweptQuote: profit,
      portfolioCreditQuote: profit, lossRealizedQuote: loss, retainedBaseAmount: input.retainedBaseAmount };
    await tx.capitalLedgerEntry.create({ data: {
      portfolioId: input.portfolioId, assetStrategyId: band.assetStrategyId, bandId: band.id,
      entryType: "SELL_SETTLEMENT", idempotencyKey: input.idempotencyKey, executionId: input.executionId,
      bandAvailableQuoteDelta: principalReturned + feeAllowance,
      bandDeployedCostDelta: -input.costBasisReleased,
      externalFeeQuoteDelta: externalFeeQuote, reason: "Atomic sell fill settlement and net profit sweep",
      metadata: result as unknown as Prisma.InputJsonValue,
    } });
    if (profit > 0) await tx.capitalLedgerEntry.create({ data: {
      portfolioId: input.portfolioId, assetStrategyId: band.assetStrategyId, bandId: band.id,
      entryType: "PROFIT_SWEEP", idempotencyKey: `${input.idempotencyKey}:profit`, executionId: input.executionId,
      portfolioFreeQuoteDelta: profit, reason: "Net USDC profit attribution (informational split; balance applied by settlement)",
      metadata: { balanceAppliedBy: input.idempotencyKey },
    } });
    if (input.retainedBaseAmount > 0) await tx.capitalLedgerEntry.create({ data: {
      portfolioId: input.portfolioId, assetStrategyId: band.assetStrategyId, bandId: band.id,
      entryType: "RETAINED_BASE", idempotencyKey: `${input.idempotencyKey}:retained`, executionId: input.executionId,
      strategyRetainedBaseDelta: input.retainedBaseAmount,
      reason: "Base retained separately from trading lots (informational split; balance applied by settlement)",
      metadata: { balanceAppliedBy: input.idempotencyKey },
    } });
  }
  if (input.side === "buy") {
    await tx.portfolio.update({ where: { id: input.portfolioId }, data: { version: { increment: 1 } } });
  }
  return result;
}

export async function upsertLotExitCommitmentInTransaction(tx: Tx, input: ExitCommitmentInput & { bandId: string }) {
  validateCommitment(input);
  const existing = await tx.lotExitCommitment.findUnique({ where: { lotId: input.lotId } });
  if (existing) {
    const same = existing.bandId === input.bandId && existing.targetStatus === input.targetStatus &&
      existing.buyLevelIndex === input.buyLevelIndex && existing.sellLevelIndex === input.sellLevelIndex &&
      nullableNumber(existing.buyTargetPrice) === input.buyTargetPrice && nullableNumber(existing.sellTargetPrice) === input.sellTargetPrice &&
      existing.economicRule === input.economicRule && existing.originRevisionId === input.originRevisionId &&
      existing.maxAdverseDriftBps === input.maxAdverseDriftBps;
    if (!same) throw new Error("A lot exit commitment already exists with different immutable economic terms.");
    return existing;
  }
  return tx.lotExitCommitment.create({ data: {
    bandId: input.bandId, lotId: input.lotId, targetStatus: input.targetStatus,
    buyLevelIndex: input.buyLevelIndex, sellLevelIndex: input.sellLevelIndex,
    buyTargetPrice: input.buyTargetPrice, sellTargetPrice: input.sellTargetPrice,
    economicRule: input.economicRule as never, originRevisionId: input.originRevisionId,
    maxAdverseDriftBps: input.maxAdverseDriftBps,
  } });
}

const contextInclude = {
  assetStrategy: { include: { portfolio: true } },
  bot: { select: { executionAttempt: { select: { executionId: true, uncertain: true } }, systemLogs: {
    where: { category: "portfolio_policy", metadata: { path: ["completeObservation"], equals: true } },
    orderBy: { createdAt: "desc" as const }, take: 1, select: { metadata: true } } } },
  revisions: { orderBy: { sequence: "desc" as const }, take: 1 },
  exitCommitments: { orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.GridBandInclude;

async function mapBandContext(client: DbClient, band: Prisma.GridBandGetPayload<{ include: typeof contextInclude }>): Promise<BandExecutionContext> {
  const revision = band.revisions[0];
  if (!revision) throw new Error(`Grid band ${band.id} has no revision.`);
  const unknownReservation = await client.capitalReservation.findFirst({
    where: { portfolioId: band.assetStrategy.portfolioId, status: "UNKNOWN" }, select: { id: true },
  });
  const unknownTarget = band.exitCommitments.some((entry) => entry.targetStatus === "UNKNOWN" && !entry.fulfilledAt);
  return {
    portfolio: mapPortfolio(band.assetStrategy.portfolio),
    strategy: mapStrategy(band.assetStrategy),
    band: {
      lastPolicyObservedAt: policyObservationDate(band.bot.systemLogs?.[0]?.metadata),
      id: band.id, botId: band.botId, status: band.status,
      allocatedQuoteAmount: toNumber(band.allocatedQuoteAmount), availableQuoteAmount: toNumber(band.availableQuoteAmount),
      reservedQuoteAmount: toNumber(band.reservedQuoteAmount), deployedCostQuote: toNumber(band.deployedCostQuote),
      realizedLossQuote: toNumber(band.realizedLossQuote), activeRevision: mapRevision(revision),
    },
    exitCommitments: band.exitCommitments.map(mapCommitment),
    capitalBlockedReason: unknownReservation ? `Reservation ${unknownReservation.id} requires reconciliation.` :
      band.bot.executionAttempt ? `Execution ${band.bot.executionAttempt.executionId} requires settlement or reconciliation.` :
      unknownTarget ? "An open lot has an unknown absolute exit target." : null,
  };
}

function policyObservationDate(metadata: unknown): Date | null {
  const value = (metadata as { observedAt?: unknown } | null)?.observedAt;
  if (typeof value !== "string") return null;
  const date = new Date(value); return Number.isFinite(+date) ? date : null;
}

async function lockPortfolio(tx: Tx, portfolioId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM portfolios WHERE id = ${portfolioId} FOR UPDATE`);
  if (!rows[0]) throw new Error("Portfolio does not exist.");
  return tx.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
}

async function lockBot(tx: Tx, botId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM bots WHERE id = ${botId} FOR UPDATE`);
  if (!rows[0]) throw new Error("Bot does not exist.");
}

async function lockBandBot(tx: Tx, bandId: string) {
  const band = await tx.gridBand.findUnique({ where: { id: bandId }, select: { botId: true } });
  if (!band) throw new Error("Grid band does not exist.");
  await lockBot(tx, band.botId);
}

async function assertPortfolioUnblocked(tx: Tx, portfolioId: string) {
  const unknown = await tx.capitalReservation.findFirst({ where: { portfolioId, status: "UNKNOWN" }, select: { id: true } });
  if (unknown) throw new Error(`Portfolio capital is blocked until reservation ${unknown.id} is reconciled.`);
}

async function getReservation(tx: Tx, portfolioId: string, reservationId: string) {
  const reservation = await tx.capitalReservation.findFirst({ where: { id: reservationId, portfolioId } });
  if (!reservation) throw new Error("Capital reservation does not belong to the portfolio.");
  return reservation;
}

function mapPortfolio(row: { id: string; mode: unknown; walletIdentity: string; quoteMint: string; freeQuoteAmount: unknown;
  version: number; autoLive: boolean; createdAt: Date; updatedAt: Date }): PortfolioRecord {
  return { id: row.id, mode: row.mode as PortfolioRecord["mode"], walletIdentity: row.walletIdentity,
    quoteMint: row.quoteMint, freeQuoteAmount: toNumber(row.freeQuoteAmount), version: row.version,
    autoLive: row.autoLive, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function mapStrategy(row: { id: string; portfolioId: string; baseMint: string; baseSymbol: string; objective: unknown;
  allocationPolicy: string; allocatedQuoteAmount: unknown; retainedBaseAmount: unknown }): AssetStrategyRecord {
  if (row.allocationPolicy !== "equal") throw new Error("Unsupported asset allocation policy.");
  return { id: row.id, portfolioId: row.portfolioId, baseMint: row.baseMint, baseSymbol: row.baseSymbol,
    objective: row.objective as AssetStrategyRecord["objective"], allocationPolicy: "equal",
    allocatedQuoteAmount: toNumber(row.allocatedQuoteAmount), retainedBaseAmount: toNumber(row.retainedBaseAmount) };
}

function mapRevision(row: { id: string; bandId: string; sequence: number; lowPrice: unknown; highPrice: unknown;
  levelCount: number; gridType: unknown; reason: string; observedAt: Date; snapshotId: string | null; createdAt: Date }): GridRevisionRecord {
  return { id: row.id, bandId: row.bandId, sequence: row.sequence, lowPrice: toNumber(row.lowPrice),
    highPrice: toNumber(row.highPrice), levelCount: row.levelCount, gridType: row.gridType as GridRevisionRecord["gridType"],
    reason: row.reason, observedAt: row.observedAt, snapshotId: row.snapshotId, createdAt: row.createdAt };
}

function mapCommitment(row: { id: string; bandId: string; lotId: string; targetStatus: unknown; buyLevelIndex: number | null;
  sellLevelIndex: number | null; buyTargetPrice: unknown; sellTargetPrice: unknown; economicRule: unknown;
  originRevisionId: string; maxAdverseDriftBps: number; fulfilledAt: Date | null; createdAt: Date }): LotExitCommitmentRecord {
  return { id: row.id, bandId: row.bandId, lotId: row.lotId, targetStatus: row.targetStatus as LotExitCommitmentRecord["targetStatus"],
    buyLevelIndex: row.buyLevelIndex, sellLevelIndex: row.sellLevelIndex, buyTargetPrice: nullableNumber(row.buyTargetPrice),
    sellTargetPrice: nullableNumber(row.sellTargetPrice), economicRule: row.economicRule as LotExitCommitmentRecord["economicRule"],
    originRevisionId: row.originRevisionId, maxAdverseDriftBps: row.maxAdverseDriftBps,
    fulfilledAt: row.fulfilledAt, createdAt: row.createdAt };
}

function mapReservation(row: { id: string; portfolioId: string; bandId: string; quoteAmount: unknown; status: unknown;
  idempotencyKey: string; executionId: string | null; unknownReason: string | null; createdAt: Date; updatedAt: Date }): CapitalReservationRecord {
  return { id: row.id, portfolioId: row.portfolioId, bandId: row.bandId, quoteAmount: toNumber(row.quoteAmount),
    status: row.status as CapitalReservationRecord["status"], idempotencyKey: row.idempotencyKey,
    executionId: row.executionId, unknownReason: row.unknownReason, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function settlementResult(metadata: unknown, applied: boolean): PortfolioFillSettlementResult {
  const value = metadata && typeof metadata === "object" ? metadata as Partial<PortfolioFillSettlementResult> : {};
  return { applied, principalReturnedQuote: Number(value.principalReturnedQuote ?? 0),
    profitSweptQuote: Number(value.profitSweptQuote ?? 0), portfolioCreditQuote: Number(value.portfolioCreditQuote ?? 0),
    lossRealizedQuote: Number(value.lossRealizedQuote ?? 0), retainedBaseAmount: Number(value.retainedBaseAmount ?? 0) };
}

function objectiveForBot(baseSymbol: string, objective: string): "accumulate_base" | "accumulate_usdc" {
  if (objective !== "accumulate_base" && objective !== "accumulate_usdc") {
    throw new Error("V2 portfolios do not adopt balanced asset strategies.");
  }
  const symbol = baseSymbol.toUpperCase();
  if (symbol === "BTC" && objective !== "accumulate_base") throw new Error("BTC V2 strategy must accumulate base.");
  if (symbol === "SOL" && objective !== "accumulate_usdc") throw new Error("SOL V2 strategy must accumulate USDC.");
  return objective;
}

function calculateLevels(low: number, high: number, count: number, gridType: string): number[] {
  if (!(low > 0) || !(high > low) || count < 2) throw new Error("Persisted bot grid is invalid.");
  return Array.from({ length: count }, (_, index) => gridType === "geometric"
    ? low * Math.pow(high / low, index / (count - 1))
    : low + (high - low) * index / (count - 1));
}

function readGridCycles(metadata: unknown): Record<string, { lotId: string; buyLevelIndex: number; sellLevelIndex: number | null }> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const raw = (metadata as Record<string, unknown>).gridCycles;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, { lotId: string; buyLevelIndex: number; sellLevelIndex: number | null }> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const cycle = value as Record<string, unknown>;
    if (typeof cycle.lotId !== "string" || !Number.isInteger(cycle.buyLevelIndex) ||
      !(cycle.sellLevelIndex === null || Number.isInteger(cycle.sellLevelIndex))) continue;
    result[key] = { lotId: cycle.lotId, buyLevelIndex: cycle.buyLevelIndex as number, sellLevelIndex: cycle.sellLevelIndex as number | null };
  }
  return result;
}

function validateRevision(input: ReviseGridBandInput) {
  requireText(input.reason, "reason");
  requirePositive(input.lowPrice, "lowPrice");
  requirePositive(input.highPrice, "highPrice");
  if (input.highPrice <= input.lowPrice) throw new Error("highPrice must be above lowPrice.");
  if (!Number.isInteger(input.levelCount) || input.levelCount < 2) throw new Error("levelCount must be an integer of at least two.");
}

function validateCommitment(input: ExitCommitmentInput) {
  requireText(input.lotId, "lotId");
  if (!Number.isInteger(input.maxAdverseDriftBps) || input.maxAdverseDriftBps < 0) {
    throw new Error("maxAdverseDriftBps must be a nonnegative integer.");
  }
  if (input.targetStatus === "KNOWN") {
    if (!Number.isInteger(input.buyLevelIndex) || !Number.isInteger(input.sellLevelIndex)) {
      throw new Error("Known lot targets require absolute buy and sell level indexes.");
    }
    if (input.buyTargetPrice === null || input.sellTargetPrice === null) throw new Error("Known lot targets require absolute prices.");
    requirePositive(input.buyTargetPrice, "buyTargetPrice");
    requirePositive(input.sellTargetPrice, "sellTargetPrice");
  }
}

function requireText(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} is required.`);
}
function requirePositive(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be a positive finite number.`);
}
function requireNonnegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a nonnegative finite number.`);
}
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}
function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}
function sum(values: number[]) { return values.reduce((total, value) => total + value, 0); }
