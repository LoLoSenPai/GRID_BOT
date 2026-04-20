import type { TradeRepository } from "@grid-bot/core";
import type { ExecutionReport, PositionLot } from "@grid-bot/core";
import { Prisma } from "@prisma/client";

import { prisma } from "../client";

export class PrismaTradeRepository implements TradeRepository {
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
        rawReport: (record.rawReport as Prisma.InputJsonValue | undefined) ?? undefined,
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
        rawReport: (report.rawReport as Prisma.InputJsonValue | undefined) ?? undefined,
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
              data: lots.map((lot) => ({
                id: lot.id,
                botId,
                originalBaseAmount: lot.originalBaseAmount,
                remainingBaseAmount: lot.remainingBaseAmount,
                entryPrice: lot.entryPrice,
                costQuote: lot.costQuote,
                openedByExecutionId: lot.openedByExecutionId,
                closedByExecutionId: lot.closedByExecutionId ?? undefined,
                openedAt: lot.openedAt,
                closedAt: lot.closedAt ?? undefined
              }))
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
