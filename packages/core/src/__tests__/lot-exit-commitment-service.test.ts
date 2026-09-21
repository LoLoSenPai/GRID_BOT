import { describe, expect, it } from "vitest";
import { eligibleCommittedExits, previousPriceForRevision } from "../services/lot-exit-commitment-service";
import type { PositionLot } from "../domain/types";

const now = new Date("2026-09-21T00:00:00Z");
const lot: PositionLot = { id: "lot", botId: "bot", kind: "trading", originalBaseAmount: 1,
  remainingBaseAmount: 1, entryPrice: 100, costQuote: 100, openedByExecutionId: "buy",
  closedByExecutionId: null, openedAt: now, closedAt: null };
const exit = { lotId: "lot", targetStatus: "KNOWN" as const, sellTargetPrice: 110,
  sellLevelIndex: 12, originRevisionId: "old", maxAdverseDriftBps: 30 };

describe("absolute lot exits", () => {
  it("keeps an old exit actionable irrespective of the current grid bounds or level count", () => {
    const signals = eligibleCommittedExits({ botId: "bot", price: 115, now, lots: [lot], commitments: [exit] });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ levelPrice: 110, levelIndex: 12, exitLotId: "lot", gridRevisionId: "old" });
  });
  it("does not lower an old target to follow the market or sell retained inventory", () => {
    expect(eligibleCommittedExits({ botId: "bot", price: 109, now, lots: [lot], commitments: [exit] })).toEqual([]);
    expect(eligibleCommittedExits({ botId: "bot", price: 120, now, lots: [{ ...lot, kind: "retained", costQuote: 0 }], commitments: [exit] })).toEqual([]);
  });
  it("blocks unknown exits rather than inferring new targets from a different grid", () => {
    expect(eligibleCommittedExits({ botId: "bot", price: 120, now, lots: [lot], commitments: [{ ...exit, targetStatus: "UNKNOWN" }] })).toEqual([]);
  });
  it("requires a fresh baseline on revision changes, including after restart", () => {
    expect(previousPriceForRevision({ activeRevisionId: "new", observedRevisionId: "old", previousPrice: 120 })).toBeNull();
    expect(previousPriceForRevision({ activeRevisionId: "new", previousPrice: 120 })).toBeNull();
    expect(previousPriceForRevision({ activeRevisionId: "new", observedRevisionId: "new", previousPrice: 120 })).toBe(120);
  });
});
