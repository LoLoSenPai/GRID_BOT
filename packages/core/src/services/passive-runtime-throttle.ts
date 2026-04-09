import type { BotRuntimeMetadata, BotStateSnapshot } from "../domain/types";

export const PASSIVE_SNAPSHOT_INTERVAL_MS = 30_000;

function sortRecordEntries<T>(record: Record<string, T> | undefined) {
  return Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right));
}

function normalizeMetadata(metadata: BotRuntimeMetadata) {
  return {
    levelLocks: sortRecordEntries(metadata.levelLocks).map(([key, value]) => [key, value]),
    pendingSignal: metadata.pendingSignal
      ? {
          levelIndex: metadata.pendingSignal.levelIndex,
          side: metadata.pendingSignal.side,
          firstObservedAt: metadata.pendingSignal.firstObservedAt,
        }
      : null,
    gridCycles: sortRecordEntries(metadata.gridCycles).map(([key, value]) => [
      key,
      {
        buyLevelIndex: value.buyLevelIndex,
        sellLevelIndex: value.sellLevelIndex,
        lotId: value.lotId,
        openedAt: value.openedAt,
      },
    ]),
    recenterHistory: [...(metadata.recenterHistory ?? [])],
    recentExecutions: [...(metadata.recentExecutions ?? [])],
  };
}

function getTimestamp(value: Date | null | undefined) {
  return value?.getTime() ?? null;
}

export function shouldPersistPassiveState(input: {
  latestState: BotStateSnapshot | null;
  status: string;
  metadata: BotRuntimeMetadata;
  lastExecutionAt?: Date | null;
  lastRecenterAt?: Date | null;
  now: Date;
  minIntervalMs?: number;
}) {
  const { latestState, status, metadata, lastExecutionAt = null, lastRecenterAt = null, now, minIntervalMs = PASSIVE_SNAPSHOT_INTERVAL_MS } = input;

  if (!latestState) {
    return true;
  }

  if (latestState.status !== status) {
    return true;
  }

  if (getTimestamp(latestState.lastExecutionAt) !== getTimestamp(lastExecutionAt)) {
    return true;
  }

  if (getTimestamp(latestState.lastRecenterAt) !== getTimestamp(lastRecenterAt)) {
    return true;
  }

  if (JSON.stringify(normalizeMetadata(latestState.metadata)) !== JSON.stringify(normalizeMetadata(metadata))) {
    return true;
  }

  return now.getTime() - latestState.lastProcessedAt.getTime() >= minIntervalMs;
}

export function shouldPersistPassivePriceSnapshot(input: {
  lastPersistedAt?: Date | null;
  now: Date;
  minIntervalMs?: number;
}) {
  const { lastPersistedAt = null, now, minIntervalMs = PASSIVE_SNAPSHOT_INTERVAL_MS } = input;

  if (!lastPersistedAt) {
    return true;
  }

  return now.getTime() - lastPersistedAt.getTime() >= minIntervalMs;
}
