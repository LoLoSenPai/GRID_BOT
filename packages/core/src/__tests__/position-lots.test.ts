import { describe, expect, it } from "vitest";

import type { PositionLot } from "../domain/types";
import { reconcileOpenPositionLots } from "../utils/position-lots";

function lot(id: string, costQuote: number, openedAt: string): PositionLot {
  return {
    id,
    botId: "bot_1",
    originalBaseAmount: costQuote / 86,
    remainingBaseAmount: costQuote / 86,
    entryPrice: 86,
    costQuote,
    openedByExecutionId: `exec-${id}`,
    closedByExecutionId: null,
    openedAt: new Date(openedAt),
    closedAt: null
  };
}

describe("reconcileOpenPositionLots", () => {
  it("keeps all open lots when they match runtime deployed quote", () => {
    const lots = [
      lot("old", 47.1, "2026-05-20T12:00:00.000Z"),
      lot("new", 47.11, "2026-05-20T13:00:00.000Z")
    ];

    expect(reconcileOpenPositionLots(lots, { deployedQuoteAmount: 94.21, availableBaseAmount: 1.095 }).map((entry) => entry.id)).toEqual(["old", "new"]);
  });

  it("drops older phantom lots when runtime deployed quote only covers the newest lot", () => {
    const lots = [
      lot("phantom-bottom", 47.1, "2026-05-20T12:00:00.000Z"),
      lot("real-top", 47.11, "2026-05-20T13:00:00.000Z")
    ];

    expect(reconcileOpenPositionLots(lots, { deployedQuoteAmount: 47.11, availableBaseAmount: 0.5474 }).map((entry) => entry.id)).toEqual(["real-top"]);
  });

  it("returns no lots when runtime says no capital is deployed", () => {
    expect(reconcileOpenPositionLots([lot("phantom", 47.1, "2026-05-20T12:00:00.000Z")], { deployedQuoteAmount: 0, availableBaseAmount: 0 })).toEqual([]);
  });
});
