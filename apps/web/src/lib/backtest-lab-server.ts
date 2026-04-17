import "server-only";

import type { BacktestMarketSeries } from "@grid-bot/core";

import type { HistoryResolution } from "@/lib/charting";
import { type LabLookbackDays, type LabPair, type LabResolution } from "@/lib/backtest-lab";
import { fetchMarketHistoryLookback } from "@/lib/market-history";

export async function fetchBacktestSeries(input: {
  pair: LabPair;
  resolution: LabResolution;
  lookbackDays: LabLookbackDays;
}): Promise<{ series: BacktestMarketSeries; historyWindow: { from: string; to: string; source: string } }> {
  const history = await fetchMarketHistoryLookback(input.pair, input.resolution as HistoryResolution, input.lookbackDays);

  return {
    series: {
      symbol: input.pair,
      pair: `${input.pair}/USDC`,
      resolution: input.resolution,
      candles: history.candles.map((candle) => ({
        timestamp: new Date(candle.time),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume ?? null
      }))
    },
    historyWindow: {
      from: history.meta.from,
      to: history.meta.to,
      source: history.meta.source
    }
  };
}
