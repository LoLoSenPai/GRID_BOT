import type { BotStateSnapshot, PositionLot } from "@grid-bot/core";
import { Prisma } from "@prisma/client";

export function stateSnapshotData(snapshot: Omit<BotStateSnapshot, "id">) {
  return { ...snapshot, status: snapshot.status as never, metadata: jsonValue(snapshot.metadata) };
}

export function lotData(botId: string, lot: PositionLot) {
  if (lot.botId !== botId) throw new Error("Position lot belongs to another bot.");
  return { id: lot.id, botId, kind: lot.kind ?? "trading", originalBaseAmount: lot.originalBaseAmount,
    remainingBaseAmount: lot.remainingBaseAmount, entryPrice: lot.entryPrice, costQuote: lot.costQuote,
    openedByExecutionId: lot.openedByExecutionId, closedByExecutionId: lot.closedByExecutionId,
    openedAt: lot.openedAt, closedAt: lot.closedAt };
}

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Never publish a reusable signed transaction in execution history or logs. */
export function publicReport(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined) return {};
  return JSON.parse(JSON.stringify(value, (key, entry: unknown) =>
    ["signedTransaction", "transaction", "preparedExecution", "payload"].includes(key) ? undefined : entry)) as Prisma.InputJsonValue;
}
