import type { HistoricalCandle } from "../domain/types";

export interface CandleReplayPoint {
  price: number;
  timestamp: Date;
}

export class CandleReplayService {
  estimateIntervalMs(candles: HistoricalCandle[]) {
    const deltas = candles
      .map((candle, index) => {
        const next = candles[index + 1];
        if (!next) {
          return null;
        }

        const delta = next.timestamp.getTime() - candle.timestamp.getTime();
        return delta > 0 ? delta : null;
      })
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right);

    if (deltas.length === 0) {
      return 1;
    }

    return deltas[Math.floor(deltas.length / 2)]!;
  }

  buildIntrabougiePath(candle: HistoricalCandle, intervalMs: number): CandleReplayPoint[] {
    const normalizedIntervalMs = Math.max(Math.floor(intervalMs), 1);
    const start = candle.timestamp.getTime();
    const lowHighSplit = Math.max(1, Math.floor(normalizedIntervalMs / 3));
    const midSplit = Math.max(lowHighSplit + 1, Math.floor((normalizedIntervalMs * 2) / 3));
    const end = start + normalizedIntervalMs;
    const bullish = candle.close >= candle.open;
    const orderedPrices = bullish
      ? [candle.open, candle.low, candle.high, candle.close]
      : [candle.open, candle.high, candle.low, candle.close];

    return orderedPrices.map((price, index) => ({
      price,
      timestamp: new Date([start, start + lowHighSplit, start + midSplit, end][index] ?? end)
    }));
  }
}
