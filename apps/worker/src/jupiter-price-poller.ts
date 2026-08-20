import { logger } from "@grid-bot/common";
import { JUPITER_PRICE_SYMBOLS, type MarketPrice, type MarketPriceService } from "@grid-bot/core";

const MAX_BACKOFF_MS = 30_000;

export class JupiterPricePoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private consecutiveFailures = 0;

  constructor(
    private readonly marketPriceService: Pick<MarketPriceService, "fetchLatestPrices">,
    private readonly onPrices: (prices: MarketPrice[]) => Promise<void> | void,
    private readonly intervalMs: number
  ) {}

  start() {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    void this.poll();
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll() {
    let nextDelayMs = this.intervalMs;

    try {
      const prices = await this.marketPriceService.fetchLatestPrices(JUPITER_PRICE_SYMBOLS, "USDC");
      this.consecutiveFailures = 0;
      await this.onPrices(prices);

      const receivedSymbols = new Set(prices.map((price) => price.symbol));
      const missingSymbols = JUPITER_PRICE_SYMBOLS.filter((symbol) => !receivedSymbols.has(symbol));
      if (missingSymbols.length > 0) {
        logger.warn({ missingSymbols }, "Jupiter Price V3 omitted unreliable symbols; cached values were not refreshed");
      }
    } catch (error) {
      this.consecutiveFailures += 1;
      nextDelayMs = Math.min(this.intervalMs * 2 ** this.consecutiveFailures, MAX_BACKOFF_MS);
      logger.warn(
        { error, nextRetryMs: nextDelayMs },
        "Jupiter Price V3 batch temporarily unavailable; trading waits for a fresh price"
      );
    }

    if (!this.stopped) {
      this.timer = setTimeout(() => void this.poll(), nextDelayMs);
    }
  }
}
