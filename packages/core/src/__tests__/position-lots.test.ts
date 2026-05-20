import { describe, expect, it } from "vitest";

import type { PositionLot } from "../domain/types";
import { reconcileOpenPositionLots } from "../utils/position-lots";

function lot(id: string, costQuote: number, openedAt: string, costBasis = 86): PositionLot {
  return {
    id,
    botId: "bot_1",
    originalBaseAmount: costQuote / costBasis,
    remainingBaseAmount: costQuote / costBasis,
    entryPrice: costBasis,
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

  it("drops lots that do not match the runtime average entry", () => {
    const lots = [
      lot("phantom-bottom", 47.1, "2026-05-20T14:00:00.000Z", 83.2),
      lot("real-mid", 47.11, "2026-05-20T12:00:00.000Z", 85.85),
      lot("real-top", 47.11, "2026-05-20T13:00:00.000Z", 86.06)
    ];

    expect(reconcileOpenPositionLots(lots, { deployedQuoteAmount: 94.22, availableBaseAmount: 1.0959 }).map((entry) => entry.id)).toEqual(["real-mid", "real-top"]);
  });

  it("normalizes stale lot base amounts to the runtime base balance", () => {
    const lots = [lot("stale-base", 47.11, "2026-05-20T14:00:00.000Z", 83.2)];

    const [reconciled] = reconcileOpenPositionLots(lots, {
      deployedQuoteAmount: 47.11,
      availableBaseAmount: 0.5474
    });

    expect(reconciled?.id).toBe("stale-base");
    expect(reconciled?.remainingBaseAmount).toBeCloseTo(0.5474, 8);
    expect(reconciled?.entryPrice).toBeCloseTo(86.0614, 4);
  });

  it("returns no lots when runtime says no capital is deployed", () => {
    expect(reconcileOpenPositionLots([lot("phantom", 47.1, "2026-05-20T12:00:00.000Z")], { deployedQuoteAmount: 0, availableBaseAmount: 0 })).toEqual([]);
  });
});
