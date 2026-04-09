import { type HistoryResolution } from "./charting";

const SYMBOL_HISTORY_START_SECONDS = {
  SOL: Math.floor(Date.UTC(2020, 3, 10, 0, 0, 0, 0) / 1000),
  BTC: Math.floor(Date.UTC(2010, 6, 17, 0, 0, 0, 0) / 1000)
} as const;

const HISTORY_LOOKBACK_SECONDS: Record<HistoryResolution, number> = {
  "5m": 7 * 24 * 60 * 60,
  "30m": 30 * 24 * 60 * 60,
  "1h": 90 * 24 * 60 * 60,
  "4h": 180 * 24 * 60 * 60,
  "1d": 365 * 24 * 60 * 60,
  "1w": 3 * 365 * 24 * 60 * 60,
  "1mo": 120 * 30 * 24 * 60 * 60
};

export function getHistoryWindow(
  symbol: keyof typeof SYMBOL_HISTORY_START_SECONDS,
  resolution: HistoryResolution,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  const to = nowSeconds;
  const symbolStart = SYMBOL_HISTORY_START_SECONDS[symbol];
  const lookbackSeconds = HISTORY_LOOKBACK_SECONDS[resolution];
  const from = Math.max(symbolStart, to - lookbackSeconds);

  return {
    from,
    to,
    cappedByResolution: from > symbolStart
  };
}
