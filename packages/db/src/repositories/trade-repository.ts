import { BotStatus, ExecutionStatus, TradeSide, type TradeRepository, type PendingExecutionAttempt, type ExecutionCommit } from "@grid-bot/core";
import type { ExecutionReport, PositionLot } from "@grid-bot/core";
import { Prisma } from "@prisma/client";

import { prisma } from "../client";
import { jsonValue, lotData, publicReport, stateSnapshotData } from "./execution-persistence-data";
import { preserveOperatorStatus } from "./bot-state-repository";
import {
  releasePortfolioReservationInTransaction,
  reservePortfolioCapitalInTransaction,
  settlePortfolioFillInTransaction,
} from "./portfolio-repository";

type DurablePortfolioContext = {
  portfolioId: string;
  bandId: string;
  assetStrategyId: string;
  reservationId?: string;
  revisionId: string;
  objective: "accumulate_base" | "accumulate_usdc";
  buyLevelIndex: number;
  sellLevelIndex: number | null;
  buyTargetPrice: number;
  sellTargetPrice: number | null;
  maxAdverseDriftBps: number;
  soldLot?: { id: string; remainingBaseAmount: number; costQuote: number };
};

type DurableAttempt = PendingExecutionAttempt & { portfolioContext?: DurablePortfolioContext };

export class PrismaTradeRepository implements TradeRepository {
  async getPendingExecution(botId: string): Promise<PendingExecutionAttempt | null> {
    const row = await prisma.executionAttempt.findUnique({ where: { botId } });
    if (row) return restoreAttempt(row);
    await assertNoLegacyPending(prisma, botId);
    return null;
  }

