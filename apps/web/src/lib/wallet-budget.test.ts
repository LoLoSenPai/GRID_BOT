import { describe, expect, it } from "vitest";

import {
  calculateAvailableBudgetUsd,
  calculateReservedQuoteUsd,
} from "./wallet-budget";

describe("wallet budget allocation", () => {
  it("reserves only idle quote from active bot snapshots", () => {
    expect(
      calculateReservedQuoteUsd([
        { totalBudgetUsd: 140, availableQuoteAmount: 38.16 },
        { totalBudgetUsd: 70, availableQuoteAmount: 0 },
      ]),
    ).toBeCloseTo(38.16);
  });

  it("falls back to total budget before the first runtime snapshot", () => {
    expect(
      calculateReservedQuoteUsd([
        { totalBudgetUsd: 140, availableQuoteAmount: null },
      ]),
    ).toBe(140);
  });

  it("does not double-count quote already converted into base", () => {
    const reservedQuoteUsd = calculateReservedQuoteUsd([
      { totalBudgetUsd: 140, availableQuoteAmount: 38.16 },
    ]);

    expect(
      calculateAvailableBudgetUsd({
        walletUsdc: 838.16,
        reservedQuoteUsd,
      }),
    ).toBeCloseTo(800);
  });

  it("releases realized profit from reserved quote so it can be reallocated", () => {
    const reservedQuoteUsd = calculateReservedQuoteUsd([
      {
        totalBudgetUsd: 140,
        availableQuoteAmount: 145.09,
        realizedPnlUsd: 5.09,
      },
      {
        totalBudgetUsd: 800,
        availableQuoteAmount: 816.78,
        realizedPnlUsd: 16.78,
      },
    ]);

    expect(reservedQuoteUsd).toBeCloseTo(940);
  });

  it("does not increase available budget when realized pnl is negative", () => {
    expect(
      calculateReservedQuoteUsd([
        {
          totalBudgetUsd: 140,
          availableQuoteAmount: 135,
          realizedPnlUsd: -5,
        },
      ]),
    ).toBe(135);
  });

  it("counts an edited bot's non-quote equity toward its own budget capacity", () => {
    expect(
      calculateAvailableBudgetUsd({
        walletUsdc: 120,
        reservedQuoteUsd: 0,
        currentBotNonQuoteEquityUsd: 80,
      }),
    ).toBe(200);
  });
});
