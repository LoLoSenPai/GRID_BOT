import { describe, expect, it } from "vitest";
import { aggregateZoneMetrics, groupBotsByStrategy, serializeBotZone, type BotZone } from "../bot-zone-groups";

const zone = (portfolioId = "p1", strategyId = "btc"): BotZone => ({
  portfolioId, strategyId, bandId: "band", status: "ACTIVE", availableQuote: 40,
  reservedQuote: 10, deployedCostQuote: 50, activeExits: 2,
});

describe("view-only strategy grouping", () => {
  it("shows spendable cash separately from reserved cash without changing persisted balances", () => {
    const band = { id: "b", assetStrategyId: "btc", status: "ACTIVE", availableQuoteAmount: 40,
      reservedQuoteAmount: 10, deployedCostQuote: 50, assetStrategy: { portfolioId: "p" }, exitCommitments: [] };
    expect(serializeBotZone(band)).toMatchObject({ availableQuote: 30, reservedQuote: 10, deployedCostQuote: 50 });
    expect(band.availableQuoteAmount).toBe(40);
  });
  it("uses both identities and mode, keeps legacy independent, preserves exact bot ids and inputs", () => {
    const bots = [
      { id: "btc-low", mode: "paper", zone: zone() },
      { id: "btc-high", mode: "paper", zone: zone() },
      { id: "other-portfolio", mode: "paper", zone: zone("p2") },
      { id: "other-strategy", mode: "paper", zone: zone("p1", "another-btc") },
      { id: "live", mode: "live", zone: zone() },
      { id: "legacy-a", mode: "paper", zone: null },
      { id: "legacy-b", mode: "paper", zone: null },
    ];
    const original = structuredClone(bots);
    bots.forEach(Object.freeze);
    Object.freeze(bots);
    const groups = groupBotsByStrategy(bots);
    expect(groups).toHaveLength(6);
    expect(groups[0]?.bots.map((bot) => bot.id)).toEqual(["btc-low", "btc-high"]);
    expect(groups.flatMap((group) => group.bots)).toEqual(original);
    expect(bots).toEqual(original);
  });

  it("weights usage by deployable capital and counts old-lot exits even in parked zones", () => {
    const totals = aggregateZoneMetrics([
      { status: "running", budget: 200, deployable: 100, deployed: 80, equity: 195, pnl: -5, inventory: 0.001, zone: zone() },
      { status: "paused", budget: 800, deployable: 400, deployed: 40, equity: 810, pnl: 10, inventory: 0.002, zone: { ...zone(), status: "PARKED_BELOW", activeExits: 3 } },
    ]);
    expect(totals).toMatchObject({ budget: 1000, equity: 1005, pnl: 5, usage: 24, inventory: 0.003,
      status: "mixed", availableQuote: 80, reservedQuote: 20, deployedCostQuote: 100, activeExits: 5 });
    expect(totals.statusDetails).toBe("running: 1 · paused: 1");
  });

  it("does not invent ledger capital for legacy bots or usage for zero capital", () => {
    expect(aggregateZoneMetrics([{ status: "stopped", budget: 0, deployable: 0, deployed: 0, equity: 0, pnl: 0, inventory: 0, zone: null }]))
      .toMatchObject({ status: "stopped", usage: 0, availableQuote: null, reservedQuote: null, deployedCostQuote: null });
  });
});
