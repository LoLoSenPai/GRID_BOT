export type HistoryResolution = "5m" | "30m" | "1h" | "4h" | "1d" | "1w" | "1mo";

export type CandlePoint = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export const HISTORY_RESOLUTION_OPTIONS: Array<{ label: string; value: HistoryResolution }> = [
  { label: "5m", value: "5m" },
  { label: "30m", value: "30m" },
  { label: "1h", value: "1h" },
  { label: "4h", value: "4h" },
  { label: "1D", value: "1d" },
  { label: "1W", value: "1w" },
  { label: "1M", value: "1mo" }
];

const RESOLUTION_SECONDS: Record<HistoryResolution, number> = {
  "5m": 5 * 60,
  "30m": 30 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
  "1w": 7 * 24 * 60 * 60,
  "1mo": 30 * 24 * 60 * 60
};

export function getResolutionParam(resolution: HistoryResolution) {
  switch (resolution) {
    case "5m":
      return "5";
    case "30m":
      return "30";
    case "1h":
      return "60";
    case "4h":
      return "240";
    case "1d":
      return "1D";
    case "1w":
      return "1W";
    case "1mo":
      return "1M";
  }
}

export function getResolutionSeconds(resolution: HistoryResolution) {
  return RESOLUTION_SECONDS[resolution];
}

export function bucketTimestamp(timestampMs: number, resolution: HistoryResolution) {
  const date = new Date(timestampMs);

  if (resolution === "1mo") {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0);
  }

  if (resolution === "1w") {
    const day = date.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + diff, 0, 0, 0, 0));
    return monday.getTime();
  }

  if (resolution === "1d") {
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
  }

  const bucketMs = RESOLUTION_SECONDS[resolution] * 1000;
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

export function buildCandlesFromSnapshots(
  snapshots: Array<{ time: string; value: number }>,
  resolution: HistoryResolution
): CandlePoint[] {
  const filtered = [...snapshots].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());

  const candles = new Map<number, CandlePoint>();

  for (const snapshot of filtered) {
    const timeMs = new Date(snapshot.time).getTime();
    const bucket = bucketTimestamp(timeMs, resolution);
    const existing = candles.get(bucket);

    if (!existing) {
      candles.set(bucket, {
        time: new Date(bucket).toISOString(),
        open: snapshot.value,
        high: snapshot.value,
        low: snapshot.value,
        close: snapshot.value,
        volume: 0
      });
      continue;
    }

    existing.high = Math.max(existing.high, snapshot.value);
    existing.low = Math.min(existing.low, snapshot.value);
    existing.close = snapshot.value;
  }

  return [...candles.values()];
}
