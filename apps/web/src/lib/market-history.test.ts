import { describe, expect, it } from "vitest";

import { getHistoryWindow } from "./market-history-window";

describe("market-history", () => {
  it("caps short resolutions to the configured lookback window", () => {
    const now = Math.floor(Date.UTC(2026, 3, 9, 12, 0, 0, 0) / 1000);

    expect(getHistoryWindow("SOL", "5m", now)).toEqual({
      from: now - 7 * 24 * 60 * 60,
      to: now,
      cappedByResolution: true,
    });
  });

  it("keeps long resolutions within available history when the symbol is newer than the cap", () => {
    const now = Math.floor(Date.UTC(2021, 3, 10, 0, 0, 0, 0) / 1000);
    const symbolStart = Math.floor(Date.UTC(2020, 3, 10, 0, 0, 0, 0) / 1000);

    expect(getHistoryWindow("SOL", "1mo", now)).toEqual({
      from: symbolStart,
      to: now,
      cappedByResolution: false,
    });
  });
});