  async prepareExecutionAttempt(input: Omit<PendingExecutionAttempt, "executionId" | "orderId">): Promise<PendingExecutionAttempt> {
    if (input.orderIntent.botId !== input.botId || input.executionParams.botId !== input.botId || !input.preparedExecution) {
      throw new Error("Invalid durable execution preparation.");
    }
    return prisma.$transaction(async (tx) => {
      const bots = await tx.$queryRaw<Array<{ status: BotStatus; mode: "paper" | "live"; executionProvider: "jupiter" | "paper" | "dflow";
        baseMint: string; quoteMint: string }>>(
        Prisma.sql`SELECT status, mode, "executionProvider", "baseMint", "quoteMint" FROM bots WHERE id = ${input.botId} AND archived_at IS NULL FOR UPDATE`
      );
      const bot = bots[0];
      if (!bot) throw new Error("Bot no longer exists or has been archived.");
      const existing = await tx.executionAttempt.findUnique({ where: { botId: input.botId } });
      if (existing) return restoreAttempt(existing);
      const latestSnapshot = await tx.botStateSnapshot.findFirst({ where: { botId: input.botId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      if ((bot.mode === "live" && input.expectedSnapshotId === undefined) ||
        (input.expectedSnapshotId !== undefined && input.expectedSnapshotId !== (latestSnapshot?.id ?? null))) {
        throw new Error("Bot accounting changed since quote preparation; discard this stale preparation and reload state.");
      }
      await assertNoLegacyPending(tx, input.botId);
      if ([BotStatus.Paused, BotStatus.Stopped].includes(bot.status)) throw new Error("Bot paused or stopped before execution preparation.");
      const portfolioContext = await preparePortfolioContext(tx, input, bot);
      const { matchedLotIds: _matchedLotIds, ...orderData } = input.orderIntent;
      const order = await tx.order.create({ data: { ...orderData, side: orderData.side as never, status: "created" } });
      const raw = input.preparedExecution!.rawQuote as { txId?: unknown } | undefined;
      const execution = await tx.execution.create({ data: {
        botId: input.botId, orderId: order.id, mode: bot.mode, provider: bot.mode === "paper" ? "paper" : bot.executionProvider,
        status: "pending", executionRef: input.preparedExecution!.requestId ?? orderData.orderKey,
        txId: typeof raw?.txId === "string" ? raw.txId : null,
        quotePrice: input.preparedExecution!.expectedPrice,
        expectedOutputAmount: input.preparedExecution!.expectedOutputAmount,
        expectedFeeAmount: input.preparedExecution!.estimatedFeeAmount,
        // Signed authorization is restricted to execution_attempts.payload.
        rawReport: { durablePreparation: true },
      } });
      if (portfolioContext?.reservationId) {
        await tx.capitalReservation.update({ where: { id: portfolioContext.reservationId }, data: { executionId: execution.id } });
      }
      const attempt: DurableAttempt = { ...input, executionId: execution.id, orderId: order.id, result: null, wasUncertain: false,
        ...(portfolioContext ? { portfolioContext } : {}) };
      await tx.executionAttempt.create({ data: { botId: input.botId, executionId: execution.id, orderId: order.id,
        payload: jsonValue({ ...attempt, result: undefined, wasUncertain: undefined }) } });
      return attempt;
    });
  }

  async saveExecutionResult(attempt: PendingExecutionAttempt, report: ExecutionReport, uncertain: boolean): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM bots WHERE id = ${attempt.botId} FOR UPDATE`);
      const stored = await tx.executionAttempt.findUnique({ where: { botId: attempt.botId } });
      if (!stored || stored.executionId !== attempt.executionId || stored.orderId !== attempt.orderId) {
        throw new Error("Durable execution attempt does not match the result.");
      }
      const execution = await tx.execution.findUnique({ where: { id: attempt.executionId } });
      if (!execution || execution.botId !== attempt.botId) throw new Error("Execution identity mismatch.");
      assertPermittedTerminal(report.status, execution.mode);
      const previous = stored.result as unknown as ExecutionReport | null;
      // A late timeout from another process must not erase a confirmed result.
      if (previous && isTerminal(previous.status, execution.mode === "paper")) {
        if (!isTerminal(report.status, execution.mode === "paper")) return;
        if (previous.status !== report.status || previous.txId !== report.txId ||
          previous.inputAmount !== report.inputAmount || previous.outputAmount !== report.outputAmount) {
          throw new Error("Conflicting terminal execution result; manual reconciliation required.");
        }
      }
      const raw = (stored.payload as unknown as PendingExecutionAttempt).preparedExecution?.rawQuote as { txId?: string } | undefined;
      const result = { ...report, executionId: attempt.executionId, txId: report.txId ?? previous?.txId ?? raw?.txId ?? null,
        rawReport: publicReport(report.rawReport) };
      await tx.executionAttempt.update({ where: { botId: attempt.botId }, data: {
        result: jsonValue(result), uncertain: uncertain || !isTerminal(report.status, execution.mode === "paper"),
      } });
      await tx.execution.update({ where: { id: attempt.executionId }, data: {
        status: result.status as never, txId: result.txId,
        rawReport: publicReport(result.rawReport),
        // completedAt is set only with the accounting commit below.
      } });
      if (!isTerminal(report.status, execution.mode === "paper") &&
        (stored.payload as unknown as DurableAttempt).portfolioContext?.reservationId) {
        await markPortfolioReservationUnknown(tx, stored.payload as unknown as DurableAttempt, attempt.executionId);
      }
    });
  }

  async commitExecution(input: ExecutionCommit): Promise<boolean> {
    if (!isTerminal(input.report.status, true) || input.position.botId !== input.botId || input.snapshot.botId !== input.botId) {
      throw new Error("Only a matching terminal execution can be committed.");
    }
    return prisma.$transaction(async (tx) => {
      const bots = await tx.$queryRaw<Array<{ status: BotStatus }>>(
        Prisma.sql`SELECT status FROM bots WHERE id = ${input.botId} FOR UPDATE`
      );
      if (!bots[0]) throw new Error("Bot no longer exists.");
      const execution = await tx.execution.findUnique({ where: { id: input.executionId } });
      if (!execution || execution.botId !== input.botId || execution.orderId !== input.orderId) throw new Error("Execution identity mismatch.");
      assertPermittedTerminal(input.report.status, execution.mode);
      if (execution.completedAt) return false;
      const stored = await tx.executionAttempt.findUnique({ where: { botId: input.botId } });
      if (!stored || stored.executionId !== input.executionId || stored.orderId !== input.orderId) throw new Error("Matching durable attempt is missing.");
      const confirmed = stored.result as unknown as ExecutionReport | null;
      if (!confirmed || confirmed.status !== input.report.status || confirmed.txId !== input.report.txId ||
        confirmed.inputAmount !== input.report.inputAmount || confirmed.outputAmount !== input.report.outputAmount) {
        throw new Error("Accounting result does not match the saved terminal execution.");
      }
      const changed = await tx.execution.updateMany({ where: { id: input.executionId, completedAt: null }, data: {
        status: input.report.status as never, completedAt: new Date(), txId: input.report.txId ?? null,
        quotePrice: input.report.effectivePrice || execution.quotePrice,
        executedInputAmount: input.report.inputAmount, executedOutputAmount: input.report.outputAmount,
        executedFeeAmount: input.report.feeAmount, rawReport: publicReport(input.report.rawReport),
      } });
      if (!changed.count) return false;
      const durableAttempt = stored.payload as unknown as DurableAttempt;
      const settlement = durableAttempt.portfolioContext
        ? await settlePortfolioExecution(tx, durableAttempt, input)
        : null;
      const config = await tx.botConfig.findUniqueOrThrow({ where: { botId: input.botId } });
      await tx.positionLot.deleteMany({ where: { botId: input.botId } });
      if (input.lots.length) await tx.positionLot.createMany({ data: input.lots.map((lot) => lotData(input.botId, lot)) });
      await tx.position.upsert({ where: { botId: input.botId }, create: input.position, update: input.position });
      const status = preserveOperatorStatus(bots[0].status, input.snapshot.status);
      const sweptProfit = settlement?.profitSweptQuote ?? 0;
      const snapshot = { ...input.snapshot, status,
        availableQuoteAmount: input.snapshot.availableQuoteAmount - sweptProfit,
        totalEquityUsd: input.snapshot.totalEquityUsd - sweptProfit };
      await tx.inventorySnapshot.create({ data: { botId: input.botId, baseAmount: snapshot.availableBaseAmount,
        quoteAmount: snapshot.availableQuoteAmount, reservedBaseAmount: 0, reservedQuoteAmount: config.reserveQuoteAmount,
        averageCost: snapshot.averageEntryPrice } });
      await tx.pnlSnapshot.create({ data: { botId: input.botId, realizedPnlUsd: snapshot.realizedPnlUsd,
        unrealizedPnlUsd: snapshot.unrealizedPnlUsd, totalPnlUsd: snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd,
        equityUsd: snapshot.totalEquityUsd, price: snapshot.currentPrice ?? input.report.effectivePrice } });
      await tx.botStateSnapshot.create({ data: stateSnapshotData(snapshot) });
      await tx.bot.update({ where: { id: input.botId }, data: { status: status as never, currentPrice: snapshot.currentPrice } });
      await tx.order.update({ where: { id: input.orderId }, data: { status: input.report.status === ExecutionStatus.Failed ? "failed" :
        input.report.status === ExecutionStatus.Simulated ? "simulated" : "filled" } });
      await tx.executionAttempt.delete({ where: { botId: input.botId } });
      return true;
    });
  }

  async createOrder(order: Parameters<TradeRepository["createOrder"]>[0]) {
    const created = await prisma.order.create({
      data: {
        botId: order.botId,
        orderKey: order.orderKey,
        side: order.side as never,
        levelIndex: order.levelIndex,
        targetPrice: order.targetPrice,
        requestedBaseAmount: order.requestedBaseAmount,
        requestedQuoteAmount: order.requestedQuoteAmount,
        status: order.status as never,
        reason: order.reason
      }
    });

    return { id: created.id };
  }

  async markOrderStatus(orderId: string, status: string, reason?: string | null) {
    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: status as never,
        reason: reason ?? undefined
      }
    });
  }

  async createExecution(record: Parameters<TradeRepository["createExecution"]>[0]) {
    const created = await prisma.execution.create({
      data: {
        orderId: record.orderId,
        botId: record.botId,
        provider: record.provider as never,
        mode: record.mode as never,
        status: record.status as never,
        executionRef: record.executionRef,
        txId: record.txId ?? undefined,
        quotePrice: record.quotePrice ?? undefined,
        expectedOutputAmount: record.expectedOutputAmount ?? undefined,
        expectedFeeAmount: record.expectedFeeAmount ?? undefined,
        executedInputAmount: record.executedInputAmount ?? undefined,
        executedOutputAmount: record.executedOutputAmount ?? undefined,
        executedFeeAmount: record.executedFeeAmount ?? undefined,
        errorCode: record.errorCode ?? undefined,
        errorMessage: record.errorMessage ?? undefined,
        rawReport: record.rawReport ? publicReport(record.rawReport) : undefined,
        completedAt: record.completedAt ?? undefined
      }
    });

    return { id: created.id };
  }

  async finalizeExecution(executionId: string, report: ExecutionReport, error?: { code?: string; message: string } | null) {
    await prisma.execution.update({
      where: { id: executionId },
      data: {
        status: report.status as never,
        txId: report.txId ?? undefined,
        quotePrice: report.effectivePrice || undefined,
        executedInputAmount: report.inputAmount,
        executedOutputAmount: report.outputAmount,
        executedFeeAmount: report.feeAmount,
        errorCode: error?.code,
        errorMessage: error?.message,
        rawReport: report.rawReport ? publicReport(report.rawReport) : undefined,
        completedAt: new Date()
      }
    });
  }

  async upsertPosition(position: Parameters<TradeRepository["upsertPosition"]>[0]) {
    await prisma.position.upsert({
      where: { botId: position.botId },
      update: {
        baseAmount: position.baseAmount,
        quoteSpent: position.quoteSpent,
        averageEntryPrice: position.averageEntryPrice,
        realizedPnlUsd: position.realizedPnlUsd,
        unrealizedPnlUsd: position.unrealizedPnlUsd,
        totalFeesQuote: position.totalFeesQuote
      },
      create: {
        botId: position.botId,
        baseAmount: position.baseAmount,
        quoteSpent: position.quoteSpent,
        averageEntryPrice: position.averageEntryPrice,
        realizedPnlUsd: position.realizedPnlUsd,
        unrealizedPnlUsd: position.unrealizedPnlUsd,
        totalFeesQuote: position.totalFeesQuote
      }
    });
  }

  async replaceLots(botId: string, lots: PositionLot[]) {
    await prisma.$transaction([
      prisma.positionLot.deleteMany({ where: { botId } }),
      ...(lots.length
        ? [
            prisma.positionLot.createMany({
              data: lots.map((lot) => lotData(botId, lot))
            })
          ]
        : [])
    ]);
  }

  async createInventorySnapshot(input: Parameters<TradeRepository["createInventorySnapshot"]>[0]) {
    await prisma.inventorySnapshot.create({
      data: {
        botId: input.botId,
        baseAmount: input.baseAmount,
        quoteAmount: input.quoteAmount,
        reservedBaseAmount: input.reservedBaseAmount,
        reservedQuoteAmount: input.reservedQuoteAmount,
        averageCost: input.averageCost ?? undefined
      }
    });
  }

  async createPnlSnapshot(input: Parameters<TradeRepository["createPnlSnapshot"]>[0]) {
    await prisma.pnlSnapshot.create({
      data: {
        botId: input.botId,
        realizedPnlUsd: input.realizedPnlUsd,
        unrealizedPnlUsd: input.unrealizedPnlUsd,
        totalPnlUsd: input.totalPnlUsd,
        equityUsd: input.equityUsd,
        price: input.price
      }
    });
  }
}

async function preparePortfolioContext(
  tx: Prisma.TransactionClient,
  input: Omit<PendingExecutionAttempt, "executionId" | "orderId">,
  bot: { mode: "paper" | "live"; baseMint: string; quoteMint: string },
): Promise<DurablePortfolioContext | undefined> {
  const band = await tx.gridBand.findUnique({
    where: { botId: input.botId },
    include: {
      assetStrategy: { include: { portfolio: true } },
      revisions: { orderBy: { sequence: "desc" }, take: 1 },
    },
  });
  if (!band) return undefined;
  const revision = band.revisions[0];
  if (!revision) throw new Error("Portfolio grid band has no active revision.");
  const portfolio = band.assetStrategy.portfolio;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM portfolios WHERE id = ${portfolio.id} FOR UPDATE`);
  if (portfolio.mode !== bot.mode || portfolio.quoteMint !== bot.quoteMint || band.assetStrategy.baseMint !== bot.baseMint) {
    throw new Error("Bot assets or mode no longer match the attached portfolio.");
  }

  if (input.signal.side === TradeSide.Buy) {
    if (band.status !== "ACTIVE") throw new Error("Only an active grid band can prepare a new entry.");
    const latestSnapshot = await tx.botStateSnapshot.findFirst({
      where: { botId: input.botId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const observedRevision = input.signal.gridRevisionId ??
      (latestSnapshot?.metadata as { gridRevisionId?: string } | null | undefined)?.gridRevisionId;
    if (observedRevision !== revision.id) {
      throw new Error("Grid revision changed since the entry signal was observed.");
    }
    const unresolvedTarget = await tx.lotExitCommitment.findFirst({
      where: { bandId: band.id, targetStatus: "UNKNOWN", fulfilledAt: null }, select: { id: true },
    });
    if (unresolvedTarget) throw new Error("New entries are blocked until every open lot has a known exit target.");
    const levels = calculateRevisionLevels(revision);
    const buyTarget = levels[input.signal.levelIndex];
    const sellTarget = levels[input.signal.levelIndex + 1] ?? null;
    if (buyTarget === undefined || !sameAmount(input.orderIntent.targetPrice, buyTarget)) {
      throw new Error("Entry target does not belong to the active grid revision.");
    }
    await assertNoDuplicateAssetExposure(tx, band.assetStrategyId, buyTarget, revisionSpacing(levels));
    const quoteAmount = input.preparedExecution!.inputAmount +
      (input.preparedExecution!.nativeFeeSymbol === "SOL" ? 0 : input.preparedExecution!.estimatedFeeAmount);
    const reservation = await reservePortfolioCapitalInTransaction(tx, {
      portfolioId: portfolio.id, bandId: band.id, quoteAmount,
      idempotencyKey: `execution-reservation:${input.orderIntent.orderKey}`,
      reason: `Durable buy reservation for ${input.orderIntent.orderKey}`,
    });
    return {
      portfolioId: portfolio.id, bandId: band.id, assetStrategyId: band.assetStrategyId,
      reservationId: reservation.id, revisionId: revision.id, objective: band.assetStrategy.objective as DurablePortfolioContext["objective"],
      buyLevelIndex: input.signal.levelIndex, sellLevelIndex: sellTarget === null ? null : input.signal.levelIndex + 1,
      buyTargetPrice: buyTarget, sellTargetPrice: sellTarget, maxAdverseDriftBps: input.executionParams.slippageBps,
    };
  }

  const lotId = input.signal.exitLotId ?? input.orderIntent.matchedLotIds?.[0];
  if (!lotId || input.orderIntent.matchedLotIds?.length !== 1) {
    throw new Error("A portfolio sell must identify exactly one committed lot.");
  }
  const commitment = await tx.lotExitCommitment.findUnique({ where: { lotId } });
  if (!commitment || commitment.bandId !== band.id || commitment.fulfilledAt || commitment.targetStatus !== "KNOWN" ||
    commitment.sellTargetPrice === null || !sameAmount(Number(commitment.sellTargetPrice), input.orderIntent.targetPrice) ||
    (input.signal.gridRevisionId !== undefined && input.signal.gridRevisionId !== commitment.originRevisionId)) {
    throw new Error("Sell target does not match the lot's immutable exit commitment.");
  }
  const soldLot = await tx.positionLot.findUnique({ where: { id: lotId } });
  if (!soldLot || soldLot.botId !== input.botId || soldLot.kind === "retained" || soldLot.closedAt || Number(soldLot.remainingBaseAmount) <= 0) {
    throw new Error("Committed sell lot is no longer open.");
  }
  return {
    portfolioId: portfolio.id, bandId: band.id, assetStrategyId: band.assetStrategyId,
    revisionId: commitment.originRevisionId, objective: commitment.economicRule as DurablePortfolioContext["objective"],
    buyLevelIndex: commitment.buyLevelIndex!, sellLevelIndex: commitment.sellLevelIndex,
    buyTargetPrice: Number(commitment.buyTargetPrice), sellTargetPrice: Number(commitment.sellTargetPrice),
    maxAdverseDriftBps: commitment.maxAdverseDriftBps,
    soldLot: { id: soldLot.id, remainingBaseAmount: Number(soldLot.remainingBaseAmount), costQuote: Number(soldLot.costQuote) },
  };
}

async function assertNoDuplicateAssetExposure(tx: Prisma.TransactionClient, assetStrategyId: string, targetPrice: number,
  currentSpacing: number): Promise<void> {
  const commitments = await tx.lotExitCommitment.findMany({
    where: { fulfilledAt: null, band: { assetStrategyId } },
    select: { buyTargetPrice: true, sellTargetPrice: true },
  });
  for (const commitment of commitments) {
    if (commitment.buyTargetPrice === null) continue;
    const oldTarget = Number(commitment.buyTargetPrice);
    const oldSpacing = commitment.sellTargetPrice === null ? 0 : Math.abs(Number(commitment.sellTargetPrice) - oldTarget);
    if (Math.abs(targetPrice - oldTarget) <= Math.max(currentSpacing, oldSpacing) / 2 + 1e-8) {
      throw new Error("A trading lot already occupies this asset price zone across a revision or band.");
    }
  }
  const pendingAttempts = await tx.executionAttempt.findMany({
    where: { bot: { gridBand: { assetStrategyId } } }, select: { payload: true },
  });
  for (const row of pendingAttempts) {
    const pending = row.payload as unknown as DurableAttempt;
    const context = pending.portfolioContext;
    if (!context?.reservationId || pending.signal?.side !== TradeSide.Buy) continue;
    const reservation = await tx.capitalReservation.findUnique({ where: { id: context.reservationId } });
    if (!reservation || (reservation.status !== "RESERVED" && reservation.status !== "UNKNOWN")) continue;
    const pendingSpacing = context.sellTargetPrice === null ? 0 : Math.abs(context.sellTargetPrice - context.buyTargetPrice);
    if (Math.abs(targetPrice - context.buyTargetPrice) <= Math.max(currentSpacing, pendingSpacing) / 2 + 1e-8) {
      throw new Error("A pending buy already reserves this asset price zone across another band.");
    }
  }
}

async function markPortfolioReservationUnknown(tx: Prisma.TransactionClient, attempt: DurableAttempt, executionId: string): Promise<void> {
  const context = attempt.portfolioContext;
  if (!context?.reservationId) return;
  await tx.$queryRaw(Prisma.sql`SELECT id FROM portfolios WHERE id = ${context.portfolioId} FOR UPDATE`);
  const reservation = await tx.capitalReservation.findUnique({ where: { id: context.reservationId } });
  if (!reservation || reservation.portfolioId !== context.portfolioId || reservation.executionId !== executionId) {
    throw new Error("Execution capital reservation identity mismatch.");
  }
  if (reservation.status === "UNKNOWN") return;
  if (reservation.status !== "RESERVED") throw new Error("A terminal capital reservation cannot become unknown.");
  const key = `execution-unknown:${executionId}`;
  await tx.capitalReservation.update({ where: { id: reservation.id }, data: {
    status: "UNKNOWN", unknownReason: "Execution outcome is not terminal; capital remains reserved.",
  } });
  await tx.capitalLedgerEntry.create({ data: {
    portfolioId: context.portfolioId, assetStrategyId: context.assetStrategyId, bandId: context.bandId,
    reservationId: reservation.id, entryType: "RECONCILIATION", idempotencyKey: key, executionId,
    reason: "Execution outcome is unknown; reservation preserved", metadata: { transition: "RESERVED_TO_UNKNOWN" },
  } });
  await tx.portfolio.update({ where: { id: context.portfolioId }, data: { version: { increment: 1 } } });
}

async function settlePortfolioExecution(tx: Prisma.TransactionClient, attempt: DurableAttempt, input: ExecutionCommit) {
  const context = attempt.portfolioContext!;
  if (input.report.status === ExecutionStatus.Failed) {
    if (!context.reservationId) return null;
    await restoreUnknownReservationForTerminalFailure(tx, context, input.executionId);
    await releasePortfolioReservationInTransaction(tx, {
      portfolioId: context.portfolioId, reservationId: context.reservationId,
      idempotencyKey: `execution-release:${input.executionId}`, reason: "Execution failed before a buy fill",
    });
    return null;
  }
  const externalFeeQuote = input.report.nativeFeeSymbol === "SOL" && (input.report.nativeFeeAmount ?? 0) > 0
    ? input.report.feeAmount : 0;
  const quoteDebitFee = Math.max(0, input.report.feeAmount - externalFeeQuote);
  if (attempt.signal.side === TradeSide.Buy) {
    if (!context.reservationId) throw new Error("Portfolio buy has no durable capital reservation.");
    const openedLot = input.lots.find((lot) => lot.openedByExecutionId === input.executionId && lot.kind !== "retained");
    if (!openedLot) throw new Error("Portfolio buy settlement is missing its acquired lot.");
    return settlePortfolioFillInTransaction(tx, {
      portfolioId: context.portfolioId, bandId: context.bandId, executionId: input.executionId,
      idempotencyKey: `execution-settlement:${input.executionId}`, side: "buy", reservationId: context.reservationId,
      cashQuoteDebited: input.report.inputAmount + quoteDebitFee, acquiredCostQuote: openedLot.costQuote,
      externalFeeQuote, baseReceived: input.report.outputAmount, reconcilesUnknown: true,
      exitCommitment: {
        lotId: openedLot.id, targetStatus: context.sellTargetPrice === null ? "UNKNOWN" : "KNOWN",
        buyLevelIndex: context.buyLevelIndex, sellLevelIndex: context.sellLevelIndex,
        buyTargetPrice: context.buyTargetPrice, sellTargetPrice: context.sellTargetPrice,
        economicRule: context.objective, originRevisionId: context.revisionId,
        maxAdverseDriftBps: context.maxAdverseDriftBps,
      },
    });
  }
  if (!context.soldLot) throw new Error("Portfolio sell is missing its prepared lot economics.");
  const remaining = input.lots.find((lot) => lot.id === context.soldLot!.id && lot.kind !== "retained");
  const costBasisReleased = context.soldLot.costQuote - (remaining?.costQuote ?? 0);
  const retainedBaseAmount = input.lots.filter((lot) => lot.kind === "retained" && lot.id.endsWith(`:retained:${input.executionId}`))
    .reduce((sum, lot) => sum + lot.remainingBaseAmount, 0);
  return settlePortfolioFillInTransaction(tx, {
    portfolioId: context.portfolioId, bandId: context.bandId, executionId: input.executionId,
    idempotencyKey: `execution-settlement:${input.executionId}`, side: "sell", lotId: context.soldLot.id,
    costBasisReleased, netQuoteReceived: Math.max(0, input.report.outputAmount - quoteDebitFee), externalFeeQuote,
    retainedBaseAmount, lotClosed: !remaining,
  });
}

async function restoreUnknownReservationForTerminalFailure(tx: Prisma.TransactionClient, context: DurablePortfolioContext,
  executionId: string): Promise<void> {
  const reservation = await tx.capitalReservation.findUnique({ where: { id: context.reservationId! } });
  if (!reservation || reservation.executionId !== executionId) throw new Error("Execution capital reservation identity mismatch.");
  if (reservation.status !== "UNKNOWN") return;
  await tx.capitalReservation.update({ where: { id: reservation.id }, data: { status: "RESERVED", unknownReason: null } });
  await tx.capitalLedgerEntry.create({ data: {
    portfolioId: context.portfolioId, assetStrategyId: context.assetStrategyId, bandId: context.bandId,
    reservationId: reservation.id, entryType: "RECONCILIATION", idempotencyKey: `execution-resolved-failed:${executionId}`,
    executionId, reason: "Unknown execution reconciled as failed before reservation release",
    metadata: { transition: "UNKNOWN_TO_RESERVED", resolution: "FAILED" },
  } });
}

function calculateRevisionLevels(revision: { lowPrice: unknown; highPrice: unknown; levelCount: number; gridType: string }): number[] {
  const low = Number(revision.lowPrice);
  const high = Number(revision.highPrice);
  if (revision.gridType === "arithmetic") {
    const step = (high - low) / (revision.levelCount - 1);
    return Array.from({ length: revision.levelCount }, (_, index) => round8(low + step * index));
  }
  const ratio = Math.pow(high / low, 1 / (revision.levelCount - 1));
  return Array.from({ length: revision.levelCount }, (_, index) => round8(low * ratio ** index));
}

function revisionSpacing(levels: number[]): number {
  let spacing = 0;
  for (let index = 1; index < levels.length; index += 1) spacing = Math.max(spacing, Math.abs(levels[index]! - levels[index - 1]!));
  return spacing;
}

function round8(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

function sameAmount(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-8;
}

function isTerminal(status: ExecutionStatus, includeSimulated = false): boolean {
  return status === ExecutionStatus.Filled || status === ExecutionStatus.Failed || (includeSimulated && status === ExecutionStatus.Simulated);
}

function assertPermittedTerminal(status: ExecutionStatus, mode: string): void {
  if (status === ExecutionStatus.Simulated && mode !== "paper") {
    throw new Error("A simulated execution is terminal only for paper mode.");
  }
}

async function assertNoLegacyPending(client: Pick<Prisma.TransactionClient, "execution">, botId: string) {
  const legacy = await client.execution.findFirst({ where: { botId, completedAt: null,
    status: { in: ["pending", "submitted", "unknown"] } }, select: { id: true } });
  if (legacy) throw new Error(`Unresolved legacy execution ${legacy.id} has no durable signed preparation; reconcile before trading.`);
}

function restoreAttempt(row: { botId: string; executionId: string; orderId: string; payload: unknown; result: unknown; uncertain: boolean }): PendingExecutionAttempt {
  const payload = row.payload as PendingExecutionAttempt;
  if (!payload || payload.botId !== row.botId || payload.executionId !== row.executionId || payload.orderId !== row.orderId ||
    !payload.signal || !payload.orderIntent || !payload.executionParams) throw new Error("Corrupt durable execution attempt; reconciliation required.");
  const triggeredAt = new Date(payload.signal.triggeredAt);
  if (!Number.isFinite(triggeredAt.getTime())) throw new Error("Invalid durable execution signal timestamp.");
  return { ...payload, signal: { ...payload.signal, triggeredAt }, result: row.result as ExecutionReport | null, wasUncertain: row.uncertain };
}
