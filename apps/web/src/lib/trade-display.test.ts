import { describe, expect, it } from "vitest";

import { formatGoalLabel, formatRailModelLabel, formatTradeDisplay } from "./trade-display";

describe("trade-display", () => {
  it("formats buy amounts with quote first and base second", () => {
    const display = formatTradeDisplay({
      side: "buy",
      quoteAmount: 10,
      baseAmount: 0.12054,
      baseSymbol: "SOL"
    });

    expect(display.primary).toBe("$10.00");
    expect(display.secondary).toBe("0.1205 SOL");
    expect(display.compact).toBe("$10.00 | 0.1205 SOL");
  });

  it("formats sell amounts with quote first and base second", () => {
    const display = formatTradeDisplay({
      side: "sell",
      quoteAmount: 10.12,
      baseAmount: 0.12054,
      baseSymbol: "SOL"
    });

    expect(display.primary).toBe("$10.12");
    expect(display.secondary).toBe("0.1205 SOL");
    expect(display.direction).toBe("Sell");
  });

  it("maps goal and rail copy to operator language", () => {
    expect(formatGoalLabel("accumulate_base")).toBe("Accumulate token");
    expect(formatGoalLabel("accumulate_usdc")).toBe("Accumulate USDC");
    expect(formatRailModelLabel(6)).toContain("6 rails = 5 trade cycles");
  });
});
