import { describe, expect, it } from "vitest";

import { findIsolatedPortfolioSpikeIndexes, removeIsolatedPortfolioSpikes } from "./portfolio-history-sanitizer";

describe("portfolio history sanitizer", () => {
  it("removes a one-bucket decimal-corruption spike", () => {
    const points = [180, 195, 6_835.25, 202, 205].map((totalPnlUsd, index) => ({ index, totalPnlUsd }));

    expect([...findIsolatedPortfolioSpikeIndexes(points)]).toEqual([2]);
    expect(removeIsolatedPortfolioSpikes(points).map((point) => point.totalPnlUsd)).toEqual([180, 195, 202, 205]);
  });

  it("keeps a sustained portfolio move", () => {
    const points = [100, 900, 1_000, 1_100, 1_200].map((totalPnlUsd) => ({ totalPnlUsd }));

    expect(removeIsolatedPortfolioSpikes(points)).toEqual(points);
  });

  it("keeps normal noisy history", () => {
    const points = [0, 35, -20, 60, 15].map((totalPnlUsd) => ({ totalPnlUsd }));

    expect(removeIsolatedPortfolioSpikes(points)).toEqual(points);
  });
});
