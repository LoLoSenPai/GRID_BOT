import { formatCurrency, formatNumber } from "./utils";

export type TradeDisplayInput = {
  side: "buy" | "sell";
  quoteAmount: number | null;
  baseAmount: number | null;
  baseSymbol: string;
};

export function formatGoalLabel(strategyMode: string) {
  switch (strategyMode) {
    case "accumulate_base":
      return "Accumulate token";
    case "balanced":
      return "Balanced recycle";
    case "accumulate_usdc":
      return "Accumulate USDC";
    default:
      return strategyMode.replaceAll("_", " ");
  }
}

export function getTradeCycleCount(levelCount: number) {
  return Math.max(0, levelCount - 1);
}

export function formatRailModelLabel(levelCount: number) {
  const tradeCycles = getTradeCycleCount(levelCount);
  const lowestRail = `L${String(1).padStart(2, "0")}`;
  const highestRail = `L${String(levelCount).padStart(2, "0")}`;
  return `${levelCount} rails = ${tradeCycles} trade cycles | ${lowestRail} buy-only | ${highestRail} sell-only | middle rails recycle`;
}

export function formatTradeDisplay({
  side,
  quoteAmount,
  baseAmount,
  baseSymbol
}: TradeDisplayInput) {
  const primary = quoteAmount !== null ? formatCurrency(quoteAmount) : "--";
  const secondary =
    baseAmount !== null ? `${formatNumber(baseAmount, baseAmount >= 100 ? 2 : 4)} ${baseSymbol}` : null;
  const compact = secondary ? `${primary} | ${secondary}` : primary;
  const direction = side === "buy" ? "Buy" : "Sell";

  return {
    primary,
    secondary,
    compact,
    direction
  };
}

export function formatTradeBadgeLabel(input: TradeDisplayInput) {
  const display = formatTradeDisplay(input);
  return `${display.direction} ${display.compact}`;
}
