import { describe, expect, it, vi } from "vitest";

import { BotStatus, TradeSide } from "../domain/enums";
import type { GridLevel, TriggerSignal } from "../domain/types";
import { GridDecisionService } from "../services/grid-decision-service";

const levels: GridLevel[] = [
  { index: 0, price: 80 },
  { index: 1, price: 82 },
  { index: 2, price: 84 },
  { index: 3, price: 86 }
];

function signal(input: Partial<TriggerSignal> & Pick<TriggerSignal, "levelIndex" | "side" | "levelPrice">): TriggerSignal {
  return {
    observedPrice: input.side === TradeSide.Buy ? input.levelPrice - 0.1 : input.levelPrice + 0.1,
    idempotencyKey: "",
    triggeredAt: new Date("2026-04-17T00:00:00.000Z"),
    ...input
  };
}

describe("GridDecisionService", () => {
  it("materializes an actionable crossed signal immediately even when confirmation is configured", () => {
    const now = new Date("2026-04-17T10:00:00.000Z");
    const service = new GridDecisionService();

    const result = service.getConfirmedSignal({
      botId: "bot-1",
      botStatus: BotStatus.Running,
      latestStatus: BotStatus.Running,
      pendingSignal: null,
      currentPrice: 81.9,
      now,
      levels,
      crossedSignals: [signal({ levelIndex: 1, side: TradeSide.Buy, levelPrice: 82 })],
      priceConfirmationWindowMs: 10_000,
      canBuildOrder: () => true
    });

    expect(result).toMatchObject({
      levelIndex: 1,
      side: TradeSide.Buy,
      idempotencyKey: `bot-1:${TradeSide.Buy}:1:${now.getTime()}`,
      triggeredAt: now
    });
  });

  it("keeps a pending signal until the configured confirmation window has elapsed", () => {
    const service = new GridDecisionService();
    const result = service.getConfirmedSignal({
      botId: "bot-1",
      botStatus: BotStatus.Running,
      latestStatus: BotStatus.Running,
      pendingSignal: {
        levelIndex: 2,
        side: TradeSide.Sell,
        firstObservedAt: "2026-04-17T10:00:00.000Z",
        lastObservedPrice: 84.1
      },
      currentPrice: 84.2,
      now: new Date("2026-04-17T10:00:05.000Z"),
      levels,
      crossedSignals: [],
      priceConfirmationWindowMs: 10_000,
      canBuildOrder: () => false
    });

    expect(result).toBeNull();
  });

  it("confirms a pending signal after the window when price still confirms the level", () => {
    const service = new GridDecisionService();
    const result = service.getConfirmedSignal({
      botId: "bot-1",
      botStatus: BotStatus.Running,
      latestStatus: BotStatus.Running,
      pendingSignal: {
        levelIndex: 2,
        side: TradeSide.Sell,
        firstObservedAt: "2026-04-17T10:00:00.000Z",
        lastObservedPrice: 84.1
      },
      currentPrice: 84.2,
      now: new Date("2026-04-17T10:00:11.000Z"),
      levels,
      crossedSignals: [],
      priceConfirmationWindowMs: 10_000,
      canBuildOrder: () => false
    });

    expect(result).toMatchObject({
      levelIndex: 2,
      side: TradeSide.Sell,
      levelPrice: 84
    });
  });

  it("suppresses buy recovery while out of range", () => {
    const service = new GridDecisionService();
    const result = service.getConfirmedSignal({
      botId: "bot-1",
      botStatus: BotStatus.OutOfRange,
      latestStatus: BotStatus.OutOfRange,
      pendingSignal: null,
      currentPrice: 79,
      now: new Date("2026-04-17T10:00:00.000Z"),
      levels,
      crossedSignals: [signal({ levelIndex: 0, side: TradeSide.Buy, levelPrice: 80 })],
      priceConfirmationWindowMs: 0,
      canBuildOrder: () => true
    });

    expect(result).toBeNull();
  });

  it("returns the highest actionable recovery sell when price is above range", () => {
    const canBuildOrder = vi.fn((candidate: TriggerSignal) => candidate.levelIndex === 2);
    const service = new GridDecisionService();

    const result = service.getOutOfRangeRecoverySellSignal({
      botId: "bot-1",
      botStatus: BotStatus.OutOfRange,
      latestStatus: BotStatus.OutOfRange,
      pendingSignal: null,
      currentPrice: 87,
      now: new Date("2026-04-17T10:00:00.000Z"),
      levels,
      crossedSignals: [],
      priceConfirmationWindowMs: 0,
      canBuildOrder
    });

    expect(result).toMatchObject({
      levelIndex: 2,
      side: TradeSide.Sell,
      levelPrice: 84
    });
    expect(canBuildOrder).toHaveBeenCalled();
  });
});
