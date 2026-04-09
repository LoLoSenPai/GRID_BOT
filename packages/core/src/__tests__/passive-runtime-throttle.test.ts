import { describe, expect, it } from "vitest";

import { BotStatus, TradeSide } from "../domain/enums";
import type { BotStateSnapshot } from "../domain/types";
import {
  PASSIVE_SNAPSHOT_INTERVAL_MS,
  shouldPersistPassivePriceSnapshot,
  shouldPersistPassiveState,
} from "../services/passive-runtime-throttle";

function createLatestState(overrides: Partial<BotStateSnapshot> = {}): BotStateSnapshot {
  return {
    id: "snapshot-1",
    botId: "bot-1",
    status: BotStatus.Running,
    currentPrice: 100,
    availableQuoteAmount: 1000,
    availableBaseAmount: 0,
    deployedQuoteAmount: 0,
    averageEntryPrice: null,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalEquityUsd: 1000,
    consecutiveFailures: 0,
    lastExecutionAt: null,
    lastProcessedAt: new Date("2026-04-09T12:00:00.000Z"),
    lastRecenterAt: null,
    metadata: {
      levelLocks: {},
      pendingSignal: {
        levelIndex: 1,
        side: TradeSide.Buy,
        firstObservedAt: "2026-04-09T11:59:55.000Z",
        lastObservedPrice: 99.4,
      },
      gridCycles: {},
      recenterHistory: [],
      recentExecutions: [],
    },
    ...overrides,
  };
}

describe("passive-runtime-throttle", () => {
  it("skips passive state writes when only the observed price drifts inside the throttle window", () => {
    const latestState = createLatestState();

    expect(
      shouldPersistPassiveState({
        latestState,
        status: BotStatus.Running,
        metadata: {
          ...latestState.metadata,
          pendingSignal: {
            ...latestState.metadata.pendingSignal!,
            lastObservedPrice: 98.8,
          },
        },
        now: new Date(latestState.lastProcessedAt.getTime() + PASSIVE_SNAPSHOT_INTERVAL_MS - 5_000),
      }),
    ).toBe(false);
  });

  it("persists passive state writes once the throttle window expires", () => {
    const latestState = createLatestState();

    expect(
      shouldPersistPassiveState({
        latestState,
        status: BotStatus.Running,
        metadata: latestState.metadata,
        now: new Date(latestState.lastProcessedAt.getTime() + PASSIVE_SNAPSHOT_INTERVAL_MS + 1_000),
      }),
    ).toBe(true);
  });

  it("persists passive state writes immediately when metadata meaningfully changes", () => {
    const latestState = createLatestState();

    expect(
      shouldPersistPassiveState({
        latestState,
        status: BotStatus.Running,
        metadata: {
          ...latestState.metadata,
          pendingSignal: {
            ...latestState.metadata.pendingSignal!,
            levelIndex: 2,
          },
        },
        now: new Date(latestState.lastProcessedAt.getTime() + 5_000),
      }),
    ).toBe(true);
  });

  it("persists passive state writes immediately when status changes", () => {
    const latestState = createLatestState();

    expect(
      shouldPersistPassiveState({
        latestState,
        status: BotStatus.Cooldown,
        metadata: latestState.metadata,
        now: new Date(latestState.lastProcessedAt.getTime() + 5_000),
      }),
    ).toBe(true);
  });

  it("persists passive price snapshots only after the throttle window", () => {
    const now = new Date("2026-04-09T12:00:20.000Z");

    expect(
      shouldPersistPassivePriceSnapshot({
        lastPersistedAt: new Date("2026-04-09T12:00:00.000Z"),
        now,
      }),
    ).toBe(false);

    expect(
      shouldPersistPassivePriceSnapshot({
        lastPersistedAt: new Date("2026-04-09T11:59:49.000Z"),
        now,
      }),
    ).toBe(true);
  });
});
