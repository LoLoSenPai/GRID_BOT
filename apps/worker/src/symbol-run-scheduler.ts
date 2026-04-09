import { logger } from "@grid-bot/common";

export class SymbolRunScheduler {
  private readonly runningSymbols = new Set<string>();
  private readonly queuedSymbols = new Set<string>();

  constructor(private readonly runSymbol: (symbol: string) => Promise<void>) {}

  schedule(symbol: string) {
    const normalizedSymbol = symbol.toUpperCase();

    if (this.runningSymbols.has(normalizedSymbol)) {
      this.queuedSymbols.add(normalizedSymbol);
      return;
    }

    this.runningSymbols.add(normalizedSymbol);
    void this.drain(normalizedSymbol);
  }

  private async drain(symbol: string) {
    try {
      do {
        this.queuedSymbols.delete(symbol);
        await this.runSymbol(symbol);
      } while (this.queuedSymbols.has(symbol));
    } catch (error) {
      logger.error({ error, symbol }, "Symbol run scheduler failed");
    } finally {
      this.runningSymbols.delete(symbol);
    }
  }
}
