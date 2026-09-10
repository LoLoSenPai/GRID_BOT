import { BotStatus, ExecutionStatus, type TradeRepository, type PendingExecutionAttempt, type ExecutionCommit } from "@grid-bot/core";
import type { ExecutionReport, PositionLot } from "@grid-bot/core";
import { Prisma } from "@prisma/client";

import { prisma } from "../client";
import { jsonValue, lotData, publicReport, stateSnapshotData } from "./execution-persistence-data";
import { preserveOperatorStatus } from "./bot-state-repository";

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
      const bots = await tx.$queryRaw<Array<{ status: BotStatus; mode: "paper" | "live"; executionProvider: "jupiter" | "paper" | "dflow" }>>(
        Prisma.sql`SELECT status, mode, "executionProvider" FROM bots WHERE id = ${input.botId} AND archived_at IS NULL FOR UPDATE`
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
      const attempt: PendingExecutionAttempt = { ...input, executionId: execution.id, orderId: order.id, result: null, wasUncertain: false };
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
      const previous = stored.result as unknown as ExecutionReport | null;
      // A late timeout from another process must not erase a confirmed result.
      if (previous && isTerminal(previous.status)) {
        if (!isTerminal(report.status)) return;
        if (previous.status !== report.status || previous.txId !== report.txId ||
          previous.inputAmount !== report.inputAmount || previous.outputAmount !== report.outputAmount) {
          throw new Error("Conflicting terminal execution result; manual reconciliation required.");
        }
      }
      const raw = (stored.payload as unknown as PendingExecutionAttempt).preparedExecution?.rawQuote as { txId?: string } | undefined;
      const result = { ...report, executionId: attempt.executionId, txId: report.txId ?? previous?.txId ?? raw?.txId ?? null,
        rawReport: publicReport(report.rawReport) };
      await tx.executionAttempt.update({ where: { botId: attempt.botId }, data: {
        result: jsonValue(result), uncertain: uncertain || !isTerminal(report.status),
      } });
      await tx.execution.update({ where: { id: attempt.executionId }, data: {
        status: result.status as never, txId: result.txId,
        rawReport: publicReport(result.rawReport),
        // completedAt is set only with the accounting commit below.
      } });
    });
  }

  async commitExecution(input: ExecutionCommit): Promise<boolean> {
    if (!isTerminal(input.report.status) || input.position.botId !== input.botId || input.snapshot.botId !== input.botId) {
      throw new Error("Only a matching terminal execution can be committed.");
    }
    return prisma.$transaction(async (tx) => {
      const bots = await tx.$queryRaw<Array<{ status: BotStatus }>>(
        Prisma.sql`SELECT status FROM bots WHERE id = ${input.botId} FOR UPDATE`
      );
      if (!bots[0]) throw new Error("Bot no longer exists.");
      const execution = await tx.execution.findUnique({ where: { id: input.executionId } });
      if (!execution || execution.botId !== input.botId || execution.orderId !== input.orderId) throw new Error("Execution identity mismatch.");
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
      const config = await tx.botConfig.findUniqueOrThrow({ where: { botId: input.botId } });
      await tx.positionLot.deleteMany({ where: { botId: input.botId } });
      if (input.lots.length) await tx.positionLot.createMany({ data: input.lots.map((lot) => lotData(input.botId, lot)) });
      await tx.position.upsert({ where: { botId: input.botId }, create: input.position, update: input.position });
      const status = preserveOperatorStatus(bots[0].status, input.snapshot.status);
      const snapshot = { ...input.snapshot, status };
      await tx.inventorySnapshot.create({ data: { botId: input.botId, baseAmount: snapshot.availableBaseAmount,
        quoteAmount: snapshot.availableQuoteAmount, reservedBaseAmount: 0, reservedQuoteAmount: config.reserveQuoteAmount,
        averageCost: snapshot.averageEntryPrice } });
      await tx.pnlSnapshot.create({ data: { botId: input.botId, realizedPnlUsd: snapshot.realizedPnlUsd,
        unrealizedPnlUsd: snapshot.unrealizedPnlUsd, totalPnlUsd: snapshot.realizedPnlUsd + snapshot.unrealizedPnlUsd,
        equityUsd: snapshot.totalEquityUsd, price: snapshot.currentPrice ?? input.report.effectivePrice } });
      await tx.botStateSnapshot.create({ data: stateSnapshotData(snapshot) });
      await tx.bot.update({ where: { id: input.botId }, data: { status: status as never, currentPrice: snapshot.currentPrice } });
      await tx.order.update({ where: { id: input.orderId }, data: { status: input.report.status === ExecutionStatus.Failed ? "failed" : "filled" } });
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

function isTerminal(status: ExecutionStatus): boolean {
  return status === ExecutionStatus.Filled || status === ExecutionStatus.Failed;
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
