import { describe, expect, it } from "vitest";
import { GridType } from "@grid-bot/core/enums";

import { calculateGridLevels, getNextGridTriggers, parsePendingSignal } from "./bot-runtime";

describe("bot-runtime", () => {
  it("calculates the next buy and sell levels around the current price", () => {
    const config = {
      lowPrice: 60,
      highPrice: 90,
      levelCount: 14,
      gridType: GridType.Arithmetic
    };

    expect(calculateGridLevels(config)).toHaveLength(14);
    expect(getNextGridTriggers(config, 79)).toEqual({
      nextBuyLevel: 78.46153846,
      nextSellLevel: 80.76923077
    });
  });

  it("parses a pending confirmation signal from runtime metadata", () => {
    const signal = parsePendingSignal(
      {
        pendingSignal: {
          levelIndex: 7,
          side: "buy",
          firstObservedAt: "2026-04-03T00:00:00.000Z",
          lastObservedPrice: 78.92
        }
      },
      10_000,
      new Date("2026-04-03T00:00:04.000Z")
    );

    expect(signal).toEqual(
      expect.objectContaining({
        levelIndex: 7,
        side: "buy",
        remainingMs: 6000,
        ready: false
      })
    );
  });
});
