import type { NormalizedCandle } from "@grid-bot/core";

/** Price reference only: USD on Coinbase is not the executable Solana BTC/USDC market. */
export const BTC_REFERENCE_IDENTITY = Object.freeze({ provider: "coinbase-reference", symbol: "BTC_REF",
  quoteSymbol: "USD", sourceMarket: "BTC-USD" });
export type BtcReferenceResolution = "5m" | "1h";
export const BTC_REFERENCE_LOOKBACK_MS = 80 * 3_600_000;

export function btcReferenceQuality(candles: NormalizedCandle[], resolution: BtcReferenceResolution,
  from: Date, now: Date) {
  const interval = resolution === "5m" ? 300_000 : 3_600_000;
  const expectedClose = Math.floor(+now / interval) * interval;
  const expectedStart = Math.ceil(+from / interval) * interval;
  const times = new Set(candles.map(c => +c.openTime));
  let missingIntervals = 0;
  for (let time = expectedStart; time < expectedClose; time += interval) if (!times.has(time)) missingIntervals++;
  const lastClose = candles.reduce<number | null>((latest, c) => c.closeTime
    ? Math.max(latest ?? 0, +c.closeTime) : latest, null);
  const flatCandles = candles.filter(c => c.open === c.high && c.high === c.low && c.low === c.close).length;
  return { expectedCandles: Math.max(0, (expectedClose - expectedStart) / interval),
    observedCandles: candles.length, missingIntervals, lastCloseTime: lastClose === null ? null : new Date(lastClose),
    closedThroughLagMs: lastClose === null ? null : Math.max(0, expectedClose - lastClose),
    stale: lastClose === null || lastClose < expectedClose, flatCandles,
    flatFraction: candles.length ? flatCandles / candles.length : null };
}

/** Public, credential-free, fixed 80h window; no retries or synthesized candles. */
export class CoinbaseBtcReferenceProvider {
  constructor(private readonly fetchFn: typeof fetch = fetch, private readonly receivedAt = () => new Date()) {}
  async getClosedHistory(resolution: BtcReferenceResolution, now: Date) {
    if (!Number.isFinite(+now)) throw new Error("Invalid BTC reference observation time.");
    const interval = resolution === "5m" ? 300_000 : 3_600_000;
    const end = Math.floor(+now / interval) * interval;
    const from = end - BTC_REFERENCE_LOOKBACK_MS;
    const candles = new Map<number, NormalizedCandle>();
    // At most four public requests for 5m and one for 1h. Each page stays within the 300 bucket cap.
    // The API can include the endpoint bucket: 299 intervals keep even inclusive replies <=300 rows.
    for (let start = from; start < end; start += 299 * interval) {
      const stop = Math.min(end, start + 299 * interval);
      const url = new URL("https://api.exchange.coinbase.com/products/BTC-USD/candles");
      url.searchParams.set("granularity", String(interval / 1000));
      url.searchParams.set("start", new Date(start).toISOString());
      url.searchParams.set("end", new Date(stop).toISOString());
      const response = await this.fetchFn(url.toString(), { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`BTC reference candles HTTP ${response.status}.`);
      const payload: unknown = await response.json();
      const fetchedAt = this.receivedAt();
      if (!Array.isArray(payload) || payload.length > 300) throw new Error("Invalid BTC reference candle payload.");
      for (const row of payload) {
        if (!Array.isArray(row) || row.length !== 6 || !row.every(v => typeof v === "number" && Number.isFinite(v))) {
          throw new Error("Invalid BTC reference candle values.");
        }
        const [timestamp, low, high, open, close, volume] = row as number[];
        const time = timestamp! * 1000;
        if (!Number.isSafeInteger(time) || time % interval !== 0 || low! <= 0 || high! < low!
          || open! < low! || open! > high! || close! < low! || close! > high! || volume! < 0) {
          throw new Error("Invalid BTC reference candle interval or OHLCV.");
        }
        // Coinbase may return buckets before start and the still-open endpoint bucket.
        if (time < start || time >= stop || time + interval > +now) continue;
        candles.set(time, { ...BTC_REFERENCE_IDENTITY, resolution, openTime: new Date(time),
          closeTime: new Date(time + interval), open: open!, high: high!, low: low!, close: close!, volume: volume!, fetchedAt });
      }
    }
    const rows = [...candles.values()].sort((a, b) => +a.openTime - +b.openTime);
    return { candles: rows, quality: btcReferenceQuality(rows, resolution, new Date(from), now) };
  }
}
