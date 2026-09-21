import { CachedCandleHistoryProvider, GeckoTerminalHistoryProvider } from "@grid-bot/core";
import { PrismaMarketCandleRepository } from "@grid-bot/db";

const provider = new CachedCandleHistoryProvider(
  new PrismaMarketCandleRepository(),
  new GeckoTerminalHistoryProvider(),
);

export function loadPortfolioHistory(symbol: "BTC" | "SOL", from: Date, to: Date) {
  return provider.getHistory({ symbol, quoteSymbol: "USDC", resolution: "1h", from, to });
}
