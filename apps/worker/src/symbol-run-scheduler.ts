import { logger } from "@grid-bot/common";

export class SymbolRunScheduler {
  private readonly runningSymbols = new Set<string>();
  private readonly queuedSymbols = new Set<string>();
  private readonly lastRunStartedAt = new Map<string, number>();

  constructor(
    private readonly runSymbol: (symbol: string) => Promise<void>,
    private readonly options: { minIntervalMs?: number } = {}
  ) {}

  schedule(symbol: string) {
    const normalizedSymbol = symbol.toUpperCase();
    this.queuedSymbols.add(normalizedSymbol);

    if (this.runningSymbols.has(normalizedSymbol)) {
      return;
    }

    this.runningSymbols.add(normalizedSymbol);
    void this.drain(normalizedSymbol);
  }

  private async drain(symbol: string) {
    try {
      while (this.queuedSymbols.has(symbol)) {
        const waitMs = this.getWaitMs(symbol);
        if (waitMs > 0) {
          await sleep(waitMs);
        }

        this.queuedSymbols.delete(symbol);
        this.lastRunStartedAt.set(symbol, Date.now());
        await this.runSymbol(symbol);
      }
    } catch (error) {
      logger.error({ error, symbol }, "Symbol run scheduler failed");
    } finally {
      this.runningSymbols.delete(symbol);
      if (this.queuedSymbols.has(symbol)) {
        this.runningSymbols.add(symbol);
        void this.drain(symbol);
      }
    }
  }

  private getWaitMs(symbol: string) {
    const minIntervalMs = Math.max(0, this.options.minIntervalMs ?? 0);
    const lastRunStartedAt = this.lastRunStartedAt.get(symbol);
    if (!minIntervalMs || !lastRunStartedAt) {
      return 0;
    }

    return Math.max(0, minIntervalMs - (Date.now() - lastRunStartedAt));
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
