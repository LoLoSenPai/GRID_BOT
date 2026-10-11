import { describe, expect, it, vi } from "vitest";
import { BTC_REFERENCE_IDENTITY, CoinbaseBtcReferenceProvider } from "./shadow-btc-reference";

const now = new Date("2026-10-12T12:00:15Z"), received = new Date("2026-10-12T12:00:16Z");
function completeFetch() {
  return vi.fn(async (input: string) => {
    const url = new URL(input), start = +new Date(url.searchParams.get("start")!),
      end = +new Date(url.searchParams.get("end")!), interval = Number(url.searchParams.get("granularity")) * 1000;
    const rows = [];
    for (let time = start; time < end; time += interval) rows.push([time / 1000, 90, 110, 100, 105, 3]);
    return new Response(JSON.stringify(rows.reverse()));
  });
}
describe("Coinbase BTC shadow reference", () => {
  it("paginates 80h 5m, preserves source times and receipt times, and never uses BTC/USDC identity", async () => {
    const fetchFn = completeFetch();
    const result = await new CoinbaseBtcReferenceProvider(fetchFn as unknown as typeof fetch, () => received).getClosedHistory("5m", now);
    expect(fetchFn).toHaveBeenCalledTimes(4); expect(result.candles).toHaveLength(960);
    expect(result.candles[0]).toMatchObject({ ...BTC_REFERENCE_IDENTITY, fetchedAt: received });
    expect(result.candles.at(-1)?.closeTime).toEqual(new Date("2026-10-12T12:00:00Z"));
    expect(result.quality).toMatchObject({ missingIntervals: 0, stale: false, flatFraction: 0 });
    for (const [input, options] of fetchFn.mock.calls as unknown as [string, RequestInit][]) {
      const url = new URL(input);
      expect((+new Date(url.searchParams.get("end")!) - +new Date(url.searchParams.get("start")!)) / 300_000).toBeLessThanOrEqual(300);
      expect(options.signal).toBeInstanceOf(AbortSignal); expect(options.headers).toBeUndefined();
    }
  });
  it("collects 80 closed hourly buckets with one request", async () => {
    const fetchFn = completeFetch();
    const result = await new CoinbaseBtcReferenceProvider(fetchFn as unknown as typeof fetch).getClosedHistory("1h", now);
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(result.candles).toHaveLength(80);
  });
  it("excludes out-of-window and open bars and reports missing, stale and flat observations", async () => {
    const end = Math.floor(+now / 3_600_000) * 3_600_000;
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([
      [(end - 2 * 3_600_000) / 1000, 100, 100, 100, 100, 0],
      [end / 1000, 90, 110, 100, 105, 1],
      [(end - 81 * 3_600_000) / 1000, 90, 110, 100, 105, 1],
    ])));
    const result = await new CoinbaseBtcReferenceProvider(fetchFn as unknown as typeof fetch).getClosedHistory("1h", now);
    expect(result.candles).toHaveLength(1);
    expect(result.quality).toMatchObject({ missingIntervals: 79, stale: true, closedThroughLagMs: 3_600_000, flatFraction: 1 });
  });
  it.each([[[1, 2, 3]], [[1, 100, 90, 95, 95, 1]], { message: "error" }])("fails closed on malformed payload %j", async payload => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(payload)));
    await expect(new CoinbaseBtcReferenceProvider(fetchFn as unknown as typeof fetch).getClosedHistory("1h", now)).rejects.toThrow(/Invalid BTC reference/);
  });
  it("bounds HTTP failure to one attempt", async () => {
    const fetchFn = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(new CoinbaseBtcReferenceProvider(fetchFn as unknown as typeof fetch).getClosedHistory("5m", now)).rejects.toThrow(/HTTP 503/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
