import { PYTH_FEED_IDS, getEnv } from "@grid-bot/common";

import type { MarketPricePort } from "../domain/contracts";
import type { Bot, MarketPrice } from "../domain/types";

interface HermesLatestResponse {
  parsed: Array<{
    id: string;
    price: {
      price: string;
      conf: string;
      expo: number;
      publish_time: number;
    };
  }>;
}

export class MarketPriceService implements MarketPricePort {
  private readonly env = getEnv();

  async getLatestPrice(bot: Bot): Promise<MarketPrice> {
    const feedId = bot.baseSymbol === "BTC" ? PYTH_FEED_IDS.BTC_USD : PYTH_FEED_IDS.SOL_USD;
    const url = `${this.env.PYTH_HERMES_BASE_URL}/v2/updates/price/latest?ids[]=${feedId}&parsed=true`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Pyth request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as HermesLatestResponse;
    const item = payload.parsed[0];
    if (!item) {
      throw new Error(`No Pyth price feed returned for ${bot.baseSymbol}`);
    }

    const price = Number(item.price.price) * 10 ** item.price.expo;
    const confidence = Number(item.price.conf) * 10 ** item.price.expo;
    return {
      symbol: bot.baseSymbol,
      pair: `${bot.baseSymbol}/${bot.quoteSymbol}`,
      price,
      confidence,
      source: "pyth",
      timestamp: new Date(item.price.publish_time * 1000),
      feedId
    };
  }
}
