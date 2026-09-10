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
  it("materializes a crossed buy immediately when confirmation is disabled", () => {
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
      priceConfirmationWindowMs: 0,
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
        side: TradeSide.Buy,
        firstObservedAt: "2026-04-17T10:00:00.000Z",
        lastObservedPrice: 83.9
      },
      currentPrice: 83.8,
      now: new Date("2026-04-17T10:00:05.000Z"),
      levels,
      crossedSignals: [],
      priceConfirmationWindowMs: 10_000,
      canBuildOrder: (candidate) => candidate.side === TradeSide.Buy
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
        side: TradeSide.Buy,
        firstObservedAt: "2026-04-17T10:00:00.000Z",
        lastObservedPrice: 83.9
      },
      currentPrice: 83.8,
      now: new Date("2026-04-17T10:00:11.000Z"),
      levels,
      crossedSignals: [],
      priceConfirmationWindowMs: 10_000,
      canBuildOrder: (candidate) => candidate.side === TradeSide.Buy
    });

    expect(result).toMatchObject({
      levelIndex: 2,
      side: TradeSide.Buy,
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

  it("returns an already exceeded sell level even without a fresh crossing", () => {
    const now = new Date("2026-04-17T10:00:00.000Z");
    const canBuildOrder = vi.fn((candidate: TriggerSignal) => candidate.levelIndex === 2);
    const service = new GridDecisionService();

    const result = service.getConfirmedSignal({
      botId: "bot-1",
      botStatus: BotStatus.Running,
      latestStatus: BotStatus.Running,
      pendingSignal: null,
      currentPrice: 85,
      now,
      levels,
      crossedSignals: [],
      priceConfirmationWindowMs: 10_000,
      canBuildOrder
    });

    expect(result).toMatchObject({
      levelIndex: 2,
      side: TradeSide.Sell,
      levelPrice: 84,
      idempotencyKey: `bot-1:recovery:sell:2:${now.getTime()}`
    });
  });

  it("confirms rails that touch the displayed cent when the internal rail is between cents", () => {
    const service = new GridDecisionService();

    expect(service.priceStillConfirms(TradeSide.Sell, 86.45454545, 86.45)).toBe(true);
    expect(service.priceStillConfirms(TradeSide.Buy, 84.54545455, 84.55)).toBe(true);
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

  it("returns the lower boundary buy when price drops below the range", () => {
    const now = new Date("2026-04-17T10:00:00.000Z");
    const canBuildOrder = vi.fn((candidate: TriggerSignal) => candidate.levelIndex === 0 && candidate.side === TradeSide.Buy);
    const service = new GridDecisionService();

    const result = service.getOutOfRangeBoundaryBuySignal({
      botId: "bot-1",
      botStatus: BotStatus.Running,
      latestStatus: BotStatus.Running,
      pendingSignal: null,
      currentPrice: 79,
      now,
      levels,
      crossedSignals: [],
      priceConfirmationWindowMs: 0,
      canBuildOrder
    });

    expect(result).toMatchObject({
      levelIndex: 0,
      side: TradeSide.Buy,
      levelPrice: 80,
      idempotencyKey: `bot-1:boundary:buy:0:${now.getTime()}`
    });
    expect(canBuildOrder).toHaveBeenCalled();
  });

  it("does not return a lower boundary buy when the bottom rail is already occupied", () => {
    const service = new GridDecisionService();

    const result = service.getOutOfRangeBoundaryBuySignal({
      botId: "bot-1",
      botStatus: BotStatus.OutOfRange,
      latestStatus: BotStatus.OutOfRange,
      pendingSignal: null,
      currentPrice: 79,
      now: new Date("2026-04-17T10:00:00.000Z"),
      levels,
      crossedSignals: [],
      priceConfirmationWindowMs: 0,
      canBuildOrder: () => false
    });

    expect(result).toBeNull();
  });
});


describe("buy confirmation causality", () => {
  const service = new GridDecisionService();
  const now = new Date("2026-04-17T10:00:00Z");
  const buy = signal({ levelIndex: 1, levelPrice: 82, side: TradeSide.Buy });
  const input = { botId: "bot", botStatus: BotStatus.Running, currentPrice: 81.9, now, levels,
    crossedSignals: [buy], priceConfirmationWindowMs: 60_000,
    canBuildOrder: (candidate: TriggerSignal) => candidate.side === TradeSide.Buy };
  it("starts a timer on the first crossing, waits the full window, and cancels a reversal", () => {
    expect(service.getConfirmedSignal(input)).toBeNull();
    const pendingSignal = service.resolvePendingSignal(input);
    expect(pendingSignal?.firstObservedAt).toBe(now.toISOString());
    expect(service.getConfirmedSignal({ ...input, pendingSignal, now: new Date(now.getTime() + 59_999) })).toBeNull();
    expect(service.getConfirmedSignal({ ...input, pendingSignal, crossedSignals: [], now: new Date(now.getTime() + 60_000) })?.side).toBe(TradeSide.Buy);
    expect(service.resolvePendingSignal({ ...input, pendingSignal, crossedSignals: [], currentPrice: 82.2 })).toBeNull();
    expect(service.getConfirmedSignal({ ...input, pendingSignal, crossedSignals: [], currentPrice: 82.2, now: new Date(now.getTime() + 60_000) })).toBeNull();
  });
  it("starts lower boundary confirmation without a fresh crossing", () => {
    const outside = { ...input, currentPrice: 79, crossedSignals: [] };
    expect(service.getOutOfRangeBoundaryBuySignal(outside)).toBeNull();
    const pendingSignal = service.resolvePendingSignal(outside);
    expect(pendingSignal).toMatchObject({ levelIndex: 0, side: TradeSide.Buy, firstObservedAt: now.toISOString() });
    expect(service.getOutOfRangeBoundaryBuySignal({ ...outside, pendingSignal, now: new Date(now.getTime() + 59_999) })).toBeNull();
    expect(service.getOutOfRangeBoundaryBuySignal({ ...outside, pendingSignal, now: new Date(now.getTime() + 60_000) })?.levelIndex).toBe(0);
  });
  it("does not delay recovery sells and refuses stale unbuildable pending buys", () => {
    const sell = service.getConfirmedSignal({ ...input, currentPrice: 85, crossedSignals: [], canBuildOrder: (candidate) => candidate.side === TradeSide.Sell && candidate.levelIndex === 2 });
    expect(sell?.side).toBe(TradeSide.Sell);
    const pendingSignal = service.resolvePendingSignal(input);
    expect(service.getConfirmedSignal({ ...input, pendingSignal, crossedSignals: [], now: new Date(now.getTime() + 60_000), canBuildOrder: () => false })).toBeNull();
  });
});
