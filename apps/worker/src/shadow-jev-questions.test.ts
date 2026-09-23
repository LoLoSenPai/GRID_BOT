import { describe, expect, it } from "vitest";

import type { PortfolioPolicyInput, PortfolioPolicyParameters } from "@grid-bot/core";

import { buildJevRequest, modelRequested, questionSetVersion } from "./shadow-jev-questions";

const parameters: PortfolioPolicyParameters = {
  persistenceClosedBars: 3,
  cooldownMs: 3_600_000,
  maxDailyRevisions: 2,
  atrMultiplier: 2,
  realizedVolMultiplier: 2,
  amplitudeMultiplier: 1,
  minWidthPct: 0.02,
  maxWidthPct: 0.3,
  minUsefulOrderUsd: 10,
  maxBands: 2,
  maxLevels: 20,
  maxExposurePct: 0.8,
  lowerBandOffsetPct: 0.05,
  lowerBandWidthPct: 0.1,
  minimumSpacingPct: 0.01,
};

function policyInput(overrides: Partial<PortfolioPolicyInput> = {}): PortfolioPolicyInput {
  const start = Date.parse("2026-09-22T00:00:00.000Z");
  const candles = Array.from({ length: 28 }, (_, index) => ({
    openedAt: new Date(start + index * 3_600_000),
    closedAt: new Date(start + (index + 1) * 3_600_000),
    open: 99 + index,
    high: 101 + index,
    low: 98 + index,
    close: 100 + index,
  }));
  return {
    now: new Date("2026-09-23T04:00:00.000Z"),
    price: 111,
    assetSymbol: "SOL",
    band: {
      id: "sol-main",
      lowPrice: 90,
      highPrice: 110,
      levelCount: 5,
      spacing: 5,
      status: "active",
      allocatedCapitalUsd: 500,
      idleQuoteUsd: 200,
      openTradingLots: [],
      lastRevisionAt: new Date("2026-09-21T12:00:00.000Z"),
    },
    bandCount: 1,
    assetAttributedCapitalUsd: 500,
    candles,
    candleIntervalMs: 3_600_000,
    maxCandleAgeMs: 7_200_000,
    availableCashUsd: 200,
    totalPortfolioCapitalUsd: 1_000,
    parameters,
    ...overrides,
  };
}

describe("buildJevRequest", () => {
  it("builds the versioned three-judgment request when price is outside the band", () => {
    const request = buildJevRequest({
      observedAt: "2026-09-23T02:00:00.000Z",
      policyInput: policyInput(),
      strategy: { objective: "accumulate_base" },
    });

    expect(questionSetVersion).toBe("shadow-jev-v1");
    expect(modelRequested).toBe("jev-1.13.0");
    expect(request.model).toBe("jev-1.13.0");
    expect(Object.keys(request.questions)).toEqual([
      "market_regime",
      "current_band_suitable",
      "temporary_outside_excursion",
    ]);
    expect(request.questions.market_regime.criteria).toHaveProperty("insufficient_evidence");
    expect(request.questions.current_band_suitable.criteria.true).toContain("substantially");
    expect(request.questions.temporary_outside_excursion?.instructions).toMatchObject({
      evaluation_horizon: expect.stringContaining("six completed one-hour candles"),
    });
    expect(request.state).toMatchObject({
      observed_at: "2026-09-23T02:00:00.000Z",
      asset_symbol: "SOL",
      strategy_objective: "accumulate_base",
      current_price: 111,
      candle_interval_ms: 3_600_000,
      band: { low_price: 90, high_price: 110, status: "active" },
    });
  });

  it("keeps only a short window of candles closed by the observation time", () => {
    const unorderedPolicyInput = policyInput();
    unorderedPolicyInput.candles.reverse();
    const request = buildJevRequest({
      observedAt: new Date("2026-09-23T02:00:00.000Z"),
      policyInput: unorderedPolicyInput,
    });

    expect(request.state.recent_closed_candles).toHaveLength(24);
    expect(request.state.recent_closed_candles[0]?.closed_at).toBe("2026-09-22T03:00:00.000Z");
    expect(request.state.recent_closed_candles.at(-1)?.closed_at).toBe("2026-09-23T02:00:00.000Z");
    expect(unorderedPolicyInput.candles[0]?.closedAt).toEqual(new Date("2026-09-23T04:00:00.000Z"));
    expect(request.state.recent_closed_candles.some((candle) => candle.closed_at > request.state.observed_at)).toBe(false);
    expect(request.state).not.toHaveProperty("available_cash_usd");
    expect(request.state).not.toHaveProperty("parameters");
    expect(request.state).not.toHaveProperty("indicators");
  });

  it("omits the temporary-excursion judgment while price is inside the inclusive band", () => {
    const request = buildJevRequest({
      observedAt: "2026-09-23T02:00:00.000Z",
      policyInput: policyInput({ price: 110 }),
    });

    expect(request.questions.temporary_outside_excursion).toBeUndefined();
    expect(Object.keys(request.questions)).toEqual(["market_regime", "current_band_suitable"]);
  });

  it("passes through only indicators that actually exist on the policy input", () => {
    const request = buildJevRequest({
      observedAt: "2026-09-23T02:00:00.000Z",
      policyInput: policyInput({
        indicators: { observedAt: new Date("2026-09-23T02:00:00.000Z"), atrPct: 0.03 },
      }),
    });

    expect(request.state.indicators).toEqual({ observed_at: "2026-09-23T02:00:00.000Z", atr_pct: 0.03 });
  });

  it("accepts policy input dates after a JSON outbox round-trip", () => {
    const serialized = JSON.parse(JSON.stringify(policyInput())) as unknown as PortfolioPolicyInput;

    const request = buildJevRequest({
      observedAt: "2026-09-23T02:00:00.000Z",
      policyInput: serialized,
    });

    expect(request.state.recent_closed_candles).toHaveLength(24);
    expect(request.state.recent_closed_candles.at(-1)?.closed_at).toBe("2026-09-23T02:00:00.000Z");
    expect(request.state.band.last_revision_at).toBe("2026-09-21T12:00:00.000Z");
  });

  it("rejects an invalid observation date before constructing a request", () => {
    expect(() => buildJevRequest({ observedAt: "not-a-date", policyInput: policyInput() })).toThrow(
      "observedAt must be a valid date",
    );
  });
});
