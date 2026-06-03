import { describe, expect, it } from "vitest";

import { formatGoalLabel, formatRailModelLabel, formatTradeDisplay, formatTradeMarkerLabel } from "./trade-display";

describe("trade-display", () => {
  it("formats buy amounts with quote first and base second", () => {
    const display = formatTradeDisplay({
      side: "buy",
      quoteAmount: 10,
      baseAmount: 0.12054,
      baseSymbol: "SOL"
    });

    expect(display.primary).toBe("$10.00");
    expect(display.secondary).toBe("0.12054 SOL");
    expect(display.compact).toBe("$10.00 | 0.12054 SOL");
  });

  it("formats sell amounts with quote first and base second", () => {
    const display = formatTradeDisplay({
      side: "sell",
      quoteAmount: 10.12,
      baseAmount: 0.12054,
      baseSymbol: "SOL"
    });

    expect(display.primary).toBe("$10.12");
    expect(display.secondary).toBe("0.12054 SOL");
    expect(display.direction).toBe("Sell");
  });

  it("does not round tiny BTC dust to zero", () => {
    const display = formatTradeDisplay({
      side: "sell",
      quoteAmount: 0.73,
      baseAmount: 0.00001093,
      baseSymbol: "BTC"
    });

    expect(display.secondary).toBe("0.00001093 BTC");
    expect(display.compact).toBe("$0.73 | 0.00001093 BTC");
  });

  it("maps goal and rail copy to operator language", () => {
    expect(formatGoalLabel("accumulate_base")).toBe("Accumulate token");
    expect(formatGoalLabel("accumulate_usdc")).toBe("Accumulate USDC");
    expect(formatRailModelLabel(6)).toContain("6 rails = 5 trade cycles");
  });

  it("formats markers with goal-aware primary units", () => {
    expect(
      formatTradeMarkerLabel({
        strategyMode: "accumulate_usdc",
        side: "buy",
        quoteAmount: 10,
        baseAmount: 0.12054,
        baseSymbol: "SOL"
      })
    ).toBe("$10.00");

    expect(
      formatTradeMarkerLabel({
        strategyMode: "accumulate_base",
        side: "sell",
        quoteAmount: 10.12,
        baseAmount: 0.12054,
        baseSymbol: "SOL"
      })
    ).toBe("0.12054 SOL");

    expect(
      formatTradeMarkerLabel({
        strategyMode: "balanced",
        side: "sell",
        quoteAmount: 10.12,
        baseAmount: 0.12054,
        baseSymbol: "SOL"
      })
    ).toBe("$10.12 | 0.12054 SOL");
  });
});
